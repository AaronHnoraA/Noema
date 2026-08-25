// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package markdown

import (
	"strings"
	"testing"
)

func stringPointer(value string) *string { return &value }

func TestPatchBlockPropertyPreservesAnchorAndUsesUTF16Offsets(t *testing.T) {
	source := "😀 prefix\nClaim {#" + blockIDOne + " status=draft owner='Aaron He'}\n"
	patch, err := PatchBlockProperty(source, "#"+blockIDOne, "owner", stringPointer("Noema Team"))
	if nil != err {
		t.Fatal(err)
	}
	want := "😀 prefix\nClaim {#" + blockIDOne + " status=draft owner='Noema Team'}\n"
	if patch.Markdown != want || patch.From != 16 || patch.Definition.Properties["owner"] != "Noema Team" {
		t.Fatalf("unexpected replacement: %+v\n%s", patch, patch.Markdown)
	}
	added, err := PatchBlockProperty(patch.Markdown, blockIDOne, "score", stringPointer("7"))
	if nil != err || !strings.Contains(added.Markdown, "owner='Noema Team' score=7}") {
		t.Fatalf("unexpected insert: %+v, %v", added, err)
	}
	removed, err := PatchBlockProperty(added.Markdown, blockIDOne, "status", nil)
	if nil != err || strings.Contains(removed.Markdown, "status=") || !strings.Contains(removed.Markdown, "owner='Noema Team'") {
		t.Fatalf("unexpected delete: %+v, %v", removed, err)
	}
}

func TestPatchBlockPropertyFailsClosedForAmbiguousIdentity(t *testing.T) {
	source := "One {#" + blockIDOne + " status=open}\nTwo {#" + blockIDOne + " status=done}\n"
	if _, err := PatchBlockProperty(source, blockIDOne, "status", stringPointer("draft")); nil == err || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("expected ambiguous identity rejection, got %v", err)
	}
}
