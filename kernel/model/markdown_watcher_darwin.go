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

//go:build darwin

package model

import (
	"sync"
	"time"

	"github.com/88250/gulu"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/radovskyb/watcher"
	"github.com/siyuan-note/logging"
)

var (
	markdownWatchersLock sync.Mutex
	markdownWatchers     = map[string]*watcher.Watcher{}
)

// markdownWatchPollInterval：assets/themes/emojis 的 darwin 轮询间隔是 10 秒
// （见 assets_watcher_darwin.go），那是资源变化，不追求即时性。markdown box
// 是笔记正文，计划文档 §1.5 的验收标准是"Emacs 改一个 .md 文件后索引在 1s 内更新"，
// 所以这里用短得多的间隔。
const markdownWatchPollInterval = 1 * time.Second

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
	w := watcher.New()
	w.FilterOps(watcher.Create, watcher.Write, watcher.Remove, watcher.Rename, watcher.Move)
	markdownWatchers[boxID] = w
	markdownWatchersLock.Unlock()

	if err := w.AddRecursive(boxDir); nil != err {
		logging.LogErrorf("add markdown box watcher for [%s] failed: %s", boxDir, err)
		markdownWatchersLock.Lock()
		delete(markdownWatchers, boxID)
		markdownWatchersLock.Unlock()
		return
	}

	go watchMarkdownBoxEvents(boxID, w)

	go func() {
		if err := w.Start(markdownWatchPollInterval); nil != err {
			logging.LogErrorf("start markdown box watcher for [%s] failed: %s", boxDir, err)
		}
	}()
}

func watchMarkdownBoxEvents(boxID string, w *watcher.Watcher) {
	defer logging.Recover()
	for {
		select {
		case event, ok := <-w.Event:
			if !ok {
				return
			}
			switch event.Op {
			case watcher.Remove:
				handleMarkdownFileEvent(boxID, event.Path, true)
			case watcher.Rename, watcher.Move:
				// Rename/Move：event.OldPath 是旧路径，event.Path 是新路径，两端都要处理。
				if "" != event.OldPath && event.OldPath != event.Path {
					handleMarkdownFileEvent(boxID, event.OldPath, true)
				}
				handleMarkdownFileEvent(boxID, event.Path, false)
			default: // Create, Write, Chmod
				handleMarkdownFileEvent(boxID, event.Path, false)
			}
		case err, ok := <-w.Error:
			if !ok {
				return
			}
			logging.LogErrorf("watch markdown box [%s] failed: %s", boxID, err)
		case <-w.Closed:
			return
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
