// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package sql

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"

	"github.com/88250/gulu"
	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/emirpasic/gods/sets/hashset"
	ignore "github.com/sabhiram/go-gitignore"
	"github.com/siyuan-note/eventbus"
	"github.com/siyuan-note/logging"
)

var luteEngine = util.NewLute()

func init() {
	luteEngine.RenderOptions.KramdownBlockIAL = false // 数据库 markdown 字段为标准 md，但是要保留 span block ial
}

const (
	BlocksInsert      = "INSERT INTO blocks (id, parent_id, root_id, hash, box, path, hpath, name, alias, memo, tag, content, fcontent, markdown, length, type, subtype, ial, sort, created, updated) VALUES %s"
	BlocksPlaceholder = "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"

	// blocks_fts 采用 external content 模式（content='blocks'），写入时必须显式提供 rowid，
	// 该 rowid 取自 blocks 表的隐式 rowid，否则 FTS rowid 与 blocks rowid 脱钩会导致
	// snippet/highlight 回表取错行、按 rowid 删除静默失效。首列即为 rowid。
	BlocksFTSInsert      = "INSERT INTO blocks_fts (rowid, id, parent_id, root_id, hash, box, path, hpath, name, alias, memo, tag, content, fcontent, markdown, length, type, subtype, ial, sort, created, updated) VALUES %s"
	BlocksFTSPlaceholder = "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"

	SpansInsert      = "INSERT INTO spans (id, block_id, root_id, box, path, content, markdown, type, ial) VALUES %s"
	SpansPlaceholder = "(?, ?, ?, ?, ?, ?, ?, ?, ?)"

	AssetsPlaceholder             = "(?, ?, ?, ?, ?, ?, ?, ?, ?)"
	AttributesPlaceholder         = "(?, ?, ?, ?, ?, ?, ?, ?)"
	RefsPlaceholder               = "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
	FileAnnotationRefsPlaceholder = "(?, ?, ?, ?, ?, ?, ?, ?, ?)"
)

func insertBlocks(tx *sql.Tx, blocks []*Block, context map[string]any) (err error) {
	if 1 > len(blocks) {
		return
	}

	var bulk []*Block
	for _, block := range blocks {
		bulk = append(bulk, block)
		if 512 > len(bulk) {
			continue
		}

		if err = insertBlocks0(tx, bulk, context); err != nil {
			return
		}
		bulk = []*Block{}
	}
	if 0 < len(bulk) {
		if err = insertBlocks0(tx, bulk, context); err != nil {
			return
		}
	}
	return
}

