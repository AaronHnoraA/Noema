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

package model

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	noemaidentity "github.com/aaronhe/noema/kernel/noema/identity"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/siyuan-note/filelock"
)

// MarkdownBlockRef 是 markdown box 文档里一个已分配 ID 的块的最小摘要。
//
// 刻意不含源偏移（from/to）：lute 的 ast.Node 完全不追踪源字节位置
// （不像 CM6 用的 Lezer 那样偏移原生），在这里算 from/to 等于把 CM6 的
// markdown 语法层在服务端重新实现一遍，既重复劳动又违背"内核只识别块边界，
// CM6/Lezer 独占语义层"的分工——见计划文档 Phase 2 的澄清。CM6 拿到
// markdown 全文后，用自己的 Lezer 解析顺带算出每个 ID 在源文本里的位置，
// 这部分对 Lezer 而言是免费的。
type MarkdownBlockRef struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Level int    `json:"level,omitempty"` // 标题层级 1-6；非标题块为 0
}

// MarkdownBlockLocation is the canonical navigation result for a Noema block
// reference. Internal SiYuan-shaped projection IDs never cross this boundary.
type MarkdownBlockLocation struct {
	ID       string `json:"id"`
	Notebook string `json:"notebook"`
	Path     string `json:"path"`
	Line     int    `json:"line,omitempty"`
	Type     string `json:"type,omitempty"`
}

func ResolveMarkdownBlock(id string) (ret *MarkdownBlockLocation, err error) {
	// Saves index asynchronously, so a reference followed right after the save
	// that introduced it must wait for that work. This runs before any lock is
	// taken, which is what keeps it deadlock-free.
	WaitMarkdownIndex()
	canonical := strings.ToLower(strings.TrimSpace(id))
	internal := canonical
	if noemaidentity.IsUUIDv7(canonical) {
		internal = noemaidentity.ProjectionID(canonical, "")
	}
	bt := treenode.GetBlockTree(internal)
	if nil == bt || conf.BoxKindMarkdown != GetBoxKind(bt.BoxID) {
		return nil, ErrBlockNotFound
	}
	ret = &MarkdownBlockLocation{ID: canonical, Notebook: bt.BoxID, Path: bt.Path, Type: bt.Type}
	snapshot, readErr := loadMarkdownSnapshot(bt.BoxID, bt.Path)
	if nil != readErr {
		return nil, readErr
	}
	for _, definition := range snapshot.propertyProjection().Definitions {
		if strings.EqualFold(definition.CanonicalID, canonical) {
			ret.Line = definition.Line
			break
		}
	}
	return ret, nil
}

// MarkdownDocLoadResult is the editor-open projection. Blocks are optional:
// CM6 owns the syntax tree and does not need the kernel to parse the same
// source before first paint, while MCP and compatibility callers can still
// request the persisted block identities.
type MarkdownDocLoadResult struct {
	Markdown string             `json:"markdown"`
	Blocks   []MarkdownBlockRef `json:"blocks"`
	MtimeMs  float64            `json:"mtimeMs"`
	Size     int64              `json:"size"`
	Version  string             `json:"version"`
}

// LoadMarkdownDocProjection reads the exact Markdown bytes and their CAS
// metadata from one immutable snapshot. With includeBlocks=false it stays on
// the source-only path: no Lute tree is built merely to open a CM6 document.
func LoadMarkdownDocProjection(boxID, path string, includeBlocks bool) (ret *MarkdownDocLoadResult, err error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return nil, fmt.Errorf("box [%s] is not a markdown box", boxID)
	}
	if path, err = normalizedMarkdownDocPath(boxID, path); nil != err {
		return nil, err
	}

	snapshot, err := loadMarkdownSnapshot(boxID, path)
	if nil != err {
		if os.IsNotExist(err) {
			return &MarkdownDocLoadResult{
				Markdown: "", Blocks: []MarkdownBlockRef{}, Version: markdownDocVersion(nil),
			}, nil
		}
		return nil, err
	}
	ret = &MarkdownDocLoadResult{
		Markdown: string(snapshot.source), Blocks: []MarkdownBlockRef{},
		MtimeMs: snapshot.mtimeMs, Size: snapshot.size, Version: snapshot.sourceVersion(),
	}
	if includeBlocks {
		ret.Blocks = markdownBlockRefs(snapshot.blockTree(boxID, path))
	}
	return ret, nil
}

