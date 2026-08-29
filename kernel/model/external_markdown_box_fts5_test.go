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
	Conf.Editor = conf.NewEditor()
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
	registeredBox := &Box{ID: registration.ID}
	registeredConf := registeredBox.GetConf()
	registeredConf.Closed = false
	if err = registeredBox.SaveConf(registeredConf); nil != err {
		t.Fatalf("open registered Markdown box: %v", err)
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
	const movedPath = "/archive/renamed.markdown"
	move, moveErr := MoveMarkdownDoc(registration.ID, relPath, movedPath)
	if nil != moveErr {
		t.Fatalf("move external Markdown document: %v", moveErr)
	}
	if move.FromPath != relPath || move.ToPath != movedPath || move.ID != bt.RootID {
		t.Fatalf("unexpected Markdown move result: %+v", move)
	}
	if _, statErr := os.Stat(filepath.Join(repositoryRoot, relPath)); !os.IsNotExist(statErr) {
		t.Fatalf("old Markdown path survived move: %v", statErr)
	}
	if movedSource, readErr := os.ReadFile(filepath.Join(repositoryRoot, movedPath)); nil != readErr || string(movedSource) != source {
		t.Fatalf("move changed source bytes: bytes=%q err=%v", movedSource, readErr)
	}
	if oldTree := treenode.GetBlockTreeRootByPath(registration.ID, relPath); nil != oldTree {
		t.Fatalf("old blocktree path survived move: %+v", oldTree)
	}
	if movedTree := treenode.GetBlockTreeRootByPath(registration.ID, movedPath); nil == movedTree || movedTree.RootID != bt.RootID || movedTree.HPath != movedPath {
		t.Fatalf("moved blocktree path/identity mismatch: %+v", movedTree)
	}
	if oldRows := blocksByBoxPath(registration.ID, relPath); 0 != len(oldRows) {
		t.Fatalf("old SQL path survived move: %+v", oldRows)
	}
	if movedRows := blocksByBoxPath(registration.ID, movedPath); 1 > len(movedRows) || movedRows[0].HPath != movedPath {
		t.Fatalf("moved SQL path missing: %+v", movedRows)
	}

	const directoryA = "#+begin meta\nid: 0198fc34-7b32-7a11-8cb4-6c40e3b33d81\n#+end meta\n\n# Directory A\n"
	const directoryB = "#+begin meta\nid: 0198fc34-7b32-7a11-8cb4-6c40e3b33d82\n#+end meta\n\n# Directory B\n"
	if _, _, err = SaveMarkdownDoc(registration.ID, "/drafts/topic/a.md", directoryA); nil != err {
		t.Fatal(err)
	}
	if _, _, err = SaveMarkdownDoc(registration.ID, "/drafts/topic/b.markdown", directoryB); nil != err {
		t.Fatal(err)
	}
	assetPath := filepath.Join(repositoryRoot, "drafts", "topic", "images", "plot.png")
	if err = os.MkdirAll(filepath.Dir(assetPath), 0o755); nil != err {
		t.Fatal(err)
	}
	if err = os.WriteFile(assetPath, []byte("plot"), 0o644); nil != err {
		t.Fatal(err)
	}
	sql.FlushQueue()
	if _, selfMoveErr := MoveMarkdownPath(registration.ID, "/drafts/topic", "/drafts/topic/sub/topic"); nil == selfMoveErr {
		t.Fatal("moving a Markdown directory into itself must fail")
	}
	if _, statErr := os.Stat(filepath.Join(repositoryRoot, "drafts", "topic", "a.md")); nil != statErr {
		t.Fatalf("rejected self-move changed the source directory: %v", statErr)
	}
	directoryMove, directoryMoveErr := MoveMarkdownPath(registration.ID, "/drafts/topic", "/archive/deep/topic")
	if nil != directoryMoveErr {
		t.Fatalf("move external Markdown directory: %v", directoryMoveErr)
	}
	if !directoryMove.Directory || 2 != len(directoryMove.Documents) ||
		directoryMove.Documents[0].FromPath != "/drafts/topic/a.md" || directoryMove.Documents[0].ToPath != "/archive/deep/topic/a.md" ||
		directoryMove.Documents[1].FromPath != "/drafts/topic/b.markdown" || directoryMove.Documents[1].ToPath != "/archive/deep/topic/b.markdown" {
		t.Fatalf("unexpected Markdown directory move result: %+v", directoryMove)
	}
	for _, document := range directoryMove.Documents {
		if oldRows := blocksByBoxPath(registration.ID, document.FromPath); 0 != len(oldRows) {
			t.Fatalf("old directory SQL path survived move: %+v", oldRows)
		}
		if rows := blocksByBoxPath(registration.ID, document.ToPath); 1 > len(rows) || rows[0].HPath != document.ToPath {
			t.Fatalf("moved directory SQL/HPath mismatch: %+v", rows)
		}
		if tree := treenode.GetBlockTreeRootByPath(registration.ID, document.ToPath); nil == tree || tree.RootID != document.ID || tree.HPath != document.ToPath {
			t.Fatalf("moved directory blocktree mismatch: %+v", tree)
		}
	}
	if movedAsset, readErr := os.ReadFile(filepath.Join(repositoryRoot, "archive", "deep", "topic", "images", "plot.png")); nil != readErr || string(movedAsset) != "plot" {
		t.Fatalf("directory move lost a non-Markdown asset: bytes=%q err=%v", movedAsset, readErr)
	}
	if _, statErr := os.Stat(filepath.Join(repositoryRoot, "drafts", "topic")); !os.IsNotExist(statErr) {
		t.Fatalf("old Markdown directory survived move: %v", statErr)
	}

	// Removing/unregistering the box must delete only the workspace shadow,
	// never the external repository or its source.
	if err = RemoveBox(registration.ID); nil != err {
		t.Fatalf("unregister external box: %v", err)
	}
	if remaining, readErr := os.ReadFile(filepath.Join(repositoryRoot, movedPath)); nil != readErr || string(remaining) != source {
		t.Fatalf("unregister removed or changed external source: bytes=%q err=%v", remaining, readErr)
	}
	if remaining, readErr := os.ReadFile(filepath.Join(repositoryRoot, "archive", "deep", "topic", "a.md")); nil != readErr || string(remaining) != directoryA {
		t.Fatalf("unregister removed or changed directory-moved source: bytes=%q err=%v", remaining, readErr)
	}
	if _, statErr := os.Stat(filepath.Join(util.DataDir, registration.ID)); !os.IsNotExist(statErr) {
		t.Fatalf("shadow registration still exists after removal, stat err=%v", statErr)
	}
	entries, readErr := os.ReadDir(util.HistoryDir)
	if nil != readErr {
		t.Fatal(readErr)
	}
	if 0 != len(entries) {
		t.Fatalf("unregistering an external box must not create source deletion history: %#v", entries)
	}
}

