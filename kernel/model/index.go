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
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/88250/go-humanize"
	"github.com/88250/gulu"
	"github.com/88250/lute/ast"
	"github.com/88250/lute/editor"
	"github.com/88250/lute/html"
	"github.com/88250/lute/parse"
	"github.com/aaronhe/noema/kernel/av"
	"github.com/aaronhe/noema/kernel/cache"
	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/task"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/panjf2000/ants/v2"
	"github.com/siyuan-note/eventbus"
	"github.com/siyuan-note/filelock"
	"github.com/siyuan-note/logging"
)

// databaseIndexDataLock 用于避免索引任务读取正在被替换或删除的笔记本目录。
var databaseIndexDataLock sync.Mutex

func dataIndexRecoveryMarkerPath() string {
	return filepath.Join(util.QueueDir, "index.pending")
}

func persistDataIndexRecoveryMarker() error {
	if err := os.MkdirAll(util.QueueDir, 0o755); nil != err {
		return err
	}
	return os.WriteFile(dataIndexRecoveryMarkerPath(), []byte("1\n"), 0o600)
}

func clearDataIndexRecoveryMarker() {
	if err := os.Remove(dataIndexRecoveryMarkerPath()); nil != err && !os.IsNotExist(err) {
		logging.LogWarnf("clear data-index recovery marker failed: %s", err)
	}
}

func dataIndexRecoveryMarkerExists() bool {
	_, err := os.Stat(dataIndexRecoveryMarkerPath())
	return nil == err
}

// pathBoxIsMarkdown 从一个 <boxID>/... 相对 DataDir 的路径反推 boxID 并查询其存储形态。
func pathBoxIsMarkdown(p string) bool {
	boxID, _, found := strings.Cut(strings.TrimPrefix(filepath.ToSlash(p), "/"), "/")
	if !found {
		return false
	}
	return conf.BoxKindMarkdown == GetBoxKind(boxID)
}

// pathIsBoxDocument checks both path extension and the owning box kind. A
// Markdown repository may legitimately contain imported .sy files as assets;
// those must never enter the Markdown parser/index just because of a suffix.
func pathIsBoxDocument(p string) bool {
	boxID, _, found := strings.Cut(strings.TrimPrefix(filepath.ToSlash(p), "/"), "/")
	return found && filesys.IsBoxDocumentPath(boxID, p)
}

func UpsertIndexes(paths []string) {
	databaseIndexDataLock.Lock()
	defer databaseIndexDataLock.Unlock()

	var files []string
	for _, p := range paths {
		if strings.HasSuffix(p, "/") {
			if pathBoxIsMarkdown(p) {
				files = append(files, listMarkdownFiles(p)...)
			} else {
				files = append(files, listSyFiles(p)...)
			}
			continue
		}

		if pathIsBoxDocument(p) {
			files = append(files, p)
		}
	}

	files = gulu.Str.RemoveDuplicatedElem(files)
	upsertIndexes(files)
}

func RemoveIndexes(paths []string) {
	databaseIndexDataLock.Lock()
	defer databaseIndexDataLock.Unlock()

	var files []string
	for _, p := range paths {
		if strings.HasSuffix(p, "/") {
			if pathBoxIsMarkdown(p) {
				files = append(files, listMarkdownFiles(p)...)
			} else {
				files = append(files, listSyFiles(p)...)
			}
			continue
		}

		if pathIsBoxDocument(p) {
			files = append(files, p)
		}
	}

	files = gulu.Str.RemoveDuplicatedElem(files)
	removeIndexes(files)
}

// removeIndexes and upsertIndexes were originally defined in the (now
// deleted) cloud/LAN sync engine, which used them to reindex files changed
// by a pull. They are general-purpose path -> blocktree/sql index
// maintenance, unrelated to sync itself, so they moved here rather than
// being deleted; the encrypted-notebook gate and the sync status-bar push
// upsertIndexes previously did were dropped along with encryption and sync.
func removeIndexes(removeFilePaths []string) (removeRootIDs []string) {
	bootProgressPart := int32(10 / float64(len(removeFilePaths)))
	for _, removeFile := range removeFilePaths {
		if !pathIsBoxDocument(removeFile) {
			continue
		}
		var rootID string
		if filesys.IsNativeDocumentPath(removeFile) {
			rootID = util.GetTreeID(removeFile)
		} else if filesys.IsMarkdownDocumentPath(removeFile) {
			// markdown box：文件名不是块 ID，只能从已建立的 blocktree 索引反查这个路径此前对应的 rootID。
			boxID, relPath, found := strings.Cut(strings.TrimPrefix(filepath.ToSlash(removeFile), "/"), "/")
			if !found {
				continue
			}
			bt := treenode.GetBlockTreeRootByPath(boxID, "/"+relPath)
			if nil == bt {
				continue
			}
			rootID = bt.RootID
		} else {
			continue
		}

		removeRootIDs = append(removeRootIDs, rootID)

		msg := fmt.Sprintf(Conf.Language(39), rootID)
		util.IncBootProgress(bootProgressPart, msg)

		cache.RemoveTreeData(rootID)
		block := treenode.GetBlockTree(rootID)
		boxID := ""
		if nil != block {
			boxID = block.BoxID
			cache.RemoveDocIAL(block.Path)
		}
		sql.RemoveTreeQueue(boxID, rootID)
		bts := treenode.GetBlockTreesByRootIDInBox(rootID, boxID)
		for _, b := range bts {
			cache.RemoveBlockIAL(b.ID)
		}
		treenode.RemoveBlockTreesByRootID(boxID, rootID)
	}

	if 1 > len(removeRootIDs) {
		removeRootIDs = []string{}
	}
	return
}

