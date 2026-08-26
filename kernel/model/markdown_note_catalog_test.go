// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package model

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	noemamarkdown "github.com/aaronhe/noema/kernel/noema/markdown"
	"github.com/aaronhe/noema/kernel/util"
)

func BenchmarkMarkdownNoteCatalog(b *testing.B) {
	originalDataDir := util.DataDir
	util.DataDir = b.TempDir()
	boxID := "note-catalog-benchmark"
	b.Cleanup(func() {
		resetMarkdownBoxCatalog(boxID)
		util.DataDir = originalDataDir
	})
	boxDir := filepath.Join(util.DataDir, boxID)
	if err := os.MkdirAll(boxDir, 0o755); nil != err {
		b.Fatal(err)
	}
	for index := 0; index < 500; index++ {
		previous := (index + 499) % 500
		source := fmt.Sprintf("---\nid: note-%03d\ntitle: Note %03d\ntags: graph math\n---\n# Note %03d\n\nSee [previous](roam://note-%03d).\n\n@@section [Result] {id=result-%03d}\n", index, index, index, previous, index)
		if err := os.WriteFile(filepath.Join(boxDir, fmt.Sprintf("note-%03d.md", index)), []byte(source), 0o644); nil != err {
			b.Fatal(err)
		}
	}
	if _, err := markdownCatalogNotes(boxID); nil != err {
		b.Fatal(err)
	}

	b.Run("warm", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			if _, err := markdownCatalogNotes(boxID); nil != err {
				b.Fatal(err)
			}
		}
	})
	b.Run("restart-persistent", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			resetMarkdownBoxCatalog(boxID)
			if _, err := markdownCatalogNotes(boxID); nil != err {
				b.Fatal(err)
			}
		}
	})
	b.Run("cold-source", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			resetMarkdownBoxCatalog(boxID)
			if err := os.Remove(markdownIndexCachePath(boxID)); nil != err && !os.IsNotExist(err) {
				b.Fatal(err)
			}
			if _, err := markdownCatalogNotes(boxID); nil != err {
				b.Fatal(err)
			}
		}
	})
}