// LoadMarkdownDoc 读取一个 markdown box 文档，返回保证与磁盘一致的当前
// markdown 字节，以及文档里已经分配了 ID 的块列表。
//
// 加载和索引严格只读：文档身份来自 meta.id 的确定性投影，绝不写入 doc IAL
// 或格式化整篇 Markdown。返回的 markdown 始终是磁盘原始字节。
func LoadMarkdownDoc(boxID, path string) (markdown string, blocks []MarkdownBlockRef, err error) {
	loaded, err := LoadMarkdownDocProjection(boxID, path, true)
	if nil != err {
		return "", nil, err
	}
	return loaded.Markdown, loaded.Blocks, nil
}

func markdownBlockRefs(tree *parse.Tree) (blocks []MarkdownBlockRef) {
	canonicalDocID := filesys.MarkdownCanonicalDocumentID(tree)
	ast.Walk(tree.Root, func(n *ast.Node, entering bool) ast.WalkStatus {
		if !entering || !n.IsBlock() || "" == n.ID {
			return ast.WalkContinue
		}
		level := 0
		if ast.NodeHeading == n.Type {
			level = n.HeadingLevel
		}
		id := filesys.MarkdownCanonicalBlockID(n)
		if n == tree.Root {
			id = canonicalDocID
		}
		blocks = append(blocks, MarkdownBlockRef{ID: id, Type: n.Type.String(), Level: level})
		return ast.WalkContinue
	})
	return
}

// SaveMarkdownDoc is the full-source compatibility/fallback path. Ordinary
// CM6 autosaves use SaveMarkdownDocChangesCAS below; full saves remain for
// initial files, unload keepalive, remote/server mode, and recovery after a
// document reset. This path never passes through lute FormatRenderer: the
// caller's bytes remain the on-disk source of truth.
//
// watcher 会按本次写入的精确内容摘要抑制文件系统回声，避免同一次保存被
// 重解析/重索引两遍；若 Emacs/git 随后写入了不同字节，摘要不匹配，仍会按
// 外部编辑正常进入 watcher。
func SaveMarkdownDoc(boxID, path, markdown string) (saved string, blocks []MarkdownBlockRef, err error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return "", nil, fmt.Errorf("box [%s] is not a markdown box", boxID)
	}
	if path, err = normalizedMarkdownDocPath(boxID, path); nil != err {
		return "", nil, err
	}
	lock := markdownDocMutationLock(boxID, path)
	lock.Lock()
	defer lock.Unlock()
	return saveMarkdownDocUnlocked(boxID, path, markdown)
}

func markdownDocMutationLock(boxID, path string) *sync.Mutex {
	lockKey := boxID + "\x00" + path
	lockValue, _ := markdownPlanningMutationLocks.LoadOrStore(lockKey, &sync.Mutex{})
	return lockValue.(*sync.Mutex)
}

func saveMarkdownDocUnlocked(boxID, path, markdown string) (saved string, blocks []MarkdownBlockRef, err error) {
	previous, loadErr := loadMarkdownSnapshot(boxID, path)
	saved, blocks, _, err = saveMarkdownDocWithPrevious(boxID, path, markdown, previous, loadErr)
	return
}

func saveMarkdownDocWithPrevious(boxID, path, markdown string, previous *markdownSnapshot, loadErr error) (saved string, blocks []MarkdownBlockRef, committed *markdownSnapshot, err error) {
	blocks, committed, err = saveMarkdownDocSourceWithPrevious(boxID, path, []byte(markdown), previous, loadErr, true)
	if nil == err {
		saved = markdown
	}
	return
}

