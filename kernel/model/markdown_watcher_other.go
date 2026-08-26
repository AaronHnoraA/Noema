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

//go:build !darwin

package model

import (
	"io/fs"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/88250/gulu"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/fsnotify/fsnotify"
	"github.com/siyuan-note/logging"
)

var (
	markdownWatchersLock sync.Mutex
	markdownWatchers     = map[string]*fsnotify.Watcher{}
)

// markdownWatchDebounce 把一小段时间窗口内的多个文件事件合并成一批处理，
// 避免 git checkout/bulk 编辑一次性触发大量单独的重索引调用。用 map 收集
// （而不是像 assets_watcher.go 那样只记"最后一个事件"），保证并发改动多个
// 文件时每一个都不会被丢——对索引而言"丢事件"比"晚一点处理"更糟。
const markdownWatchDebounce = 300 * time.Millisecond

func WatchMarkdownBox(boxID string) {
	boxDir := filesys.BoxRootPath(boxID)
	if !gulu.File.IsDir(boxDir) {
		return
	}

	markdownWatchersLock.Lock()
	if _, exists := markdownWatchers[boxID]; exists {
		markdownWatchersLock.Unlock()
		return
	}
	w, err := fsnotify.NewWatcher()
	if nil != err {
		markdownWatchersLock.Unlock()
		logging.LogErrorf("create markdown box watcher for [%s] failed: %s", boxDir, err)
		return
	}
	markdownWatchers[boxID] = w
	markdownWatchersLock.Unlock()

	if addErr := addMarkdownWatchTree(w, boxDir, nil); nil != addErr {
		logging.LogErrorf("add markdown box watcher for [%s] failed: %s", boxDir, addErr)
	}

	go watchMarkdownBoxEvents(boxID, w)
}

// addMarkdownWatchTree 递归地把 root 下所有目录加入 fsnotify watch（fsnotify 不会
// 自动跟进新目录），跳过 .siyuan 配置目录。onFile 非空时对遍历到的每个 .md 文件调用一次
// ——用于"新出现一整棵目录树"（比如 git checkout、mv 整个文件夹进来）时，不能只加 watch，
// 已经存在的文件也需要一次性补索引，不能指望后续还会单独收到它们的 Create 事件。
func addMarkdownWatchTree(w *fsnotify.Watcher, root string, onFile func(path string)) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if nil != err {
			return nil // 单个子路径读失败不该让整棵树的 watch 挂掉
		}
		if d.IsDir() {
			if ".siyuan" == d.Name() {
				return filepath.SkipDir
			}
			if addErr := w.Add(path); nil != addErr {
				logging.LogWarnf("watch dir [%s] failed: %s", path, addErr)
			}
			return nil
		}
		if nil != onFile && isMarkdownDocPath(path) {
			onFile(path)
		}
		return nil
	})
}

func watchMarkdownBoxEvents(boxID string, w *fsnotify.Watcher) {
	defer logging.Recover()

	pendingLock := sync.Mutex{}
	pending := map[string]bool{} // path -> removed
	flush := func() {
		pendingLock.Lock()
		batch := pending
		pending = map[string]bool{}
		pendingLock.Unlock()
		for path, removed := range batch {
			handleMarkdownFileEvent(boxID, path, removed)
		}
	}
	enqueue := func(path string, removed bool) {
		pendingLock.Lock()
		pending[path] = removed
		pendingLock.Unlock()
	}

	ticker := time.NewTicker(markdownWatchDebounce)
	defer ticker.Stop()

	for {
		select {
		case event, ok := <-w.Events:
			if !ok {
				flush()
				return
			}
			if event.Op&fsnotify.Create == fsnotify.Create && gulu.File.IsDir(event.Name) {
				// 新目录：补 watch，并把里面已经存在的 .md 文件当成一批新增来索引——
				// 它们不会再单独触发各自的 Create 事件。
				if addErr := addMarkdownWatchTree(w, event.Name, func(p string) { enqueue(p, false) }); nil != addErr {
					logging.LogWarnf("watch new dir [%s] failed: %s", event.Name, addErr)
				}
				continue
			}
			removed := event.Op&fsnotify.Remove == fsnotify.Remove || event.Op&fsnotify.Rename == fsnotify.Rename
			enqueue(event.Name, removed)
		case err, ok := <-w.Errors:
			if !ok {
				flush()
				return
			}
			logging.LogErrorf("watch markdown box [%s] failed: %s", boxID, err)
		case <-ticker.C:
			flush()
		}
	}
}

func CloseWatchMarkdownBox(boxID string) {
	markdownWatchersLock.Lock()
	w, exists := markdownWatchers[boxID]
	if exists {
		delete(markdownWatchers, boxID)
	}
	markdownWatchersLock.Unlock()

	if exists {
		w.Close()
	}
}
