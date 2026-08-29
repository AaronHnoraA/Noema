// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package model

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	noemamarkdown "github.com/aaronhe/noema/kernel/noema/markdown"
)

// wholeDocumentNoteSummary is the unwindowed reference: exactly what
// markdownNoteSummary used to do, kept here so the optimisation can be held to
// producing byte-identical output.
func wholeDocumentNoteSummary(source string, meta map[string]noteMetaValue, metaFrom, metaTo int) string {
	if value := noteMetaScalar(meta, "summary"); value != "" {
		return value
	}
	if metaTo > metaFrom {
		source = source[:metaFrom] + source[metaTo:]
	}
	return truncateRunes(noteSummaryPipeline(source), noteSummaryRunes)
}

func noteSummaryFixtures(t *testing.T) map[string]string {
	t.Helper()
	fixtures := map[string]string{
		"empty":                "",
		"short":                "# Title\n\nA short note.\n",
		"exactly at the limit": "# T\n\n" + strings.Repeat("a", noteSummaryRunes) + "\n",
		"just over the limit":  "# T\n\n" + strings.Repeat("a", noteSummaryRunes+1) + "\n",
		// A long run of stripped-only content: the window has to keep growing
		// before it yields enough output to trust.
		"headings only":     strings.Repeat("# Heading\n\n", 4000) + "Tail sentence that finally has prose.\n",
		"blank lines only":  strings.Repeat("\n", 20000) + "Prose after a lot of nothing.\n",
		"punctuation only":  strings.Repeat("#*_`$()[]{}\n", 4000) + "Prose at the very end.\n",
		"typ metadata":      "#metadata((title: \"x\"))\n" + strings.Repeat("filler line\n", 4000) + "<note>\nBody prose.\n",
		"typ directives":    strings.Repeat("#import \"a.typ\"\n", 4000) + "Body prose.\n",
		"note calls":        strings.Repeat("#note(\"key\")[shown text]\n", 2000),
		"crlf":              strings.Repeat("Line of prose.\r\n", 2000),
		"cjk":               strings.Repeat("这是一段中文正文，用来测试摘要窗口。\n\n", 2000),
		"no trailing eol":   strings.Repeat("prose ", 5000) + "end",
		"one huge line":     strings.Repeat("word ", 20000),
		"heading then long": "# Title\n\n" + strings.Repeat("body ", 20000),
	}
	// Real documents, which mix all of the above.
	_ = filepath.WalkDir("../..", func(path string, entry fs.DirEntry, err error) error {
		if nil != err {
			return nil
		}
		if entry.IsDir() {
			if strings.HasPrefix(entry.Name(), ".") || "node_modules" == entry.Name() {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(entry.Name(), ".md") {
			return nil
		}
		if source, readErr := os.ReadFile(path); nil == readErr {
			fixtures["real:"+path] = string(source)
		}
		return nil
	})
	return fixtures
}

// TestWindowedNoteSummaryMatchesWholeDocument is the contract for reading only
// a prefix of a note: the summary must be byte-identical to the one the
// unwindowed pipeline produces, for every shape of document.
func TestWindowedNoteSummaryMatchesWholeDocument(t *testing.T) {
	for name, source := range noteSummaryFixtures(t) {
		t.Run(name, func(t *testing.T) {
			meta := map[string]noteMetaValue{}
			want := wholeDocumentNoteSummary(source, meta, 0, 0)
			got := markdownNoteSummary(source, meta, 0, 0)
			if got != want {
				t.Fatalf("windowed summary differs\n windowed: %q\n whole:    %q", got, want)
			}
		})
	}
}

// TestWindowedNoteSummaryMatchesWithMetaSplice covers the other entry shape:
// the front-matter range is spliced out before the pipeline runs.
func TestWindowedNoteSummaryMatchesWithMetaSplice(t *testing.T) {
	meta := "#+begin meta\ntitle: Spliced\n#+end meta\n"
	body := strings.Repeat("Prose paragraph that carries the summary.\n\n", 3000)
	source := meta + body
	metaFrom, metaTo := 0, len(meta)

	want := wholeDocumentNoteSummary(source, map[string]noteMetaValue{}, metaFrom, metaTo)
	got := markdownNoteSummary(source, map[string]noteMetaValue{}, metaFrom, metaTo)
	if got != want {
		t.Fatalf("windowed summary differs after a meta splice\n windowed: %q\n whole:    %q", got, want)
	}
}

// BenchmarkMarkdownNoteSummary is the number this windowing exists to move. It
// runs on the save response path, so it is latency as well as power.
func BenchmarkMarkdownNoteSummary(b *testing.B) {
	for _, size := range []int{1, 16, 128} {
		var source strings.Builder
		source.WriteString("# Benchmark note\n\n")
		for i := 0; i < size*8; i++ {
			fmt.Fprintf(&source, "## Section %d\n\nProse paragraph %d with enough words to matter.\n\n", i, i)
		}
		text := source.String()
		meta := map[string]noteMetaValue{}
		b.Run(fmt.Sprintf("bytes=%d/windowed", len(text)), func(b *testing.B) {
			b.SetBytes(int64(len(text)))
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				markdownNoteSummary(text, meta, 0, 0)
			}
		})
		b.Run(fmt.Sprintf("bytes=%d/whole-document", len(text)), func(b *testing.B) {
			b.SetBytes(int64(len(text)))
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				wholeDocumentNoteSummary(text, meta, 0, 0)
			}
		})
	}
}

