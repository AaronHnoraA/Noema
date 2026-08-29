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

	"github.com/88250/lute/ast"
	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/treenode"
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

// TestIncrementalParseIndexesLikeAFullParse is the contract for skipping Lute.
//
// The incremental path hands Lute only the blocks whose source bytes changed and
// represents the rest with identity-only placeholders. That is sound only if the
// resulting index is indistinguishable from one built by parsing the document
// whole, so the two are built side by side from the same bytes and compared row
// for row.
func TestIncrementalParseIndexesLikeAFullParse(t *testing.T) {
	revisions := []string{
		"# Doc\n\nAlpha paragraph.\n\nBeta paragraph.\n\n- one\n- two\n\n```go\nfunc a() {}\n```\n\nGamma.\n",
		// Edit one paragraph.
		"# Doc\n\nAlpha paragraph edited.\n\nBeta paragraph.\n\n- one\n- two\n\n```go\nfunc a() {}\n```\n\nGamma.\n",
		// Insert a block in the middle: every later block keeps its key.
		"# Doc\n\nAlpha paragraph edited.\n\nInserted paragraph.\n\nBeta paragraph.\n\n- one\n- two\n\n```go\nfunc a() {}\n```\n\nGamma.\n",
		// Delete a block.
		"# Doc\n\nAlpha paragraph edited.\n\nInserted paragraph.\n\n- one\n- two\n\n```go\nfunc a() {}\n```\n\nGamma.\n",
		// Change a fenced block's contents.
		"# Doc\n\nAlpha paragraph edited.\n\nInserted paragraph.\n\n- one\n- two\n\n```go\nfunc a() int { return 1 }\n```\n\nGamma.\n",
		// Reorder: same blocks, different places.
		"# Doc\n\nGamma.\n\nInserted paragraph.\n\n- one\n- two\n\n```go\nfunc a() int { return 1 }\n```\n\nAlpha paragraph edited.\n",
	}

	const path = "/notes/parity.md"
	incrementalBox := typingIndexWorkspace(t)
	var incremental []map[string]string
	for _, revision := range revisions {
		if _, _, err := SaveMarkdownDoc(incrementalBox, path, revision); nil != err {
			t.Fatal(err)
		}
		WaitMarkdownIndex()
		sql.FlushQueue()
		incremental = append(incremental, blockRowFingerprints(t, incrementalBox, path))
	}

	// A fresh workspace per revision has nothing indexed, so every save takes
	// the whole-document parse.
	for index, revision := range revisions {
		freshBox := typingIndexWorkspace(t)
		if _, _, err := SaveMarkdownDoc(freshBox, path, revision); nil != err {
			t.Fatal(err)
		}
		WaitMarkdownIndex()
		sql.FlushQueue()
		full := blockRowFingerprints(t, freshBox, path)

		if len(full) != len(incremental[index]) {
			t.Fatalf("revision %d: incremental produced %d rows, full parse %d",
				index, len(incremental[index]), len(full))
		}
		for id, fingerprint := range full {
			got, present := incremental[index][id]
			if !present {
				t.Fatalf("revision %d: block %s is missing from the incremental index", index, id)
			}
			if got != fingerprint {
				t.Fatalf("revision %d: block %s differs\n incremental: %q\n full:        %q",
					index, id, got, fingerprint)
			}
		}
	}
}

// TestIncrementalParseSkipsUnchangedBlocks proves the path is actually taken:
// an equivalence test alone would pass a build that always parsed everything.
func TestIncrementalParseSkipsUnchangedBlocks(t *testing.T) {
	boxID := typingIndexWorkspace(t)
	const path = "/notes/skips.md"

	var source strings.Builder
	source.WriteString("# Skips\n\n")
	for i := 0; i < 120; i++ {
		fmt.Fprintf(&source, "Paragraph %d with enough words to be a real block.\n\n", i)
	}
	if _, _, err := SaveMarkdownDoc(boxID, path, source.String()); nil != err {
		t.Fatal(err)
	}
	WaitMarkdownIndex()
	sql.FlushQueue()

	edited := strings.Replace(source.String(), "Paragraph 60 ", "Paragraph 60 edited ", 1)
	keys, ok := filesys.MarkdownBlockProjectionKeys([]byte(edited), boxID, path)
	if !ok {
		t.Fatal("a plain prose document could not be split into blocks")
	}
	rootID := filesys.MarkdownProjectionID([]byte(edited), boxID, path)
	indexed := sql.IndexedBlockTypes(rootID, boxID)
	reused := 0
	for _, key := range keys {
		if _, found := indexed[key]; found {
			reused++
		}
	}
	if reused < len(keys)-2 {
		t.Fatalf("editing one paragraph left only %d of %d blocks reusable; the parse is not incremental",
			reused, len(keys))
	}
	if _, incremental := filesys.MarkdownIncrementalTree(
		[]byte(edited), boxID, path, util.NewLute(), indexed); !incremental {
		t.Fatal("the incremental parse declined a document it should have accepted")
	}
	t.Logf("one edit left %d of %d blocks unparsed", reused, len(keys))
}

