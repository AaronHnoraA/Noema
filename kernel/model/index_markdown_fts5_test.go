// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

//go:build fts5

package model

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
)

// TestUpsertThenRemoveIndexesRoundTripsMarkdownBoxWithRealSQL 是
// UpsertIndexes/RemoveIndexes 的完整端到端验证，含真正的 sql.UpsertTreeQueue/
// RemoveTreeQueue 落到数据库那一步——补上 index_markdown_test.go 里因为没有
// -tags fts5 而只测到 filesys+treenode 边界的那部分。
//
//	go test -tags fts5 ./model/... -run TestUpsertThenRemoveIndexesRoundTripsMarkdownBoxWithRealSQL
func TestUpsertThenRemoveIndexesRoundTripsMarkdownBoxWithRealSQL(t *testing.T) {
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

	boxID := "20260825020000-idxfts501"
	box := &Box{ID: boxID}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Index fts5 test"
	if err := box.SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}

	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)

	foreignRelPath := "/notes/foreign.sy"
	foreignAbsPath := filepath.Join(util.DataDir, boxID, foreignRelPath)
	if err := os.MkdirAll(filepath.Dir(foreignAbsPath), 0755); nil != err {
		t.Fatal(err)
	}
	foreignSource := []byte("# Foreign native export\n\nMust remain an ordinary repository file.\n")
	if err := os.WriteFile(foreignAbsPath, foreignSource, 0644); nil != err {
		t.Fatal(err)
	}
	UpsertIndexes([]string{boxID + foreignRelPath})
	sql.FlushQueue()
	if bt := treenode.GetBlockTreeRootByPath(boxID, foreignRelPath); nil != bt {
		t.Fatalf("foreign .sy file in Markdown repository entered blocktree: %+v", bt)
	}
	if rows := sql.SelectBlocksRawStmtArgs("SELECT * FROM blocks WHERE box = ? AND path = ?", []any{boxID, foreignRelPath}, 2); 0 != len(rows) {
		t.Fatalf("foreign .sy file in Markdown repository entered SQL: %+v", rows)
	}
	if got, err := os.ReadFile(foreignAbsPath); nil != err || string(got) != string(foreignSource) {
		t.Fatalf("foreign .sy file changed during ignored index request: bytes=%q err=%v", got, err)
	}

	relPath := "/notes/hello.md"
	absPath := filepath.Join(util.DataDir, boxID, relPath)
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); nil != err {
		t.Fatal(err)
	}
	source := "# Hello\n\nWritten directly to disk, like Emacs would.\n"
	if err := os.WriteFile(absPath, []byte(source), 0644); nil != err {
		t.Fatal(err)
	}

	UpsertIndexes([]string{boxID + relPath})
	sql.FlushQueue()

	bt := treenode.GetBlockTreeRootByPath(boxID, relPath)
	if nil == bt {
		t.Fatal("UpsertIndexes did not index the markdown file")
	}
	if nil == sql.GetBlock(bt.RootID) {
		t.Fatal("UpsertIndexes did not reach the sql layer — root block not indexed")
	}

	// A stray .sy whose stem happens to equal a live Markdown projection ID
	// must not make RemoveIndexes delete that projection by filename-derived ID.
	foreignRemoveRelPath := "/notes/" + bt.RootID + ".sy"
	if err := os.WriteFile(filepath.Join(util.DataDir, boxID, foreignRemoveRelPath), foreignSource, 0644); nil != err {
		t.Fatal(err)
	}
	RemoveIndexes([]string{boxID + foreignRemoveRelPath})
	sql.FlushQueue()
	if nil == treenode.GetBlockTreeRootByPath(boxID, relPath) || nil == sql.GetBlock(bt.RootID) {
		t.Fatal("foreign .sy removal request deleted the live Markdown projection")
	}
	if got, err := os.ReadFile(filepath.Join(util.DataDir, boxID, foreignRemoveRelPath)); nil != err || string(got) != string(foreignSource) {
		t.Fatalf("foreign .sy file changed during ignored removal request: bytes=%q err=%v", got, err)
	}
	if got, err := os.ReadFile(absPath); nil != err || string(got) != source {
		t.Fatalf("live Markdown source changed during foreign removal request: bytes=%q err=%v", got, err)
	}

	if err := os.Remove(absPath); nil != err {
		t.Fatal(err)
	}
	RemoveIndexes([]string{boxID + relPath})
	sql.FlushQueue()

	if nil != treenode.GetBlockTreeRootByPath(boxID, relPath) {
		t.Fatal("RemoveIndexes did not remove the blocktree entry")
	}
	if nil != sql.GetBlock(bt.RootID) {
		t.Fatal("RemoveIndexes did not remove the sql root block")
	}
}