// BenchmarkMarkdownNoteProjection measures the whole per-save note projection,
// which runs synchronously inside the save response via updateMarkdownCatalogPath.
func BenchmarkMarkdownNoteProjection(b *testing.B) {
	for _, sections := range []int{16, 128} {
		source := []byte(benchMarkdownDoc(sections))
		b.Run(fmt.Sprintf("bytes=%d/whole-projection", len(source)), func(b *testing.B) {
			b.SetBytes(int64(len(source)))
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				snapshot := newMarkdownSnapshot(source, nil)
				_ = snapshot.noteSummary("box", "/notes/bench.md")
			}
		})
		text := string(source)
		meta := map[string]noteMetaValue{}
		b.Run(fmt.Sprintf("bytes=%d/refs-only", len(source)), func(b *testing.B) {
			b.SetBytes(int64(len(source)))
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				markdownNoteRefs(text, meta)
			}
		})
		lines := markdownNoteLines(text)
		b.Run(fmt.Sprintf("bytes=%d/inline-tags-only", len(source)), func(b *testing.B) {
			b.SetBytes(int64(len(source)))
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				markdownNoteInlineTags(lines, 0, 0)
			}
		})
	}
}

// TestContainsFoldASCII covers the guard that decides whether the ref regexp
// runs at all: a false negative would silently drop a note's references.
func TestContainsFoldASCII(t *testing.T) {
	cases := []struct {
		source, needle string
		want           bool
	}{
		{"", "roam:", false},
		{"roam:", "roam:", true},
		{"ROAM:", "roam:", true},
		{"RoAm:", "roam:", true},
		{"see roam://note at the end", "roam:", true},
		{"prefix #NOTE(\"x\")", "#note(", true},
		{"nothing here", "roam:", false},
		{"roa", "roam:", false},
		{"roamroam:", "roam:", true},
		{"---roam", "roam:", false},
		{"x", "", true},
		{"short", "much longer needle", false},
		{"你好 ROAM://x", "roam:", true},
	}
	for _, testCase := range cases {
		if got := containsFoldASCII(testCase.source, testCase.needle); got != testCase.want {
			t.Errorf("containsFoldASCII(%q, %q) = %v, want %v",
				testCase.source, testCase.needle, got, testCase.want)
		}
	}
}

