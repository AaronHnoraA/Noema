//go:build fts5

// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package model

import (
	"fmt"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/util"
)

// BenchmarkMarkdownIndexJob measures one committed index job: the parse plus
// the block-tree and SQL rewrite that a save schedules and the response path
// deliberately does not wait for.
//
// `reindex` re-indexes unchanged bytes, which is the floor: everything is
// hash-identical and only the parse is paid. `after-one-edit` is the shape
// editing actually has — one character changed somewhere in the middle — and is
// the number this whole path exists to keep small. Before Markdown blocks had
// deterministic keys the two were the same work, because the document was a
// single row whose content was the entire body: one keystroke deleted it and
// re-tokenized the whole note into FTS, at roughly 78 µs per KB.
func BenchmarkMarkdownIndexJob(b *testing.B) {
	for _, shape := range []struct {
		name  string
		build func(int) string
	}{
		// Anchored documents cannot take the incremental parse: a `{#uuid}`
		// block's key comes from a whole-document projection rather than from its
		// own bytes. Most Noema notes carry no anchor at all — only genuinely
		// referenced blocks get one — so both shapes are measured.
		{"unanchored", benchUnanchoredDoc},
		{"anchored", benchAnchoredDoc},
	} {
		for _, sections := range []int{1, 16, 128} {
			source := shape.build(sections)
			// Edit in the middle so neither the first nor the last block is special.
			marker := "## Section " + fmt.Sprint(sections/2)
			edited := strings.Replace(source, marker, marker+" edited", 1)
			if edited == source {
				b.Fatalf("benchmark fixture did not contain %q", marker)
			}

			b.Run(fmt.Sprintf("%s/sections=%d/reindex", shape.name, sections), func(b *testing.B) {
				boxID, path := benchIndexedDoc(b, source)
				job := markdownIndexJob{boxID: boxID, path: path, source: []byte(source)}
				b.SetBytes(int64(len(source)))
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					indexMarkdownJob(job)
					// indexMarkdownJob only enqueues the SQL work; the rewrite this
					// benchmark exists to measure happens in the flush.
					sql.FlushQueue()
				}
			})

			b.Run(fmt.Sprintf("%s/sections=%d/after-one-edit", shape.name, sections), func(b *testing.B) {
				boxID, path := benchIndexedDoc(b, source)
				variants := [][]byte{[]byte(edited), []byte(source)}
				b.SetBytes(int64(len(source)))
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					indexMarkdownJob(markdownIndexJob{boxID: boxID, path: path, source: variants[i&1]})
					sql.FlushQueue()
				}
			})
		}
	}
}

// benchUnanchoredDoc is benchAnchoredDoc without the `{#uuid}` anchors: the
// ordinary shape of a Noema note.
func benchUnanchoredDoc(sections int) string {
	var b strings.Builder
	b.WriteString("# Benchmark note\n\n")
	for i := 0; i < sections; i++ {
		fmt.Fprintf(&b, "## Section %d\n\n", i)
		fmt.Fprintf(&b, "这是第 %d 段中文正文，混合 English prose and `inline code` plus a [link](https://example.com/%d) and $E = mc^2$ math.\n\n", i, i)
		b.WriteString("- first item with **bold** and *emphasis*\n")
		b.WriteString("- second item with ~~strike~~ and a #tag\n")
		b.WriteString("- [ ] a task list item\n\n")
		fmt.Fprintf(&b, "```go\nfunc bench%d() int {\n\treturn %d\n}\n```\n\n", i, i)
		b.WriteString("> a blockquote line\n>\n> with a second paragraph\n\n")
		b.WriteString("$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n\n")
	}
	return b.String()
}

func benchIndexedDoc(b *testing.B, source string) (boxID, path string) {
	b.Helper()
	boxID = benchSaveWorkspace(b)
	path = "/notes/index-job.md"
	if _, _, err := SaveMarkdownDoc(boxID, path, source); nil != err {
		b.Fatal(err)
	}
	WaitMarkdownIndex()
	sql.FlushQueue()
	return boxID, path
}

// BenchmarkMarkdownIndexedRowsPerDocument is not a timing benchmark: it reports
// how many SQL rows one document occupies, which is the quantity that decides
// whether an edit can be incremental at all.
func BenchmarkMarkdownIndexedRowsPerDocument(b *testing.B) {
	for _, sections := range []int{1, 16, 128} {
		b.Run(fmt.Sprintf("sections=%d", sections), func(b *testing.B) {
			source := benchAnchoredDoc(sections)
			boxID, path := benchIndexedDoc(b, source)
			rows := sql.SelectBlocksRawStmtArgs(
				"SELECT * FROM blocks WHERE box = ? AND path = ?", []any{boxID, path}, 4096)
			longest := 0
			for _, row := range rows {
				if length := len(row.Content); length > longest {
					longest = length
				}
			}
			b.ReportMetric(float64(len(rows)), "rows/doc")
			b.ReportMetric(float64(longest), "bytes/widest-row")
			b.ReportMetric(float64(len(source)), "bytes/doc")
			_ = filesys.BoxRootPath
			_ = util.DataDir
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
			}
		})
	}
}