// TestPlaceholderNeverWritesAnEmptyRow reproduces the one way the incremental
// parse could corrupt the index.
//
// Placeholders are chosen from rows read before the write transaction, while
// the set fromTree skips is computed from rows read inside it. If something
// removes a row in between, a placeholder is no longer "unchanged" — and a
// placeholder has no content, so building a row from it would blank that block
// in search.
//
// The race is staged with ordinary saves: the indexed set is captured while a
// paragraph exists, the paragraph is then deleted by a normal save (which
// removes its row), and a tree is finally built from the stale set — so that
// paragraph is a placeholder with nothing behind it.
func TestPlaceholderNeverWritesAnEmptyRow(t *testing.T) {
	boxID := typingIndexWorkspace(t)
	const path = "/notes/placeholder.md"

	withAlpha := "# Placeholder\n\nAlpha paragraph sentinelalpha here.\n\nBeta paragraph sentinelbeta here.\n"
	withoutAlpha := "# Placeholder\n\nBeta paragraph sentinelbeta here.\n"

	if _, _, err := SaveMarkdownDoc(boxID, path, withAlpha); nil != err {
		t.Fatal(err)
	}
	WaitMarkdownIndex()
	sql.FlushQueue()
	if !documentIsIndexed(boxID, path, "sentinelalpha") {
		t.Fatal("the fixture was not indexed")
	}
	staleRootID := filesys.MarkdownProjectionID([]byte(withAlpha), boxID, path)
	staleIndexed := sql.IndexedBlockTypes(staleRootID, boxID)
	if 3 > len(staleIndexed) {
		t.Fatalf("expected the document to be indexed block by block, got %d rows", len(staleIndexed))
	}

	// An ordinary save removes the alpha paragraph and its row.
	if _, _, err := SaveMarkdownDoc(boxID, path, withoutAlpha); nil != err {
		t.Fatal(err)
	}
	WaitMarkdownIndex()
	sql.FlushQueue()
	if documentIsIndexed(boxID, path, "sentinelalpha") {
		t.Fatal("deleting the paragraph did not remove its row; the test proves nothing")
	}

	// Now index the document that still has it, using the stale set: the alpha
	// paragraph becomes a placeholder with no row behind it.
	tree, ok := filesys.MarkdownIncrementalTree([]byte(withAlpha), boxID, path, util.NewLute(), staleIndexed)
	if !ok {
		t.Skip("the incremental path declined this document; nothing to guard here")
	}
	upsertLoadedMarkdownTree(tree)
	WaitMarkdownIndex()
	sql.FlushQueue()

	for _, row := range blocksByBoxPath(boxID, path) {
		if "d" != row.Type && "" == strings.TrimSpace(row.Content) {
			t.Fatalf("a placeholder was written as an empty row: %+v", row)
		}
	}

	// And the block comes back on the next ordinary save, because its key is no
	// longer in the index.
	if _, _, err := SaveMarkdownDoc(boxID, path, withAlpha); nil != err {
		t.Fatal(err)
	}
	WaitMarkdownIndex()
	sql.FlushQueue()
	if !documentIsIndexed(boxID, path, "sentinelalpha") {
		t.Fatal("the missing block did not come back on the next save")
	}
}

// TestPlaceholderTypesRoundTrip guards a quiet cost rather than a correctness
// bug: a placeholder carries the type its stored row has, and upsertBlockTree
// compares against it. A type that does not survive the abbreviation round trip
// would look changed on every save and rewrite that block-tree row forever.
func TestPlaceholderTypesRoundTrip(t *testing.T) {
	types := []ast.NodeType{
		ast.NodeDocument, ast.NodeHeading, ast.NodeParagraph, ast.NodeList,
		ast.NodeCodeBlock, ast.NodeMathBlock, ast.NodeBlockquote, ast.NodeTable,
		ast.NodeThematicBreak, ast.NodeHTMLBlock, ast.NodeSuperBlock,
	}
	for _, nodeType := range types {
		abbr := treenode.TypeAbbr(nodeType.String())
		if "" == abbr {
			t.Fatalf("%s has no type abbreviation", nodeType)
		}
		if name := treenode.FromAbbrType(abbr); ast.Str2NodeType(name) != nodeType {
			t.Fatalf("%s does not survive the abbreviation round trip: %q -> %q", nodeType, abbr, name)
		}
	}
}

