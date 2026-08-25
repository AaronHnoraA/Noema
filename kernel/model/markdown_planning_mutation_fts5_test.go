// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema planning additions are Copyright (c) 2026 Aaron He and distributed
// under the same AGPL-3.0-or-later terms.

//go:build fts5

package model

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	noemaplanning "github.com/aaronhe/noema/kernel/noema/planning"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
)

func TestMutateMarkdownPlanningWritesAndReindexes(t *testing.T) {
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

	boxID := "20260825000000-mutfts51"
	setupMarkdownBoxForIndexTest(t, boxID)
	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)

	path := "/agenda.md"
	const source = "#+begin meta\nid: 019d2a10-bfa1-7e1b-8c21-a1f9c4f31f10\n#+end meta\n\n@@todo [Before] {id: task01}\n"
	if _, _, err := SaveMarkdownDoc(boxID, path, source); err != nil {
		t.Fatal(err)
	}
	documents, err := ListMarkdownPlanning(boxID, path)
	if err != nil {
		t.Fatal(err)
	}
	node := documents[0].Nodes[0]
	status, owner := "done", "Kernel"
	replacement := "@@todo(done) [Before] {id=task01, owner=Kernel}"
	result, err := MutateMarkdownPlanning(MarkdownPlanningMutationRequest{
		Notebook: boxID, Path: path, ExpectedVersion: documents[0].Version,
		Selector: MarkdownPlanningSelector{Kind: "todo", Index: &node.Span.From, Source: node.Raw},
		Mutation: MarkdownPlanningMutation{Type: "patch-todo", Todo: &noemaplanning.TodoPatch{
			Status: &status, Attrs: map[string]*string{"owner": &owner},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || result.Node == nil || result.Node.Status != "done" {
		t.Fatalf("unexpected mutation result: %+v", result)
	}
	onDisk, _ := os.ReadFile(filepath.Join(util.DataDir, boxID, path))
	if !strings.Contains(string(onDisk), replacement) || strings.Contains(string(onDisk), "@@todo [Before]") {
		t.Fatalf("planning mutation did not persist exact replacement: %q", onDisk)
	}
	sql.FlushQueue()
	if bt := treenode.GetBlockTreeRootByPath(boxID, path); bt == nil || bt.RootID == "" {
		t.Fatalf("planning mutation did not reindex document: %+v", bt)
	}

	originalTodoID, originalDocumentID := newMarkdownPlanningTodoID, newMarkdownPlanningDocumentID
	newMarkdownPlanningTodoID = func() (string, error) { return "new001", nil }
	newMarkdownPlanningDocumentID = func() (string, error) {
		return "019d2a10-bfa1-7e1b-8c21-a1f9c4f31f11", nil
	}
	t.Cleanup(func() {
		newMarkdownPlanningTodoID = originalTodoID
		newMarkdownPlanningDocumentID = originalDocumentID
	})
	created, err := MutateMarkdownPlanning(MarkdownPlanningMutationRequest{
		Notebook: boxID, Path: "/new/inbox.md",
		Mutation: MarkdownPlanningMutation{Type: "append-todo", Create: &noemaplanning.TodoCreate{
			Title: "Indexed create", Attrs: map[string]string{"owner": "Kernel"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.Node == nil || created.Node.Attrs["id"] != "new001" || created.Node.Attrs["owner"] != "Kernel" {
		t.Fatalf("semantic create result was not projected: %+v", created)
	}
	sql.FlushQueue()
	if bt := treenode.GetBlockTreeRootByPath(boxID, "/new/inbox.md"); bt == nil || bt.RootID == "" {
		t.Fatalf("semantic create did not reindex new document: %+v", bt)
	}
}