func insertBlocks0(tx *sql.Tx, bulk []*Block, context map[string]any) (err error) {
	valueStrings := make([]string, 0, len(bulk))
	valueArgs := make([]any, 0, len(bulk)*strings.Count(BlocksPlaceholder, "?"))
	hashBuf := bytes.Buffer{}
	for _, b := range bulk {
		valueStrings = append(valueStrings, BlocksPlaceholder)
		valueArgs = append(valueArgs, b.ID)
		valueArgs = append(valueArgs, b.ParentID)
		valueArgs = append(valueArgs, b.RootID)
		valueArgs = append(valueArgs, b.Hash)
		valueArgs = append(valueArgs, b.Box)
		valueArgs = append(valueArgs, b.Path)
		valueArgs = append(valueArgs, b.HPath)
		valueArgs = append(valueArgs, b.Name)
		valueArgs = append(valueArgs, b.Alias)
		valueArgs = append(valueArgs, b.Memo)
		valueArgs = append(valueArgs, b.Tag)
		valueArgs = append(valueArgs, b.Content)
		valueArgs = append(valueArgs, b.FContent)
		valueArgs = append(valueArgs, b.Markdown)
		valueArgs = append(valueArgs, b.Length)
		valueArgs = append(valueArgs, b.Type)
		valueArgs = append(valueArgs, b.SubType)
		valueArgs = append(valueArgs, b.IAL)
		valueArgs = append(valueArgs, b.Sort)
		valueArgs = append(valueArgs, b.Created)
		valueArgs = append(valueArgs, b.Updated)
		putBlockCache(b)

		hashBuf.WriteString(b.Hash)
	}

	stmt := fmt.Sprintf(BlocksInsert, strings.Join(valueStrings, ","))
	if err = prepareExecInsertTx(tx, stmt, valueArgs); err != nil {
		return
	}
	hashBuf.WriteString("blocks")
	evtHash := fmt.Sprintf("%x", sha256.Sum256(hashBuf.Bytes()))[:7]
	// 使用下面的 EvtSQLInsertBlocksFTS 就可以了
	//eventbus.Publish(eventbus.EvtSQLInsertBlocks, context, current, total, len(bulk), evtHash)

	// external content 模式下，FTS 行必须使用 blocks 的 rowid。刚插入的 blocks 行在同一事务内可见，
	// 这里按 id 反查 rowid，再用与 bulk 顺序对齐的 rowid 拼装 FTS 写入参数。
	blockRowIDs, err := queryBlockRowIDsTx(tx, bulk)
	if err != nil {
		return
	}
	ftsValueStrings := make([]string, 0, len(bulk))
	ftsValueArgs := make([]any, 0, len(bulk)*strings.Count(BlocksFTSPlaceholder, "?"))
	for _, b := range bulk {
		rowID, ok := blockRowIDs[b.ID]
		if !ok {
			// 理论上不会发生（刚插入即反查），防御性处理避免错位
			logging.LogErrorf("query block rowid failed after insert: id=%s not found", b.ID)
			err = fmt.Errorf("block rowid not found after insert: %s", b.ID)
			return
		}
		ftsValueStrings = append(ftsValueStrings, BlocksFTSPlaceholder)
		ftsValueArgs = append(ftsValueArgs, rowID)
		ftsValueArgs = append(ftsValueArgs, any(b.ID))
		ftsValueArgs = append(ftsValueArgs, any(b.ParentID))
		ftsValueArgs = append(ftsValueArgs, any(b.RootID))
		ftsValueArgs = append(ftsValueArgs, any(b.Hash))
		ftsValueArgs = append(ftsValueArgs, any(b.Box))
		ftsValueArgs = append(ftsValueArgs, any(b.Path))
		ftsValueArgs = append(ftsValueArgs, any(b.HPath))
		ftsValueArgs = append(ftsValueArgs, any(b.Name))
		ftsValueArgs = append(ftsValueArgs, any(b.Alias))
		ftsValueArgs = append(ftsValueArgs, any(b.Memo))
		ftsValueArgs = append(ftsValueArgs, any(b.Tag))
		ftsValueArgs = append(ftsValueArgs, any(b.Content))
		ftsValueArgs = append(ftsValueArgs, any(b.FContent))
		ftsValueArgs = append(ftsValueArgs, any(b.Markdown))
		ftsValueArgs = append(ftsValueArgs, any(b.Length))
		ftsValueArgs = append(ftsValueArgs, any(b.Type))
		ftsValueArgs = append(ftsValueArgs, any(b.SubType))
		ftsValueArgs = append(ftsValueArgs, any(b.IAL))
		ftsValueArgs = append(ftsValueArgs, any(b.Sort))
		ftsValueArgs = append(ftsValueArgs, any(b.Created))
		ftsValueArgs = append(ftsValueArgs, any(b.Updated))
	}
	stmt = fmt.Sprintf(BlocksFTSInsert, strings.Join(ftsValueStrings, ","))
	if err = prepareExecInsertTx(tx, stmt, ftsValueArgs); err != nil {
		return
	}
	hashBuf.WriteString("fts")
	evtHash = fmt.Sprintf("%x", sha256.Sum256(hashBuf.Bytes()))[:7]
	eventbus.Publish(eventbus.EvtSQLInsertBlocksFTS, context, len(bulk), evtHash)
	return
}

func insertAttributes(tx *sql.Tx, attributes []*Attribute) (err error) {
	if 1 > len(attributes) {
		return
	}

	var bulk []*Attribute
	for _, attr := range attributes {
		bulk = append(bulk, attr)
		if 512 > len(bulk) {
			continue
		}

		if err = insertAttribute0(tx, bulk); err != nil {
			return
		}
		bulk = []*Attribute{}
	}
	if 0 < len(bulk) {
		if err = insertAttribute0(tx, bulk); err != nil {
			return
		}
	}
	return
}

