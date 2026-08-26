// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/util"
)

// TestHandleMarkdownFileEventSkipsNonCandidatePaths 只覆盖会在触达
// UpsertIndexes/RemoveIndexes（需要 sql.InitDatabase 的 fts5 编译支持，见
// markdown_watcher_darwin_test.go 的说明）之前就提前返回的分支：.tmp 文件、
// .siyuan 配置目录、非 .md 后缀。断言方式是"调用不 panic"——这些分支本来就
// 应该在碰到 sql 层之前退出，如果哪天有人不小心把判断顺序改错导致漏判，
// 这个测试会直接 panic 而不是默默什么都不做。
func TestHandleMarkdownFileEventSkipsNonCandidatePaths(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260824234000-skipev01"
	boxDir := filepath.Join(util.DataDir, boxID)
	if err := os.MkdirAll(filepath.Join(boxDir, ".siyuan"), 0755); nil != err {
		t.Fatal(err)
	}

	cases := []string{
		filepath.Join(boxDir, "notes", "a.md.tmp"),
		filepath.Join(boxDir, ".siyuan", "conf.json"),
		filepath.Join(boxDir, "notes", "a.sy"),
		filepath.Join(boxDir, "notes", "a.txt"),
	}
	for _, absPath := range cases {
		handleMarkdownFileEvent(boxID, absPath, false)
		handleMarkdownFileEvent(boxID, absPath, true)
	}
}

func TestMarkdownFiletreeReloadOnlyForStructuralChanges(t *testing.T) {
	tests := []struct {
		name             string
		created, removed bool
		want             bool
	}{
		{name: "content write", want: false},
		{name: "create", created: true, want: true},
		{name: "remove", removed: true, want: true},
		{name: "rename replacement", created: true, removed: true, want: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := markdownFiletreeNeedsReload(test.created, test.removed); got != test.want {
				t.Fatalf("markdownFiletreeNeedsReload(%v, %v) = %v, want %v", test.created, test.removed, got, test.want)
			}
		})
	}
}
