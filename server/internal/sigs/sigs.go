// Package sigs implements the canonical sigInput construction from docs/protocol.md and
// Ed25519 verification helpers. Fields are length-prefixed (u32 big-endian) byte strings.
package sigs

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
)

// Input builds sigInput(purpose, fields…) =
// "tezca/v1/" ‖ purpose ‖ 0x00 ‖ for each field: u32be(len(f)) ‖ f.
// Fields may be []byte or string (UTF-8).
func Input(purpose string, fields ...any) []byte {
	n := len("tezca/v1/") + len(purpose) + 1
	bs := make([][]byte, len(fields))
	for i, f := range fields {
		switch v := f.(type) {
		case []byte:
			bs[i] = v
		case string:
			bs[i] = []byte(v)
		default:
			panic("sigs.Input: field must be []byte or string")
		}
		n += 4 + len(bs[i])
	}
	out := make([]byte, 0, n)
	out = append(out, "tezca/v1/"...)
	out = append(out, purpose...)
	out = append(out, 0)
	for _, b := range bs {
		out = binary.BigEndian.AppendUint32(out, uint32(len(b)))
		out = append(out, b...)
	}
	return out
}

// U32 encodes x as 4 bytes big-endian.
func U32(x uint32) []byte { return binary.BigEndian.AppendUint32(nil, x) }

// U64 encodes x as 8 bytes big-endian.
func U64(x uint64) []byte { return binary.BigEndian.AppendUint64(nil, x) }

// Auth is the message signed in the WebSocket Auth frame.
func Auth(serverID string, nonce, signPk []byte, deviceID string) []byte {
	return Input("auth", serverID, nonce, signPk, deviceID)
}

// HTTP is the message signed in the HTTP Authorization header.
func HTTP(method, pathWithQuery string, ts uint64, body []byte) []byte {
	h := sha256.Sum256(body)
	return Input("http", method, pathWithQuery, U64(ts), h[:])
}

// Redeem is the message signed for /api/claim and /api/redeem (token = claim code or invite token).
func Redeem(serverID, token string, signPk, boxPk []byte) []byte {
	return Input("redeem", serverID, token, signPk, boxPk)
}

// Update is the message signed in PushUpdate.sig / Update.sig.
func Update(spaceID, docID string, epoch uint32, payload []byte) []byte {
	return Input("update", spaceID, docID, U32(epoch), payload)
}

// Snapshot is the message signed in PutSnapshot.sig.
func Snapshot(spaceID, docID string, baseSeq uint64, epoch uint32, payload []byte) []byte {
	return Input("snapshot", spaceID, docID, U64(baseSeq), U32(epoch), payload)
}

// Verify reports whether sig is a valid Ed25519 signature of msg under pk.
// It never panics on malformed keys or signatures.
func Verify(pk, msg, sig []byte) bool {
	if len(pk) != ed25519.PublicKeySize || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(pk), msg, sig)
}