func TestMarkdownNoteCatalogMatchesEditorSemanticsAndUpdatesIncrementally(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	boxID := "20260826214000-catalog1"
	t.Cleanup(func() {
		resetMarkdownBoxCatalog(boxID)
		util.DataDir = originalDataDir
	})
	setupMarkdownBoxForIndexTest(t, boxID)

	write := func(path, source string) {
		absPath := filepath.Join(util.DataDir, boxID, path)
		if err := os.MkdirAll(filepath.Dir(absPath), 0o755); nil != err {
			t.Fatal(err)
		}
		if err := os.WriteFile(absPath, []byte(source), 0o644); nil != err {
			t.Fatal(err)
		}
	}
	write("topics/target.md", "---\nid: target-id\ntitle: Target\naliases:\n  - Alias A\ntags:\n  - Graph\nkind: theorem\nproject: Atlas\n---\n# Target\n\n@@section [Main result] {id=main}\n\nBody @@tag [inline].\n\n#+begin theorem Named {#eq-1}\nProof.\n#+end theorem\n")
	write("source.md", "#+begin meta\nid: source-id\ntitle: Source\nrefs:\n#+begin summary\n[hidden](roam://hidden-note)\n#+end summary\n#+end meta\n\n# Source\n\nSee [nested [Alias A]](roam://target-id), [path](topics/target.md#main), and \\[[escaped]].\n")
	write("plain.md", "# Plain\n\nNo explicit identity.\n")

	catalog, err := ListMarkdownNoteCatalog(boxID, false)
	if nil != err {
		t.Fatal(err)
	}
	if 3 != len(catalog.Notes) || "kernel-note-catalog" != catalog.Source || 1 != catalog.IndexVersion {
		t.Fatalf("unexpected catalog header: %+v", catalog)
	}
	byID := map[string]MarkdownNoteSummary{}
	for _, note := range catalog.Notes {
		byID[note.ID] = note
	}
	target, source, plain := byID["target-id"], byID["source-id"], byID["plain.md"]
	if target.Title != "Target" || target.Kind != "theorem" || target.Project != "Atlas" || !target.Roam {
		t.Fatalf("unexpected target projection: %+v", target)
	}
	if len(target.Tags) != 1 || target.Tags[0] != "Graph" || len(target.InlineTags) != 1 || target.InlineTags[0] != "inline" {
		t.Fatalf("unexpected target tags: %+v", target)
	}
	blockKinds := map[string]string{}
	for _, block := range target.Blocks {
		blockKinds[block.ID] = block.Kind
	}
	if blockKinds["main"] != "planning" || blockKinds["eq-1"] != "org-env" {
		t.Fatalf("unexpected target blocks: %+v", target.Blocks)
	}
	if len(target.DOMTargets) < 2 {
		t.Fatalf("semantic and Markdown headings were not projected: %+v", target.DOMTargets)
	}
	if len(source.Refs) != 1 || source.Refs[0] != "target-id" || len(target.Backlinks) != 1 || target.Backlinks[0] != "source-id" {
		t.Fatalf("relationships were not resolved: source=%+v target=%+v", source, target)
	}
	if plain.Roam || plain.Summary != "Plain No explicit identity." {
		t.Fatalf("metadata-free note semantics changed: %+v", plain)
	}
	if len(catalog.Directories) != 2 || catalog.Directories[0].Path != "Root" || catalog.Directories[1].Path != "topics" {
		t.Fatalf("unexpected directory projection: %+v", catalog.Directories)
	}

	persistent := loadMarkdownIndexCache(boxID, filepath.Join(util.DataDir, boxID))
	if entry := persistent.Entries["/topics/target.md"]; !entry.CatalogCached || entry.Catalog.ID != "target-id" {
		t.Fatalf("rich note projection was not persisted: %+v", entry)
	}

	changed := "#+begin meta\nid: source-id\ntitle: Source changed\n#+end meta\n\n# Source changed\n\nNo reference now.\n"
	if err = os.WriteFile(filepath.Join(util.DataDir, boxID, "source.md"), []byte(changed), 0o644); nil != err {
		t.Fatal(err)
	}
	forgetMarkdownSnapshot(boxID, "/source.md")
	changedSnapshot, err := loadMarkdownSnapshot(boxID, "/source.md")
	if nil != err {
		t.Fatal(err)
	}
	updateMarkdownCatalogPath(boxID, "/source.md", false, changedSnapshot)
	catalog, err = ListMarkdownNoteCatalog(boxID, false)
	if nil != err {
		t.Fatal(err)
	}
	byID = map[string]MarkdownNoteSummary{}
	for _, note := range catalog.Notes {
		byID[note.ID] = note
	}
	if byID["source-id"].Title != "Source changed" || len(byID["source-id"].Refs) != 0 || len(byID["target-id"].Backlinks) != 0 {
		t.Fatalf("changed path did not reconnect relationships: %+v", catalog.Notes)
	}
	if catalog.IndexVersion <= 1 {
		t.Fatalf("catalog generation did not advance: %d", catalog.IndexVersion)
	}
}

func TestMarkdownNoteBlocksUseUTF16OffsetsWithCRLF(t *testing.T) {
	source := "# 😀\r\n\r\n#+begin theorem Named {#anchor-id}\r\n#+end theorem\r\n"
	lines := markdownNoteLines(source)
	blocks := markdownNoteBlocks(lines, 0, 0, noemamarkdown.Projection{})
	if len(blocks) != 1 {
		t.Fatalf("unexpected blocks: %+v", blocks)
	}
	want := markdownNoteUTF16Length("# 😀\r\n\r\n#+begin theorem Named ")
	if blocks[0].Offset != want {
		t.Fatalf("UTF-16/CRLF offset = %d, want %d", blocks[0].Offset, want)
	}
}