func upsertIndexes(upsertFilePaths []string) (upsertRootIDs []string) {
	luteEngine := util.NewLute()
	bootProgressPart := int32(10 / float64(len(upsertFilePaths)))
	for _, upsertFile := range upsertFilePaths {
		rootID, indexed := func() (string, bool) {
			upsertFile = filepath.ToSlash(upsertFile)
			upsertFile = strings.TrimPrefix(upsertFile, "/")

			box, _, found := strings.Cut(upsertFile, "/")
			if !found {
				// .sy/.md 直接出现在 data 文件夹下，没有出现在笔记本文件夹下的情况
				return "", false
			}
			if !filesys.IsBoxDocumentPath(box, upsertFile) {
				return "", false
			}
			isMarkdown := filesys.IsMarkdownDocumentPath(upsertFile)

			p := strings.TrimPrefix(upsertFile, box)

			var rootID string
			if !isMarkdown {
				rootID = util.GetTreeID(p)
				msg := fmt.Sprintf(Conf.Language(40), rootID)
				util.IncBootProgress(bootProgressPart, msg)
				cache.RemoveTreeData(rootID)
			}
			// markdown box：文件名不是块 ID，rootID 要等 LoadTree 解析完文档级 IAL 才知道；
			// 也不接前置树缓存（见 filesys.loadMarkdownTree 的注释），无需预失效。

			tree, err0 := filesys.LoadTree(box, p, luteEngine)
			if nil != err0 {
				return "", false
			}
			if isMarkdown {
				rootID = tree.ID
				util.IncBootProgress(bootProgressPart, fmt.Sprintf(Conf.Language(40), rootID))
				// LoadTree 已从 meta.id/box+path 建立稳定投影并清理临时块 ID；
				// 索引过程严格只读，不能为了内部身份写回 doc IAL。
			}
			upsertLoadedTree(tree)
			return rootID, true
		}()
		if indexed {
			upsertRootIDs = append(upsertRootIDs, rootID)
		}
	}

	if 1 > len(upsertRootIDs) {
		upsertRootIDs = []string{}
	}
	return
}

// upsertLoadedTree commits an already parsed snapshot to the in-memory and SQL
// indexes. Keeping this separate from path loading lets Markdown save reuse
// the exact tree it just parsed for its API response. It also removes a stale
// previous root when meta.id changes at the same repository path.
// databaseIndexDataLock must be held by the caller.
func upsertLoadedTree(tree *parse.Tree) {
	if nil == tree || nil == tree.Root {
		return
	}
	if old := treenode.GetBlockTreeRootByPath(tree.Box, tree.Path); nil != old && old.RootID != tree.ID {
		for _, block := range treenode.GetBlockTreesByRootIDInBox(old.RootID, tree.Box) {
			cache.RemoveBlockIALInBox(block.ID, tree.Box)
		}
		cache.RemoveTreeDataInBox(old.RootID, tree.Box)
		sql.RemoveTreeQueue(tree.Box, old.RootID)
		treenode.RemoveBlockTreesByRootID(tree.Box, old.RootID)
	}
	// Reading this root's rows is a full blocktrees scan and was the single
	// most expensive step of a save, because it ran twice: once inside
	// UpsertBlockTree to decide what changed, then again here to list the
	// blocks whose IAL cache needs dropping. Take the pre-write rows from the
	// upsert and pair them with the tree's own blocks. Post-write rows are
	// always a subset of that union, so every ID the second query would have
	// returned is still invalidated, plus the blocks this save removed.
	previous := treenode.UpsertBlockTreeReportingPrevious(tree)
	sql.UpsertTreeQueue(tree)
	for _, block := range previous {
		cache.RemoveBlockIALInBox(block.ID, tree.Box)
	}
	ast.Walk(tree.Root, func(n *ast.Node, entering bool) ast.WalkStatus {
		if !entering || !n.IsBlock() || "" == n.ID {
			return ast.WalkContinue
		}
		cache.RemoveBlockIALInBox(n.ID, tree.Box)
		return ast.WalkContinue
	})
	cache.RemoveDocIALInBox(tree.Path, tree.Box)
}

