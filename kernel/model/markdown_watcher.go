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
	"crypto/sha256"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/siyuan-note/filelock"
	"github.com/siyuan-note/logging"
)

type markdownSelfWrite struct {
	digest    [sha256.Size]byte
	expiresAt time.Time
}

var (
	markdownSelfWritesLock sync.Mutex
	markdownSelfWrites     = map[string]markdownSelfWrite{}
)

const markdownSelfWriteTTL = 5 * time.Second

// rememberMarkdownSelfWrite records the exact bytes an in-process mutation is
// about to persist. The filesystem watcher checks the bytes again before
// suppressing an event, so a later Emacs/git edit is never mistaken for the
// kernel's own write merely because it happened within the same time window.
func rememberMarkdownSelfWrite(absPath string, source []byte) {
	now := time.Now()
	markdownSelfWritesLock.Lock()
	for path, write := range markdownSelfWrites {
		if !write.expiresAt.After(now) {
			delete(markdownSelfWrites, path)
		}
	}
	markdownSelfWrites[filepath.Clean(absPath)] = markdownSelfWrite{
		digest:    sha256.Sum256(source),
		expiresAt: now.Add(markdownSelfWriteTTL),
	}
	markdownSelfWritesLock.Unlock()
}

func forgetMarkdownSelfWrite(absPath string) {
	markdownSelfWritesLock.Lock()
	delete(markdownSelfWrites, filepath.Clean(absPath))
	markdownSelfWritesLock.Unlock()
}

func markdownSelfWriteEvent(absPath string) bool {
	path := filepath.Clean(absPath)
	now := time.Now()
	markdownSelfWritesLock.Lock()
	write, exists := markdownSelfWrites[path]
	if exists && !write.expiresAt.After(now) {
		delete(markdownSelfWrites, path)
		exists = false
	}
	markdownSelfWritesLock.Unlock()
	if !exists {
		return false
	}
	source, err := os.ReadFile(path)
	return nil == err && sha256.Sum256(source) == write.digest
}

// handleMarkdownFileEvent 响应外部编辑器（Emacs/git）对某个 markdown box 内一个
// .md 文件的改动：把变更增量灌回 blocktree/sql 索引（见 index.go 的
// UpsertIndexes/RemoveIndexes），并推送 WS 事件让已打开的界面刷新——
// 对齐计划文档 §1.5："变更 → 重解析 → 索引 → WS 推 reloadProtyle 等价事件"。
// removed=true 表示文件已经从磁盘消失（Remove/Rename 的旧路径）。
func handleMarkdownFileEvent(boxID, absPath string, removed bool) {
	if strings.HasSuffix(absPath, ".tmp") {
		return
	}
	if !isMarkdownDocPath(absPath) {
		rel, relErr := filepath.Rel(filesys.BoxRootPath(boxID), absPath)
		if relErr == nil && markdownAssetCandidate(rel) {
			if removed {
				removeMarkdownAssetContent(boxID, absPath)
			} else if filelock.IsExist(absPath) {
				indexMarkdownAssetContent(boxID, absPath)
			}
		}
		return
	}
	if filelock.IsHidden(absPath) {
		return
	}

	boxDir := filesys.BoxRootPath(boxID)
	rel, err := filepath.Rel(boxDir, absPath)
	if nil != err {
		return
	}
	rel = "/" + filepath.ToSlash(rel)
	if strings.HasPrefix(rel, "/.siyuan/") {
		return
	}

	relBoxPath := boxID + rel
	forgetMarkdownSnapshot(boxID, rel)
	if removed {
		updateMarkdownCatalogPath(boxID, rel, true, nil)
		RemoveIndexes([]string{relBoxPath})
		if markdownFiletreeNeedsReload(false, true) {
			util.PushReloadFiletree()
		}
		return
	}

	if !filelock.IsExist(absPath) {
		// Write/Create 事件触发时文件可能已经被后续操作删掉（比如编辑器"写临时文件再原子重命名"
		// 的保存方式，中间可能先看到一次目标路径的短暂删除）；索引一个已经不存在的文件没有意义，
		// 真正的删除会有自己的 Remove 事件。
		return
	}

	// A content-only edit must not reload the complete note tree. Besides the
	// visible sidebar jump, that used to turn every Emacs/git save into a full
	// renderer refresh. An absent old block-tree entry means this path really
	// is new (or was not indexed yet), for which a tree reload is necessary.
	created := nil == treenode.GetBlockTreeRootByPath(boxID, rel)
	UpsertIndexes([]string{relBoxPath})
	updateMarkdownCatalogPath(boxID, rel, false, nil)
	if markdownFiletreeNeedsReload(created, false) {
		util.PushReloadFiletree()
	}

	if bt := treenode.GetBlockTreeRootByPath(boxID, rel); nil != bt {
		docID := bt.RootID
		if raw, readErr := os.ReadFile(absPath); nil == readErr {
			if canonical := filesys.MarkdownDocumentIdentity(raw); "" != canonical {
				docID = canonical
			}
		}
		util.PushReloadDoc(docID)
	} else {
		logging.LogWarnf("markdown watcher: no blocktree entry for [%s%s] after indexing", boxID, rel)
	}
}

// markdownFiletreeNeedsReload is the Go equivalent of the Node host's
// deferred editor refresh: body writes update the current note and indexes,
// while only structural path changes invalidate the note tree.
func markdownFiletreeNeedsReload(created, removed bool) bool {
	return created || removed
}
