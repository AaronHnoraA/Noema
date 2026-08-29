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
	noemaidentity "github.com/aaronhe/noema/kernel/noema/identity"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
)

func TestMutateMarkdownMetaWritesAndReindexesCanonicalUUIDv7(t *testing.T) {
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
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	Conf = NewAppConf()
	Conf.FileTree = conf.NewFileTree()
	Conf.NotebookCrypto = conf.NewNotebookCrypto()
	Conf.Sync = conf.NewSync()
	Conf.Search = conf.NewSearch()

	boxID := "20260826090000-metafts5"
	box := &Box{ID: boxID}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	if err := box.SaveConf(boxConf); err != nil {
		t.Fatal(err)
	}
	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)

	path := "/notes/paper.md"
	absPath := filepath.Join(util.DataDir, boxID, path)
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); err != nil {
		t.Fatal(err)
	}
	source := "# Meta search sentinel\n\nBody remains exact.\n"
	if err := os.WriteFile(absPath, []byte(source), 0644); err != nil {
		t.Fatal(err)
	}
	tags := []string{"kernel", "metadata"}
	result, err := MutateMarkdownMeta(MarkdownMetaMutationRequest{
		Notebook: boxID, Path: path, Action: "add", Tags: &tags,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || !noemaidentity.IsUUIDv7(result.ID) || !strings.HasSuffix(result.Markdown, source) {
		t.Fatalf("unexpected mutation result: %+v", result)
	}
	sql.FlushQueue()
	projectionID := noemaidentity.ProjectionID(result.ID, "")
	if tree := treenode.GetBlockTreeRootByPath(boxID, path); tree == nil || tree.RootID != projectionID {
		t.Fatalf("metadata identity was not reindexed: tree=%+v projection=%s", tree, projectionID)
	}
	if !documentIsIndexed(boxID, path, "Meta search sentinel") {
		t.Fatalf("metadata document is absent from SQL/FTS projection: %+v", blocksByBoxPath(boxID, path))
	}
}
