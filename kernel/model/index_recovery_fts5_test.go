//go:build fts5

package model

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
)

func TestInitBoxesRebuildsInterruptedMarkdownIndexFromSource(t *testing.T) {
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
	workspaceDir := t.TempDir()
	repositoryRoot := t.TempDir()
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
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("create test directory [%s]: %v", dir, err)
		}
	}

	Conf = NewAppConf()
	Conf.FileTree = conf.NewFileTree()
	Conf.NotebookCrypto = conf.NewNotebookCrypto()
	Conf.Sync = conf.NewSync()
	Conf.Search = conf.NewSearch()
	boxID := "20260826000500-recovr1"
	box := &Box{ID: boxID}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Interrupted index recovery"
	boxConf.Root = repositoryRoot
	boxConf.Closed = false
	if err := box.SaveConf(boxConf); err != nil {
		t.Fatal(err)
	}

	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(func() {
		dataIndexRecoveryRequired = false
		sql.CloseDatabase()
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

	indexedSource := []byte("# Indexed before crash\n\nA first document containing recoveryalpha.\n")
	if _, _, err := SaveMarkdownDoc(boxID, "/indexed.md", string(indexedSource)); err != nil {
		t.Fatalf("SaveMarkdownDoc indexed.md: %v", err)
	}
	sql.FlushQueue()
	if got := treenode.CountTrees(); got != 1 {
		t.Fatalf("precondition: indexed tree count = %d, want 1", got)
	}

	missingSource := []byte("# Not queued before crash\n\nA second document containing recoveryomega.\n")
	missingPath := filepath.Join(repositoryRoot, "missing.md")
	if err := os.WriteFile(missingPath, missingSource, 0o644); err != nil {
		t.Fatalf("write missing source: %v", err)
	}
	if blocks := blocksByBoxPath(boxID, "/missing.md"); len(blocks) != 0 {
		t.Fatalf("precondition: source that never reached the queue is already indexed: %+v", blocks)
	}

	// This is the state persisted when a process dies partway through a
	// box-wide index: at least one tree exists, but later source files never
	// reached index.queue. Queue replay alone cannot discover missing.md.
	Conf.DataIndexState = 1
	dataIndexRecoveryRequired = true
	if err := InitBoxes(); nil != err {
		t.Fatalf("recover complete Markdown sources: %v", err)
	}
	sql.FlushQueue()

	if got := treenode.CountTrees(); got != 2 {
		t.Fatalf("recovered tree count = %d, want 2", got)
	}
	blocks := blocksByBoxPath(boxID, "/missing.md")
	if len(blocks) != 1 || blocks[0].Box != boxID {
		t.Fatalf("interrupted-index recovery did not index missing.md: %+v", blocks)
	}
	results, matched, _, _, _ := FullTextSearchBlock(
		"recoveryomega", nil, nil, nil, nil, 0, 0, 0, 1, 32,
	)
	if matched != 1 || len(results) != 1 || results[0].Path != "/missing.md" {
		t.Fatalf("recovered FTS result mismatch: matched=%d results=%+v", matched, results)
	}
	if Conf.DataIndexState != 0 || dataIndexRecoveryRequired {
		t.Fatalf("recovery marker was not cleared after a complete rebuild: persisted=%d runtime=%v", Conf.DataIndexState, dataIndexRecoveryRequired)
	}
	if got, err := os.ReadFile(missingPath); err != nil || !bytes.Equal(got, missingSource) {
		t.Fatalf("recovery rewrote Markdown source: err=%v got=%q", err, got)
	}

	// The generic idle/sync index repair must dispatch by box kind. Its native
	// implementation scans data/<boxID> for .sy; a Markdown box keeps only its
	// conf shadow there, so treating that empty scan as source truth used to
	// erase every valid Markdown blocktree and SQL row.
	if err := fixIndexPipeline(); nil != err {
		t.Fatalf("box-kind-aware index repair failed: %v", err)
	}
	sql.FlushQueue()
	if got := treenode.CountTrees(); got != 2 {
		t.Fatalf("index repair erased Markdown blocktrees: got %d, want 2", got)
	}
	results, matched, _, _, _ = FullTextSearchBlock(
		"recoveryomega", nil, nil, nil, nil, 0, 0, 0, 1, 32,
	)
	if matched != 1 || len(results) != 1 || results[0].Path != "/missing.md" {
		t.Fatalf("index repair erased Markdown SQL/FTS rows: matched=%d results=%+v", matched, results)
	}
	if got, err := os.ReadFile(missingPath); err != nil || !bytes.Equal(got, missingSource) {
		t.Fatalf("index repair rewrote Markdown source: err=%v got=%q", err, got)
	}

	// A corrupt source must never be converted into a successful recovery. Use
	// a native box here because malformed .sy JSON provides a deterministic
	// cross-platform read failure (permission-based fixtures are unreliable in
	// privileged CI environments).
	boxConf.Kind = conf.BoxKindSy
	boxConf.Root = ""
	if err := box.SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}
	corruptPath := filepath.Join(util.DataDir, boxID, "20260826000600-broken1.sy")
	if err := os.MkdirAll(filepath.Dir(corruptPath), 0o755); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(corruptPath, []byte("not valid tree JSON"), 0o644); nil != err {
		t.Fatal(err)
	}
	Conf.DataIndexState = 1
	dataIndexRecoveryRequired = true
	if err := InitBoxes(); nil == err {
		t.Fatal("corrupt source incorrectly completed interrupted-index recovery")
	}
	if Conf.DataIndexState != 1 || !dataIndexRecoveryRequired {
		t.Fatalf("failed recovery marker was cleared: persisted=%d runtime=%v", Conf.DataIndexState, dataIndexRecoveryRequired)
	}
}

func blocksByBoxPath(boxID, path string) []*sql.Block {
	return sql.SelectBlocksRawStmtArgs("SELECT * FROM blocks WHERE box = ? AND path = ?", []any{boxID, path}, 32)
}