func insertAttribute0(tx *sql.Tx, bulk []*Attribute) (err error) {
	if 1 > len(bulk) {
		return
	}

	valueStrings := make([]string, 0, len(bulk))
	valueArgs := make([]any, 0, len(bulk)*strings.Count(AttributesPlaceholder, "?"))
	for _, attr := range bulk {
		valueStrings = append(valueStrings, AttributesPlaceholder)
		valueArgs = append(valueArgs, attr.ID)
		valueArgs = append(valueArgs, attr.Name)
		valueArgs = append(valueArgs, attr.Value)
		valueArgs = append(valueArgs, attr.Type)
		valueArgs = append(valueArgs, attr.BlockID)
		valueArgs = append(valueArgs, attr.RootID)
		valueArgs = append(valueArgs, attr.Box)
		valueArgs = append(valueArgs, attr.Path)
	}
	stmt := fmt.Sprintf("INSERT INTO attributes (id, name, value, type, block_id, root_id, box, path) VALUES %s", strings.Join(valueStrings, ","))
	err = prepareExecInsertTx(tx, stmt, valueArgs)
	return
}

func insertAssets(tx *sql.Tx, assets []*Asset) (err error) {
	if 1 > len(assets) {
		return
	}

	var bulk []*Asset
	for _, asset := range assets {
		bulk = append(bulk, asset)
		if 512 > len(bulk) {
			continue
		}

		if err = insertAsset0(tx, bulk); err != nil {
			return
		}
		bulk = []*Asset{}
	}
	if 0 < len(bulk) {
		if err = insertAsset0(tx, bulk); err != nil {
			return
		}
	}
	return
}

func insertAsset0(tx *sql.Tx, bulk []*Asset) (err error) {
	if 1 > len(bulk) {
		return
	}

	valueStrings := make([]string, 0, len(bulk))
	valueArgs := make([]any, 0, len(bulk)*strings.Count(AssetsPlaceholder, "?"))
	for _, asset := range bulk {
		valueStrings = append(valueStrings, AssetsPlaceholder)
		valueArgs = append(valueArgs, asset.ID)
		valueArgs = append(valueArgs, asset.BlockID)
		valueArgs = append(valueArgs, asset.RootID)
		valueArgs = append(valueArgs, asset.Box)
		valueArgs = append(valueArgs, asset.DocPath)
		valueArgs = append(valueArgs, asset.Path)
		valueArgs = append(valueArgs, asset.Name)
		valueArgs = append(valueArgs, asset.Title)
		valueArgs = append(valueArgs, asset.Hash)
	}
	stmt := fmt.Sprintf("INSERT INTO assets (id, block_id, root_id, box, docpath, path, name, title, hash) VALUES %s", strings.Join(valueStrings, ","))
	err = prepareExecInsertTx(tx, stmt, valueArgs)
	return
}

func insertSpans(tx *sql.Tx, spans []*Span) (err error) {
	if 1 > len(spans) {
		return
	}

	var bulk []*Span
	for _, span := range spans {
		bulk = append(bulk, span)
		if 512 > len(bulk) {
			continue
		}

		if err = insertSpans0(tx, bulk); err != nil {
			return
		}
		bulk = []*Span{}
	}
	if 0 < len(bulk) {
		if err = insertSpans0(tx, bulk); err != nil {
			return
		}
	}
	return
}

func insertSpans0(tx *sql.Tx, bulk []*Span) (err error) {
	if 1 > len(bulk) {
		return
	}

	valueStrings := make([]string, 0, len(bulk))
	valueArgs := make([]any, 0, len(bulk)*strings.Count(SpansPlaceholder, "?"))
	for _, span := range bulk {
		valueStrings = append(valueStrings, SpansPlaceholder)
		valueArgs = append(valueArgs, span.ID)
		valueArgs = append(valueArgs, span.BlockID)
		valueArgs = append(valueArgs, span.RootID)
		valueArgs = append(valueArgs, span.Box)
		valueArgs = append(valueArgs, span.Path)
		valueArgs = append(valueArgs, span.Content)
		valueArgs = append(valueArgs, span.Markdown)
		valueArgs = append(valueArgs, span.Type)
		valueArgs = append(valueArgs, span.IAL)
	}
	stmt := fmt.Sprintf(SpansInsert, strings.Join(valueStrings, ","))
	err = prepareExecInsertTx(tx, stmt, valueArgs)
	return
}