// TestDeclinedDocumentsStayIndexedAndSearchable is the compatibility contract
// for everything SplitTopLevelMarkdownBlocks refuses. Declining costs those
// documents the incremental parse; it must not cost them block granularity or
// searchability, because the whole-document root row that used to carry their
// text is gone.
func TestDeclinedDocumentsStayIndexedAndSearchable(t *testing.T) {
	declined := map[string]string{
		"html comment":    "# Doc\n\n<!-- a comment\n## not a heading\n-->\n\nsentinelhtmlcomment here.\n",
		"html block":      "# Doc\n\n<div>\n  <p>x</p>\n</div>\n\nsentinelhtmlblock here.\n",
		"link definition": "[ref]: https://example.com\n\n# Doc\n\nsentinellinkdef uses [ref].\n",
		"footnote":        "# Doc\n\nsentinelfootnote body[^1].\n\n[^1]: the note.\n",
		"indented code":   "# Doc\n\n    indented code\n\n    still code\n\nsentinelindented here.\n",
		"anchored blocks": "# Doc {#0198fc34-7b32-7a11-8cb4-6c40e3b33d81}\n\nsentinelanchored here.\n",
	}
	for name, source := range declined {
		t.Run(name, func(t *testing.T) {
			boxID := typingIndexWorkspace(t)
			path := "/notes/declined.md"
			if _, _, err := SaveMarkdownDoc(boxID, path, source); nil != err {
				t.Fatal(err)
			}
			WaitMarkdownIndex()
			sql.FlushQueue()

			sentinel := ""
			for _, word := range strings.Fields(source) {
				if strings.HasPrefix(word, "sentinel") {
					sentinel = word
					break
				}
			}
			if "" == sentinel {
				t.Fatal("fixture has no sentinel")
			}
			if !documentIsIndexed(boxID, path, sentinel) {
				t.Fatalf("a declined document is not indexed: rows=%+v", blocksByBoxPath(boxID, path))
			}
			if rows := blocksByBoxPath(boxID, path); 2 > len(rows) {
				t.Fatalf("a declined document lost block granularity: %d rows", len(rows))
			}

			edited := strings.Replace(source, sentinel, sentinel+"edited", 1)
			if _, _, err := SaveMarkdownDoc(boxID, path, edited); nil != err {
				t.Fatal(err)
			}
			WaitMarkdownIndex()
			sql.FlushQueue()
			if !documentIsIndexed(boxID, path, sentinel+"edited") {
				t.Fatal("an edit to a declined document did not reach the index")
			}
		})
	}
}

// TestCollidingRootIDsDoNotEraseEachOther uses a real collision.
//
// An unanchored Markdown document's root key is 28 bits wide — ProjectionID's
// timestamp prefix is the constant "20000101000000" for it — so a vault of a
// few thousand notes can produce a pair by birthday (measured: ~17% of 5,000
// note vaults, every 50,000 note vault). Block granularity made the blast
// radius a whole document: every row of one is keyed to the shared root, so a
// save of the other would sweep them all as "no longer present".
//
// The two paths below are a genuine collision for this box, found by search.
func TestCollidingRootIDsDoNotEraseEachOther(t *testing.T) {
	boxID := typingIndexWorkspace(t)
	const (
		pathA = "/c/682.md"
		pathB = "/c/8394.md"
	)
	sourceA := "# N\n\nAlpha body sentinelcollidea here.\n"
	sourceB := "# N\n\nBeta body sentinelcollideb here.\n"

	rootA := filesys.MarkdownProjectionID([]byte(sourceA), boxID, pathA)
	rootB := filesys.MarkdownProjectionID([]byte(sourceB), boxID, pathB)
	if rootA != rootB {
		t.Skipf("these paths no longer collide under this box (%s vs %s); the guard still holds", rootA, rootB)
	}

	for _, document := range []struct{ path, source string }{{pathA, sourceA}, {pathB, sourceB}} {
		if _, _, err := SaveMarkdownDoc(boxID, document.path, document.source); nil != err {
			t.Fatal(err)
		}
		WaitMarkdownIndex()
		sql.FlushQueue()
	}

	if !documentIsIndexed(boxID, pathA, "sentinelcollidea") {
		t.Fatal("saving the second document erased the first one's rows")
	}
	if !documentIsIndexed(boxID, pathB, "sentinelcollideb") {
		t.Fatal("the second document was not indexed")
	}

	// Editing one must still leave the other alone.
	if _, _, err := SaveMarkdownDoc(boxID, pathA, sourceA+"\nMore alpha.\n"); nil != err {
		t.Fatal(err)
	}
	WaitMarkdownIndex()
	sql.FlushQueue()
	if !documentIsIndexed(boxID, pathB, "sentinelcollideb") {
		t.Fatal("editing the first document erased the second one's rows")
	}
	if !documentIsIndexed(boxID, pathA, "sentinelcollidea") {
		t.Fatal("the first document lost its own rows")
	}
}
