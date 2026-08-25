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
	"os"
	"path/filepath"
	"strings"

	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/siyuan-note/filelock"
	"github.com/siyuan-note/logging"
)

// handleMarkdownFileEvent 响应外部编辑器（Emacs/git）对某个 markdown box 内一个
// .md 文件的改动：把变更增量灌回 blocktree/sql 索引（见 index.go 的
// UpsertIndexes/RemoveIndexes），并推送 WS 事件让已打开的界面刷新——
// 对齐计划文档 §1.5："变更 → 重解析 → 索引 → WS 推 reloadProtyle 等价事件"。
// removed=true 表示文件已经从磁盘消失（Remove/Rename 的旧路径）。
func handleMarkdownFileEvent(boxID, absPath string, removed bool) {
	if strings.HasSuffix(absPath, ".tmp") {
		return
	}
	if !strings.HasSuffix(absPath, ".md") {
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
	if removed {
		RemoveIndexes([]string{relBoxPath})
		util.PushReloadFiletree()
		return
	}

	if !filelock.IsExist(absPath) {
		// Write/Create 事件触发时文件可能已经被后续操作删掉（比如编辑器"写临时文件再原子重命名"
		// 的保存方式，中间可能先看到一次目标路径的短暂删除）；索引一个已经不存在的文件没有意义，
		// 真正的删除会有自己的 Remove 事件。
		return
	}

	UpsertIndexes([]string{relBoxPath})
	util.PushReloadFiletree()

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