func insertBlockRefs(tx *sql.Tx, refs []*Ref) (err error) {
	validRefs := refs[:0]
	for _, ref := range refs {
		if nil == ref || "" == strings.TrimSpace(ref.DefBlockID) || "" == strings.TrimSpace(ref.BlockID) ||
			"" == strings.TrimSpace(ref.RootID) {
			continue
		}
		validRefs = append(validRefs, ref)
	}
	refs = validRefs
	if 1 > len(refs) {
		return
	}

	var bulk []*Ref
	for _, ref := range refs {
		bulk = append(bulk, ref)
		if 512 > len(bulk) {
			continue
		}

		if err = insertRefs0(tx, bulk); err != nil {
			return
		}
		bulk = []*Ref{}
	}
	if 0 < len(bulk) {
		if err = insertRefs0(tx, bulk); err != nil {
			return
		}
	}
	return
}

func insertRefs0(tx *sql.Tx, bulk []*Ref) (err error) {
	if 1 > len(bulk) {
		return
	}

	valueStrings := make([]string, 0, len(bulk))
	valueArgs := make([]any, 0, len(bulk)*strings.Count(RefsPlaceholder, "?"))
	for _, ref := range bulk {
		valueStrings = append(valueStrings, RefsPlaceholder)
		valueArgs = append(valueArgs, ref.ID)
		valueArgs = append(valueArgs, ref.DefBlockID)
		valueArgs = append(valueArgs, ref.DefBlockParentID)
		valueArgs = append(valueArgs, ref.DefBlockRootID)
		valueArgs = append(valueArgs, ref.DefBlockPath)
		valueArgs = append(valueArgs, ref.BlockID)
		valueArgs = append(valueArgs, ref.RootID)
		valueArgs = append(valueArgs, ref.Box)
		valueArgs = append(valueArgs, ref.Path)
		valueArgs = append(valueArgs, ref.Content)
		valueArgs = append(valueArgs, ref.Markdown)
		valueArgs = append(valueArgs, ref.Type)

		putRefCache(ref.Box, ref)
	}
	stmt := fmt.Sprintf("INSERT INTO refs (id, def_block_id, def_block_parent_id, def_block_root_id, def_block_path, block_id, root_id, box, path, content, markdown, type) VALUES %s", strings.Join(valueStrings, ","))
	err = prepareExecInsertTx(tx, stmt, valueArgs)
	return
}

func insertFileAnnotationRefs(tx *sql.Tx, refs []*FileAnnotationRef) (err error) {
	if 1 > len(refs) {
		return
	}

	var bulk []*FileAnnotationRef
	for _, ref := range refs {
		bulk = append(bulk, ref)
		if 512 > len(bulk) {
			continue
		}

		if err = insertFileAnnotationRefs0(tx, bulk); err != nil {
			return
		}
		bulk = []*FileAnnotationRef{}
	}
	if 0 < len(bulk) {
		if err = insertFileAnnotationRefs0(tx, bulk); err != nil {
			return
		}
	}
	return
}

func insertFileAnnotationRefs0(tx *sql.Tx, bulk []*FileAnnotationRef) (err error) {
	if 1 > len(bulk) {
		return
	}

	valueStrings := make([]string, 0, len(bulk))
	valueArgs := make([]any, 0, len(bulk)*strings.Count(FileAnnotationRefsPlaceholder, "?"))
	for _, ref := range bulk {
		valueStrings = append(valueStrings, FileAnnotationRefsPlaceholder)
		valueArgs = append(valueArgs, ref.ID)
		valueArgs = append(valueArgs, ref.FilePath)
		valueArgs = append(valueArgs, ref.AnnotationID)
		valueArgs = append(valueArgs, ref.BlockID)
		valueArgs = append(valueArgs, ref.RootID)
		valueArgs = append(valueArgs, ref.Box)
		valueArgs = append(valueArgs, ref.Path)
		valueArgs = append(valueArgs, ref.Content)
		valueArgs = append(valueArgs, ref.Type)
	}
	stmt := fmt.Sprintf("INSERT INTO file_annotation_refs (id, file_path, annotation_id, block_id, root_id, box, path, content, type) VALUES %s", strings.Join(valueStrings, ","))
	err = prepareExecInsertTx(tx, stmt, valueArgs)
	return
}

func indexTree(tx *sql.Tx, tree *parse.Tree, context map[string]any) (err error) {
	blocks, spans, assets, attributes := fromTree(tree.Root, tree, nil)
	refs, fileAnnotationRefs := refsFromTree(tree)
	err = insertTree0(tx, tree, context, blocks, spans, assets, attributes, refs, fileAnnotationRefs)
	return
}

