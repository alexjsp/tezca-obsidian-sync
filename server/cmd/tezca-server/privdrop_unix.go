//go:build unix

package main

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

// dropPrivileges implements the PUID/PGID convention (Unraid and friends): started as root with
// PUID (and optionally PGID) set, the server makes the data directory theirs and then runs as that
// user. Without PUID, or when not root, it does nothing.
func dropPrivileges(dataDir string) error {
	puid := os.Getenv("PUID")
	if puid == "" || os.Geteuid() != 0 {
		return nil
	}
	uid, err := strconv.Atoi(puid)
	if err != nil || uid < 0 {
		return fmt.Errorf("PUID must be a numeric user id, got %q", puid)
	}
	gid := uid
	if g := os.Getenv("PGID"); g != "" {
		if gid, err = strconv.Atoi(g); err != nil || gid < 0 {
			return fmt.Errorf("PGID must be a numeric group id, got %q", g)
		}
	}
	if uid == 0 {
		return nil // asked to stay root
	}
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		return err
	}
	if err := filepath.WalkDir(dataDir, func(p string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(p, uid, gid)
	}); err != nil {
		return fmt.Errorf("giving %s to %d:%d: %w", dataDir, uid, gid, err)
	}
	if err := syscall.Setgroups([]int{gid}); err != nil {
		return err
	}
	if err := syscall.Setgid(gid); err != nil {
		return err
	}
	return syscall.Setuid(uid)
}