func upsertLoadedMarkdownTree(tree *parse.Tree) {
	databaseIndexDataLock.Lock()
	upsertLoadedTree(tree)
	databaseIndexDataLock.Unlock()
}

func listSyFiles(dir string) (ret []string) {
	dirPath := filepath.Join(util.DataDir, dir)
	err := filelock.Walk(dirPath, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			logging.LogWarnf("walk dir [%s] failed: %s", dirPath, err)
			return err
		}

		if d.IsDir() {
			return nil
		}

		if filesys.IsNativeDocumentPath(path) {
			p := filepath.ToSlash(strings.TrimPrefix(path, util.DataDir))
			ret = append(ret, p)
		}
		return nil
	})
	if err != nil {
		logging.LogWarnf("walk dir [%s] failed: %s", dirPath, err)
	}
	return
}

// listMarkdownFiles 是 listSyFiles 的 markdown box 版本：递归列出 .md 文件，
// 跳过 .siyuan 配置目录（会话/账户等元数据存放处，不是笔记内容）。
func listMarkdownFiles(dir string) (ret []string) {
	normalized := strings.Trim(strings.TrimSpace(filepath.ToSlash(dir)), "/")
	boxID, relDir, found := strings.Cut(normalized, "/")
	if "" == boxID {
		return
	}
	if !found {
		relDir = ""
	}
	boxRoot := filesys.BoxRootPath(boxID)
	dirPath := filepath.Join(boxRoot, filepath.FromSlash(relDir))
	err := filelock.Walk(dirPath, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			logging.LogWarnf("walk dir [%s] failed: %s", dirPath, err)
			return err
		}

		if d.IsDir() {
			if path != dirPath && markdownAssetScanExcludedDir(d.Name(), true) {
				return filepath.SkipDir
			}
			return nil
		}

		if isMarkdownDocPath(path) {
			rel, relErr := filepath.Rel(boxRoot, path)
			if nil == relErr {
				ret = append(ret, boxID+"/"+filepath.ToSlash(rel))
			}
		}
		return nil
	})
	if err != nil {
		logging.LogWarnf("walk dir [%s] failed: %s", dirPath, err)
	}
	return
}

func (box *Box) Unindex() {
	task.AppendTask(task.DatabaseIndex, unindex, box.ID)
	go func() {
		// Unrecovered, a panic in here takes the whole kernel down rather than
		// the unindex it was asked to do. Every other background goroutine in
		// the kernel carries this.
		defer logging.Recover()
		sql.FlushQueue()
		ResetVirtualBlockRefCache()
	}()
}

func unindex(boxID string) {
	treenode.RemoveBlockTreesByBoxID(boxID)
	sql.DeleteBoxQueue(boxID)
}

func (box *Box) Index() {
	task.AppendTask(task.DatabaseIndexRef, removeBoxRefs, box.ID)
	task.AppendTask(task.DatabaseIndex, indexBox, box.ID)
	task.AppendTask(task.DatabaseIndexRef, IndexRefs)
	go func() {
		sql.FlushQueue()
		ResetVirtualBlockRefCache()
	}()
}

func removeBoxRefs(boxID string) {
	sql.DeleteBoxRefsQueue(boxID)
}

func indexBox(boxID string) {
	if err := indexBoxChecked(boxID); nil != err {
		logging.LogErrorf("index notebook [%s] failed: %s", boxID, err)
	}
}

// listBoxFilesForIndex is the error-preserving counterpart of Box.ListFiles.
// A full rebuild must distinguish an empty notebook from an unreadable root or
// subtree; treating both as an empty list would delete the old SQL rows and
// then incorrectly report a complete index.
func listBoxFilesForIndex(box *Box, p string) (ret []*FileInfo, err error) {
	files, _, err := box.Ls(p)
	if nil != err {
		return nil, err
	}
	for _, file := range files {
		if file.isdir {
			children, listErr := listBoxFilesForIndex(box, file.path)
			if nil != listErr {
				return nil, listErr
			}
			ret = append(ret, children...)
		}
		ret = append(ret, file)
	}
	return
}

