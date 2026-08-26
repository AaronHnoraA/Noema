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
	"github.com/aaronhe/noema/kernel/util"
)

// TestFullTextSearchFindsMarkdownBoxContent 目标是关上计划文档 Phase 1.5 验收
// 标准里的"/api/search/* 能命中"，但实测发现这条现在**必然失败**：惰性 IAL
// （§1.2）和全文检索直接冲突——没有显式 {: id=...} 的标题/段落永远拿不到真实
// 持久化 ID，而 sql/database.go:684（fromTree 的兜底分支）要求 n.ID 非空才会
// 把这个节点写进 blocks/blocks_fts 表。任何一篇没有主动加引用/属性的普通笔记，
// 正文内容都不会进入可搜索索引——这是思源本来的设计（.sy 世界里每个块永远有
// ID，这条判断从来不会触发），不是这次改动引入的 bug。
//
// 完整分析和三个候选方案（A：markdown box 也让每块都有真实 ID，放弃"惰性"；
// B：改成文档级索引，保留惰性 IAL，搜索精度降到"命中哪篇笔记"；C：检索专用
// 的临时 ID，复杂度最高不推荐）写在计划文档 §1.2 的进度记录里，需要 Aaron
// 拍板选哪个方向，不是能单方面替他决定的产品取舍，所以先不实现任何一个。
// 这个测试先跳过（不是删掉）：它是"哪个方案生效了"的现成验收标准，等选定
// 方向、代码落地后，去掉 t.Skip 就应该直接变绿。
//
//	go test -tags fts5 ./model/... -run TestFullTextSearchFindsMarkdownBoxContent
func TestFullTextSearchFindsMarkdownBoxContent(t *testing.T) {
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

	boxID := "20260825030000-searchfts5"
	box := &Box{ID: boxID}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Search fts5 test"
	if err := box.SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}

	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)

	relPath := "/notes/100%_needle.md"
	source := "# Findable Title\n\nA paragraph containing a very distinctive noemasearchneedle token for full text search.\n"
	if _, _, err := SaveMarkdownDoc(boxID, relPath, source); nil != err {
		t.Fatalf("SaveMarkdownDoc failed: %s", err)
	}
	siblingPath := "/notes/100XYneedle.md"
	if _, _, err := SaveMarkdownDoc(boxID, siblingPath, source); nil != err {
		t.Fatalf("SaveMarkdownDoc sibling failed: %s", err)
	}
	sql.FlushQueue()

	// types/subTypes 必须传 nil，不能传空 map：buildTypeFilter 把非 nil 的空 map
	// 当成"每个类型都显式设为 false"，而不是"不过滤、用 Conf.Search 的默认值"——
	// 传空 map 会把包括 document 在内的所有类型全部关掉，搜索永远查不到东西。
	blocks, matchedBlockCount, _, _, _ := FullTextSearchBlock(
		"noemasearchneedle", nil, nil, nil, nil, 0, 0, 0, 1, 32,
	)
	if 0 == matchedBlockCount {
		t.Fatal("full-text search found nothing for a markdown box document — FTS5 indexing did not pick it up")
	}

	found := false
	for _, b := range blocks {
		if b.Box == boxID && b.Path == relPath {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("full-text search matched %d block(s), but none from the markdown box document [%s%s]: %+v", matchedBlockCount, boxID, relPath, blocks)
	}

	blocks, matchedBlockCount, _, _, _ = FullTextSearchBlock(
		"noemasearchneedle", []string{boxID}, []string{relPath}, nil, nil, 0, 0, 0, 1, 32,
	)
	if 1 != matchedBlockCount || 1 != len(blocks) || relPath != blocks[0].Path {
		t.Fatalf("escaped Markdown path filter should match only %q, got count=%d blocks=%+v", relPath, matchedBlockCount, blocks)
	}
}
