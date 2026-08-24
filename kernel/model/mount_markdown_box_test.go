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

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
)

// TestCreateMarkdownBoxSetsKindWithoutInitializingBoxDoc 验证真实运行时踩到过
// 的第一个缺口（手动 curl 冒烟测试时发现：createNotebook API 原来只接受
// name，没有办法建 markdown box，只能手改磁盘上的 conf.json）：
// CreateMarkdownBox 建出来的 box 有 Kind=markdown，且不会调 ensureBoxDoc0
// （那是 .sy 嵌套文档树"笔记本自身文档"的概念，markdown box 不需要，
// mount.go 的 mountBox 对 markdown box 同样跳过 EnsureBoxDoc/ListDocTree）。
// 顺带验证普通 CreateBox 的行为没有被这次改动影响——Kind 仍然是空字符串
// （NewBoxConf 的默认值，不是显式的 "sy" 字面量，向后兼容已有的 conf.json）。
func TestCreateMarkdownBoxSetsKindWithoutInitializingBoxDoc(t *testing.T) {
	originalConf := Conf
	originalDataDir := util.DataDir
	originalBlockTreeDBPath := util.BlockTreeDBPath
	tempDir := t.TempDir()
	util.DataDir = filepath.Join(tempDir, "data")
	util.BlockTreeDBPath = filepath.Join(tempDir, "blocktree.db")
	Conf = NewAppConf()
	Conf.FileTree = conf.NewFileTree()
	Conf.NotebookCrypto = conf.NewNotebookCrypto()
	Conf.Sync = conf.NewSync()
	treenode.InitBlockTree(true)
	t.Cleanup(func() {
		treenode.CloseDatabase()
		Conf = originalConf
		util.DataDir = originalDataDir
		util.BlockTreeDBPath = originalBlockTreeDBPath
	})

	mdBoxID, err := CreateMarkdownBox("Markdown Vault")
	if nil != err {
		t.Fatalf("CreateMarkdownBox failed: %s", err)
	}
	mdBox := &Box{ID: mdBoxID}
	mdBoxConf := mdBox.GetConf()
	if conf.BoxKindMarkdown != mdBoxConf.Kind {
		t.Fatalf("expected Kind=%q, got %q", conf.BoxKindMarkdown, mdBoxConf.Kind)
	}
	if "Markdown Vault" != mdBoxConf.Name {
		t.Fatalf("unexpected box name %q", mdBoxConf.Name)
	}
	// ensureBoxDoc0（initializeBoxDoc=true 才会跑）对 .sy box 会创建一个隐藏的
	// "笔记本自身文档"元数据文件；markdown box 应该完全没有这个文件。
	// readBoxDocID 对"文件不存在"和"文件存在但内容合法"都返回 nil error，
	// 不能用它的 err 判断文件在不在，得直接查文件系统。
	boxDocPath := boxDocMetaPath(mdBoxID)
	if _, statErr := os.Stat(boxDocPath); nil == statErr {
		t.Fatalf("markdown box should not have box-doc metadata, found at %s", boxDocPath)
	} else if !os.IsNotExist(statErr) {
		t.Fatalf("unexpected stat error for %s: %s", boxDocPath, statErr)
	}

	syBoxID, err := CreateBox("Sy Vault")
	if nil != err {
		t.Fatalf("CreateBox failed: %s", err)
	}
	syBox := &Box{ID: syBoxID}
	syBoxConf := syBox.GetConf()
	if "" != syBoxConf.Kind {
		t.Fatalf("expected plain CreateBox to leave Kind empty (sy default), got %q", syBoxConf.Kind)
	}
}
