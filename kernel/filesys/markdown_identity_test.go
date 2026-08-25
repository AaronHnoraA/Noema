// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema markdown-box identity projection additions are Copyright (c) 2026
// Aaron He and distributed under the same AGPL-3.0-or-later terms.

package filesys

import (
	"strings"
	"testing"

	"github.com/88250/lute/ast"
)

func TestMarkdownDocumentIdentityUsesCompletedLeadingMeta(t *testing.T) {
	const canonical = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68"
	source := []byte("preface\n#+begin meta\ntitle: Noema\nid: \"" + canonical + "\"\n#+end meta\n\n# Note\n")
	if got := MarkdownDocumentIdentity(source); canonical != got {
		t.Fatalf("canonical identity mismatch: got %q want %q", got, canonical)
	}
}

func TestMarkdownDocumentIdentityIgnoresSummaryFieldsAndIncompleteMeta(t *testing.T) {
	const canonical = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68"
	source := []byte("#+begin meta\n" +
		"id: " + canonical + "\n" +
		"#+begin summary\n" +
		"id: not-the-page-id\n" +
		"#+end summary\n" +
		"#+end meta\n")
	if got := MarkdownDocumentIdentity(source); canonical != got {
		t.Fatalf("summary prose replaced canonical identity: got %q", got)
	}

	incomplete := []byte("#+begin meta\nid: " + canonical + "\n")
	if got := MarkdownDocumentIdentity(incomplete); "" != got {
		t.Fatalf("incomplete meta block must not establish identity, got %q", got)
	}
}

func TestMarkdownDocumentIdentityHonorsPreambleBoundaryAndLegacyFallback(t *testing.T) {
	const canonical = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68"
	late := []byte(strings.Repeat("preamble\n", 12) + "#+begin meta\nid: " + canonical + "\n#+end meta\n")
	if got := MarkdownDocumentIdentity(late); "" != got {
		t.Fatalf("meta opener after the first 12 lines must be ignored, got %q", got)
	}

	const legacy = "20260825095344-8w75nfv"
	legacySource := []byte("# Legacy\n\n{: id=\"" + legacy + "\" type=\"doc\"}\n")
	if got := MarkdownDocumentIdentity(legacySource); legacy != got {
		t.Fatalf("legacy document IAL fallback mismatch: got %q want %q", got, legacy)
	}
}

func TestMarkdownProjectionIDIsDeterministicAndDisposable(t *testing.T) {
	const canonical = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68"
	withMeta := []byte("#+begin meta\nid: " + canonical + "\n#+end meta\n")
	first := MarkdownProjectionID(withMeta, "box-a", "/notes/a.md")
	second := MarkdownProjectionID(withMeta, "box-b", "/moved/b.md")
	if first != second {
		t.Fatalf("canonical projection must survive path/box changes: first=%s second=%s", first, second)
	}
	if !ast.IsNodeIDPattern(first) {
		t.Fatalf("projection is not a valid internal node key: %s", first)
	}
	if strings.Contains(string(withMeta), first) {
		t.Fatalf("projection must not be serialized into Markdown: %s", first)
	}

	provisional := MarkdownProjectionID([]byte("# Untitled\n"), "box-a", "/notes/a.md")
	provisionalAgain := MarkdownProjectionID([]byte("changed body\n"), "box-a", "\\notes\\a.md")
	if provisional != provisionalAgain {
		t.Fatalf("provisional projection must depend on normalized box/path, not content: first=%s second=%s", provisional, provisionalAgain)
	}
	if provisional == MarkdownProjectionID(nil, "box-a", "/notes/b.md") {
		t.Fatal("different provisional paths must not share an internal projection")
	}
}
