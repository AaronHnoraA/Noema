// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package filesys

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/88250/lute/ast"
	"github.com/aaronhe/noema/kernel/util"
)

// blockSpanCorpus is deliberately adversarial: every entry either exercises a
// construct whose extent a line scan could get wrong, or is ordinary prose that
// must split cleanly. The contract is the same for all of them — either the
// split matches Lute exactly, or the scanner declines.
var blockSpanCorpus = map[string]string{
	"prose":                       "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n",
	"no trailing eol":             "# Title\n\nParagraph without a final newline.",
	"leading blanks":              "\n\n# Title\n\nBody.\n",
	"many blank lines":            "One.\n\n\n\n\nTwo.\n",
	"crlf":                        "# Title\r\n\r\nBody line.\r\n",
	"setext":                      "Title\n=====\n\nBody.\n\nSub\n---\n\nMore.\n",
	"fenced code":                 "Intro.\n\n```go\nfunc main() {\n\n\tprintln(\"blank line inside\")\n}\n```\n\nAfter.\n",
	"tilde fence":                 "Intro.\n\n~~~\nplain\n\nfenced\n~~~\n\nAfter.\n",
	"fence with backticks inside": "A.\n\n````\n```\nnested\n```\n````\n\nB.\n",
	"math block":                  "Before.\n\n$$\n\\int_0^1 x^2\n\ndx\n$$\n\nAfter.\n",
	"inline math only":            "Text with $x^2$ inline.\n\nNext.\n",
	"tight list":                  "- one\n- two\n- three\n\nAfter.\n",
	"loose list":                  "- one\n\n- two\n\n- three\n\nAfter.\n",
	"ordered list":                "1. one\n2. two\n\nAfter.\n",
	"nested list":                 "- one\n  - nested\n  - nested two\n- two\n\nAfter.\n",
	"list then paragraph":         "- one\n- two\n\nParagraph after the list.\n",
	"blockquote":                  "> quoted\n> more\n\nAfter.\n",
	"loose blockquote":            "> quoted\n\n> still quoted\n\nAfter.\n",
	"heading run":                 "# One\n## Two\n### Three\n\nBody.\n",
	"table":                       "| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.\n",
	"thematic break":              "Above.\n\n---\n\nBelow.\n",
	"html block":                  "<div>\n  <p>hi</p>\n</div>\n\nAfter.\n",
	"org env":                     "#+begin meta\nid: 0198fc34-7b32-7a11-8cb4-6c40e3b33d81\n\ntitle: x\n#+end meta\n\nBody.\n",
	"org env then list":           "#+begin proof\nstep\n#+end proof\n\n- a\n- b\n",
	"indented code":               "Text.\n\n    indented code\n\n    still code\n\nAfter.\n",
	"link reference definition":   "[ref]: https://example.com\n\nUse [ref].\n",
	"footnote":                    "Body with a note[^1].\n\n[^1]: The note.\n",
	"legacy ial":                  "# Title\n{: id=\"20200101000000-abcdefg\"}\n\nBody.\n",
	"empty":                       "",
	"only blanks":                 "\n\n\n",
	"cjk prose":                   "# 标题\n\n第一段中文正文。\n\n第二段中文正文。\n",
	"task list":                   "- [ ] todo\n- [x] done\n\nAfter.\n",
	"noema command":               "@@cell python\n\nAfter.\n",
}

// TestBlockSpansMatchLuteTopLevel is the invariant the incremental parse rests
// on. A span is used to decide whether a block changed and, when it did, as the
// source handed to Lute on its own — so a split that does not line up exactly
// with Lute's own top-level blocks would index the wrong text.
func TestBlockSpansMatchLuteTopLevel(t *testing.T) {
	luteEngine := util.NewLute()
	for name, source := range blockSpanCorpus {
		t.Run(name, func(t *testing.T) {
			spans, ok := SplitTopLevelMarkdownBlocks([]byte(source))
			if !ok {
				return // declining is always allowed
			}

			tree := LoadMarkdownTreeByData([]byte(source), "box", "/doc.md", luteEngine)
			var want []string
			for n := tree.Root.FirstChild; nil != n; n = n.Next {
				if !n.IsBlock() || ast.NodeKramdownBlockIAL == n.Type {
					continue
				}
				want = append(want, strings.TrimSpace(n.Content()))
			}

			if len(spans) != len(want) {
				var got []string
				for _, span := range spans {
					got = append(got, strings.TrimSpace(source[span.From:span.To]))
				}
				t.Fatalf("span count = %d, Lute top-level blocks = %d\n spans: %q\n lute:  %q",
					len(spans), len(want), got, want)
			}

			// Each span, parsed alone, must produce the same single block Lute
			// produced for it in the whole document.
			for index, span := range spans {
				if span.From < 0 || span.To > len(source) || span.From >= span.To {
					t.Fatalf("span %d is out of range: %+v (len %d)", index, span, len(source))
				}
				alone := LoadMarkdownTreeByData([]byte(source[span.From:span.To]), "box", "/doc.md", luteEngine)
				var produced []string
				for n := alone.Root.FirstChild; nil != n; n = n.Next {
					if !n.IsBlock() || ast.NodeKramdownBlockIAL == n.Type {
						continue
					}
					produced = append(produced, strings.TrimSpace(n.Content()))
				}
				if 1 != len(produced) {
					t.Fatalf("span %d (%q) parsed alone yields %d blocks, want 1: %q",
						index, source[span.From:span.To], len(produced), produced)
				}
				if produced[0] != want[index] {
					t.Fatalf("span %d parsed alone = %q, in document = %q",
						index, produced[0], want[index])
				}
			}
		})
	}
}