func indexBoxChecked(boxID string) error {
	databaseIndexDataLock.Lock()
	defer databaseIndexDataLock.Unlock()

	box := Conf.Box(boxID)
	if nil == box {
		return ErrBoxNotFound
	}
	files, err := listBoxFilesForIndex(box, "/")
	if nil != err {
		return fmt.Errorf("scan notebook source: %w", err)
	}
	isMarkdownBox := conf.BoxKindMarkdown == GetBoxKind(boxID)
	indexFiles := make([]*FileInfo, 0, len(files))
	for _, file := range files {
		if file.isdir {
			continue
		}
		if !filesys.IsBoxDocumentPath(boxID, file.name) {
			continue
		}
		if isMarkdownBox {
			indexFiles = append(indexFiles, file)
			continue
		}
		if !ast.IsNodeIDPattern(strings.TrimSuffix(file.name, ".sy")) {
			// 不以块 ID 命名的 .sy 文件不应该被加载到思源中 https://github.com/siyuan-note/siyuan/issues/16089
			continue
		}
		indexFiles = append(indexFiles, file)
	}
	// 全量索引使用纯 INSERT，开始前必须清理该笔记本的旧数据，避免重复任务叠加相同行。
	sql.DeleteBoxQueue(boxID)

	util.SetBootDetails(Conf.Language(303))
	boxLen := max(1, len(Conf.GetOpenedBoxes()))
	bootProgressPart := int32(30.0 / float64(boxLen) / float64(max(1, len(indexFiles))))

	start := time.Now()
	luteEngine := util.NewLute()
	var treeCount int
	var treeSize int64
	var loadFailureCount int
	var firstLoadFailure error
	lock := sync.Mutex{}
	util.PushStatusBar(fmt.Sprintf("["+html.EscapeString(box.Name)+"] "+Conf.Language(64), len(indexFiles)))

	poolSize := min(runtime.NumCPU(), 4)
	waitGroup := &sync.WaitGroup{}
	var avNodes []*ast.Node
	p, _ := ants.NewPoolWithFunc(poolSize, func(arg any) {
		defer waitGroup.Done()

		file := arg.(*FileInfo)
		tree, err := filesys.LoadTree(box.ID, file.path, luteEngine)
		if err != nil {
			logging.LogErrorf("read box [%s] tree [%s] failed: %s", box.ID, file.path, err)
			lock.Lock()
			loadFailureCount++
			if nil == firstLoadFailure {
				firstLoadFailure = fmt.Errorf("load %s: %w", file.path, err)
			}
			lock.Unlock()
			return
		}
		lock.Lock()
		treeSize += file.size
		treeCount++
		i := treeCount
		lock.Unlock()

		docIAL := parse.IAL2Map(tree.Root.KramdownIAL)
		if !isMarkdownBox && "" == docIAL["updated"] { // 早期 .sy 数据可能没有 updated 属性，这里进行订正
			updated := util.TimeFromID(tree.Root.ID)
			tree.Root.SetIALAttr("updated", updated)
			docIAL["updated"] = updated
			if _, writeErr := filesys.WriteTree(tree); nil != writeErr {
				logging.LogErrorf("write tree [%s] failed: %s", tree.Path, writeErr)
			}
		}

		if !isMarkdownBox {
			// Native database mirrors are workspace-owned metadata. Portable
			// #+begin av blocks in a Markdown repository remain source-owned and
			// must never populate storage/av/blocks.msgpack during reindexing.
			lock.Lock()
			avNodes = append(avNodes, tree.Root.ChildrenByType(ast.NodeAttributeView)...)
			lock.Unlock()
		}

		cache.PutDocIALInBox(file.path, tree.Box, docIAL)
		treenode.IndexBlockTree(tree)
		sql.IndexTreeQueue(tree)
		util.IncBootProgress(bootProgressPart, fmt.Sprintf(Conf.Language(92), util.ShortPathForBootingDisplay(tree.Path)))
		if 1 < i && 0 == i%64 {
			util.PushStatusBar(fmt.Sprintf(Conf.Language(88), i, (len(indexFiles))-i))
		}
	})
	for _, file := range indexFiles {
		waitGroup.Add(1)
		invokeErr := p.Invoke(file)
		if nil != invokeErr {
			waitGroup.Done()
			logging.LogErrorf("invoke [%s] failed: %s", file.path, invokeErr)
			lock.Lock()
			loadFailureCount++
			if nil == firstLoadFailure {
				firstLoadFailure = fmt.Errorf("schedule %s: %w", file.path, invokeErr)
			}
			lock.Unlock()
			continue
		}
	}
	waitGroup.Wait()
	p.Release()

	// 关联数据库和块
	av.BatchUpsertBlockRel(avNodes)

	box.UpdateHistoryGenerated() // 初始化历史生成时间为当前时间
	end := time.Now()
	elapsed := end.Sub(start).Seconds()
	logging.LogInfof("rebuilt database for notebook [%s] in [%.2fs], tree [count=%d, size=%s]", box.ID, elapsed, treeCount, humanize.BytesCustomCeil(uint64(treeSize), 2))
	debug.FreeOSMemory()
	if 0 < loadFailureCount {
		return fmt.Errorf("notebook [%s] index incomplete: %d of %d source files failed (first error: %w)", box.ID, loadFailureCount, len(indexFiles), firstLoadFailure)
	}
	return nil
}

