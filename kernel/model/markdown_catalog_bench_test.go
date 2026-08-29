// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema incremental Markdown catalog additions are Copyright (c) 2026 Aaron
// He and distributed under the same AGPL-3.0-or-later terms.

package model

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/filesys"
)

// benchMarkdownCatalogBox fills a Markdown box with `notes` small notes shaped
// like real ones (a heading, prose, a couple of wiki links) and returns the box.
func benchMarkdownCatalogBox(b *testing.B, notes int) (boxID string, paths []string) {
	b.Helper()
	// The catalog is a process-global sync.Map keyed by box id, and
	// benchMarkdownBox hands out one fixed id. Reset it so each sub-benchmark
	// measures its own note count instead of the first one's cached catalog.
	boxID = benchMarkdownBox(b)
	resetMarkdownBoxCatalog(boxID)
	b.Cleanup(func() { resetMarkdownBoxCatalog(boxID) })
	root := filesys.BoxRootPath(boxID)
	for i := 0; i < notes; i++ {
		path := fmt.Sprintf("/folder%d/note-%03d.md", i%10, i)
		abs := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(abs), 0755); nil != err {
			b.Fatal(err)
		}
		source := fmt.Sprintf(
			"# Note %d\n\n#tag%d\n\nProse for note %d linking [[note-%03d]] and [[note-%03d]].\n\n"+
				"- a list item\n- another item\n\nMore prose so the note is not degenerate.\n",
			i, i%7, i, (i+1)%notes, (i+2)%notes)
		if err := os.WriteFile(abs, []byte(source), 0644); nil != err {
			b.Fatal(err)
		}
		paths = append(paths, path)
	}
	return boxID, paths
}

// BenchmarkMarkdownCatalogNotes measures the cost of assembling one catalog
// response. This is what the Node host pays on every note-list refresh, which
// during editing means once per autosave.
func BenchmarkMarkdownCatalogNotes(b *testing.B) {
	for _, notes := range []int{200, 1000} {
		b.Run(fmt.Sprintf("notes=%d/warm", notes), func(b *testing.B) {
			boxID, _ := benchMarkdownCatalogBox(b, notes)
			if _, err := markdownCatalogNotes(boxID); nil != err {
				b.Fatal(err)
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := markdownCatalogNotes(boxID); nil != err {
					b.Fatal(err)
				}
			}
		})

		// The editing shape: one path changes, then the catalog is read again.
		b.Run(fmt.Sprintf("notes=%d/after-one-change", notes), func(b *testing.B) {
			boxID, paths := benchMarkdownCatalogBox(b, notes)
			if _, err := markdownCatalogNotes(boxID); nil != err {
				b.Fatal(err)
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				updateMarkdownCatalogPath(boxID, paths[i%len(paths)], false, nil)
				if _, err := markdownCatalogNotes(boxID); nil != err {
					b.Fatal(err)
				}
			}
		})
	}
}
