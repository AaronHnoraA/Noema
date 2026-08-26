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
	"strings"
	"sync"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
)

func TestSaveMarkdownDocCASSerializesConcurrentWritersAndIndexesWinner(t *testing.T) {
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

	boxID := "20260826093000-casfts5"
	box := &Box{ID: boxID}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "CAS fts5 test"
	if err := box.SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}

	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)

	const relPath = "/notes/race.md"
	const initial = "# Initial CAS source\n"
	if _, _, err := SaveMarkdownDoc(boxID, relPath, initial); nil != err {
		t.Fatal(err)
	}
	expected := markdownDocVersion([]byte(initial))
	writes := []string{
		"# Alpha CAS winner\n\nalpha-cas-marker\n",
		"# Bravo CAS winner\n\nbravo-cas-marker\n",
	}
	type outcome struct {
		result *MarkdownDocCASResult
		err    error
	}
	start := make(chan struct{})
	outcomes := make(chan outcome, len(writes))
	var ready sync.WaitGroup
	ready.Add(len(writes))
	for _, source := range writes {
		go func(source string) {
			ready.Done()
			<-start
			result, err := SaveMarkdownDocCAS(boxID, relPath, source, expected, false)
			outcomes <- outcome{result: result, err: err}
		}(source)
	}
	ready.Wait()
	close(start)

	var winner, loser *MarkdownDocCASResult
	for range writes {
		outcome := <-outcomes
		if nil != outcome.err {
			t.Fatal(outcome.err)
		}
		if outcome.result.Conflict {
			loser = outcome.result
		} else {
			winner = outcome.result
		}
	}
	if nil == winner || nil == loser {
		t.Fatalf("expected one winner and one conflict, got winner=%+v conflict=%+v", winner, loser)
	}
	if loser.Markdown != winner.Markdown || loser.Version != winner.Version {
		t.Fatalf("conflict did not report the committed winner: winner=%+v conflict=%+v", winner, loser)
	}
	absPath := filepath.Join(util.DataDir, boxID, relPath)
	if onDisk, err := os.ReadFile(absPath); nil != err || string(onDisk) != winner.Markdown {
		t.Fatalf("disk does not contain CAS winner: content=%q err=%v winner=%q", onDisk, err, winner.Markdown)
	}

	sql.FlushQueue()
	bt := treenode.GetBlockTreeRootByPath(boxID, relPath)
	if nil == bt {
		t.Fatal("CAS winner was not projected into the block tree")
	}
	block := sql.GetBlockInBox(bt.RootID, boxID)
	winnerMarker := strings.TrimSpace(strings.SplitN(winner.Markdown, "\n\n", 2)[1])
	if nil == block || !strings.Contains(block.Content, winnerMarker) {
		t.Fatalf("SQL projection does not contain CAS winner: tree=%+v block=%+v winner=%q", bt, block, winner.Markdown)
	}
}

// TestSaveMarkdownDocWritesAndIndexes 是 SaveMarkdownDoc 的完整端到端验证，
// 含它对 UpsertIndexes 的调用一路走到 sql.UpsertTreeQueue。这一步需要项目的
// fts5 cgo 编译支持（sql.InitDatabase 在没有这个 tag 时会直接
// "no such module: fts5" fatal，不只是 file_index_test.go 那种"贵，选择性
// 运行"的标签），这个会话默认的 go test ./... 没有带 -tags fts5，所以这个
// 文件不在默认验证范围内——同类不带 tag 的校验分支测试见
// markdown_doc_save_test.go。真正跑这个文件：
//
//	go test -tags fts5 ./model/... -run TestSaveMarkdownDocWritesAndIndexes
func TestSaveMarkdownDocWritesAndIndexes(t *testing.T) {
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

	boxID := "20260825010000-savefts5"
	box := &Box{ID: boxID}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Save fts5 test"
	if err := box.SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}

	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)

	relPath := "/notes/edited.md"
	source := "# Edited\n\nSee @@cmd(bar) here.\n"

	saved, blocks, err := SaveMarkdownDoc(boxID, relPath, source)
	if nil != err {
		t.Fatalf("SaveMarkdownDoc failed: %s", err)
	}
	if !strings.Contains(saved, "@@cmd(bar)") {
		t.Fatalf("private syntax lost on save: %s", saved)
	}

	absPath := filepath.Join(util.DataDir, boxID, relPath)
	onDisk, err := os.ReadFile(absPath)
	if nil != err {
		t.Fatal(err)
	}
	if saved != string(onDisk) {
		t.Fatalf("returned bytes don't match what's on disk:\nreturned:\n%s\non-disk:\n%s", saved, onDisk)
	}

	var docBlock *MarkdownBlockRef
	for i := range blocks {
		if "NodeDocument" == blocks[i].Type {
			docBlock = &blocks[i]
		}
	}
	if nil == docBlock || "" == docBlock.ID {
		t.Fatalf("missing document root block ref after save: %+v", blocks)
	}

	sql.FlushQueue()
	bt := treenode.GetBlockTreeRootByPath(boxID, relPath)
	if nil == bt || bt.RootID != docBlock.ID {
		t.Fatalf("blocktree not updated by SaveMarkdownDoc's UpsertIndexes call: %+v (want root %s)", bt, docBlock.ID)
	}
}