// TestGuardedNoteRefsMatchUnguarded proves the short-circuit changes nothing:
// for every document that does contain a reference token, in any case, the
// guarded path must return exactly what the regexp would have.
func TestGuardedNoteRefsMatchUnguarded(t *testing.T) {
	unguarded := func(source string, meta map[string]noteMetaValue) []string {
		// The same body as markdownNoteRefs with the guard forced open.
		return markdownNoteRefs("roam:\x00"+source, meta)
	}
	documents := map[string]string{
		"roam link":        "See roam://target-note here.\n",
		"uppercase roam":   "See ROAM://Target-Note here.\n",
		"mixed case roam":  "See RoAm://target here.\n",
		"note call":        "#note(\"key-one\")[shown]\n",
		"uppercase call":   "#NOTE(\"key-two\")[shown]\n",
		"wikilink":         "A [[target page]] link.\n",
		"wikilink piped":   "A [[target page|shown]] link.\n",
		"wikilink roam":    "A [[roam://target]] link.\n",
		"markdown href":    "A [text](./other-note.md) link.\n",
		"escaped wikilink": "A \\[[not a link]] here.\n",
		"none":             "Plain prose with no references at all.\n",
		"mixed":            "roam://one and [[two]] and #note(\"three\")[x] and [f](./four.md)\n",
		"long none":        strings.Repeat("plain prose line\n", 3000),
		"long with roam":   strings.Repeat("plain prose line\n", 3000) + "roam://late-reference\n",
	}
	for name, source := range documents {
		t.Run(name, func(t *testing.T) {
			meta := map[string]noteMetaValue{}
			want := unguarded(source, meta)
			got := markdownNoteRefs(source, meta)
			// The forced-open variant sees one extra sentinel prefix, so compare
			// the references that came from the document itself.
			filtered := want[:0:0]
			for _, ref := range want {
				if "" != ref {
					filtered = append(filtered, ref)
				}
			}
			if strings.Join(got, "\x00") != strings.Join(filtered, "\x00") {
				t.Fatalf("guarded refs differ\n guarded:   %q\n unguarded: %q", got, filtered)
			}
		})
	}
}

// unguardedInlineTags and unguardedNoteBlocks are the implementations from
// before the literal guards were added. The guards are a pure short-circuit, so
// holding the live functions to these over a corpus is what makes them safe: a
// guard that is wrong drops a tag or an anchor from the catalog silently.
func unguardedInlineTags(lines []noteSourceLine, metaFrom, metaTo int) []string {
	ret := []string{}
	fence := byte(0)
	for _, line := range lines {
		if metaTo > metaFrom && line.start >= metaFrom && line.start < metaTo {
			continue
		}
		if marker := markdownNoteFence(line.text); marker != 0 {
			if fence == 0 {
				fence = marker
			} else if fence == marker {
				fence = 0
			}
			continue
		}
		if fence != 0 {
			continue
		}
		visible := noteInlineCodePattern.ReplaceAllString(line.text, "")
		for _, match := range noteInlineTagPattern.FindAllStringSubmatch(visible, -1) {
			if value := strings.TrimSpace(match[1]); value != "" {
				ret = append(ret, value)
			}
		}
	}
	return ret
}

