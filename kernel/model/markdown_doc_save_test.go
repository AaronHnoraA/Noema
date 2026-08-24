// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"testing"

	"github.com/aaronhe/noema/kernel/util"
)

// 这两个测试只覆盖在 SaveMarkdownDoc 触达 UpsertIndexes（进而 sql.UpsertTreeQueue，
// 需要项目的 fts5 cgo 编译支持，见 markdown_doc_save_fts5_test.go 顶部的说明）之前
// 就返回的校验分支，不需要任何数据库初始化。

func TestSaveMarkdownDocRejectsNonMarkdownBox(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260825010000-savereject"
	box := &Box{ID: boxID}
	if err := box.SaveConf(box.GetConf()); nil != err { // 默认 Kind 是 sy
		t.Fatal(err)
	}

	if _, _, err := SaveMarkdownDoc(boxID, "/whatever.md", "# hi\n"); nil == err {
		t.Fatal("expected an error saving into a non-markdown box")
	}
}

func TestSaveMarkdownDocRejectsPathEscape(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260825010000-saveescape"
	setupMarkdownBoxForIndexTest(t, boxID)

	if _, _, err := SaveMarkdownDoc(boxID, "/../../etc/passwd.md", "pwned\n"); nil == err {
		t.Fatal("expected an error saving to a path that escapes the box directory")
	}
}
