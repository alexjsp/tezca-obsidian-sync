package api

import (
	"encoding/base64"
	"errors"
	"net/http"
	"time"

	"tezca/server/internal/sigs"
	"tezca/server/internal/store"
)

// MaxWrappedShareKey bounds a wrapped space key in share requests. A link-wrapped key is 72
// bytes (nonce 24 + key 32 + tag 16) and a sealed box 80; the slack allows for format changes.
const MaxWrappedShareKey = 256

// shareKey is a wrapped key for one epoch.
type shareKey struct {
	Epoch   *uint32 `json:"epoch"`
	Wrapped B64     `json:"wrapped"`
}

// parseEpochKeys validates a [{epoch, wrapped}] list: non-empty, sane sizes, no epoch twice.
func parseEpochKeys(in []shareKey) ([]store.SpaceKey, error) {
	if len(in) == 0 {
		return nil, herr(http.StatusBadRequest, "keys required")
	}
	seen := map[uint32]bool{}
	out := make([]store.SpaceKey, 0, len(in))
	for _, k := range in {
		if k.Epoch == nil {
			return nil, herr(http.StatusBadRequest, "key without epoch")
		}
		if len(k.Wrapped) == 0 || len(k.Wrapped) > MaxWrappedShareKey {
			return nil, herr(http.StatusBadRequest, "wrapped key missing or too large")
		}
		if seen[*k.Epoch] {
			return nil, herr(http.StatusBadRequest, "duplicate epoch in keys")
		}
		seen[*k.Epoch] = true
		out = append(out, store.SpaceKey{Epoch: *k.Epoch, Wrapped: k.Wrapped})
	}
	return out, nil
}

func keysJSON(ks []store.SpaceKey) []map[string]any {
	out := make([]map[string]any, len(ks))
	for i, k := range ks {
		out[i] = map[string]any{"epoch": k.Epoch, "wrapped": B64(k.Wrapped)}
	}
	return out
}

func spaceRoleName(r int) string {
	switch r {
	case store.SpaceOwner:
		return "owner"
	case store.SpaceEditor:
		return "editor"
	case store.SpaceViewer:
		return "viewer"
	}
	return "unknown"
}

func parseSpaceRole(s string) (int, bool) {
	switch s {
	case "owner":
		return store.SpaceOwner, true
	case "editor":
		return store.SpaceEditor, true
	case "viewer":
		return store.SpaceViewer, true
	}
	return 0, false
}

func spaceKindName(k int) string {
	switch k {
	case 1:
		return "root"
	case 2:
		return "share"
	case 3:
		return "profile"
	}
	return "unknown"
}

// shareErr maps store errors from the share operations to HTTP errors.
func shareErr(err error) error {
	switch {
	case errors.Is(err, store.ErrForbidden):
		return herr(http.StatusForbidden, "owner only")
	case errors.Is(err, store.ErrLastOwner):
		return herr(http.StatusConflict, "a space must keep at least one owner")
	case errors.Is(err, store.ErrNotFound):
		return herr(http.StatusNotFound, "not found")
	}
	return err
}

// spaceRequest authenticates the request and validates {space_id}.
func (a *API) spaceRequest(r *http.Request) (store.User, string, []byte, error) {
	u, body, err := a.authenticate(r)
	if err != nil {
		return store.User{}, "", nil, err
	}
	space := r.PathValue("space_id")
	if !validSpaceID(space) {
		return store.User{}, "", nil, herr(http.StatusBadRequest, "space_id must be 16 bytes base64url")
	}
	return u, space, body, nil
}

// notifyMembers pushes SpaceChanged to every current member of space plus extra.
func (a *API) notifyMembers(r *http.Request, space string, extra ...[]byte) {
	if a.cfg.Notify == nil {
		return
	}
	pks, err := a.cfg.Store.MemberPks(r.Context(), space)
	if err != nil {
		a.log.Error("list members for SpaceChanged", "err", err, "space", space)
	}
	a.cfg.Notify.SpaceChanged(space, append(pks, extra...))
}

func (a *API) createShareInvite(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		u, space, body, err := a.spaceRequest(r)
		if err != nil {
			return err
		}
		var q struct {
			Role       string     `json:"role"`
			Keys       []shareKey `json:"keys"`
			TTLSeconds int64      `json:"ttl_seconds"`
		}
		if err := decode(body, &q); err != nil {
			return err
		}
		role, ok := parseSpaceRole(q.Role)
		if !ok || role == store.SpaceOwner {
			return herr(http.StatusBadRequest, "role must be \"editor\" or \"viewer\"")
		}
		keys, err := parseEpochKeys(q.Keys)
		if err != nil {
			return err
		}
		ttl := DefaultInvite
		if q.TTLSeconds > 0 {
			ttl = min(max(time.Duration(q.TTLSeconds)*time.Second, MinInvite), MaxInvite)
		}
		now := a.cfg.Now()
		exp := now.Add(ttl).Unix()
		tok, err := a.cfg.Store.CreateShareInvite(r.Context(), space, u.SignPk, role, keys, now.Unix(), exp)
		if errors.Is(err, store.ErrBadKeys) {
			return herr(http.StatusConflict, "keys must cover every epoch from 0 to the current one")
		}
		if err != nil {
			return shareErr(err)
		}
		writeJSON(w, http.StatusOK, map[string]any{"token": tok, "expires_at": exp})
		return nil
	}()
	if err != nil {
		a.fail(w, err)
	}
}

