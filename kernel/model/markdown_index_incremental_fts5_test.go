//go:build fts5

// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package model

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/util"
)

// typingIndexWorkspace stands up a Markdown box with the real databases open so
// the index queue does its actual block-tree and SQL work.
func typingIndexWorkspace(t *testing.T) string {
	t.Helper()
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
	boxID := "20260829150000-incrmnt"
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Incremental index"
	if err := (&Box{ID: boxID}).SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}
	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(func() {
		WaitMarkdownIndex()
		sql.CloseDatabase()
		resetMarkdownBoxCatalog(boxID)
	})
	return boxID
}

// blockRowFingerprints maps a document's indexed block ids to their rowids, so
// a test can tell which rows an edit actually rewrote. A rewritten row is
// deleted and reinserted, so it comes back with a new rowid even when its id is
// unchanged.
func blockRowFingerprints(t *testing.T, boxID, path string) map[string]string {
	t.Helper()
	rows := sql.SelectBlocksRawStmtArgs(
		"SELECT * FROM blocks WHERE box = ? AND path = ?", []any{boxID, path}, 8192)
	ret := make(map[string]string, len(rows))
	for _, row := range rows {
		ret[row.ID] = row.Hash + "\x00" + row.Content
	}
	return ret
}

func changedRowCount(before, after map[string]string) (changed int) {
	for id, fingerprint := range after {
		if previous, ok := before[id]; !ok || previous != fingerprint {
			changed++
		}
	}
	for id := range before {
		if _, ok := after[id]; !ok {
			changed++
		}
	}
	return changed
}

// TestOneEditRewritesOnlyTheEditedBlock is the contract the whole block
// projection exists for.
//
// A Markdown note used to reach the index as a single row whose content was the
// entire document, so every autosave deleted that row and re-tokenized the note
// into FTS — work proportional to the document, for one keystroke. Blocks now
// carry deterministic content-derived ids, and this asserts the consequence:
// editing one paragraph disturbs a bounded number of rows no matter how large
// the document is.
//
// The count is bounded rather than exact because an edit legitimately touches
// the block it happened in (removed under its old content key, reinserted under
// the new one) and may touch the document root.
func TestOneEditRewritesOnlyTheEditedBlock(t *testing.T) {
	boxID := typingIndexWorkspace(t)
	const path = "/notes/incremental.md"

	var source strings.Builder
	source.WriteString("# Incremental\n\n")
	for i := 0; i < 200; i++ {
		fmt.Fprintf(&source, "Paragraph %d with enough words to be a real block of prose.\n\n", i)
	}
	if _, _, err := SaveMarkdownDoc(boxID, path, source.String()); nil != err {
		t.Fatal(err)
	}
	WaitMarkdownIndex()
	sql.FlushQueue()

	before := blockRowFingerprints(t, boxID, path)
	if len(before) < 100 {
		t.Fatalf("expected the document to be indexed block by block, got %d rows", len(before))
	}

	edited := strings.Replace(source.String(), "Paragraph 100 ", "Paragraph 100 edited ", 1)
	if edited == source.String() {
		t.Fatal("fixture did not contain the paragraph to edit")
	}
	if _, _, err := SaveMarkdownDoc(boxID, path, edited); nil != err {
		t.Fatal(err)
	}
	WaitMarkdownIndex()
	sql.FlushQueue()

	after := blockRowFingerprints(t, boxID, path)
	changed := changedRowCount(before, after)
	if changed > 8 {
		t.Fatalf("editing one paragraph rewrote %d of %d rows; the index is not incremental",
			changed, len(before))
	}
	if changed == 0 {
		t.Fatal("editing one paragraph rewrote nothing; the edit never reached the index")
	}
	t.Logf("one edit rewrote %d of %d rows", changed, len(before))
}

// TestEditedBlockIsSearchableAndStaleTextIsNot pairs with the count above: an
// index that never rewrites anything would satisfy a bound but lose the edit.
func TestEditedBlockIsSearchableAndStaleTextIsNot(t *testing.T) {
	boxID := typingIndexWorkspace(t)
	const path = "/notes/searchable.md"

	original := "# Searchable\n\nAlpha paragraph with sentineloriginal inside.\n\nBeta paragraph stays put.\n"
	if _, _, err := SaveMarkdownDoc(boxID, path, original); nil != err {
		t.Fatal(err)
	}
	WaitMarkdownIndex()
	sql.FlushQueue()
	if !documentIsIndexed(boxID, path, "sentineloriginal") {
		t.Fatal("original text was not indexed")
	}

	edited := strings.Replace(original, "sentineloriginal", "sentinelreplaced", 1)
	if _, _, err := SaveMarkdownDoc(boxID, path, edited); nil != err {
		t.Fatal(err)
	}
	WaitMarkdownIndex()
	sql.FlushQueue()

	if !documentIsIndexed(boxID, path, "sentinelreplaced") {
		t.Fatal("edited text did not reach the index")
	}
	if documentIsIndexed(boxID, path, "sentineloriginal") {
		t.Fatal("the replaced text is still indexed; the edited block's old row was left behind")
	}
	if !documentIsIndexed(boxID, path, "Beta paragraph stays put") {
		t.Fatal("an untouched paragraph lost its row")
	}
}

// TestDeletingABlockRemovesItsRows guards the other direction: content-derived
// ids change with their block, so a document that loses a paragraph must lose
// exactly that paragraph's rows rather than accumulate orphans.
func TestDeletingABlockRemovesItsRows(t *testing.T) {
	boxID := typingIndexWorkspace(t)
	const path = "/notes/deleted.md"

	original := "# Deleted\n\nKeep this paragraph.\n\nRemove sentineldoomed paragraph.\n\nKeep this one too.\n"
	if _, _, err := SaveMarkdownDoc(boxID, path, original); nil != err {
		t.Fatal(err)
	}
	WaitMarkdownIndex()
	sql.FlushQueue()
	before := len(blockRowFingerprints(t, boxID, path))

	shortened := strings.Replace(original, "Remove sentineldoomed paragraph.\n\n", "", 1)
	if _, _, err := SaveMarkdownDoc(boxID, path, shortened); nil != err {
		t.Fatal(err)
	}
	WaitMarkdownIndex()
	sql.FlushQueue()

	if documentIsIndexed(boxID, path, "sentineldoomed") {
		t.Fatal("a deleted paragraph kept its index row")
	}
	if after := len(blockRowFingerprints(t, boxID, path)); after != before-1 {
		t.Fatalf("row count after deleting one paragraph = %d, want %d", after, before-1)
	}
}
