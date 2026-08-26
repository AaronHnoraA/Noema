// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"io/fs"
	"path/filepath"
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
	markdownWatcherStops = map[string]chan struct{}{}
	markdownWatcherDone  = map[string]chan struct{}{}
)

// A native filesystem event can arrive several times for one editor save
// (temporary create, rename, write). Coalesce those events without a periodic
// ticker so a completely idle Noema kernel causes no timer wakeups.
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
	stop := make(chan struct{})
	done := make(chan struct{})
	markdownWatchers[boxID] = w
	markdownWatcherStops[boxID] = stop
	markdownWatcherDone[boxID] = done
	markdownWatchersLock.Unlock()

	if addErr := addMarkdownWatchTree(w, boxDir, nil); nil != addErr {
		logging.LogErrorf("add markdown box watcher for [%s] failed: %s", boxDir, addErr)
	}

	go watchMarkdownBoxEvents(boxID, w, stop, done)
}

// addMarkdownWatchTree recursively watches directories, not every file. Hidden
// trees are deliberately excluded: handleMarkdownFileEvent already rejects
// hidden paths, and walking a repository's .git objects was the source of the
// former macOS 1 Hz full-tree polling regression. onFile is used when a newly
// created directory already contains Markdown files before its create event is
// observed.
func addMarkdownWatchTree(w *fsnotify.Watcher, root string, onFile func(path string)) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if nil != err {
			return nil // one unreadable child must not disable the remaining tree
		}
		if d.IsDir() {
			if path != root && markdownAssetScanExcludedDir(d.Name(), true) {
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

func watchMarkdownBoxEvents(boxID string, w *fsnotify.Watcher, stop <-chan struct{}, done chan<- struct{}) {
	defer logging.Recover()
	defer close(done)

	pending := map[string]bool{} // path -> removed
	var debounce *time.Timer
	var debounceC <-chan time.Time
	flush := func() {
		batch := pending
		pending = map[string]bool{}
		for path, removed := range batch {
			// SaveMarkdownDoc has already parsed, indexed and broadcast the write.
			// Suppress only when the current bytes still match that exact write;
			// a later external edit/delete therefore cannot be swallowed.
			if markdownSelfWriteEvent(path) {
				continue
			}
			handleMarkdownFileEvent(boxID, path, removed)
		}
	}
	armDebounce := func() {
		if nil == debounce {
			debounce = time.NewTimer(markdownWatchDebounce)
			debounceC = debounce.C
			return
		}
		if !debounce.Stop() {
			select {
			case <-debounce.C:
			default:
			}
		}
		debounce.Reset(markdownWatchDebounce)
		debounceC = debounce.C
	}
	defer func() {
		if nil != debounce {
			debounce.Stop()
		}
	}()

	for {
		select {
		case <-stop:
			return
		case event, ok := <-w.Events:
			if !ok {
				return
			}
			if 0 == event.Op&(fsnotify.Create|fsnotify.Write|fsnotify.Remove|fsnotify.Rename) {
				continue
			}
			if event.Op&fsnotify.Create == fsnotify.Create && gulu.File.IsDir(event.Name) {
				if markdownAssetScanExcludedDir(filepath.Base(event.Name), true) {
					continue
				}
				if addErr := addMarkdownWatchTree(w, event.Name, func(path string) {
					pending[path] = false
				}); nil != addErr {
					logging.LogWarnf("watch new dir [%s] failed: %s", event.Name, addErr)
				}
				if 0 < len(pending) {
					armDebounce()
				}
				continue
			}
			removed := event.Op&fsnotify.Remove == fsnotify.Remove || event.Op&fsnotify.Rename == fsnotify.Rename
			pending[event.Name] = removed
			armDebounce()
		case err, ok := <-w.Errors:
			if !ok {
				return
			}
			logging.LogErrorf("watch markdown box [%s] failed: %s", boxID, err)
		case <-debounceC:
			debounceC = nil
			select {
			case <-stop:
				return
			default:
			}
			flush()
		}
	}
}

func CloseWatchMarkdownBox(boxID string) {
	markdownWatchersLock.Lock()
	w, exists := markdownWatchers[boxID]
	stop := markdownWatcherStops[boxID]
	done := markdownWatcherDone[boxID]
	if exists {
		delete(markdownWatchers, boxID)
		delete(markdownWatcherStops, boxID)
		delete(markdownWatcherDone, boxID)
	}
	markdownWatchersLock.Unlock()

	if exists {
		close(stop)
		w.Close()
		<-done
	}
	resetMarkdownBoxCatalog(boxID)
}
