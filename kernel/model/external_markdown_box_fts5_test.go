// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema external markdown-box registry additions are Copyright (c) 2026
// Aaron He and distributed under the same AGPL-3.0-or-later terms.

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

func TestExternalMarkdownBoxSaveWritesRepositoryAndIndexesShadowBox(t *testing.T) {
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

	repositoryRoot := filepath.Join(t.TempDir(), "external-repository")
	writeExternalRepositoryFixture(t, repositoryRoot, "# Existing\n")
	registration, err := RegisterExternalMarkdownBox("External", repositoryRoot, "")
	if nil != err {
		t.Fatal(err)
	}

	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)

	const relPath = "/notes/new.md"
	const source = "#+begin meta\nid: 0198fc34-7b32-7a11-8cb4-6c40e3b33d71\n#+end meta\n\n# Indexed externally\n"
	if _, _, err = SaveMarkdownDoc(registration.ID, relPath, source); nil != err {
		t.Fatal(err)
	}
	onDisk, err := os.ReadFile(filepath.Join(repositoryRoot, relPath))
	if nil != err {
		t.Fatal(err)
	}
	if string(onDisk) != source {
		t.Fatalf("save did not preserve external source bytes: %q", onDisk)
	}
	if _, err = os.Stat(filepath.Join(util.DataDir, registration.ID, "notes", "new.md")); !os.IsNotExist(err) {
		t.Fatalf("Markdown was copied into the shadow box, stat err=%v", err)
	}

	sql.FlushQueue()
	bt := treenode.GetBlockTreeRootByPath(registration.ID, relPath)
	if nil == bt {
		t.Fatal("external Markdown save did not update blocktree index")
	}
	if bt.RootID == "" {
		t.Fatal("external Markdown index has an empty internal projection")
	}

	// Removing/unregistering the box must delete only the workspace shadow,
	// never the external repository or its source.
	if err = RemoveBox(registration.ID); nil != err {
		t.Fatalf("unregister external box: %v", err)
	}
	if remaining, readErr := os.ReadFile(filepath.Join(repositoryRoot, relPath)); nil != readErr || string(remaining) != source {
		t.Fatalf("unregister removed or changed external source: bytes=%q err=%v", remaining, readErr)
	}
	if _, statErr := os.Stat(filepath.Join(util.DataDir, registration.ID)); !os.IsNotExist(statErr) {
		t.Fatalf("shadow registration still exists after removal, stat err=%v", statErr)
	}
}