// saveMarkdownDocSourceWithPrevious is the byte-native commit primitive used
// by incremental saves. Keeping the boundary as []byte avoids converting the
// patched document to string and immediately copying the whole document back
// to []byte before the atomic write.
func saveMarkdownDocSourceWithPrevious(boxID, path string, source []byte, previous *markdownSnapshot, loadErr error, includeBlockRefs bool) (blocks []MarkdownBlockRef, committed *markdownSnapshot, err error) {
	absPath := filepath.Join(filesys.BoxRootPath(boxID), path)
	if err = os.MkdirAll(filepath.Dir(absPath), 0755); nil != err {
		return nil, nil, err
	}
	created := os.IsNotExist(loadErr)
	if nil == loadErr && bytes.Equal(previous.source, source) {
		if includeBlockRefs {
			blocks = markdownBlockRefs(previous.blockTree(boxID, path))
		}
		return blocks, previous, nil
	}
	rememberMarkdownSelfWrite(absPath, source)
	if err = writeMarkdownSourceAtomic(absPath, source); nil != err {
		forgetMarkdownSelfWrite(absPath)
		return nil, nil, err
	}

	var tree *parse.Tree
	var signature uint64
	if includeBlockRefs {
		// The full-source compatibility response includes the block list. Reuse
		// it when nothing that can affect the document's blocks changed. The
		// signature is taken straight from the source bytes, so this path no
		// longer scans for definitions merely to decide whether to reuse.
		// Incremental CM6 responses do not include blocks at all; their parse
		// and projection run only on the index worker.
		signature = markdownBlockRefSignature(filesys.MarkdownDocumentIdentity(source), source)
		if nil != previous && nil != previous.blockRefs && previous.blockRefSignature == signature {
			blocks = previous.blockRefs
		} else {
			tree = filesys.LoadMarkdownTreeByData(source, boxID, path, util.NewLute())
			blocks = markdownBlockRefs(tree)
		}
	}
	committed = rememberMarkdownSnapshot(boxID, path, source, tree)
	if includeBlockRefs {
		committed.blockRefSignature = signature
		committed.blockRefs = blocks
	}
	enqueueMarkdownIndex(boxID, path, source, tree, committed)
	updateMarkdownCatalogPath(boxID, path, false, committed)
	if markdownFiletreeNeedsReload(created, false) {
		util.PushReloadFiletree()
	}
	return
}

// writeMarkdownSourceAtomic matches the Node host's editor-save policy: write
// a complete sibling temporary file and rename it over the destination. The
// rename is atomic on the repository filesystem, while omitting the
// multi-millisecond fsync that made every debounced keystroke save wait for
// physical media. Index recovery remains protected by index.queue and the
// DataIndexState marker.
//
// The filelock path lock is still taken so a save stays serialized against
// every other filelock reader and writer of the same note, exactly as the
// previous filelock.WriteFile call was.
func writeMarkdownSourceAtomic(filePath string, data []byte) (err error) {
	filelock.Lock(filePath)
	defer filelock.Unlock(filePath)

	dir := filepath.Dir(filePath)
	temporary, err := os.CreateTemp(dir, "."+filepath.Base(filePath)+".noema-save-*")
	if nil != err {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err = temporary.Chmod(0o644); nil == err {
		_, err = temporary.Write(data)
	}
	if closeErr := temporary.Close(); nil == err {
		err = closeErr
	}
	if nil != err {
		return err
	}
	return os.Rename(temporaryPath, filePath)
}

type MarkdownDocCASResult struct {
	Markdown string             `json:"markdown"`
	Blocks   []MarkdownBlockRef `json:"blocks"`
	Conflict bool               `json:"conflict"`
	Rejected bool               `json:"rejected,omitempty"`
	Message  string             `json:"message,omitempty"`
	MtimeMs  float64            `json:"mtimeMs"`
	Size     int64              `json:"size"`
	Version  string             `json:"version"`
}

type MarkdownTextChange struct {
	From   int    `json:"from"`
	To     int    `json:"to"`
	Insert string `json:"insert"`
}

type MarkdownChangeSet struct {
	Length    int                  `json:"length"`
	NewLength int                  `json:"newLength"`
	Changes   []MarkdownTextChange `json:"changes"`
}

type MarkdownDocChangesResult struct {
	Markdown string  `json:"markdown,omitempty"`
	Conflict bool    `json:"conflict"`
	Rejected bool    `json:"rejected,omitempty"`
	Message  string  `json:"message,omitempty"`
	MtimeMs  float64 `json:"mtimeMs"`
	Size     int64   `json:"size"`
	Version  string  `json:"version"`
}

func markdownDocVersion(source []byte) string {
	digest := sha256.Sum256(source)
	return fmt.Sprintf("%x", digest)
}

// SaveMarkdownDocCAS closes the Node-check/Go-write race for CM6 saves. The
// version precondition and write share the same per-document lock as planning,
// property, metadata, restore, and ordinary Markdown saves.
func SaveMarkdownDocCAS(boxID, path, markdown, expectedVersion string, force bool) (ret *MarkdownDocCASResult, err error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return nil, fmt.Errorf("box [%s] is not a markdown box", boxID)
	}
	if path, err = normalizedMarkdownDocPath(boxID, path); nil != err {
		return nil, err
	}
	lock := markdownDocMutationLock(boxID, path)
	lock.Lock()
	defer lock.Unlock()

	current := []byte{}
	currentVersion := markdownDocVersion(nil)
	previous, loadErr := loadMarkdownSnapshot(boxID, path)
	if nil == loadErr {
		current = previous.source
		currentVersion = previous.sourceVersion()
		ret = &MarkdownDocCASResult{
			Markdown: string(current), Blocks: []MarkdownBlockRef{}, Version: currentVersion,
			MtimeMs: previous.mtimeMs, Size: previous.size,
		}
	} else if os.IsNotExist(loadErr) {
		ret = &MarkdownDocCASResult{Markdown: "", Blocks: []MarkdownBlockRef{}, Version: currentVersion}
	} else {
		return nil, loadErr
	}
	if !force && "" == strings.TrimSpace(markdown) && "" != strings.TrimSpace(string(current)) {
		ret.Rejected = true
		ret.Message = "Refusing to save empty content over a non-empty file. Use force: true to override."
		return ret, nil
	}
	if !force && expectedVersion != "" && expectedVersion != ret.Version {
		ret.Conflict = true
		return ret, nil
	}
	var committed *markdownSnapshot
	ret.Markdown, ret.Blocks, committed, err = saveMarkdownDocWithPrevious(boxID, path, markdown, previous, loadErr)
	if nil != err {
		return nil, err
	}
	if nil == committed {
		return nil, errors.New("Markdown save completed without a committed snapshot")
	}
	ret.Version = committed.sourceVersion()
	ret.MtimeMs = committed.mtimeMs
	ret.Size = committed.size
	return ret, nil
}

