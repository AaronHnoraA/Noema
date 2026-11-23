// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package identity

import (
	"strings"
	"testing"
)

const uuid = "0192f3a4-5b6c-7d8e-9f01-23456789abcd"

// The same ids shared/block-identity.mjs isBlockReferenceId accepts.
func TestReferenceIDShapesMatchTheSharedParser(t *testing.T) {
	cases := []struct {
		value          string
		uuidV7, legacy bool
	}{
		{uuid, true, false},
		{strings.ToUpper(uuid), true, false},
		{"  " + uuid + " ", true, false},
		{"0192f3a4-5b6c-4d8e-9f01-23456789abcd", false, false}, // version 4
		{"20240101120000-abcdefg", false, true},
		{"20240101120000-ABCDEFG", false, false},
		{"fig:setup", false, false},
	}
	for _, c := range cases {
		if got := IsUUIDv7(c.value); got != c.uuidV7 {
			t.Errorf("IsUUIDv7(%q) = %v, want %v", c.value, got, c.uuidV7)
		}
		if got := IsLegacyNodeID(c.value); got != c.legacy {
			t.Errorf("IsLegacyNodeID(%q) = %v, want %v", c.value, got, c.legacy)
		}
	}
}

func TestProjectionIDIsStableAndLegacyShaped(t *testing.T) {
	first := ProjectionID(uuid, "")
	if first != ProjectionID(uuid, "") || first != projectionID(uuid, "") {
		t.Fatalf("projection is not stable: %q", first)
	}
	if !IsLegacyNodeID(first) {
		t.Fatalf("projection %q is not a legacy node id", first)
	}
	// A UUIDv7 projects to the time it was minted (its first 48 bits, ms).
	if !strings.HasPrefix(first, "2024") {
		t.Fatalf("projection %q does not carry the UUID's timestamp", first)
	}
	legacy := "20240101120000-abcdefg"
	if got := ProjectionID(legacy, ""); !strings.HasPrefix(got, "20240101120000-") {
		t.Fatalf("legacy id lost its stamp: %q", got)
	}
	if ProjectionID("", "seed-a") == ProjectionID("", "seed-b") {
		t.Fatal("fallback seeds collide")
	}
	if got := ProjectionID("label", ""); !strings.HasPrefix(got, "20000101000000-") {
		t.Fatalf("an unshaped id should use the epoch stamp: %q", got)
	}
}

func TestBlockProjectionIDIsStableAndLegacyShaped(t *testing.T) {
	a := BlockProjectionID("note.md#3")
	if a != BlockProjectionID("note.md#3") {
		t.Fatal("block projection is not stable")
	}
	if a == BlockProjectionID("note.md#4") {
		t.Fatal("different seeds give one projection")
	}
	for _, seed := range []string{"", "x", "a much longer seed with spaces"} {
		if got := BlockProjectionID(seed); !IsLegacyNodeID(got) {
			t.Fatalf("BlockProjectionID(%q) = %q is not legacy-shaped", seed, got)
		}
	}
}
