// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

//go:build darwin

package model

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aaronhe/noema/kernel/util"
)

// TestWatchMarkdownBoxLifecycle 验证 watcher 的启动/去重/关闭机制本身
// （不触发实际的重索引——那条路径需要 sql.InitDatabase 的 fts5 编译支持，
// 这个包默认的 go test ./... 没有带 -tags fts5，见 file_index_test.go 的
// //go:build fts5 和这里踩到的 "no such module: fts5" 报错）。
// 这里只确认：原生 fsnotify watcher 把所有可见目录纳入 watch（用
// w.WatchList() 的条目数间接验证），跳过不会被索引的隐藏树，重复调用不会
// 产生第二个 watcher，CloseWatchMarkdownBox 能干净地停下并清掉注册表。
func TestWatchMarkdownBoxLifecycle(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260824233500-watchlc1"
	boxDir := filepath.Join(util.DataDir, boxID)
	if err := os.MkdirAll(filepath.Join(boxDir, "notes", "sub"), 0755); nil != err {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(boxDir, ".git", "objects", "aa"), 0755); nil != err {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(boxDir, "node_modules", "package", "docs"), 0755); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(boxDir, "notes", "a.md"), []byte("a"), 0644); nil != err {
		t.Fatal(err)
	}

	WatchMarkdownBox(boxID)
	t.Cleanup(func() { CloseWatchMarkdownBox(boxID) })

	// The initial recursive registration is synchronous, but tolerate a short
	// window so the assertion remains stable across fsnotify backends.
	deadline := time.Now().Add(2 * time.Second)
	var watchedCount int
	for time.Now().Before(deadline) {
		markdownWatchersLock.Lock()
		w, exists := markdownWatchers[boxID]
		markdownWatchersLock.Unlock()
		if exists {
			watched := w.WatchList()
			watchedCount = len(watched)
			for _, path := range watched {
				if filepath.Base(path) == ".git" || strings.Contains(filepath.ToSlash(path), "/.git/") ||
					filepath.Base(path) == "node_modules" || strings.Contains(filepath.ToSlash(path), "/node_modules/") {
					t.Fatalf("excluded repository internals must not be watched: %s", path)
				}
			}
			if watchedCount >= 3 { // box 根 + notes/ + notes/sub/
				break
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	if watchedCount < 3 {
		t.Fatalf("expected AddRecursive to watch at least 3 directories (box root + notes + notes/sub), got %d", watchedCount)
	}

	// 重复调用不应该替换掉已有 watcher。
	markdownWatchersLock.Lock()
	before := markdownWatchers[boxID]
	markdownWatchersLock.Unlock()
	WatchMarkdownBox(boxID)
	markdownWatchersLock.Lock()
	after := markdownWatchers[boxID]
	markdownWatchersLock.Unlock()
	if before != after {
		t.Fatal("calling WatchMarkdownBox twice replaced the existing watcher instead of being a no-op")
	}

	CloseWatchMarkdownBox(boxID)
	markdownWatchersLock.Lock()
	_, stillExists := markdownWatchers[boxID]
	markdownWatchersLock.Unlock()
	if stillExists {
		t.Fatal("CloseWatchMarkdownBox did not remove the box from the watcher registry")
	}
}

func TestMarkdownSelfWriteSuppressionMatchesExactCurrentBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "note.md")
	original := []byte("# saved by kernel\n")
	rememberMarkdownSelfWrite(path, original)
	t.Cleanup(func() { forgetMarkdownSelfWrite(path) })
	if err := os.WriteFile(path, original, 0644); nil != err {
		t.Fatal(err)
	}
	if !markdownSelfWriteEvent(path) {
		t.Fatal("the exact in-process write should be suppressed")
	}
	if err := os.WriteFile(path, []byte("# changed by Emacs\n"), 0644); nil != err {
		t.Fatal(err)
	}
	if markdownSelfWriteEvent(path) {
		t.Fatal("a later external edit must not be suppressed")
	}
	if err := os.Remove(path); nil != err {
		t.Fatal(err)
	}
	if markdownSelfWriteEvent(path) {
		t.Fatal("an external delete must not be suppressed")
	}
}
