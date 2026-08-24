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

	"github.com/aaronhe/noema/kernel/util"
)

func TestLoadMarkdownDocRejectsNonMarkdownBox(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260825000000-notmd001"
	box := &Box{ID: boxID}
	if err := box.SaveConf(box.GetConf()); nil != err { // 默认 Kind 是 sy
		t.Fatal(err)
	}

	if _, _, err := LoadMarkdownDoc(boxID, "/whatever.md"); nil == err {
		t.Fatal("expected an error loading a non-markdown box as a markdown doc")
	}
}

// TestLoadMarkdownDocReturnsEmptyDocForMissingPath 验证"打开一个还没建过的
// 笔记路径"这个正常的新建文档流程：应该拿到空文档，不是报错。
func TestLoadMarkdownDocReturnsEmptyDocForMissingPath(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260825000000-missing1"
	setupMarkdownBoxForIndexTest(t, boxID)

	markdown, blocks, err := LoadMarkdownDoc(boxID, "/notes/never-created.md")
	if nil != err {
		t.Fatalf("expected no error loading a not-yet-created path, got: %s", err)
	}
	if "" != markdown {
		t.Fatalf("expected empty markdown, got: %q", markdown)
	}
	if 0 != len(blocks) {
		t.Fatalf("expected no blocks, got: %+v", blocks)
	}

	absPath := filepath.Join(util.DataDir, boxID, "/notes/never-created.md")
	if _, statErr := os.Stat(absPath); nil == statErr {
		t.Fatal("LoadMarkdownDoc must not create the file on disk just by loading it")
	}
}

func TestLoadMarkdownDocRejectsPathEscape(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260825000000-escape01"
	setupMarkdownBoxForIndexTest(t, boxID)

	if _, _, err := LoadMarkdownDoc(boxID, "/../../etc/passwd.md"); nil == err {
		t.Fatal("expected an error loading a path that escapes the box directory")
	}
}

func TestListMarkdownDocsSkipsSiyuanDirAndSortsByPath(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260825000000-listdoc1"
	setupMarkdownBoxForIndexTest(t, boxID)

	mustWrite := func(rel string) {
		abs := filepath.Join(util.DataDir, boxID, rel)
		if err := os.MkdirAll(filepath.Dir(abs), 0755); nil != err {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte("# "+rel+"\n"), 0644); nil != err {
			t.Fatal(err)
		}
	}
	mustWrite("/zebra.md")
	mustWrite("/notes/alpha.md")
	mustWrite("/notes/sub/beta.md")
	mustWrite("/notes/not-markdown.sy")

	docs, err := ListMarkdownDocs(boxID)
	if nil != err {
		t.Fatalf("ListMarkdownDocs failed: %s", err)
	}
	if 3 != len(docs) {
		t.Fatalf("expected exactly 3 markdown docs, got %+v", docs)
	}

	wantPaths := []string{"/notes/alpha.md", "/notes/sub/beta.md", "/zebra.md"}
	for i, want := range wantPaths {
		if docs[i].Path != want {
			t.Fatalf("docs[%d].Path = %q, want %q (full list: %+v)", i, docs[i].Path, want, docs)
		}
	}
	if "alpha" != docs[0].Title {
		t.Fatalf("unexpected title for docs[0]: %q", docs[0].Title)
	}
}

func TestListMarkdownDocsRejectsNonMarkdownBox(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260825000000-listrej1"
	box := &Box{ID: boxID}
	if err := box.SaveConf(box.GetConf()); nil != err { // 默认 Kind 是 sy
		t.Fatal(err)
	}

	if _, err := ListMarkdownDocs(boxID); nil == err {
		t.Fatal("expected an error listing docs for a non-markdown box")
	}
}

func TestLoadMarkdownDocOnlyReturnsPersistedBlockIDs(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260825000000-loadmd01"
	setupMarkdownBoxForIndexTest(t, boxID)

	relPath := "/notes/hello.md"
	absPath := filepath.Join(util.DataDir, boxID, relPath)
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); nil != err {
		t.Fatal(err)
	}
	// 惰性 IAL 模型（计划 §1.2）：Title/Sub 两个标题都没有显式 {: id=...}，
	// 不该出现在块列表里——它们的 ID 会被 util.NewLute() 的 ProtyleWYSIWYG
	// 现场发一个（供内存里的树用），但不落盘、每次解析都不一样，用它们做
	// 稳定标识是错的。Referenced 段落显式带了 ID，应该稳定出现。
	source := "# Title\n\nSome text.\n\n## Sub\n\nReferenced paragraph.\n{: id=\"20260101000000-abcdefg\"}\n\nSee @@cmd(foo) here.\n"
	if err := os.WriteFile(absPath, []byte(source), 0644); nil != err {
		t.Fatal(err)
	}

	markdown, blocks, err := LoadMarkdownDoc(boxID, relPath)
	if nil != err {
		t.Fatalf("LoadMarkdownDoc failed: %s", err)
	}

	// 返回的字节必须和落盘之后的字节完全一致（含首次解析新分配、并写回的文档级 ID）。
	onDisk, err := os.ReadFile(absPath)
	if nil != err {
		t.Fatal(err)
	}
	if markdown != string(onDisk) {
		t.Fatalf("returned markdown does not match on-disk bytes:\nreturned:\n%s\non-disk:\n%s", markdown, onDisk)
	}
	if !strings.Contains(markdown, "@@cmd(foo)") {
		t.Fatalf("private syntax was not preserved in the returned markdown:\n%s", markdown)
	}

	var docBlock, referencedBlock *MarkdownBlockRef
	headingCount := 0
	for i := range blocks {
		b := &blocks[i]
		switch b.Type {
		case "NodeDocument":
			docBlock = b
		case "NodeHeading":
			headingCount++
		case "NodeParagraph":
			if "20260101000000-abcdefg" == b.ID {
				referencedBlock = b
			}
		}
	}
	if nil == docBlock || "" == docBlock.ID {
		t.Fatalf("missing document root block ref (freshly assigned doc ID) in %+v", blocks)
	}
	if 0 != headingCount {
		t.Fatalf("un-referenced headings without an explicit ID must not appear in the block list, got %d in %+v", headingCount, blocks)
	}
	if nil == referencedBlock {
		t.Fatalf("paragraph with an explicit source ID is missing from the block list: %+v", blocks)
	}

	// 再读一次应该拿到同样的块 ID（幂等，Spike 1 已经验证过底层 lute 行为，这里验证到
	// LoadMarkdownDoc 这一层没有破坏这个性质）。
	markdown2, blocks2, err := LoadMarkdownDoc(boxID, relPath)
	if nil != err {
		t.Fatalf("second LoadMarkdownDoc failed: %s", err)
	}
	if markdown != markdown2 {
		t.Fatalf("second load returned different bytes:\nfirst:\n%s\nsecond:\n%s", markdown, markdown2)
	}
	if len(blocks) != len(blocks2) {
		t.Fatalf("second load returned a different number of blocks: %d vs %d", len(blocks), len(blocks2))
	}
	for i := range blocks {
		if blocks[i].ID != blocks2[i].ID {
			t.Fatalf("block ID at index %d changed across reloads: %s -> %s", i, blocks[i].ID, blocks2[i].ID)
		}
	}
}
