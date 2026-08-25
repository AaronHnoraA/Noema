// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
)

// setupMarkdownBoxForIndexTest 建一个 Kind=markdown 的 box，供索引相关测试使用。
func setupMarkdownBoxForIndexTest(t *testing.T, boxID string) {
	t.Helper()
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Markdown Index Test"
	box := &Box{ID: boxID}
	if err := box.SaveConf(boxConf); nil != err {
		t.Fatalf("save box conf failed: %s", err)
	}
}

func TestPathBoxIsMarkdownReflectsBoxConfKind(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	mdBoxID := "20260824232000-pbim0001"
	setupMarkdownBoxForIndexTest(t, mdBoxID)

	syBoxID := "20260824232000-pbim0002"
	box := &Box{ID: syBoxID}
	syBoxConf := conf.NewBoxConf()
	syBoxConf.Name = "Sy Box"
	if err := box.SaveConf(syBoxConf); nil != err {
		t.Fatal(err)
	}

	if !pathBoxIsMarkdown(mdBoxID + "/notes/") {
		t.Fatal("expected markdown box path to be detected as markdown")
	}
	if pathBoxIsMarkdown(syBoxID + "/notes/") {
		t.Fatal("sy box path must not be detected as markdown")
	}
	if pathBoxIsMarkdown("no-slash-here") {
		t.Fatal("a path with no box segment must not be treated as markdown")
	}
}

func TestListMarkdownFilesSkipsSiyuanConfDir(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260824232000-lmf00001"
	mustWrite := func(rel, content string) {
		abs := filepath.Join(util.DataDir, boxID, rel)
		if err := os.MkdirAll(filepath.Dir(abs), 0755); nil != err {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(content), 0644); nil != err {
			t.Fatal(err)
		}
	}
	mustWrite("/notes/a.md", "a")
	mustWrite("/notes/sub/b.md", "b")
	mustWrite("/.siyuan/conf.json", `{"kind":"markdown"}`)
	mustWrite("/notes/c.sy", "{}") // 不应被 markdown 列表捡到

	got := listMarkdownFiles(boxID + "/")
	if 2 != len(got) {
		t.Fatalf("expected exactly 2 markdown files, got %v", got)
	}
	for _, p := range got {
		if strings.Contains(p, ".siyuan") {
			t.Fatalf(".siyuan config dir leaked into markdown file listing: %v", got)
		}
		if !strings.HasSuffix(p, ".md") {
			t.Fatalf("non-.md file leaked into markdown file listing: %v", got)
		}
	}
}

// TestFreshMarkdownFileGetsStableProjectionWithoutWrite 复现外部编辑器直接写入
// Markdown 的场景，验证 LoadTree 从 Noema meta.id 建立稳定投影且不改写源文件。
// 这里直接调 filesys 层加 treenode，不经过 upsertIndexes 本身——upsertIndexes
// 还会调 sql.UpsertTreeQueue，需要完整的 sql.InitDatabase（fts5 build tag、
// 独立子进程，见 file_index_test.go），超出这次改动想要覆盖的范围。
func TestFreshMarkdownFileGetsStableProjectionWithoutWrite(t *testing.T) {
	originalDataDir := util.DataDir
	originalBlockTreeDBPath := util.BlockTreeDBPath
	tempDir := t.TempDir()
	util.DataDir = filepath.Join(tempDir, "data")
	util.BlockTreeDBPath = filepath.Join(tempDir, "blocktree.db")
	treenode.InitBlockTree(true)
	t.Cleanup(func() {
		treenode.CloseDatabase()
		util.DataDir = originalDataDir
		util.BlockTreeDBPath = originalBlockTreeDBPath
	})

	boxID := "20260824232000-freshmd1"
	setupMarkdownBoxForIndexTest(t, boxID)

	relPath := "/notes/hello.md"
	absPath := filepath.Join(util.DataDir, boxID, relPath)
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); nil != err {
		t.Fatal(err)
	}
	source := "#+begin meta\nid: 0198fc34-7b32-7a11-8cb4-6c40e3b33d68\n#+end meta\n\n# Hello\n\nWritten directly to disk, like Emacs would.\n"
	if err := os.WriteFile(absPath, []byte(source), 0644); nil != err {
		t.Fatal(err)
	}

	luteEngine := util.NewLute()
	tree, err := filesys.LoadTree(boxID, relPath, luteEngine)
	if nil != err {
		t.Fatalf("LoadTree failed: %s", err)
	}
	rootID := tree.ID
	if "" == rootID {
		t.Fatal("LoadTree did not assign a root ID for a fresh markdown file")
	}

	treenode.UpsertBlockTree(tree)
	bt := treenode.GetBlockTreeRootByPath(boxID, relPath)
	if nil == bt || bt.RootID != rootID {
		t.Fatalf("blocktree entry missing or root ID mismatch: %+v (want %s)", bt, rootID)
	}

	reloaded, err := filesys.LoadTree(boxID, relPath, luteEngine)
	if nil != err {
		t.Fatalf("second LoadTree failed: %s", err)
	}
	if reloaded.ID != rootID {
		t.Fatalf("reloaded tree ID [%s] != original projection ID [%s]", reloaded.ID, rootID)
	}
	raw, err := os.ReadFile(absPath)
	if nil != err {
		t.Fatal(err)
	}
	if string(raw) != source {
		t.Fatalf("loading/indexing rewrote source bytes:\n%s", raw)
	}
	if strings.Contains(string(raw), `type="doc"`) {
		t.Fatalf("loading/indexing injected a document IAL:\n%s", raw)
	}

	treenode.RemoveBlockTreesByRootID(boxID, rootID)
	if nil != treenode.GetBlockTreeRootByPath(boxID, relPath) {
		t.Fatal("blocktree entry still present after RemoveBlockTreesByRootID")
	}
}

