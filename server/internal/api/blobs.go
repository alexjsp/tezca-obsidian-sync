package api

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"hash"
	"io"
	"net/http"
	"strconv"

	"tezca/server/internal/blobs"
	"tezca/server/internal/store"
)

// validBlobID: 32 bytes as unpadded base64url (43 chars).
func validBlobID(id string) bool {
	if len(id) != 43 {
		return false
	}
	b, err := base64.RawURLEncoding.DecodeString(id)
	return err == nil && len(b) == 32
}

// validSpaceID: 16 bytes as unpadded base64url (22 chars).
func validSpaceID(id string) bool {
	if len(id) != 22 {
		return false
	}
	b, err := base64.RawURLEncoding.DecodeString(id)
	return err == nil && len(b) == 16
}

func blobPath(r *http.Request) (space, blob string, err error) {
	space, blob = r.PathValue("space_id"), r.PathValue("blob_id")
	if !validSpaceID(space) {
		return "", "", herr(http.StatusBadRequest, "space_id must be 16 bytes base64url")
	}
	if !validBlobID(blob) {
		return "", "", herr(http.StatusBadRequest, "blob_id must be 32 bytes base64url")
	}
	return space, blob, nil
}

// spaceRole returns the user's role in a space; non-members get 403.
func (a *API) spaceRole(r *http.Request, u store.User, space string) (int, error) {
	role, _, err := a.cfg.Store.Membership(r.Context(), space, u.SignPk)
	if errors.Is(err, store.ErrNotFound) {
		return 0, herr(http.StatusForbidden, "not a member of this space")
	}
	return role, err
}

var errBadBodySig = errors.New("bad signature")

// signedBody hashes a streamed request body and checks the request signature when it reaches
// EOF. A bad signature surfaces as a read error, so a BlobStore never commits the blob.
type signedBody struct {
	r      io.Reader
	h      hash.Hash
	verify func(sum []byte) bool
	n      int64
	err    error // first non-EOF error returned
	done   bool  // reached EOF with a valid signature
}

func (b *signedBody) Read(p []byte) (int, error) {
	if b.err != nil {
		return 0, b.err
	}
	if b.done {
		return 0, io.EOF
	}
	n, err := b.r.Read(p)
	b.h.Write(p[:n])
	b.n += int64(n)
	switch {
	case err == io.EOF:
		if !b.verify(b.h.Sum(nil)) {
			b.err = errBadBodySig
			return n, b.err
		}
		b.done = true
	case err != nil:
		b.err = err
	}
	return n, err
}

var (
	errQuota     = errors.New("guest storage quota exceeded")
	errQuotaHTTP = herr(http.StatusInsufficientStorage, "guest storage quota exceeded")
)

// quotaReader fails with errQuota once more than left bytes have been read.
type quotaReader struct {
	r    io.Reader
	left int64
}

func (q *quotaReader) Read(p []byte) (int, error) {
	n, err := q.r.Read(p)
	q.left -= int64(n)
	if q.left < 0 {
		return n, errQuota
	}
	return n, err
}

// bodyErr maps a signedBody read failure to an HTTP error.
func bodyErr(err error) error {
	var mbe *http.MaxBytesError
	switch {
	case errors.Is(err, errQuota):
		return errQuotaHTTP
	case errors.Is(err, errBadBodySig):
		return herr(http.StatusUnauthorized, "bad signature")
	case errors.As(err, &mbe):
		return herr(http.StatusRequestEntityTooLarge, "blob too large")
	}
	return herr(http.StatusBadRequest, "cannot read body")
}