// reconcileMarkdownBoxChecked compares repository-native Markdown sources
// with the disposable blocktree/SQL projection. It parses every source to
// compare the same root hash stored by SQL, but only queues changed trees; on
// a warm attach this avoids the expensive delete-and-reinsert transaction.
// It also repairs files added, removed, renamed, or edited while Noema was not
// running, before the host is allowed to publish listening.
func reconcileMarkdownBoxChecked(boxID string) (changed int, err error) {
	databaseIndexDataLock.Lock()
	defer databaseIndexDataLock.Unlock()

	box := Conf.Box(boxID)
	if nil == box {
		return 0, ErrBoxNotFound
	}
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return 0, errors.New("not a Markdown notebook")
	}
	files, err := listBoxFilesForIndex(box, "/")
	if nil != err {
		return 0, fmt.Errorf("scan Markdown repository: %w", err)
	}

	existingByPath := map[string]*treenode.BlockTree{}
	for _, bt := range treenode.GetBlockTreesByBoxID(boxID) {
		if bt.ID == bt.RootID && "d" == bt.Type {
			existingByPath[bt.Path] = bt
		}
	}
	persistedByPath, err := sql.QueryRootBlockProjectionsByBox(boxID)
	if nil != err {
		return 0, fmt.Errorf("load persisted Markdown roots: %w", err)
	}
	boxRoot := filesys.BoxRootPath(boxID)
	persistentCacheLock := markdownIndexCacheLock(boxID)
	persistentCacheLock.Lock()
	defer persistentCacheLock.Unlock()
	indexCache := loadMarkdownIndexCache(boxID, boxRoot)
	indexCacheDirty := false
	sourcePaths := map[string]struct{}{}
	luteEngine := util.NewLute()
	loadFailures := 0
	var firstLoadFailure error
	for _, file := range files {
		if file.isdir || !isMarkdownDocPath(file.name) {
			continue
		}
		sourcePaths[file.path] = struct{}{}
		oldTree := existingByPath[file.path]
		persistedRoot := persistedByPath[file.path]
		if cached, ok := indexCache.Entries[file.path]; ok && nil != oldTree && nil != persistedRoot {
			info, statErr := os.Stat(filepath.Join(boxRoot, file.path))
			if nil == statErr && cached.matches(info, oldTree.RootID, persistedRoot.ID, persistedRoot.Hash) {
				continue
			}
		}
		snapshot, loadErr := loadMarkdownSnapshot(boxID, file.path)
		if nil != loadErr {
			loadFailures++
			if nil == firstLoadFailure {
				firstLoadFailure = fmt.Errorf("load %s: %w", file.path, loadErr)
			}
			continue
		}

		tree := filesys.LoadMarkdownTreeByData(snapshot.source, boxID, file.path, luteEngine)
		projectedRoot := sql.BuildBlockFromNode(tree.Root, tree)
		previousCacheEntry, hadCacheEntry := indexCache.Entries[file.path]
		nextCacheEntry, sourceChanged := markdownIndexEntryForSnapshot(previousCacheEntry, snapshot)
		if sourceChanged || !hadCacheEntry || nextCacheEntry.RootID != projectedRoot.ID || nextCacheEntry.Hash != projectedRoot.Hash {
			nextCacheEntry.RootID = projectedRoot.ID
			nextCacheEntry.Hash = projectedRoot.Hash
			indexCache.Entries[file.path] = nextCacheEntry
			indexCacheDirty = true
		}
		if nil != oldTree && oldTree.RootID == tree.ID && nil != persistedRoot && persistedRoot.ID == tree.ID &&
			persistedRoot.Hash == projectedRoot.Hash {
			continue
		}
		if nil != oldTree && oldTree.RootID != tree.ID {
			sql.RemoveTreeQueue(boxID, oldTree.RootID)
			treenode.RemoveBlockTreesByRootID(boxID, oldTree.RootID)
		}
		treenode.UpsertBlockTree(tree)
		sql.UpsertTreeQueue(tree)
		cache.RemoveDocIAL(tree.Path)
		changed++
	}
	if 0 < loadFailures {
		if indexCacheDirty {
			if saveErr := saveMarkdownIndexCache(boxID, indexCache); nil != saveErr {
				logging.LogWarnf("save partial Markdown index cache failed: %s", saveErr)
			}
		}
		return changed, fmt.Errorf("Markdown reconciliation incomplete: %d source files failed (first error: %w)", loadFailures, firstLoadFailure)
	}

	for sourcePath, oldTree := range existingByPath {
		if _, exists := sourcePaths[sourcePath]; exists {
			continue
		}
		sql.RemoveTreeQueue(boxID, oldTree.RootID)
		treenode.RemoveBlockTreesByRootID(boxID, oldTree.RootID)
		cache.RemoveDocIAL(sourcePath)
		if _, cached := indexCache.Entries[sourcePath]; cached {
			delete(indexCache.Entries, sourcePath)
			indexCacheDirty = true
		}
		changed++
	}
	if indexCacheDirty {
		if saveErr := saveMarkdownIndexCache(boxID, indexCache); nil != saveErr {
			logging.LogWarnf("save Markdown index cache failed: %s", saveErr)
		}
	}
	return changed, nil
}