func (a *API) listShareInvites(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		u, space, _, err := a.spaceRequest(r)
		if err != nil {
			return err
		}
		role, err := a.spaceRole(r, u, space)
		if err != nil {
			return err
		}
		if role != store.SpaceOwner {
			return herr(http.StatusForbidden, "owner only")
		}
		invs, err := a.cfg.Store.ListShareInvites(r.Context(), space)
		if err != nil {
			return err
		}
		type item struct {
			Token      string `json:"token"`
			Role       string `json:"role"`
			CreatedAt  int64  `json:"created_at"`
			ExpiresAt  int64  `json:"expires_at"`
			RedeemedBy B64    `json:"redeemed_by,omitempty"`
			RedeemedAt int64  `json:"redeemed_at,omitempty"`
		}
		out := make([]item, 0, len(invs))
		for _, i := range invs {
			out = append(out, item{Token: i.Token, Role: spaceRoleName(i.Role), CreatedAt: i.CreatedAt, ExpiresAt: i.ExpiresAt,
				RedeemedBy: i.RedeemedBy, RedeemedAt: i.RedeemedAt})
		}
		writeJSON(w, http.StatusOK, map[string]any{"invites": out})
		return nil
	}()
	if err != nil {
		a.fail(w, err)
	}
}

func (a *API) revokeShareInvite(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		u, space, _, err := a.spaceRequest(r)
		if err != nil {
			return err
		}
		err = a.cfg.Store.RevokeShareInvite(r.Context(), space, u.SignPk, r.PathValue("token"))
		switch {
		case errors.Is(err, store.ErrNotFound):
			return herr(http.StatusNotFound, "invite not found")
		case errors.Is(err, store.ErrRedeemed):
			return herr(http.StatusConflict, "invite already redeemed")
		case err != nil:
			return shareErr(err)
		}
		writeJSON(w, http.StatusOK, map[string]any{})
		return nil
	}()
	if err != nil {
		a.fail(w, err)
	}
}

// redeemShareInvite: POST /api/share-invites/redeem. A host user signs the request (HTTP sig,
// body {token}); anyone else signs the body like /api/redeem ({token, sign_pk, box_pk, sig})
// and becomes a GUEST if the redeem succeeds (M4). Registered users may use either form.
func (a *API) redeemShareInvite(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		var (
			q          redeemReq
			signPk     []byte
			guestBoxPk []byte
		)
		if r.Header.Get("Authorization") != "" {
			u, body, err := a.authenticate(r)
			if err != nil {
				return err
			}
			if err := decode(body, &q); err != nil {
				return err
			}
			signPk = u.SignPk
		} else {
			body, err := readBody(r)
			if err != nil {
				return err
			}
			if err := decode(body, &q); err != nil {
				return err
			}
			if q.SignPk == nil {
				return herr(http.StatusUnauthorized, "missing Tezca authorization")
			}
			if err := q.check(q.Token); err != nil {
				return err
			}
			if !sigs.Verify(q.SignPk, sigs.Redeem(a.cfg.ServerID, q.Token, q.SignPk, q.BoxPk), q.Sig) {
				return herr(http.StatusUnauthorized, "bad signature")
			}
			signPk, guestBoxPk = q.SignPk, q.BoxPk
		}
		if q.Token == "" {
			return herr(http.StatusBadRequest, "token required")
		}
		res, joined, err := a.cfg.Store.RedeemShareInvite(r.Context(), q.Token, signPk, guestBoxPk, a.cfg.Now().Unix())
		switch {
		case errors.Is(err, store.ErrNotFound):
			return herr(http.StatusNotFound, "invite not found")
		case errors.Is(err, store.ErrExpired):
			return herr(http.StatusGone, "invite expired or revoked")
		case errors.Is(err, store.ErrRedeemed):
			return herr(http.StatusConflict, "invite already redeemed")
		case err != nil:
			return err
		}
		if joined {
			a.notifyMembers(r, res.SpaceID)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"space_id": res.SpaceID, "role": spaceRoleName(res.Role), "keys": keysJSON(res.Keys),
			"kind": spaceKindName(res.Kind), "epoch": res.Epoch, "meta": B64(res.Meta), "meta_epoch": res.MetaEpoch,
		})
		return nil
	}()
	if err != nil {
		a.fail(w, err)
	}
}

