// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

//go:build darwin && fts5

package model

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
)

// TestWatchMarkdownBoxIndexesExternallyWrittenFile 是 §1.5 的完整端到端验证：
// 外部编辑器（模拟 Emacs）往一个已挂载的 markdown box 里直接写一个全新的 .md
// 文件，watcher 应该在轮询间隔内探测到并通过 UpsertIndexes 重新索引，同时保持
// Markdown 源文件字节不变。需要 -tags fts5，见 markdown_doc_save_fts5_test.go
// 顶部关于这个 tag 为什么必需的说明；不带这个 tag 时的轻量版本
// （只测 watcher 生命周期，不触达 sql 层）在 markdown_watcher_darwin_test.go。
//
//	go test -tags fts5 ./model/... -run TestWatchMarkdownBoxIndexesExternallyWrittenFile
func TestWatchMarkdownBoxIndexesExternallyWrittenFile(t *testing.T) {
	workspaceDir := t.TempDir()
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
			t.Fatalf("create test directory [%s] failed: %v", dir, err)
		}
	}

	Conf = NewAppConf()
	Conf.FileTree = conf.NewFileTree()
	Conf.NotebookCrypto = conf.NewNotebookCrypto()
	Conf.Sync = conf.NewSync()
	Conf.Search = conf.NewSearch()

	boxID := "20260825020000-watchfts5"
	box := &Box{ID: boxID}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Watch fts5 test"
	if err := box.SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(util.DataDir, boxID), 0755); nil != err {
		t.Fatal(err)
	}

	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)

	WatchMarkdownBox(boxID)
	t.Cleanup(func() { CloseWatchMarkdownBox(boxID) })

	relPath := "/notes/hello.md"
	absPath := filepath.Join(util.DataDir, boxID, relPath)
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); nil != err {
		t.Fatal(err)
	}
	source := "# Hello\n\nWritten by the watcher test, like Emacs would.\n"
	if err := os.WriteFile(absPath, []byte(source), 0644); nil != err {
		t.Fatal(err)
	}

	deadline := time.Now().Add(5 * time.Second)
	var bt *treenode.BlockTree
	for time.Now().Before(deadline) {
		bt = treenode.GetBlockTreeRootByPath(boxID, relPath)
		if nil != bt {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if nil == bt {
		t.Fatal("watcher did not index the externally-written markdown file within the deadline")
	}

	raw, err := os.ReadFile(absPath)
	if nil != err {
		t.Fatal(err)
	}
	if string(raw) != source {
		t.Fatalf("watcher must not rewrite source-authoritative Markdown:\nwant: %q\n got: %q", source, raw)
	}
	if strings.Contains(string(raw), `type="doc"`) {
		t.Fatalf("watcher must not persist a synthetic document IAL:\n%s", raw)
	}

	sql.FlushQueue()
}
