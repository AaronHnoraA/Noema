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

// referenceMarkdownDocumentIdentity is the original line-slice implementation,
// kept as the oracle for the streaming rewrite that replaced it.
func referenceMarkdownDocumentIdentity(markdown []byte) string {
	lines := strings.Split(strings.ReplaceAll(string(markdown), "\r\n", "\n"), "\n")
	metaStart := -1
	for i, line := range lines {
		if 12 <= i {
			break
		}
		if markdownMetaBeginPattern.MatchString(line) {
			metaStart = i
			break
		}
	}
	if 0 <= metaStart {
		candidate := ""
		summaryDepth := 0
		for _, line := range lines[metaStart+1:] {
			if markdownSummaryBeginPattern.MatchString(line) {
				summaryDepth++
				continue
			}
			if 0 < summaryDepth {
				if markdownSummaryEndPattern.MatchString(line) {
					summaryDepth--
				}
				continue
			}
			if markdownMetaEndPattern.MatchString(line) {
				return candidate
			}
			if match := markdownMetaIDPattern.FindStringSubmatch(line); nil != match {
				candidate = strings.Trim(strings.TrimSpace(match[1]), `"'`)
			}
		}
	}
	if match := legacyDocIALIDPattern.FindSubmatch(markdown); nil != match {
		return string(match[1])
	}
	return ""
}

func TestMarkdownDocumentIdentityMatchesReference(t *testing.T) {
	const canonical = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68"
	const legacy = "20260825095344-8w75nfv"
	for name, source := range map[string]string{
		"empty":                     "",
		"no trailing newline":       "# Note",
		"plain note":                "# Note\n\nBody.\n",
		"meta with id":              "#+begin meta\nid: " + canonical + "\n#+end meta\n\n# Note\n",
		"meta without id":           "#+begin meta\ntitle: Noema\n#+end meta\n\n# Note\n",
		"meta after preface":        "preface\n\n#+begin meta\nid: " + canonical + "\n#+end meta\n",
		"meta at line 11":           strings.Repeat("x\n", 11) + "#+begin meta\nid: " + canonical + "\n#+end meta\n",
		"meta at line 12":           strings.Repeat("x\n", 12) + "#+begin meta\nid: " + canonical + "\n#+end meta\n",
		"unterminated meta":         "#+begin meta\nid: " + canonical + "\n\n# Note\n",
		"unterminated meta legacy":  "#+begin meta\nid: " + canonical + "\n\n{: id=\"" + legacy + "\" type=\"doc\"}\n",
		"last id wins":              "#+begin meta\nid: aaaa\nid: " + canonical + "\n#+end meta\n",
		"nested summary":            "#+begin meta\nid: " + canonical + "\n#+begin summary\nid: nope\n#+begin summary\nid: nope2\n#+end summary\n#+end summary\n#+end meta\n",
		"quoted id":                 "#+begin meta\nid: '" + canonical + "'\n#+end meta\n",
		"crlf meta":                 "#+begin meta\r\nid: " + canonical + "\r\n#+end meta\r\n",
		"crlf legacy":               "# Legacy\r\n\r\n{: id=\"" + legacy + "\" type=\"doc\"}\r\n",
		"legacy only":               "# Legacy\n\n{: id=\"" + legacy + "\" type=\"doc\"}\n",
		"legacy unquoted type":      "# Legacy\n\n{: id=\"" + legacy + "\" type=doc}\n",
		"legacy without doc type":   "# Legacy\n\n{: id=\"" + legacy + "\" type=\"p\"}\n",
		"brace but no legacy ial":   "# Note\n\n{: not-an-ial}\n",
		"meta then legacy":          "#+begin meta\nid: " + canonical + "\n#+end meta\n\n{: id=\"" + legacy + "\" type=\"doc\"}\n",
		"uppercase meta markers":    "#+BEGIN META\nID: " + canonical + "\n#+END META\n",
		"indented meta markers":     "  #+begin meta\n  id: " + canonical + "\n  #+end meta\n",
		"blank document body":       "\n\n\n",
		"meta opener with trailing": "#+begin meta extra words\nid: " + canonical + "\n#+end meta\n",
	} {
		want := referenceMarkdownDocumentIdentity([]byte(source))
		if got := MarkdownDocumentIdentity([]byte(source)); got != want {
			t.Fatalf("%s: got %q want %q for source %q", name, got, want, source)
		}
	}
}
