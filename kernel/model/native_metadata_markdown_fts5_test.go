// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

//go:build fts5

package model

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/util"
)

func TestNativeMetadataBulkMutationsDoNotTouchMarkdownOrCreateHistory(t *testing.T) {
	originalConf := Conf
	originalWorkspaceDir, originalConfDir := util.WorkspaceDir, util.ConfDir
	originalDataDir, originalHistoryDir := util.DataDir, util.HistoryDir
	originalTempDir, originalQueueDir := util.TempDir, util.QueueDir
	originalDBPath, originalHistoryDBPath := util.DBPath, util.HistoryDBPath
	originalAssetContentDBPath, originalBlockTreeDBPath := util.AssetContentDBPath, util.BlockTreeDBPath

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
		if err := os.MkdirAll(dir, 0o755); nil != err {
			t.Fatal(err)
		}
	}

	Conf = NewAppConf()
	Conf.FileTree = conf.NewFileTree()
	Conf.NotebookCrypto = conf.NewNotebookCrypto()
	Conf.Sync = conf.NewSync()
	Conf.Search = conf.NewSearch()
	boxID := "20260826053000-metaguard"
	setupMarkdownBoxForIndexTest(t, boxID)

	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(func() {
		sql.CloseDatabase()
		Conf = originalConf
		util.WorkspaceDir, util.ConfDir = originalWorkspaceDir, originalConfDir
		util.DataDir, util.HistoryDir = originalDataDir, originalHistoryDir
		util.TempDir, util.QueueDir = originalTempDir, originalQueueDir
		util.DBPath, util.HistoryDBPath = originalDBPath, originalHistoryDBPath
		util.AssetContentDBPath, util.BlockTreeDBPath = originalAssetContentDBPath, originalBlockTreeDBPath
	})

	const source = "#+begin meta\nid: 0198fc34-7b32-7a11-8cb4-6c40e3b33d72\n#+end meta\n\n# Guard\n\n#native-guard-tag\n\nBookmarked paragraph\n{: id=\"20260826053001-bookmrk\" bookmark=\"native-guard-bookmark\"}\n"
	if _, _, err := SaveMarkdownDoc(boxID, "/guard.md", source); nil != err {
		t.Fatal(err)
	}
	sql.FlushQueue()

	checks := []struct {
		name      string
		wantGuard bool
		run       func() error
	}{
		{name: "remove unindexed native tag", run: func() error { return RemoveTag("native-guard-tag") }},
		{name: "rename unindexed native tag", run: func() error { return RenameTag("native-guard-tag", "changed-tag") }},
		{name: "remove bookmark", wantGuard: true, run: func() error { return RemoveBookmark("native-guard-bookmark") }},
		{name: "rename bookmark", wantGuard: true, run: func() error { return RenameBookmark("native-guard-bookmark", "changed-bookmark") }},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			err := check.run()
			if check.wantGuard && !errors.Is(err, ErrMarkdownNativeDocumentTree) {
				t.Fatalf("expected Markdown native-tree rejection, got %v", err)
			}
			if !check.wantGuard && nil != err {
				t.Fatalf("expected no-op for tag absent from native spans, got %v", err)
			}
		})
	}

	onDisk, err := os.ReadFile(filepath.Join(util.DataDir, boxID, "guard.md"))
	if nil != err || source != string(onDisk) {
		t.Fatalf("bulk native metadata operation changed Markdown source: %q, err=%v", onDisk, err)
	}
	entries, err := os.ReadDir(util.HistoryDir)
	if nil != err || 0 != len(entries) {
		t.Fatalf("bulk native metadata operation created history before rejection: %+v, err=%v", entries, err)
	}
}
