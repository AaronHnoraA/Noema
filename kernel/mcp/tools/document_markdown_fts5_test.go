// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema Markdown MCP tests are Copyright (c) 2026 Aaron He and distributed
// under the same AGPL-3.0-or-later terms.

//go:build fts5

package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/util"
)

func TestDocumentToolUsesRepositoryNativeMarkdownPaths(t *testing.T) {
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
	model.Conf = model.NewAppConf()
	model.Conf.Editor = conf.NewEditor()
	model.Conf.FileTree = conf.NewFileTree()
	model.Conf.NotebookCrypto = conf.NewNotebookCrypto()
	model.Conf.Sync = conf.NewSync()
	model.Conf.Search = conf.NewSearch()
	boxID := "20260826153000-mcpmark"
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Noema MCP"
	boxConf.Closed = false
	if err := (&model.Box{ID: boxID}).SaveConf(boxConf); err != nil {
		t.Fatal(err)
	}
	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)

	created, err := documentHandler(map[string]any{
		"action": "create", "notebook": boxID, "path": "/inbox/idea", "title": "Idea",
		"markdown": "# Idea\n\nRepository-native body.\n",
	})
	if err != nil || created.IsError {
		t.Fatalf("Markdown MCP create failed: %+v, %v", created, err)
	}
	createdPath := filepath.Join(util.DataDir, boxID, "inbox", "idea.md")
	if data, readErr := os.ReadFile(createdPath); readErr != nil || string(data) != "# Idea\n\nRepository-native body.\n" {
		t.Fatalf("MCP did not write source Markdown: %q, %v", data, readErr)
	}

	loaded, err := documentHandler(map[string]any{"action": "get", "notebook": boxID, "path": "/inbox/idea.md"})
	if err != nil || loaded.IsError || !strings.Contains(loaded.Content[0].Text, "Repository-native body") {
		t.Fatalf("Markdown MCP get failed: %+v, %v", loaded, err)
	}
	renamed, err := documentHandler(map[string]any{
		"action": "rename", "notebook": boxID, "source_path": "/inbox/idea.md", "title": "thesis",
	})
	if err != nil || renamed.IsError {
		t.Fatalf("Markdown MCP rename failed: %+v, %v", renamed, err)
	}
	moved, err := documentHandler(map[string]any{
		"action": "move", "notebook": boxID, "source_path": "/inbox/thesis.md", "path": "/archive/thesis.md",
	})
	if err != nil || moved.IsError {
		t.Fatalf("Markdown MCP move failed: %+v, %v", moved, err)
	}
	if data, readErr := os.ReadFile(filepath.Join(util.DataDir, boxID, "archive", "thesis.md")); readErr != nil || !strings.Contains(string(data), "Repository-native body") {
		t.Fatalf("MCP move did not preserve Markdown bytes: %q, %v", data, readErr)
	}
	listed, err := documentHandler(map[string]any{"action": "list", "notebook": boxID, "path": "/archive"})
	if err != nil || listed.IsError || !strings.Contains(listed.Content[0].Text, "/archive/thesis.md") {
		t.Fatalf("Markdown MCP list failed: %+v, %v", listed, err)
	}
}
