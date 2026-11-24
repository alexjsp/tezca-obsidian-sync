// Command tezca-server is the Tezca relay: an opaque, end-to-end-encrypted sync store for Obsidian.
//
// Usage:
//
//	tezca-server              run the server (configured by TEZCA_* env vars)
//	tezca-server healthcheck  exit 0 if the local server answers /healthz (for container health checks)
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"tezca/server/internal/api"
	"tezca/server/internal/blobs"
	"tezca/server/internal/store"
	"tezca/server/internal/ws"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// envInt reads a non-negative integer env var.
func envInt(k string, def int) (int, error) {
	v := os.Getenv(k)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("%s must be a non-negative integer, got %q", k, v)
	}
	return n, nil
}

// openBlobs returns the S3 blob store when TEZCA_S3_BUCKET is set, otherwise the filesystem one
// under dataDir/blobs.
func openBlobs(ctx context.Context, dataDir string) (blobs.BlobStore, string, error) {
	bucket := os.Getenv("TEZCA_S3_BUCKET")
	if bucket == "" {
		dir := filepath.Join(dataDir, "blobs")
		fs, err := blobs.NewFS(dir)
		return fs, dir, err
	}
	cfg := blobs.S3Config{
		Endpoint:  os.Getenv("TEZCA_S3_ENDPOINT"),
		AccessKey: os.Getenv("TEZCA_S3_ACCESS_KEY"),
		SecretKey: os.Getenv("TEZCA_S3_SECRET_KEY"),
		Region:    os.Getenv("TEZCA_S3_REGION"),
		Bucket:    bucket,
		Prefix:    os.Getenv("TEZCA_S3_PREFIX"),
		Insecure:  os.Getenv("TEZCA_S3_INSECURE") == "1",
	}
	s3, err := blobs.NewS3(cfg)
	if err != nil {
		return nil, "", err
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := s3.Check(cctx); err != nil {
		return nil, "", err
	}
	return s3, "s3://" + cfg.Endpoint + "/" + bucket + "/" + cfg.Prefix, nil
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "healthcheck":
			os.Exit(healthcheck())
		case "-h", "--help", "help":
			fmt.Println("usage: tezca-server [healthcheck]\nsee server/README.md for TEZCA_* environment variables")
			return
		default:
			fmt.Fprintf(os.Stderr, "unknown command %q\n", os.Args[1])
			os.Exit(2)
		}
	}
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func healthcheck() int {
	addr := env("TEZCA_LISTEN", ":8080")
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	c := http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://" + net.JoinHostPort(host, port) + "/healthz")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "status", resp.Status)
		return 1
	}
	return 0
}

func run() error {
	level := slog.LevelInfo
	if os.Getenv("TEZCA_DEBUG") != "" {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)

	dataDir := env("TEZCA_DATA_DIR", "./data")
	if err := dropPrivileges(dataDir); err != nil {
		return err
	}
	listen := env("TEZCA_LISTEN", ":8080")
	publicURL := strings.TrimRight(os.Getenv("TEZCA_PUBLIC_URL"), "/")
	name := env("TEZCA_SERVER_NAME", "Tezca")
	pluginRepo := env("TEZCA_PLUGIN_REPO", api.DefaultPluginRepo)
	if !api.ValidPluginRepo(pluginRepo) {
		return fmt.Errorf("TEZCA_PLUGIN_REPO must be a GitHub owner/repo, e.g. %s", api.DefaultPluginRepo)
	}
	maxBlobMB, err := envInt("TEZCA_MAX_BLOB_MB", 100)
	if err != nil {
		return err
	}
	if maxBlobMB == 0 {
		return fmt.Errorf("TEZCA_MAX_BLOB_MB must be at least 1")
	}
	guestQuotaMB, err := envInt("TEZCA_GUEST_QUOTA_MB", api.DefaultGuestMB)
	if err != nil {
		return err
	}
	var history store.History
	if history.Hours, err = envInt("TEZCA_HISTORY_HOURS", store.DefaultHistory.Hours); err != nil {
		return err
	}
	if history.Days, err = envInt("TEZCA_HISTORY_DAYS", store.DefaultHistory.Days); err != nil {
		return err
	}

	st, err := store.Open(dataDir)
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()
	st.SetHistory(history)
	ctx := context.Background()
	blobStore, blobLoc, err := openBlobs(ctx, dataDir)
	if err != nil {
		return fmt.Errorf("open blob store: %w", err)
	}
	serverID, claimed, code, err := st.Init(ctx, os.Getenv("TEZCA_CLAIM_CODE"))
	if err != nil {
		return fmt.Errorf("init store: %w", err)
	}

	hub := ws.NewHub(ws.Config{Store: st, ServerID: serverID, Logger: log, GuestQuotaBytes: int64(guestQuotaMB) << 20})
	handler := api.New(api.Config{
		Store: st, Hub: hub, Notify: hub, ServerID: serverID, PublicURL: publicURL, Name: name, PluginRepo: pluginRepo, Logger: log,
		Blobs: blobStore, MaxBlobBytes: int64(maxBlobMB) << 20, GuestQuotaBytes: int64(guestQuotaMB) << 20,
	})

	ln, err := net.Listen("tcp", listen)
	if err != nil {
		return err
	}
	log.Info("tezca-server listening", "addr", ln.Addr().String(), "data", dataDir, "blobs", blobLoc, "server_id", serverID)
	if !claimed {
		base := publicURL
		if base == "" {
			_, port, _ := net.SplitHostPort(ln.Addr().String())
			base = "http://localhost:" + port
		}
		banner := strings.Repeat("=", 72)
		fmt.Fprintf(os.Stderr, "\n%s\n  This server is not claimed yet.\n  Claim this server: %s/claim?code=%s\n", banner, base, code)
		if publicURL == "" {
			fmt.Fprintf(os.Stderr, "  (TEZCA_PUBLIC_URL is not set: replace the host with the address your devices use.)\n")
		}
		fmt.Fprintf(os.Stderr, "%s\n\n", banner)
	}

	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}

	stop, cancel := signal.NotifyContext(ctx, syscall.SIGTERM, os.Interrupt)
	defer cancel()

	go func() { // housekeeping
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-stop.Done():
				return
			case now := <-t.C:
				if err := st.PruneExpired(ctx, now.Unix()); err != nil {
					log.Warn("prune pairings", "err", err)
				}
			}
		}
	}()

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	select {
	case err := <-errc:
		return err
	case <-stop.Done():
	}
	log.Info("shutting down")
	hub.Close()
	sctx, scancel := context.WithTimeout(ctx, 10*time.Second)
	defer scancel()
	if err := srv.Shutdown(sctx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		log.Warn("shutdown", "err", err)
	}
	log.Info("bye")
	return nil
}
