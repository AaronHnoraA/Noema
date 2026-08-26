// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package virtualreference

import (
	"fmt"
	"strings"
	"testing"
)

func TestFindMatchesPortableNodeSemantics(t *testing.T) {
	documents := []Document{
		{ID: "alpha", Title: "Alpha", Aliases: []string{"First"}, File: "/alpha.md", Text: "# Alpha\nAlpha owns itself."},
		{ID: "beta", Title: "Beta", Aliases: []string{"Shared"}, File: "/beta.md", Text: "# Beta"},
		{ID: "gamma", Title: "Gamma", Aliases: []string{"Shared"}, File: "/gamma.md", Text: "# Gamma"},
		{
			ID: "source", Title: "Source", File: "/source.md",
			Text: "---\ntitle: Alpha\n---\nAlpha and First are relevant. Alphabet is not. [[Alpha]] and [First](/alpha.md) are links. `Alpha` is code.\n```\nAlpha\n```\nShared is ambiguous. Alpha again.",
		},
		{ID: "linked", Title: "Linked", File: "/linked.md", Refs: []string{"alpha"}, Text: "Alpha should be excluded."},
	}
	mentions := Find(documents, "alpha", false)
	if len(mentions) != 1 {
		t.Fatalf("mentions = %#v", mentions)
	}
	mention := mentions[0]
	if mention.SourceID != "source" || mention.Count != 3 {
		t.Fatalf("mention = %#v", mention)
	}
	if got := strings.Join(mention.Keywords, ","); got != "Alpha,First" {
		t.Fatalf("keywords = %q", got)
	}
	if strings.Contains(mention.Snippet, "title: Alpha") || !strings.Contains(mention.Snippet, "Alpha and First") {
		t.Fatalf("snippet = %q", mention.Snippet)
	}
	if got := Find(documents, "beta", false); len(got) != 0 {
		t.Fatalf("ambiguous/linked beta mentions = %#v", got)
	}
}

func TestFindHonorsCaseAndUnicodeWordBoundaries(t *testing.T) {
	documents := []Document{
		{ID: "target", Title: "Café", File: "/target.md"},
		{ID: "source", Title: "Source", File: "/source.md", Text: "café CAFÉ cafés uncafé"},
	}
	if got := Find(documents, "target", false); len(got) != 1 || got[0].Count != 2 {
		t.Fatalf("case-insensitive NFC mentions = %#v", got)
	}
	if got := Find(documents, "target", true); len(got) != 0 {
		t.Fatalf("case-sensitive mentions = %#v", got)
	}
}

func BenchmarkFindTarget(b *testing.B) {
	documents := make([]Document, 500)
	for index := range documents {
		documents[index] = Document{
			ID: fmt.Sprintf("note-%03d", index), Title: fmt.Sprintf("Reference %03d", index),
			Aliases: []string{fmt.Sprintf("Alias %03d", index)}, File: fmt.Sprintf("/note-%03d.md", index),
			Text: strings.Repeat("ordinary prose around Reference 000 and Alias 000. ", 32),
		}
	}
	b.ReportAllocs()
	for range b.N {
		if mentions := Find(documents, "note-000", false); len(mentions) != 499 {
			b.Fatalf("mentions = %d", len(mentions))
		}
	}
}