func TestDeactivateMissingExternalMarkdownBoxesPreservesRegistryMetadata(t *testing.T) {
	workspaceDir := t.TempDir()
	originalConf := Conf
	originalWorkspaceDir := util.WorkspaceDir
	originalConfDir := util.ConfDir
	originalDataDir := util.DataDir
	originalHistoryDir := util.HistoryDir
	originalTempDir := util.TempDir
	originalQueueDir := util.QueueDir
	originalDBPath := util.DBPath
	originalHistoryDBPath := util.HistoryDBPath
	originalAssetContentDBPath := util.AssetContentDBPath
	originalBlockTreeDBPath := util.BlockTreeDBPath
	t.Cleanup(func() {
		Conf = originalConf
		util.WorkspaceDir = originalWorkspaceDir
		util.ConfDir = originalConfDir
		util.DataDir = originalDataDir
		util.HistoryDir = originalHistoryDir
		util.TempDir = originalTempDir
		util.QueueDir = originalQueueDir
		util.DBPath = originalDBPath
		util.HistoryDBPath = originalHistoryDBPath
		util.AssetContentDBPath = originalAssetContentDBPath
		util.BlockTreeDBPath = originalBlockTreeDBPath
	})
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

	liveRoot := filepath.Join(t.TempDir(), "live")
	staleRoot := filepath.Join(t.TempDir(), "stale")
	if err := os.MkdirAll(liveRoot, 0755); nil != err {
		t.Fatal(err)
	}
	if err := os.MkdirAll(staleRoot, 0755); nil != err {
		t.Fatal(err)
	}
	live, err := RegisterExternalMarkdownBox("Live", liveRoot, "0198fc34-7b32-7a11-8cb4-6c40e3b33d72")
	if nil != err {
		t.Fatal(err)
	}
	stale, err := RegisterExternalMarkdownBox("Stale", staleRoot, "0198fc34-7b32-7a11-8cb4-6c40e3b33d73")
	if nil != err {
		t.Fatal(err)
	}
	staleBox := &Box{ID: stale.ID}
	staleConf := staleBox.GetConf()
	staleConf.Closed = false
	if err = staleBox.SaveConf(staleConf); nil != err {
		t.Fatal(err)
	}
	if err = os.RemoveAll(staleRoot); nil != err {
		t.Fatal(err)
	}

	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)

	deactivated, err := DeactivateMissingExternalMarkdownBoxes()
	if nil != err {
		t.Fatal(err)
	}
	if 1 != len(deactivated) || stale.ID != deactivated[0].ID {
		t.Fatalf("unexpected stale registrations deactivated: %#v", deactivated)
	}
	if !staleBox.GetConf().Closed {
		t.Fatal("missing external registration remained open")
	}
	if _, statErr := os.Stat(filepath.Join(util.DataDir, stale.ID, ".siyuan", "conf.json")); nil != statErr {
		t.Fatalf("deactivation deleted the stale shadow identity: %v", statErr)
	}
	if _, statErr := os.Stat(filepath.Join(util.DataDir, live.ID, ".siyuan", "conf.json")); nil != statErr {
		t.Fatalf("live/kept registration was removed: %v", statErr)
	}
	boxes, err := ListExternalMarkdownBoxes()
	if nil != err {
		t.Fatal(err)
	}
	if 2 != len(boxes) {
		t.Fatalf("deactivation removed a registry entry: %#v", boxes)
	}
	seen := map[string]bool{}
	for _, box := range boxes {
		seen[box.ID] = true
	}
	if !seen[live.ID] || !seen[stale.ID] {
		t.Fatalf("registry identities changed after deactivation: %#v", boxes)
	}
	entries, err := os.ReadDir(util.HistoryDir)
	if nil != err {
		t.Fatal(err)
	}
	if 0 != len(entries) {
		t.Fatalf("deactivating stale shadows must not create deletion history: %#v", entries)
	}
}