// SaveMarkdownDocChangesCAS applies one composed CodeMirror change set to the
// exact source version the editor opened. CM6 offsets are UTF-16 code units,
// so the conversion to UTF-8 byte offsets is performed in one forward scan.
// Successful responses contain only metadata; the full source is returned
// only on the uncommon conflict path.
func SaveMarkdownDocChangesCAS(boxID, path, expectedVersion string, changes MarkdownChangeSet, force bool) (ret *MarkdownDocChangesResult, err error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return nil, fmt.Errorf("box [%s] is not a markdown box", boxID)
	}
	if path, err = normalizedMarkdownDocPath(boxID, path); nil != err {
		return nil, err
	}
	if "" == expectedVersion {
		return nil, errors.New("expectedVersion is required for incremental Markdown save")
	}
	lock := markdownDocMutationLock(boxID, path)
	lock.Lock()
	defer lock.Unlock()

	previous, loadErr := loadMarkdownSnapshot(boxID, path)
	current := []byte{}
	currentVersion := markdownDocVersion(nil)
	ret = &MarkdownDocChangesResult{Version: currentVersion}
	if nil == loadErr {
		current = previous.source
		currentVersion = previous.sourceVersion()
		ret.Version = currentVersion
		ret.MtimeMs = previous.mtimeMs
		ret.Size = previous.size
	} else if !os.IsNotExist(loadErr) {
		return nil, loadErr
	}
	if !force && expectedVersion != currentVersion {
		ret.Conflict = true
		ret.Markdown = string(current)
		return ret, nil
	}

	patched, applyErr := applyMarkdownChangeSet(current, changes)
	if nil != applyErr {
		return nil, applyErr
	}
	if !force && "" == strings.TrimSpace(string(patched)) && "" != strings.TrimSpace(string(current)) {
		ret.Rejected = true
		ret.Markdown = string(current)
		ret.Message = "Refusing to save empty content over a non-empty file. Use force: true to override."
		return ret, nil
	}
	_, committed, saveErr := saveMarkdownDocSourceWithPrevious(boxID, path, patched, previous, loadErr, false)
	if nil != saveErr {
		return nil, saveErr
	}
	if nil == committed {
		return nil, errors.New("incremental Markdown save completed without a committed snapshot")
	}
	ret.Version = committed.sourceVersion()
	ret.MtimeMs = committed.mtimeMs
	ret.Size = committed.size
	return ret, nil
}

