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
	"testing"
	"time"

	"github.com/aaronhe/noema/kernel/util"
)

// TestWatchMarkdownBoxLifecycle 验证 watcher 的启动/去重/关闭机制本身
// （不触发实际的重索引——那条路径需要 sql.InitDatabase 的 fts5 编译支持，
// 这个包默认的 go test ./... 没有带 -tags fts5，见 file_index_test.go 的
// //go:build fts5 和这里踩到的 "no such module: fts5" 报错）。
// 这里只确认：AddRecursive 真的把整棵目录树纳入了 watch（用
// w.WatchedFiles() 的条目数间接验证），重复调用 WatchMarkdownBox 不会
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
	if err := os.WriteFile(filepath.Join(boxDir, "notes", "a.md"), []byte("a"), 0644); nil != err {
		t.Fatal(err)
	}

	WatchMarkdownBox(boxID)
	t.Cleanup(func() { CloseWatchMarkdownBox(boxID) })

	// AddRecursive 是异步触发（WatchMarkdownBox 内部 goroutine 里做的），给它一点时间。
	deadline := time.Now().Add(2 * time.Second)
	var watchedCount int
	for time.Now().Before(deadline) {
		markdownWatchersLock.Lock()
		w, exists := markdownWatchers[boxID]
		markdownWatchersLock.Unlock()
		if exists {
			watchedCount = len(w.WatchedFiles())
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
