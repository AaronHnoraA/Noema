// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

//go:build fts5

package model

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	noemamarkdown "github.com/aaronhe/noema/kernel/noema/markdown"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/siyuan-note/filelock"
)

// benchSaveWorkspace stands up the same workspace the fts5 save tests use so
// SaveMarkdownDoc runs its real indexing path rather than a stub.
func benchSaveWorkspace(b *testing.B) string {
	b.Helper()
	workspaceDir := b.TempDir()
	util.WorkspaceDir = workspaceDir
	util.ConfDir = filepath.Join(workspaceDir, "conf")
	util.DataDir = filepath.Join(workspaceDir, "data")
	util.HistoryDir = filepath.Join(workspaceDir, "history")
	util.TempDir = filepath.Join(workspaceDir, "temp")
	util.QueueDir = filepath.Join(util.TempDir, "queue")
	util.DBPath = filepath.Join(util.TempDir, util.DBName)
	util.HistoryDBPath = filepath.Join(util.TempDir, "history.db")
	util.AssetContentDBPath = filepath.Join(util.TempDir, "asset_content.db")
	util.BlockTreeDBPath = filepath.Join(util.TempDir, "blocktree.db")
	for _, dir := range []string{util.ConfDir, util.DataDir, util.HistoryDir, util.TempDir, util.QueueDir} {
		if err := os.MkdirAll(dir, 0755); nil != err {
			b.Fatalf("create bench directory [%s] failed: %v", dir, err)
		}
	}

	Conf = NewAppConf()
	Conf.FileTree = conf.NewFileTree()
	Conf.NotebookCrypto = conf.NewNotebookCrypto()
	Conf.Sync = conf.NewSync()
	Conf.Search = conf.NewSearch()

	boxID := "20260826190000-savebench"
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Save bench"
	if err := (&Box{ID: boxID}).SaveConf(boxConf); nil != err {
		b.Fatal(err)
	}

	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	b.Cleanup(func() {
		// The index queue must settle before the databases close, exactly as
		// it does on kernel shutdown.
		WaitMarkdownIndex()
		sql.CloseDatabase()
	})
	return boxID
}