func applyMarkdownChangeSet(source []byte, changeSet MarkdownChangeSet) ([]byte, error) {
	if changeSet.Length < 0 || changeSet.NewLength < 0 {
		return nil, errors.New("Markdown change-set lengths must not be negative")
	}
	if !utf8.Valid(source) {
		return nil, errors.New("Markdown source is not valid UTF-8")
	}
	byteCursor, unitCursor, emitCursor := 0, 0, 0
	advance := func(target int) (int, error) {
		if target < unitCursor {
			return 0, errors.New("Markdown changes must be sorted and non-overlapping")
		}
		for unitCursor < target && byteCursor < len(source) {
			r, size := utf8.DecodeRune(source[byteCursor:])
			width := 1
			if 0xFFFF < r {
				width = 2
			}
			if target < unitCursor+width {
				return 0, errors.New("Markdown change offset splits a UTF-16 surrogate pair")
			}
			unitCursor += width
			byteCursor += size
		}
		if unitCursor != target {
			return 0, errors.New("Markdown change offset exceeds source length")
		}
		return byteCursor, nil
	}

	var patched strings.Builder
	patched.Grow(len(source))
	computedNewLength := changeSet.Length
	for _, change := range changeSet.Changes {
		if change.From < 0 || change.To < change.From || change.To > changeSet.Length {
			return nil, errors.New("invalid Markdown change range")
		}
		fromByte, offsetErr := advance(change.From)
		if nil != offsetErr {
			return nil, offsetErr
		}
		toByte, offsetErr := advance(change.To)
		if nil != offsetErr {
			return nil, offsetErr
		}
		patched.Write(source[emitCursor:fromByte])
		patched.WriteString(change.Insert)
		emitCursor = toByte
		computedNewLength += utf16TextLength(change.Insert) - (change.To - change.From)
	}
	if _, offsetErr := advance(changeSet.Length); nil != offsetErr {
		return nil, offsetErr
	}
	if byteCursor != len(source) {
		return nil, errors.New("Markdown change-set source length mismatch")
	}
	if computedNewLength != changeSet.NewLength {
		return nil, fmt.Errorf("Markdown change-set new length mismatch: got %d, want %d", computedNewLength, changeSet.NewLength)
	}
	patched.Write(source[emitCursor:])
	return []byte(patched.String()), nil
}

func utf16TextLength(text string) (ret int) {
	for _, r := range text {
		ret++
		if 0xFFFF < r {
			ret++
		}
	}
	return
}

// MarkdownDocSummary 是 markdown box 文档树里一个 .md 文件的摘要，供浏览/打开列表用。
type MarkdownDocSummary struct {
	Path  string `json:"path"`  // box 内相对路径，可以直接传给 LoadMarkdownDoc/SaveMarkdownDoc
	Title string `json:"title"` // 目前只是去掉扩展名的文件名；真实标题（比如取正文第一个标题）是后续增量
}

// ListMarkdownDocs 列出一个 markdown box 里的所有 .md/.markdown 文档，按路径排序。
// 用于给客户端（比如 CM6 那边的文档浏览器）提供"这个 box 里有哪些笔记"，
// 不需要用户手敲路径才能打开已有文档。
func ListMarkdownDocs(boxID string) (docs []MarkdownDocSummary, err error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return nil, fmt.Errorf("box [%s] is not a markdown box", boxID)
	}
	return markdownCatalogDocs(boxID)
}

// ListMarkdownNoteCatalog returns the rich editor-facing note projection.
// Source parsing is cached per immutable snapshot; force rebuilds the catalog
// from filesystem identities and the persistent per-file projection cache.
func ListMarkdownNoteCatalog(boxID string, force bool) (catalog MarkdownNoteCatalog, err error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return catalog, fmt.Errorf("box [%s] is not a markdown box", boxID)
	}
	if force {
		resetMarkdownBoxCatalog(boxID)
	}
	return markdownCatalogNotes(boxID)
}

func scanMarkdownDocs(boxID string) (docs []MarkdownDocSummary, err error) {
	boxDir := filesys.BoxRootPath(boxID)
	docs = []MarkdownDocSummary{}
	walkErr := filepath.WalkDir(boxDir, func(p string, d fs.DirEntry, walkErr error) error {
		if nil != walkErr {
			if errors.Is(walkErr, fs.ErrNotExist) {
				return nil
			}
			return walkErr
		}
		if d.IsDir() {
			if p != boxDir && markdownAssetScanExcludedDir(d.Name(), true) {
				return filepath.SkipDir
			}
			return nil
		}
		if !isMarkdownDocPath(p) {
			return nil
		}
		rel, relErr := filepath.Rel(boxDir, p)
		if nil != relErr {
			return nil
		}
		rel = "/" + filepath.ToSlash(rel)
		docs = append(docs, MarkdownDocSummary{
			Path:  rel,
			Title: trimMarkdownDocExtension(filepath.Base(rel)),
		})
		return nil
	})
	if nil != walkErr && !errors.Is(walkErr, fs.ErrNotExist) {
		return nil, walkErr
	}

	sort.Slice(docs, func(i, j int) bool { return docs[i].Path < docs[j].Path })
	return docs, nil
}