func (a *API) putKeys(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		u, space, body, err := a.spaceRequest(r)
		if err != nil {
			return err
		}
		var q struct {
			Keys []shareKey `json:"keys"`
		}
		if err := decode(body, &q); err != nil {
			return err
		}
		keys, err := parseEpochKeys(q.Keys)
		if err != nil {
			return err
		}
		err = a.cfg.Store.PutMemberKeys(r.Context(), space, u.SignPk, keys)
		switch {
		case errors.Is(err, store.ErrForbidden):
			return herr(http.StatusForbidden, "not a member of this space")
		case errors.Is(err, store.ErrBadKeys):
			return herr(http.StatusBadRequest, "epoch above the space's current epoch")
		case err != nil:
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{})
		return nil
	}()
	if err != nil {
		a.fail(w, err)
	}
}

// memberPath parses {sign_pk} as a 32-byte b64u key.
func memberPath(r *http.Request) ([]byte, error) {
	pk, err := base64.RawURLEncoding.DecodeString(r.PathValue("sign_pk"))
	if err != nil || len(pk) != 32 {
		return nil, herr(http.StatusBadRequest, "sign_pk must be 32 bytes base64url")
	}
	return pk, nil
}

func (a *API) setMemberRole(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		u, space, body, err := a.spaceRequest(r)
		if err != nil {
			return err
		}
		target, err := memberPath(r)
		if err != nil {
			return err
		}
		var q struct {
			Role string `json:"role"`
		}
		if err := decode(body, &q); err != nil {
			return err
		}
		role, ok := parseSpaceRole(q.Role)
		if !ok {
			return herr(http.StatusBadRequest, "role must be \"owner\", \"editor\" or \"viewer\"")
		}
		if err := a.cfg.Store.SetMemberRole(r.Context(), space, u.SignPk, target, role); err != nil {
			return shareErr(err)
		}
		a.notifyMembers(r, space)
		writeJSON(w, http.StatusOK, map[string]any{})
		return nil
	}()
	if err != nil {
		a.fail(w, err)
	}
}

func (a *API) removeMember(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		u, space, _, err := a.spaceRequest(r)
		if err != nil {
			return err
		}
		target, err := memberPath(r)
		if err != nil {
			return err
		}
		if err := a.cfg.Store.RemoveMember(r.Context(), space, u.SignPk, target); err != nil {
			if errors.Is(err, store.ErrForbidden) {
				return herr(http.StatusForbidden, "only an owner can remove other members")
			}
			return shareErr(err)
		}
		if a.cfg.Notify != nil {
			a.cfg.Notify.EvictMember(space, target)
		}
		a.notifyMembers(r, space, target)
		writeJSON(w, http.StatusOK, map[string]any{})
		return nil
	}()
	if err != nil {
		a.fail(w, err)
	}
}

func (a *API) rotate(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		u, space, body, err := a.spaceRequest(r)
		if err != nil {
			return err
		}
		var q struct {
			Epoch *uint32 `json:"epoch"`
			Keys  []struct {
				SignPk  B64 `json:"sign_pk"`
				Wrapped B64 `json:"wrapped"`
			} `json:"keys"`
		}
		if err := decode(body, &q); err != nil {
			return err
		}
		if q.Epoch == nil || len(q.Keys) == 0 {
			return herr(http.StatusBadRequest, "epoch and keys required")
		}
		keys := make([]store.MemberKey, 0, len(q.Keys))
		seen := map[string]bool{}
		for _, k := range q.Keys {
			if len(k.SignPk) != 32 || len(k.Wrapped) == 0 || len(k.Wrapped) > MaxWrappedShareKey {
				return herr(http.StatusBadRequest, "each key needs a 32-byte sign_pk and a wrapped key")
			}
			if seen[string(k.SignPk)] {
				return herr(http.StatusBadRequest, "duplicate sign_pk in keys")
			}
			seen[string(k.SignPk)] = true
			keys = append(keys, store.MemberKey{SignPk: k.SignPk, Wrapped: k.Wrapped})
		}
		err = a.cfg.Store.RotateKey(r.Context(), space, u.SignPk, *q.Epoch, keys)
		switch {
		case errors.Is(err, store.ErrConflict):
			return herr(http.StatusConflict, "epoch must be the current epoch + 1")
		case errors.Is(err, store.ErrBadKeys):
			return herr(http.StatusConflict, "keys must contain exactly one key for every current member")
		case err != nil:
			return shareErr(err)
		}
		a.notifyMembers(r, space)
		writeJSON(w, http.StatusOK, map[string]any{"epoch": *q.Epoch})
		return nil
	}()
	if err != nil {
		a.fail(w, err)
	}
}