func IndexRefs() {
	boxes := Conf.GetOpenedBoxes()
	boxIDs := make([]string, 0, len(boxes))
	for _, box := range boxes {
		boxIDs = append(boxIDs, box.ID)
	}
	release, err := AcquireEncryptedBoxOperations(context.Background(), boxIDs)
	if err != nil {
		logging.LogWarnf("skip resolving references while an encrypted notebook is unavailable: %s", err)
		return
	}
	defer release()

	databaseIndexDataLock.Lock()
	defer databaseIndexDataLock.Unlock()

	start := time.Now()
	util.SetBootDetails(Conf.Language(304))
	util.PushStatusBar(Conf.Language(54))
	util.SetBootDetails(Conf.Language(305))

	var defBlockIDs []string
	defBlockBoxes := map[string]string{} // defBlockID -> boxID，加密笔记本下需按 box 路由后续加载
	luteEngine := util.NewLute()
	collectRefTree := func(tree *parse.Tree) {
		ast.Walk(tree.Root, func(n *ast.Node, entering bool) ast.WalkStatus {
			if !entering {
				return ast.WalkContinue
			}

			if treenode.IsBlockRef(n) || treenode.IsFileAnnotationRef(n) {
				defBlockIDs = append(defBlockIDs, tree.Root.ID)
				defBlockBoxes[tree.Root.ID] = tree.Box
			}
			return ast.WalkContinue
		})
	}
	for _, box := range boxes {
		if conf.BoxKindMarkdown == GetBoxKind(box.ID) {
			files, listErr := listBoxFilesForIndex(box, "/")
			if nil != listErr {
				logging.LogWarnf("list Markdown notebook [%s] for reference indexing failed: %s", box.ID, listErr)
				continue
			}
			for _, file := range files {
				if file.isdir || !isMarkdownDocPath(file.name) {
					continue
				}
				tree, loadErr := filesys.LoadTree(box.ID, file.path, luteEngine)
				if nil != loadErr {
					logging.LogWarnf("load Markdown notebook [%s] tree [%s] for reference indexing failed: %s", box.ID, file.path, loadErr)
					continue
				}
				collectRefTree(tree)
			}
			continue
		}

		encryptedBox := IsEncryptedBox(box.ID)
		pages := pagedPaths(filepath.Join(util.DataDir, box.ID), 32)
		for _, paths := range pages {
			for _, treeAbsPath := range paths {
				p := filepath.ToSlash(strings.TrimPrefix(treeAbsPath, filepath.Join(util.DataDir, box.ID)))

				// 加密笔记本的 .sy 是密文，必须走 filesys.LoadTree 透明解密；无法用 bytes.Contains 预检
				var tree *parse.Tree
				if encryptedBox {
					loadTree, loadErr := filesys.LoadTree(box.ID, p, luteEngine)
					if nil != loadErr {
						logging.LogWarnf("load encrypted box [%s] tree [%s] failed: %s", box.ID, treeAbsPath, loadErr)
						continue
					}
					tree = loadTree
				} else {
					data, readErr := filelock.ReadFile(treeAbsPath)
					if nil != readErr {
						logging.LogWarnf("get data [path=%s] failed: %s", treeAbsPath, readErr)
						continue
					}

					if !bytes.Contains(data, []byte("TextMarkBlockRefID")) && !bytes.Contains(data, []byte("TextMarkFileAnnotationRefID")) {
						continue
					}

					parseTree, parseErr := filesys.LoadTreeByData(data, box.ID, p, luteEngine)
					if nil != parseErr {
						logging.LogWarnf("parse json to tree [%s] failed: %s", treeAbsPath, parseErr)
						continue
					}
					tree = parseTree
				}

				collectRefTree(tree)
			}
		}
	}

	defBlockIDs = gulu.Str.RemoveDuplicatedElem(defBlockIDs)

	i := 0
	size := len(defBlockIDs)
	if 0 < size {
		bootProgressPart := int32(10.0 / float64(size))

		for _, defBlockID := range defBlockIDs {
			// 加密笔记本的 defBlock 在加密 blocktree db，需按 box 路由加载
			var defTree *parse.Tree
			var loadErr error
			if boxID, ok := defBlockBoxes[defBlockID]; ok && IsEncryptedBox(boxID) {
				defTree, loadErr = loadTreeByBlockIDInBox(defBlockID, boxID)
			} else {
				defTree, loadErr = LoadTreeByBlockID(defBlockID)
			}
			if nil != loadErr {
				continue
			}

			util.IncBootProgress(bootProgressPart, fmt.Sprintf(Conf.Language(306), defTree.ID))
			sql.UpdateRefsTreeQueue(defTree)
			if 1 < i && 0 == i%64 {
				util.PushStatusBar(fmt.Sprintf(Conf.Language(55), i))
			}
			i++
		}
	}
	logging.LogInfof("resolved refs [%d] in [%dms]", size, time.Since(start).Milliseconds())
	util.PushStatusBar(fmt.Sprintf(Conf.Language(55), i))
}