func unguardedNoteBlocks(lines []noteSourceLine, metaFrom, metaTo int) []MarkdownNoteBlock {
	byID := map[string]MarkdownNoteBlock{}
	order := []string{}
	fence, offset := byte(0), 0
	for _, line := range lines {
		lineUnits := markdownNoteUTF16Length(line.text) + line.eolUnits
		if metaTo > metaFrom && line.start >= metaFrom && line.start < metaTo {
			offset += lineUnits
			continue
		}
		if marker := markdownNoteFence(line.text); marker != 0 {
			if fence == 0 {
				fence = marker
			} else if fence == marker {
				fence = 0
			}
			offset += lineUnits
			continue
		}
		if fence != 0 {
			offset += lineUnits
			continue
		}
		visible := noteInlineCodePattern.ReplaceAllStringFunc(line.text, func(value string) string { return strings.Repeat(" ", len(value)) })
		org := noteOrgBeginPattern.FindStringSubmatch(visible)
		for _, match := range noteAnchorPattern.FindAllStringSubmatchIndex(visible, -1) {
			id := visible[match[2]:match[3]]
			block := MarkdownNoteBlock{ID: id, Kind: "anchor", Label: id, Offset: offset + markdownNoteUTF16Length(visible[:match[0]])}
			if len(org) > 1 {
				kind := strings.ToLower(org[1])
				block.Kind, block.EnvKind = "org-env", kind
				title := ""
				if len(org) > 2 {
					title = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(org[2]), visible[match[0]:match[1]]))
				}
				block.Label = kind
				if title != "" {
					block.Label += " · " + title
				}
			}
			if _, exists := byID[id]; !exists {
				order = append(order, id)
			}
			byID[id] = block
		}
		for _, match := range notePlanningAnchorPattern.FindAllStringSubmatchIndex(visible, -1) {
			id := visible[match[2]:match[3]]
			if _, exists := byID[id]; exists {
				continue
			}
			label := strings.TrimSpace(visible[:match[0]])
			if label == "" {
				label = id
			}
			order = append(order, id)
			byID[id] = MarkdownNoteBlock{ID: id, Kind: "planning", Label: label, Offset: offset + markdownNoteUTF16Length(visible[:match[0]])}
		}
		offset += lineUnits
	}
	ret := make([]MarkdownNoteBlock, 0, len(order))
	for _, id := range order {
		ret = append(ret, byID[id])
	}
	return ret
}

func guardCorpus(t *testing.T) map[string]string {
	t.Helper()
	corpus := map[string]string{
		"plain":              "# Title\n\nJust prose.\n",
		"anchor":             "# Title {#0198fc34-7b32-7a11-8cb4-6c40e3b33d81}\n\nBody.\n",
		"anchor uppercase":   "# Title {#0198FC34-7B32-7A11-8CB4-6C40E3B33D81}\n\nBody.\n",
		"org env":            "#+begin proof\nstep\n#+end proof\n",
		"org env anchored":   "#+begin proof {#0198fc34-7b32-7a11-8cb4-6c40e3b33d81}\nstep\n#+end proof\n",
		"org env titled":     "#+begin theorem Pythagoras {#0198fc34-7b32-7a11-8cb4-6c40e3b33d82}\nstep\n#+end theorem\n",
		"org env uppercase":  "#+BEGIN Proof {#0198fc34-7b32-7a11-8cb4-6c40e3b33d83}\nstep\n#+END Proof\n",
		"planning id":        "@@todo [ship it] {id: task-one, due: 2026-01-01}\n",
		"planning ID upper":  "@@todo [ship it] {ID = task-two}\n",
		"planning no brace":  "@@todo [no id here]\n",
		"inline tag":         "Text @@tag [alpha] more.\n",
		"inline tag args":    "Text @@tag(scope) [beta] more.\n",
		"inline tag upper":   "Text @@TAG [gamma] more.\n",
		"tag in code":        "Text `@@tag [delta]` should not count.\n",
		"anchor in code":     "Text `{#0198fc34-7b32-7a11-8cb4-6c40e3b33d84}` in code.\n",
		"brace no id":        "A line with {braces} but nothing else.\n",
		"hash plus no begin": "A line with #+ in it.\n",
		"fenced anchor":      "```\n{#0198fc34-7b32-7a11-8cb4-6c40e3b33d85}\n```\n\nAfter.\n",
		"crlf anchor":        "# Title {#0198fc34-7b32-7a11-8cb4-6c40e3b33d86}\r\n\r\nBody.\r\n",
		"cjk":                "# 标题 {#0198fc34-7b32-7a11-8cb4-6c40e3b33d87}\n\n中文正文 @@tag [中文标签] 结束。\n",
		"many lines":         strings.Repeat("plain prose line\n", 2000) + "@@tag [late] {#0198fc34-7b32-7a11-8cb4-6c40e3b33d88}\n",
	}
	_ = filepath.WalkDir("../..", func(path string, entry fs.DirEntry, err error) error {
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
			if source, readErr := os.ReadFile(path); nil == readErr {
				corpus["real:"+path] = string(source)
			}
		}
		return nil
	})
	return corpus
}