// TestBlockSpansCoverEveryNonBlankByte guards against a scan that silently
// drops content: everything outside a span must be blank.
func TestBlockSpansCoverEveryNonBlankByte(t *testing.T) {
	for name, source := range blockSpanCorpus {
		t.Run(name, func(t *testing.T) {
			spans, ok := SplitTopLevelMarkdownBlocks([]byte(source))
			if !ok {
				return
			}
			covered := make([]bool, len(source))
			previousEnd := 0
			for index, span := range spans {
				if span.From < previousEnd {
					t.Fatalf("span %d overlaps the previous one: %+v after %d", index, span, previousEnd)
				}
				for offset := span.From; offset < span.To; offset++ {
					covered[offset] = true
				}
				previousEnd = span.To
			}
			for offset, isCovered := range covered {
				if isCovered {
					continue
				}
				if char := source[offset]; ' ' != char && '\t' != char && '\n' != char && '\r' != char {
					t.Fatalf("byte %d (%q) is outside every span", offset, string(char))
				}
			}
		})
	}
}

// TestBlockSpansDeclineRatherThanGuess documents which corpus entries the
// scanner refuses, so a future change that starts accepting one of them has to
// say so deliberately — and prove it against the equivalence test above.
func TestBlockSpansDeclineRatherThanGuess(t *testing.T) {
	mustDecline := []string{
		"link reference definition", "footnote", "legacy ial", "indented code", "html block",
	}
	for _, name := range mustDecline {
		if _, ok := SplitTopLevelMarkdownBlocks([]byte(blockSpanCorpus[name])); ok {
			t.Errorf("%q was split; it is not safe to split one block at a time", name)
		}
	}
}

// TestBlockSpansMatchLuteOnRealDocuments runs the same equivalence check over
// the repository's own Markdown, which is far more varied than a hand-written
// corpus: long prose, nested lists, tables, fenced code in several languages,
// math, and Noema's own org-style blocks.
func TestBlockSpansMatchLuteOnRealDocuments(t *testing.T) {
	roots := []string{"../../docs", "../../agents", "../.."}
	var files []string
	for _, root := range roots {
		_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if nil != err {
				return nil
			}
			if entry.IsDir() {
				if strings.HasPrefix(entry.Name(), ".") || "node_modules" == entry.Name() {
					return filepath.SkipDir
				}
				return nil
			}
			if strings.HasSuffix(entry.Name(), ".md") {
				files = append(files, path)
			}
			return nil
		})
	}
	if 5 > len(files) {
		t.Skipf("expected a Markdown corpus on disk, found %d files", len(files))
	}

	luteEngine := util.NewLute()
	split, declined := 0, 0
	for _, file := range files {
		source, err := os.ReadFile(file)
		if nil != err {
			continue
		}
		spans, ok := SplitTopLevelMarkdownBlocks(source)
		if !ok {
			declined++
			continue
		}
		split++

		tree := LoadMarkdownTreeByData(source, "box", "/doc.md", luteEngine)
		var want []string
		for n := tree.Root.FirstChild; nil != n; n = n.Next {
			if !n.IsBlock() || ast.NodeKramdownBlockIAL == n.Type {
				continue
			}
			want = append(want, strings.TrimSpace(n.Content()))
		}
		if len(spans) != len(want) {
			t.Fatalf("%s: span count = %d, Lute top-level blocks = %d", file, len(spans), len(want))
		}
		for index, span := range spans {
			alone := LoadMarkdownTreeByData(source[span.From:span.To], "box", "/doc.md", luteEngine)
			var produced []string
			for n := alone.Root.FirstChild; nil != n; n = n.Next {
				if !n.IsBlock() || ast.NodeKramdownBlockIAL == n.Type {
					continue
				}
				produced = append(produced, strings.TrimSpace(n.Content()))
			}
			if 1 != len(produced) || produced[0] != want[index] {
				t.Fatalf("%s: span %d (%q) parsed alone = %q, in document = %q",
					file, index, source[span.From:span.To], produced, want[index])
			}
		}
	}
	t.Logf("%d documents split, %d declined", split, declined)
	if 0 == split {
		t.Fatal("no real document could be split; the scanner is too conservative to be useful")
	}
}
