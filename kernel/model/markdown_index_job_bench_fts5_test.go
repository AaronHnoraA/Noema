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
	for _, sections := range []int{1, 16, 128} {
		source := benchAnchoredDoc(sections)
		// Edit in the middle so neither the first nor the last block is special.
		marker := "## Section " + fmt.Sprint(sections/2)
		edited := strings.Replace(source, marker, marker+" edited", 1)
		if edited == source {
			b.Fatalf("benchmark fixture did not contain %q", marker)
		}

		b.Run(fmt.Sprintf("sections=%d/reindex", sections), func(b *testing.B) {
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

		b.Run(fmt.Sprintf("sections=%d/after-one-edit", sections), func(b *testing.B) {
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
