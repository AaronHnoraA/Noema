// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema Markdown asset-content indexing tests are Copyright (c) 2026
// Aaron He and distributed under the same AGPL-3.0-or-later terms.

//go:build fts5

package model

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/util"
)

func TestSearchMarkdownAssetContentIndexesReferencedAttachment(t *testing.T) {
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

	boxID := "20260826000000-assetfts"
	setupMarkdownBoxForIndexTest(t, boxID)
	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)

	root := filesys.BoxRootPath(boxID)
	asset := filepath.Join(root, "attachments", "reports", "topic.txt")
	if err := os.MkdirAll(filepath.Dir(asset), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(asset, []byte("The quasarneedle belongs to this Noema attachment."), 0644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := SaveMarkdownDoc(boxID, "/research/note.md", "# Research\n\n[report](../attachments/reports/topic.txt)\n"); err != nil {
		t.Fatal(err)
	}

	assets, total, indexed, err := SearchMarkdownAssetContent(boxID, "quasarneedle", 20)
	if err != nil {
		t.Fatal(err)
	}
	if indexed != 1 || total != 1 || len(assets) != 1 {
		t.Fatalf("unexpected attachment search counts: indexed=%d total=%d assets=%+v", indexed, total, assets)
	}
	if assets[0].File != asset || assets[0].Path != "attachments/reports/topic.txt" {
		t.Fatalf("attachment result did not resolve to Markdown box: %+v", assets[0])
	}
	if !strings.Contains(strings.ToLower(assets[0].Content), "quasarneedle") {
		t.Fatalf("attachment result omitted matching content: %q", assets[0].Content)
	}
}

func waitObsidianTaskState(t *testing.T, taskID string, states ...string) *ObsidianVaultTask {
	t.Helper()
	accepted := map[string]bool{}
	for _, state := range states {
		accepted[state] = true
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		task, err := GetObsidianVaultTask(taskID)
		if err != nil {
			t.Fatal(err)
		}
		if accepted[task.State] {
			return task
		}
		if task.State == ObsidianTaskStateFailed || task.State == ObsidianTaskStateCancelled {
			t.Fatalf("Obsidian task stopped in %s: %+v", task.State, task)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for Obsidian task %s", taskID)
	return nil
}

func TestObsidianVaultMarkdownImportCommitsNativeRepository(t *testing.T) {
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
	boxID := "20260826000000-obsidian"
	setupMarkdownBoxForIndexTest(t, boxID)
	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)

	obsidianTasksMu.Lock()
	previousTasks, previousActive := obsidianTasks, obsidianActive
	obsidianTasks = map[string]*obsidianTask{}
	obsidianActive = ""
	obsidianTasksMu.Unlock()
	t.Cleanup(func() {
		obsidianTasksMu.Lock()
		for _, task := range obsidianTasks {
			if task.Cancel != nil {
				task.Cancel()
			}
		}
		obsidianTasks, obsidianActive = previousTasks, previousActive
		obsidianTasksMu.Unlock()
	})

	vault := filepath.Join(t.TempDir(), "Vault")
	for _, dir := range []string{filepath.Join(vault, ".obsidian"), filepath.Join(vault, "Folder")} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	vault, err := filepath.EvalSymlinks(vault)
	if err != nil {
		t.Fatal(err)
	}
	homeSource := "[[Folder/Target|Target]]\n![[image.png]]\n[[Folder/Target#^legacy|block]]\n"
	if err := os.WriteFile(filepath.Join(vault, "Home.md"), []byte(homeSource), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(vault, "Folder", "Target.md"), []byte("Paragraph ^legacy\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(vault, "image.png"), []byte("image"), 0644); err != nil {
		t.Fatal(err)
	}

	started, err := StartObsidianVaultAnalysis(vault)
	if err != nil {
		t.Fatal(err)
	}
	ready := waitObsidianTaskState(t, started.TaskID, ObsidianTaskStateReady)
	if ready.Analysis == nil || ready.Analysis.MarkdownCount != 2 || ready.Analysis.ImportableAssetCount != 1 {
		t.Fatalf("unexpected Vault analysis: %+v", ready.Analysis)
	}
	if _, err = StartObsidianVaultMarkdownImport(started.TaskID, boxID, "Imports/Vault"); err != nil {
		t.Fatal(err)
	}
	completed := waitObsidianTaskState(t, started.TaskID, ObsidianTaskStateCompleted)
	if completed.Result == nil || completed.Result.Source != "noema-markdown" || completed.Result.Destination != "Imports/Vault" {
		t.Fatalf("unexpected Markdown import result: %+v", completed.Result)
	}

	root := filesys.BoxRootPath(boxID)
	home, err := os.ReadFile(filepath.Join(root, "Imports", "Vault", "Home.md"))
	if err != nil {
		t.Fatal(err)
	}
	converted := string(home)
	if !strings.Contains(converted, "[Target](Folder/Target.md)") || !strings.Contains(converted, "![image.png](image.png)") {
		t.Fatalf("Obsidian links did not become relative Markdown: %q", converted)
	}
	blockReference := regexp.MustCompile(`\(\([0-9a-f-]{36} "block"\)\)`)
	if !blockReference.MatchString(converted) {
		t.Fatalf("Obsidian block reference was not converted: %q", converted)
	}
	target, err := os.ReadFile(filepath.Join(root, "Imports", "Vault", "Folder", "Target.md"))
	if err != nil || !regexp.MustCompile(`\{#[0-9a-f-]{36}\}`).Match(target) {
		t.Fatalf("Obsidian block anchor was not converted: %q, %v", target, err)
	}
	if image, readErr := os.ReadFile(filepath.Join(root, "Imports", "Vault", "image.png")); readErr != nil || string(image) != "image" {
		t.Fatalf("Vault asset was not preserved: %q, %v", image, readErr)
	}
	if original, readErr := os.ReadFile(filepath.Join(vault, "Home.md")); readErr != nil || string(original) != homeSource {
		t.Fatalf("source Vault was modified: %q, %v", original, readErr)
	}
}