func upsertTree(tx *sql.Tx, tree *parse.Tree, context map[string]any) (err error) {
	oldBlockHashes := queryBlockHashes(tx, tree.ID)

	// Blocks whose id was minted from their own content need no projection to
	// be classified: an id already indexed under this root can only have come
	// from byte-identical content. Deciding that before fromTree runs is the
	// point — buildBlockFromNode renders every block it is handed to Markdown,
	// which for a whole document is the dominant cost of an index job.
	unchanged, present := contentDerivedBlockState(tree, oldBlockHashes)

	blocks, spans, assets, attributes := fromTree(tree.Root, tree, unchanged)
	newBlockHashes := map[string]string{}
	for _, block := range blocks {
		newBlockHashes[block.ID] = block.Hash
	}
	unChanges := hashset.New()
	var toRemoves []string
	for id, row := range oldBlockHashes {
		if unchanged[id] {
			unChanges.Add(id)
			continue
		}
		// Never delete a row that belongs to another document. See
		// queryBlockHashes for how two documents come to share a root id.
		if "" != row.path && row.path != tree.Path {
			continue
		}
		if nil != present && !present[id] {
			// A content-derived id the current revision no longer has: its
			// block was edited away or deleted.
			toRemoves = append(toRemoves, id)
			continue
		}
		if newHash, ok := newBlockHashes[id]; ok {
			if newHash == row.hash {
				unChanges.Add(id)
			}
		} else if nil == present {
			toRemoves = append(toRemoves, id)
		}
	}
	tmp := blocks[:0]
	for _, b := range blocks {
		if !unChanges.Contains(b.ID) {
			tmp = append(tmp, b)
		}
	}
	blocks = tmp
	changedBlockIDs := hashset.New()
	for _, b := range blocks {
		toRemoves = append(toRemoves, b.ID)
		changedBlockIDs.Add(b.ID)
	}

	if err = deleteBlocksByIDs(tx, toRemoves); err != nil {
		return
	}

	// Spans and attributes are pure projections of their owning source block.
	// Keep rows for unchanged blocks and replace only rows whose block is being
	// rewritten or removed. If a future parser emits an unowned row, fall back
	// to the document-wide path rather than risking stale data.
	derivedRowsScoped := rowsBelongToBlocks(spans, newBlockHashes, func(row *Span) string { return row.BlockID }) &&
		rowsBelongToBlocks(attributes, newBlockHashes, func(row *Attribute) string { return row.BlockID })
	if derivedRowsScoped {
		if err = deleteSpansByBlockIDs(tx, toRemoves); err != nil {
			return
		}
		if err = deleteAttributesByBlockIDs(tx, toRemoves); err != nil {
			return
		}
		spans = retainChangedBlockRows(spans, changedBlockIDs, func(row *Span) string { return row.BlockID })
		attributes = retainChangedBlockRows(attributes, changedBlockIDs, func(row *Attribute) string { return row.BlockID })
	} else {
		if err = deleteSpansByRootID(tx, tree.ID); err != nil {
			return
		}
		if err = deleteAttributesByRootID(tx, tree.ID); err != nil {
			return
		}
	}

	// Asset hashes depend on external file bytes, not just Markdown source.
	// A save must therefore refresh the document's asset rows even when the
	// source block that names an asset is unchanged.
	if err = deleteAssetsByRootID(tx, tree.ID); err != nil {
		return
	}
	if err = deleteRefsByPathTx(tx, tree.Box, tree.Path); err != nil {
		return
	}
	if err = deleteFileAnnotationRefsByPathTx(tx, tree.Box, tree.Path); err != nil {
		return
	}

	refs, fileAnnotationRefs := refsFromTree(tree)
	if err = insertTree0(tx, tree, context, blocks, spans, assets, attributes, refs, fileAnnotationRefs); err != nil {
		return
	}
	return err
}

func rowsBelongToBlocks[T any](rows []T, blocks map[string]string, blockID func(T) string) bool {
	for _, row := range rows {
		if _, exists := blocks[blockID(row)]; !exists {
			return false
		}
	}
	return true
}

func retainChangedBlockRows[T any](rows []T, changed *hashset.Set, blockID func(T) string) []T {
	ret := rows[:0]
	for _, row := range rows {
		if changed.Contains(blockID(row)) {
			ret = append(ret, row)
		}
	}
	return ret
}