// putBlob: PUT /api/spaces/{space_id}/blobs/{blob_id}. The signature covers sha256(body), so
// the body is streamed through signedBody: everything checkable from the headers (skew, user,
// role) is checked first, and the signature when the body ends, before the blob is committed.
func (a *API) putBlob(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		space, id, err := blobPath(r)
		if err != nil {
			return err
		}
		limit := a.cfg.MaxBlobBytes + BlobOverhead
		if r.ContentLength > limit {
			return herr(http.StatusRequestEntityTooLarge, "blob too large")
		}
		ah, err := a.parseAuth(r)
		if err != nil {
			return err
		}
		u, err := a.user(r, ah)
		if err != nil {
			return err
		}
		role, err := a.spaceRole(r, u, space)
		if err != nil {
			return err
		}
		if role != store.SpaceOwner && role != store.SpaceEditor {
			return herr(http.StatusForbidden, "read-only member")
		}
		body := &signedBody{
			r:      http.MaxBytesReader(w, r.Body, limit),
			h:      sha256.New(),
			verify: func(sum []byte) bool { return ah.verify(r, sum) },
		}

		ctx := r.Context()
		existing, err := a.cfg.Store.GetBlob(ctx, space, id)
		isNew := errors.Is(err, store.ErrNotFound)
		switch {
		case err == nil:
			// Already stored: authenticate the body, discard it. (If the bytes went missing
			// from the blob store, fall through and store them again.)
			ok, err := a.cfg.Blobs.Exists(ctx, space, id)
			if err != nil {
				return err
			}
			if ok {
				if _, err := io.Copy(io.Discard, body); err != nil {
					return bodyErr(err)
				}
				writeJSON(w, http.StatusOK, map[string]any{"size": existing.Size})
				return nil
			}
		case !isNew:
			return err
		}

		// Guest quota (M4; blobs, updates and snapshots count): refuse up front what can't fit, stop the stream once it overflows,
		// and re-check when recording (concurrent uploads), dropping the bytes if it's over.
		var quota int64
		if isNew && u.Role == store.HostGuest && a.cfg.GuestQuotaBytes > 0 {
			quota = a.cfg.GuestQuotaBytes
			used, err := a.cfg.Store.UserBytes(ctx, u.SignPk)
			if err != nil {
				return err
			}
			left := quota - used
			if left <= 0 || r.ContentLength > left {
				return errQuotaHTTP
			}
			body.r = &quotaReader{r: body.r, left: left}
		}

		if err := a.cfg.Blobs.Put(ctx, space, id, body); err != nil {
			if body.err != nil {
				return bodyErr(body.err)
			}
			return err
		}
		if !body.done { // a BlobStore must read to EOF; never record an unverified blob
			return errors.New("blob store did not consume the body")
		}
		created, err := a.cfg.Store.PutBlob(ctx, space, id, store.Blob{Size: body.n, CreatedBy: u.SignPk, CreatedAt: a.cfg.Now().UnixMilli()}, quota)
		if errors.Is(err, store.ErrQuota) {
			// Only remove the bytes if nobody recorded this blob meanwhile (a concurrent upload of
			// the same content by another user): deleting them would break that user's copy.
			if _, gerr := a.cfg.Store.GetBlob(ctx, space, id); errors.Is(gerr, store.ErrNotFound) {
				if err := a.cfg.Blobs.Delete(ctx, space, id); err != nil {
					a.log.Warn("delete over-quota blob", "space", space, "blob", id, "err", err)
				}
			}
			return errQuotaHTTP
		}
		if err != nil {
			return err
		}
		status := http.StatusOK
		if created {
			status = http.StatusCreated
		}
		writeJSON(w, status, map[string]any{"size": body.n})
		return nil
	}()
	if err != nil {
		a.fail(w, err)
	}
}

// getBlob: GET and HEAD /api/spaces/{space_id}/blobs/{blob_id}. Any member may read.
func (a *API) getBlob(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		space, id, err := blobPath(r)
		if err != nil {
			return err
		}
		u, _, err := a.authenticate(r)
		if err != nil {
			return err
		}
		if _, err := a.spaceRole(r, u, space); err != nil {
			return err
		}
		ctx := r.Context()
		row, err := a.cfg.Store.GetBlob(ctx, space, id)
		if errors.Is(err, store.ErrNotFound) {
			return herr(http.StatusNotFound, "blob not found")
		}
		if err != nil {
			return err
		}
		h := w.Header()
		h.Set("Content-Type", "application/octet-stream")
		h.Set("Cache-Control", "no-store")
		if r.Method == http.MethodHead {
			h.Set("Content-Length", strconv.FormatInt(row.Size, 10))
			w.WriteHeader(http.StatusOK)
			return nil
		}
		rc, size, err := a.cfg.Blobs.Get(ctx, space, id)
		if errors.Is(err, blobs.ErrNotFound) {
			a.log.Warn("blob recorded but missing from the blob store", "space", space, "blob", id)
			return herr(http.StatusNotFound, "blob not found")
		}
		if err != nil {
			return err
		}
		defer rc.Close()
		h.Set("Content-Length", strconv.FormatInt(size, 10))
		w.WriteHeader(http.StatusOK)
		if _, err := io.Copy(w, rc); err != nil {
			a.log.Debug("blob download interrupted", "space", space, "blob", id, "err", err)
		}
		return nil
	}()
	if err != nil {
		a.fail(w, err)
	}
}
