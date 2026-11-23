package sigs

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type vectors struct {
	SignPkHex string `json:"sign_pk_hex"`
	BoxPkHex  string `json:"box_pk_hex"`
	Cases     []struct {
		Name     string `json:"name"`
		InputHex string `json:"input_hex"`
		SigHex   string `json:"sig_hex"`
	} `json:"cases"`
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// TestGoldenVectors rebuilds each case from the same logical inputs used by
// plugin/scripts/gen-vectors.ts and verifies the libsodium signature with crypto/ed25519.
func TestGoldenVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "proto", "vectors", "sig-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	signPk := mustHex(t, v.SignPkHex)
	boxPk := mustHex(t, v.BoxPkHex)
	nonce := bytes.Repeat([]byte{7}, 32)
	payload := []byte{1, 2, 3, 4, 5}
	body := []byte(`{"role":"member"}`)
	const space = "AAAAAAAAAAAAAAAAAAAAAA"

	build := map[string][]byte{
		"auth":      Auth("srv_test", nonce, signPk, "dev-1"),
		"http":      HTTP("POST", "/api/invites", 1764000000, body),
		"redeem":    Redeem("srv_test", "tok123", signPk, boxPk),
		"update":    Update(space, "index", 3, payload),
		"snapshot":  Snapshot(space, "index", 42, 3, payload),
		"ad-update": Input("ad-update", space, "index", U32(3)),
		"u64-max":   Input("x", U64(0xffffffffffffffff)),
	}
	if len(v.Cases) != len(build) {
		t.Fatalf("vector file has %d cases, test knows %d", len(v.Cases), len(build))
	}
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			got, ok := build[c.Name]
			if !ok {
				t.Fatalf("unknown case %q", c.Name)
			}
			want := mustHex(t, c.InputHex)
			if !bytes.Equal(got, want) {
				t.Fatalf("input mismatch\n got  %x\n want %x", got, want)
			}
			sig := mustHex(t, c.SigHex)
			if !Verify(signPk, got, sig) {
				t.Fatal("signature does not verify")
			}
			bad := append([]byte{}, got...)
			bad[len(bad)-1] ^= 1
			if Verify(signPk, bad, sig) {
				t.Fatal("tampered input verified")
			}
		})
	}
}

func TestVerifyMalformed(t *testing.T) {
	if Verify([]byte{1, 2}, []byte("x"), make([]byte, 64)) {
		t.Fatal("short pk verified")
	}
	if Verify(make([]byte, 32), []byte("x"), []byte{1}) {
		t.Fatal("short sig verified")
	}
}