// TestRepeatedReindexDoesNotAccumulateEphemeralBlockGarbage 是对一个真实发现的
// bug 的回归测试：util.NewLute() 开着 SetProtyleWYSIWYG，任何没有显式
// {: id=...} 的块，lute 每次解析都会现场发一个只存在于内存里、不落盘的临时 ID
// （见 filesys.StripEphemeralMarkdownBlockIDs 的注释）。如果不在
// treenode.UpsertBlockTree 之前清掉，每次重索引都会把上一轮的临时 ID
// 当"找不到旧记录"处理，插入一批新垃圾行，上一轮的垃圾行因为 ID 对不上
// 也永远清不掉——blocktree 会无限膨胀。这里反复索引同一份从未被引用过的
// 内容 5 次，断言 blocktree 里这份文档的行数不随索引次数增长。
func TestRepeatedReindexDoesNotAccumulateEphemeralBlockGarbage(t *testing.T) {
	originalDataDir := util.DataDir
	originalBlockTreeDBPath := util.BlockTreeDBPath
	tempDir := t.TempDir()
	util.DataDir = filepath.Join(tempDir, "data")
	util.BlockTreeDBPath = filepath.Join(tempDir, "blocktree.db")
	treenode.InitBlockTree(true)
	t.Cleanup(func() {
		treenode.CloseDatabase()
		util.DataDir = originalDataDir
		util.BlockTreeDBPath = originalBlockTreeDBPath
	})

	boxID := "20260825003000-noaccum1"
	setupMarkdownBoxForIndexTest(t, boxID)

	relPath := "/notes/hello.md"
	absPath := filepath.Join(util.DataDir, boxID, relPath)
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); nil != err {
		t.Fatal(err)
	}
	// 五个未被引用的标题/段落——都没有显式 ID，正是会触发临时 ID 的场景。
	source := "# Title\n\nPara one.\n\n## Sub A\n\nPara two.\n\n## Sub B\n\nPara three.\n"
	if err := os.WriteFile(absPath, []byte(source), 0644); nil != err {
		t.Fatal(err)
	}

	luteEngine := util.NewLute()
	var rootID string
	var rowCounts []int
	for i := 0; i < 5; i++ {
		tree, err := filesys.LoadTree(boxID, relPath, luteEngine)
		if nil != err {
			t.Fatalf("pass %d: LoadTree failed: %s", i, err)
		}
		treenode.UpsertBlockTree(tree)
		rootID = tree.ID

		rows := treenode.GetBlockTreesByRootIDInBox(rootID, boxID)
		rowCounts = append(rowCounts, len(rows))
	}

	for i := 1; i < len(rowCounts); i++ {
		if rowCounts[i] != rowCounts[0] {
			t.Fatalf("blocktree row count grew across repeated reindexing (ephemeral IDs leaking into the index): %v", rowCounts)
		}
	}
	if 0 == rowCounts[0] {
		t.Fatal("expected at least the document root to be indexed")
	}
}