func insertTree0(tx *sql.Tx, tree *parse.Tree, context map[string]any,
	blocks []*Block, spans []*Span, assets []*Asset, attributes []*Attribute,
	refs []*Ref, fileAnnotationRefs []*FileAnnotationRef) (err error) {
	if ignoreLines := getIndexIgnoreLines(); 0 < len(ignoreLines) {
		// Support ignore index https://github.com/siyuan-note/siyuan/issues/9198
		matcher := ignore.CompileIgnoreLines(ignoreLines...)
		if matcher.MatchesPath("/" + path.Join(tree.Box, tree.Path)) {
			return
		}
	}

	if err = insertBlocks(tx, blocks, context); err != nil {
		return
	}

	if err = insertBlockRefs(tx, refs); err != nil {
		return
	}
	if err = insertFileAnnotationRefs(tx, fileAnnotationRefs); err != nil {
		return
	}

	if 0 < len(spans) {
		if err = insertSpans(tx, spans); err != nil {
			return
		}
	}
	if err = insertAssets(tx, assets); err != nil {
		return
	}
	if err = insertAttributes(tx, attributes); err != nil {
		return
	}
	return
}

var (
	IndexIgnoreCached bool
	indexIgnore       []string
	indexIgnoreLock   = sync.Mutex{}
)

func getIndexIgnoreLines() (ret []string) {
	// Support ignore index https://github.com/siyuan-note/siyuan/issues/9198

	if IndexIgnoreCached {
		return indexIgnore
	}

	indexIgnoreLock.Lock()
	defer indexIgnoreLock.Unlock()

	IndexIgnoreCached = true
	indexIgnorePath := filepath.Join(util.DataDir, ".siyuan", "indexignore")
	err := os.MkdirAll(filepath.Dir(indexIgnorePath), 0755)
	if err != nil {
		return
	}
	if !gulu.File.IsExist(indexIgnorePath) {
		if err = gulu.File.WriteFileSafer(indexIgnorePath, nil, 0644); err != nil {
			logging.LogErrorf("create indexignore [%s] failed: %s", indexIgnorePath, err)
			return
		}
	}
	data, err := os.ReadFile(indexIgnorePath)
	if err != nil {
		logging.LogErrorf("read indexignore [%s] failed: %s", indexIgnorePath, err)
		return
	}
	dataStr := string(data)
	dataStr = strings.ReplaceAll(dataStr, "\r\n", "\n")
	ret = strings.Split(dataStr, "\n")

	ret = gulu.Str.RemoveDuplicatedElem(ret)
	if 0 < len(ret) && "" == ret[0] {
		ret = ret[1:]
	}
	indexIgnore = nil
	for _, line := range ret {
		indexIgnore = append(indexIgnore, line)
	}
	return
}

// contentDerivedBlockState classifies a tree's blocks before any of them is
// projected, for documents whose ids encode their own content.
//
// `unchanged` holds ids already indexed under this root — proof the stored row
// still describes the block. `present` is every id this revision has, so the
// caller can tell "edited away" from "still here". Both are nil for trees whose
// ids are persistent rather than content-derived (.sy documents), where an id
// says nothing about content and the hash comparison has to run.
func contentDerivedBlockState(tree *parse.Tree, indexed map[string]indexedBlockRow) (unchanged, present map[string]bool) {
	if nil == IsContentDerivedBlockIDFn || nil == tree || nil == tree.Root {
		return nil, nil
	}
	derived := false
	present = map[string]bool{}
	unchanged = map[string]bool{}
	ast.Walk(tree.Root, func(n *ast.Node, entering bool) ast.WalkStatus {
		if !entering || !n.IsBlock() || "" == n.ID {
			return ast.WalkContinue
		}
		present[n.ID] = true
		if nil != IsIndexPlaceholderBlockFn && IsIndexPlaceholderBlockFn(n) {
			// Always skipped, never removed: see IsIndexPlaceholderBlockFn.
			derived = true
			unchanged[n.ID] = true
			return ast.WalkContinue
		}
		if !IsContentDerivedBlockIDFn(n) {
			return ast.WalkContinue
		}
		derived = true
		if _, found := indexed[n.ID]; found {
			unchanged[n.ID] = true
		}
		return ast.WalkContinue
	})
	if !derived {
		return nil, nil
	}
	return unchanged, present
}