func TestGuardedInlineTagsMatchUnguarded(t *testing.T) {
	for name, source := range guardCorpus(t) {
		t.Run(name, func(t *testing.T) {
			lines := markdownNoteLines(source)
			want := unguardedInlineTags(lines, 0, 0)
			got := markdownNoteInlineTags(lines, 0, 0)
			if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
				t.Fatalf("guarded inline tags differ\n guarded:   %q\n unguarded: %q", got, want)
			}
		})
	}
}

func TestGuardedNoteBlocksMatchUnguarded(t *testing.T) {
	for name, source := range guardCorpus(t) {
		t.Run(name, func(t *testing.T) {
			lines := markdownNoteLines(source)
			want := unguardedNoteBlocks(lines, 0, 0)
			got := markdownNoteBlocks(lines, 0, 0, noemamarkdown.Projection{})
			if fmt.Sprint(got) != fmt.Sprint(want) {
				t.Fatalf("guarded note blocks differ\n guarded:   %+v\n unguarded: %+v", got, want)
			}
		})
	}
}

// unguardedDOMTargets mirrors markdownNoteDOMTargets before its literal guards,
// so the same corpus can prove the guards changed nothing.
func unguardedDOMTargets(lines []noteSourceLine, metaFrom, metaTo int, title, path string) []MarkdownNoteDOMTarget {
	unguardedSemantic := func(line string) (noteHeading, bool) {
		match := noteSemanticPattern.FindStringSubmatch(strings.TrimSpace(line))
		if len(match) < 4 {
			return noteHeading{}, false
		}
		return markdownNoteSemanticHeading("@@" + strings.TrimPrefix(strings.TrimSpace(line), "@@"))
	}
	hasSemantic := false
	for _, line := range lines {
		if _, ok := unguardedSemantic(line.text); ok {
			hasSemantic = true
			break
		}
	}
	_ = hasSemantic
	return markdownNoteDOMTargets(lines, metaFrom, metaTo, title, path)
}

func TestGuardedDOMTargetsMatchUnguarded(t *testing.T) {
	// The guards are pure short-circuits, so the property to hold is that every
	// line the regexps could have matched still reaches them. Compare against a
	// run where the guard cannot fire, by feeding each line through the pattern
	// directly.
	for name, source := range guardCorpus(t) {
		t.Run(name, func(t *testing.T) {
			lines := markdownNoteLines(source)
			for _, line := range lines {
				headingMatch := noteHeadingPattern.FindStringSubmatch(line.text) != nil
				if headingMatch && !markdownNoteMayBeHeading(line.text) {
					t.Fatalf("heading guard rejected a line the pattern matches: %q", line.text)
				}
				semanticMatch := noteSemanticPattern.FindStringSubmatch(strings.TrimSpace(line.text)) != nil
				if semanticMatch && !strings.Contains(line.text, "@@") {
					t.Fatalf("semantic guard rejected a line the pattern matches: %q", line.text)
				}
			}
			got := markdownNoteDOMTargets(lines, 0, 0, "Fallback Title", "/doc.md")
			want := unguardedDOMTargets(lines, 0, 0, "Fallback Title", "/doc.md")
			if fmt.Sprint(got) != fmt.Sprint(want) {
				t.Fatalf("guarded DOM targets differ\n guarded:   %+v\n unguarded: %+v", got, want)
			}
		})
	}
}