var indexEmbedBlockLock = sync.Mutex{}

// IndexEmbedBlockJob 嵌入块支持搜索 https://github.com/siyuan-note/siyuan/issues/7112
func IndexEmbedBlockJob() {
	task.AppendTaskWithTimeout(task.DatabaseIndexEmbedBlock, 30*time.Second, autoIndexEmbedBlock)
}

func autoIndexEmbedBlock() {
	indexEmbedBlockLock.Lock()
	defer indexEmbedBlockLock.Unlock()

	embedBlocks := sql.QueryEmptyContentEmbedBlocks()
	for _, boxID := range treenode.GetOpenedEncryptedBoxIDs() {
		embedBlocks = append(embedBlocks, sql.QueryEmptyContentEmbedBlocksInBox(boxID)...)
	}
	for i, embedBlock := range embedBlocks {
		markdown := strings.TrimSpace(embedBlock.Markdown)
		markdown = strings.TrimPrefix(markdown, "{{")
		stmt := strings.TrimSuffix(markdown, "}}")

		// 嵌入块的 Markdown 内容需要反转义
		stmt = html.UnescapeString(stmt)
		stmt = strings.ReplaceAll(stmt, editor.IALValEscNewLine, "\n")

		// 需要移除首尾的空白字符以判断是否具有 //!js 标记
		stmt = strings.TrimSpace(stmt)
		if strings.HasPrefix(stmt, "//!js") {
			// https://github.com/siyuan-note/siyuan/issues/9648
			// js 嵌入块不支持自动索引，由前端主动调用 /api/search/updateEmbedBlock 接口更新内容 https://github.com/siyuan-note/siyuan/issues/9736
			continue
		}

		if !strings.Contains(strings.ToLower(stmt), "select") {
			continue
		}

		var queryResultBlocks []*sql.Block
		if IsEncryptedBox(embedBlock.Box) {
			queryResultBlocks = sql.SelectBlocksRawStmtNoParseInBox(stmt, 102400, embedBlock.Box)
		} else {
			queryResultBlocks = sql.SelectBlocksRawStmtNoParse(stmt, 102400)
		}
		for _, block := range queryResultBlocks {
			embedBlock.Content += block.Content
		}
		if "" == embedBlock.Content {
			embedBlock.Content = "no query result"
		}
		sql.UpdateBlockContentQueue(embedBlock)

		if 63 <= i { // 一次任务中最多处理 64 个嵌入块，防止卡顿
			break
		}
	}
}

func updateEmbedBlockContent(embedBlockID string, queryResultBlocks []*EmbedBlock, boxIDs ...string) {
	boxID := ""
	if len(boxIDs) > 0 {
		boxID = boxIDs[0]
	}
	embedBlock := sql.GetBlockInBox(embedBlockID, boxID)
	if nil == embedBlock {
		return
	}

	embedBlock.Content = "" // 嵌入块每查询一次多一个结果 https://github.com/siyuan-note/siyuan/issues/7196
	for _, block := range queryResultBlocks {
		embedBlock.Content += block.Block.Markdown
	}
	if "" == embedBlock.Content {
		embedBlock.Content = "no query result"
	}
	sql.UpdateBlockContentQueue(embedBlock)
}