// BenchmarkSaveMarkdownDocEndToEnd is the debounced CM6 save as the kernel
// actually serves it: write, parse, project blocks, and enqueue the indexes.
func BenchmarkSaveMarkdownDocEndToEnd(b *testing.B) {
	for _, sections := range []int{1, 16, 128} {
		b.Run(fmt.Sprintf("sections=%d", sections), func(b *testing.B) {
			boxID := benchSaveWorkspace(b)
			source := benchAnchoredDoc(sections)
			sources := []string{source + "\n<!-- bench-a -->\n", source + "\n<!-- bench-b -->\n"}
			b.SetBytes(int64(len(source)))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, _, err := SaveMarkdownDoc(boxID, "/notes/bench.md", sources[i&1]); nil != err {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkSaveMarkdownDocNoop(b *testing.B) {
	boxID := benchSaveWorkspace(b)
	source := benchAnchoredDoc(16)
	if _, _, err := SaveMarkdownDoc(boxID, "/notes/noop.md", source); nil != err {
		b.Fatal(err)
	}
	b.SetBytes(int64(len(source)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, _, err := SaveMarkdownDoc(boxID, "/notes/noop.md", source); nil != err {
			b.Fatal(err)
		}
	}
}

func BenchmarkSaveMarkdownDocCASEndToEnd(b *testing.B) {
	boxID := benchSaveWorkspace(b)
	base := benchAnchoredDoc(16)
	sources := []string{base + "\n<!-- cas-a -->\n", base + "\n<!-- cas-b -->\n"}
	if _, _, err := SaveMarkdownDoc(boxID, "/notes/cas.md", base); nil != err {
		b.Fatal(err)
	}
	expected := markdownDocVersion([]byte(base))
	b.SetBytes(int64(len(base)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		result, err := SaveMarkdownDocCAS(boxID, "/notes/cas.md", sources[i&1], expected, false)
		if nil != err {
			b.Fatal(err)
		}
		if result.Conflict {
			b.Fatal("benchmark CAS unexpectedly conflicted")
		}
		expected = result.Version
	}
}

// BenchmarkSaveMarkdownDocChangesCASEndToEnd measures the ordinary editor hot
// path: one single-character CM6 change, one version compare, one atomic file
// replacement, and deferred indexing. The request itself stays constant-size
// even as the document grows.
func BenchmarkSaveMarkdownDocChangesCASEndToEnd(b *testing.B) {
	for _, sections := range []int{1, 16, 128} {
		b.Run(fmt.Sprintf("sections=%d", sections), func(b *testing.B) {
			boxID := benchSaveWorkspace(b)
			base := benchAnchoredDoc(sections) + "A"
			if _, _, err := SaveMarkdownDoc(boxID, "/notes/changes.md", base); nil != err {
				b.Fatal(err)
			}
			expected := markdownDocVersion([]byte(base))
			length := utf16TextLength(base)
			inserts := []string{"B", "A"}
			b.SetBytes(int64(len(base)))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				changeSet := MarkdownChangeSet{
					Length: length, NewLength: length,
					Changes: []MarkdownTextChange{{From: length - 1, To: length, Insert: inserts[i&1]}},
				}
				result, err := SaveMarkdownDocChangesCAS(boxID, "/notes/changes.md", expected, changeSet, false)
				if nil != err {
					b.Fatal(err)
				}
				if result.Conflict {
					b.Fatal("benchmark incremental CAS unexpectedly conflicted")
				}
				expected = result.Version
			}
		})
	}
}

// BenchmarkLoadMarkdownDocCold measures an editor opening a note the kernel
// has not seen, which is the case the snapshot cache cannot serve.
func BenchmarkLoadMarkdownDocCold(b *testing.B) {
	for _, sections := range []int{1, 16, 128} {
		b.Run(fmt.Sprintf("sections=%d", sections), func(b *testing.B) {
			boxID := benchSaveWorkspace(b)
			source := benchAnchoredDoc(sections)
			paths := make([]string, b.N)
			for i := range paths {
				paths[i] = fmt.Sprintf("/notes/cold-%d.md", i)
				absPath := filepath.Join(util.DataDir, boxID, paths[i])
				if err := os.MkdirAll(filepath.Dir(absPath), 0755); nil != err {
					b.Fatal(err)
				}
				if err := os.WriteFile(absPath, []byte(source), 0644); nil != err {
					b.Fatal(err)
				}
			}
			b.SetBytes(int64(len(source)))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, _, err := LoadMarkdownDoc(boxID, paths[i]); nil != err {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkLoadMarkdownDocSourceOnlyCold is the desktop/Emacs editor-open
// path. Unlike LoadMarkdownDoc, it does not build a Lute tree whose block list
// the CM6 caller would discard.
func BenchmarkLoadMarkdownDocSourceOnlyCold(b *testing.B) {
	for _, sections := range []int{1, 16, 128} {
		b.Run(fmt.Sprintf("sections=%d", sections), func(b *testing.B) {
			boxID := benchSaveWorkspace(b)
			source := benchAnchoredDoc(sections)
			paths := make([]string, b.N)
			for i := range paths {
				paths[i] = fmt.Sprintf("/notes/source-only-%d.md", i)
				absPath := filepath.Join(util.DataDir, boxID, paths[i])
				if err := os.MkdirAll(filepath.Dir(absPath), 0755); nil != err {
					b.Fatal(err)
				}
				if err := os.WriteFile(absPath, []byte(source), 0644); nil != err {
					b.Fatal(err)
				}
			}
			b.SetBytes(int64(len(source)))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := LoadMarkdownDocProjection(boxID, paths[i], false); nil != err {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkSaveMarkdownDocComponents attributes the size-independent part of a
// save: the note's own durable write versus the conf.json write that the
// DataIndexState marker triggers on every dirty/clean transition.
func BenchmarkSaveMarkdownDocComponents(b *testing.B) {
	boxID := benchSaveWorkspace(b)
	source := []byte(benchAnchoredDoc(1))
	absPath := filepath.Join(util.DataDir, boxID, "/notes/component.md")
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); nil != err {
		b.Fatal(err)
	}

	b.Run("note-filelock-write", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if err := filelock.WriteFile(absPath, source); nil != err {
				b.Fatal(err)
			}
		}
	})
	b.Run("note-atomic-rename", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if err := writeMarkdownSourceAtomic(absPath, source); nil != err {
				b.Fatal(err)
			}
		}
	})
	b.Run("conf-save-transition", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			Conf.DataIndexState = i & 1
			Conf.Save()
		}
	})
	b.Run("parse-and-project", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			tree := filesys.LoadMarkdownTreeByData(source, boxID, "/notes/component.md", util.NewLute())
			_ = markdownBlockRefs(tree)
		}
	})
}

// BenchmarkDurableWritePolicy contrasts the kernel's durable note write
// (temp file + fsync + rename) with the non-durable atomic write the Node
// host performs for the same save (temp file + rename, no fsync).
func BenchmarkDurableWritePolicy(b *testing.B) {
	boxID := benchSaveWorkspace(b)
	dir := filepath.Join(util.DataDir, boxID, "notes")
	if err := os.MkdirAll(dir, 0755); nil != err {
		b.Fatal(err)
	}
	for _, size := range []int{1, 16, 128} {
		source := []byte(benchAnchoredDoc(size))
		target := filepath.Join(dir, fmt.Sprintf("durable-%d.md", size))
		b.Run(fmt.Sprintf("bytes=%d/fsync-rename", len(source)), func(b *testing.B) {
			b.SetBytes(int64(len(source)))
			for i := 0; i < b.N; i++ {
				if err := filelock.WriteFile(target, source); nil != err {
					b.Fatal(err)
				}
			}
		})
		b.Run(fmt.Sprintf("bytes=%d/rename-only", len(source)), func(b *testing.B) {
			b.SetBytes(int64(len(source)))
			for i := 0; i < b.N; i++ {
				tmp := target + ".tmp"
				if err := os.WriteFile(tmp, source, 0644); nil != err {
					b.Fatal(err)
				}
				if err := os.Rename(tmp, target); nil != err {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkSaveResponsePhases attributes what is left of a save response now
// that parsing and indexing have moved off it.
func BenchmarkSaveResponsePhases(b *testing.B) {
	boxID := benchSaveWorkspace(b)
	source := []byte(benchAnchoredDoc(128))
	target := filepath.Join(util.DataDir, boxID, "notes", "phases.md")
	if err := os.MkdirAll(filepath.Dir(target), 0755); nil != err {
		b.Fatal(err)
	}
	b.Run("atomic-write", func(b *testing.B) {
		b.SetBytes(int64(len(source)))
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if err := writeMarkdownSourceAtomic(target, source); nil != err {
				b.Fatal(err)
			}
		}
	})
	b.Run("remember-self-write", func(b *testing.B) {
		b.SetBytes(int64(len(source)))
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			rememberMarkdownSelfWrite(target, source)
		}
	})
	b.Run("scan", func(b *testing.B) {
		b.SetBytes(int64(len(source)))
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_ = noemamarkdown.Scan(source)
		}
	})
	b.Run("signature", func(b *testing.B) {
		b.SetBytes(int64(len(source)))
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_ = markdownBlockRefSignature("doc", source)
		}
	})
	b.Run("document-identity", func(b *testing.B) {
		b.SetBytes(int64(len(source)))
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_ = filesys.MarkdownDocumentIdentity(source)
		}
	})
}
