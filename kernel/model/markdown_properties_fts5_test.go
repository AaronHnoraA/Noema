// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
//go:build fts5

package model

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
)

func TestMutateMarkdownPropertyWritesAndReindexes(t *testing.T) {
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
			t.Fatal(err)
		}
	}
	Conf = NewAppConf()
	Conf.FileTree = conf.NewFileTree()
	Conf.NotebookCrypto = conf.NewNotebookCrypto()
	Conf.Sync = conf.NewSync()
	Conf.Search = conf.NewSearch()

	boxID := "20260825000000-propfts1"
	setupMarkdownBoxForIndexTest(t, boxID)
	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)

	path := "/properties.md"
	id := "0198fc34-7b32-7a11-8cb4-6c40e3b33d68"
	source := "#+begin meta\nid: 019d2a10-bfa1-7e1b-8c21-a1f9c4f31f10\n#+end meta\n\nClaim {#" + id + " status=draft owner='Aaron He'}\n"
	if _, _, err := SaveMarkdownDoc(boxID, path, source); nil != err {
		t.Fatal(err)
	}
	documents, err := ListMarkdownPropertyBlocks(boxID, path)
	if nil != err {
		t.Fatal(err)
	}
	value := "Noema Team"
	result, err := MutateMarkdownProperty(MarkdownPropertyMutationRequest{
		Notebook: boxID, Path: path, ExpectedVersion: documents[0].Version,
		ID: id, Key: "owner", Value: &value,
	})
	if nil != err {
		t.Fatal(err)
	}
	if !result.Changed || result.Block.Properties["owner"] != value {
		t.Fatalf("unexpected property mutation result: %+v", result)
	}
	onDisk, _ := os.ReadFile(filepath.Join(util.DataDir, boxID, path))
	if !strings.Contains(string(onDisk), "status=draft owner='Noema Team'") || strings.Contains(string(onDisk), "owner='Aaron He'") {
		t.Fatalf("property mutation did not persist exact anchor patch: %q", onDisk)
	}
	sql.FlushQueue()
	if bt := treenode.GetBlockTreeRootByPath(boxID, path); nil == bt || bt.RootID == "" {
		t.Fatalf("property mutation did not reindex document: %+v", bt)
	}
}