func init() {
	subscribeSQLEvents()
}

var (
	pushSQLInsertBlocksFTSMsg bool
	pushSQLDeleteBlocksMsg    bool
)

func subscribeSQLEvents() {
	// 使用下面的 EvtSQLInsertBlocksFTS 就可以了
	//eventbus.Subscribe(eventbus.EvtSQLInsertBlocks, func(context map[string]any, current, total, blockCount int, hash string) {
	//
	//	msg := fmt.Sprintf(Conf.Language(89), current, total, blockCount, hash)
	//	util.SetBootDetails(msg)
	//	util.ContextPushMsg(context, msg)
	//})
	eventbus.Subscribe(eventbus.EvtSQLInsertBlocksFTS, func(context map[string]any, blockCount int, hash string) {
		if !pushSQLInsertBlocksFTSMsg {
			return
		}

		if nil == context["current"] || nil == context["total"] {
			logging.LogWarnf("EvtSQLInsertBlocksFTS handler missing key [current] or [total] in context")
			return
		}
		current := context["current"].(int)
		total := context["total"]
		msg := fmt.Sprintf(Conf.Language(90), current, total, blockCount, hash)
		util.SetBootDetails(msg)
		util.ContextPushMsg(context, msg)
	})
	eventbus.Subscribe(eventbus.EvtSQLDeleteBlocks, func(context map[string]any, rootID string) {
		if !pushSQLDeleteBlocksMsg {
			return
		}

		if nil == context["current"] || nil == context["total"] {
			logging.LogWarnf("EvtSQLDeleteBlocks handler missing key [current] or [total] in context")
			return
		}
		current := context["current"].(int)
		total := context["total"]
		msg := fmt.Sprintf(Conf.Language(93), current, total, rootID)
		util.SetBootDetails(msg)
		util.ContextPushMsg(context, msg)
	})
	eventbus.Subscribe(eventbus.EvtSQLUpdateBlocksHPaths, func(context map[string]any, blockCount int, hash string) {
		if util.IsMobileContainer() {
			return
		}

		if nil == context["current"] || nil == context["total"] {
			logging.LogWarnf("EvtSQLUpdateBlocksHPaths handler missing key [current] or [total] in context")
			return
		}
		current := context["current"].(int)
		total := context["total"]
		msg := fmt.Sprintf(Conf.Language(234), current, total, blockCount, hash)
		util.SetBootDetails(msg)
		util.ContextPushMsg(context, msg)
	})

	eventbus.Subscribe(eventbus.EvtSQLInsertHistory, func(context map[string]any) {
		if util.IsMobileContainer() {
			return
		}

		if nil == context["current"] || nil == context["total"] {
			logging.LogWarnf("EvtSQLInsertHistory handler missing key [current] or [total] in context")
			return
		}
		current := context["current"].(int)
		total := context["total"]
		msg := fmt.Sprintf(Conf.Language(191), current, total)
		util.SetBootDetails(msg)
		util.ContextPushMsg(context, msg)
	})

	eventbus.Subscribe(eventbus.EvtSQLInsertAssetContent, func(context map[string]any) {
		if util.IsMobileContainer() {
			return
		}

		if nil == context["current"] || nil == context["total"] {
			logging.LogWarnf("EvtSQLInsertAssetContent handler missing key [current] or [total] in context")
			return
		}
		current := context["current"].(int)
		total := context["total"]
		msg := fmt.Sprintf(Conf.Language(217), current, total)
		util.SetBootDetails(msg)
		util.ContextPushMsg(context, msg)
	})

	// These fire once per queued SQL operation. A tiny existence marker keeps
	// crash recovery synchronous without making an editor save marshal,
	// encrypt and fsync the complete conf.json. The ordinary config snapshot is
	// brought up to date later by the background SQL flush worker.
	eventbus.Subscribe(eventbus.EvtSQLIndexChanged, func() {
		if 1 == Conf.DataIndexState {
			return
		}
		Conf.DataIndexState = 1
		if err := persistDataIndexRecoveryMarker(); nil != err {
			logging.LogWarnf("persist data-index recovery marker failed: %s", err)
			Conf.Save()
		}
	})

	eventbus.Subscribe(eventbus.EvtSQLIndexFlushed, func() {
		if 0 == Conf.DataIndexState {
			clearDataIndexRecoveryMarker()
			return
		}
		Conf.DataIndexState = 0
		clearDataIndexRecoveryMarker()
		Conf.Save()
	})
}
