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

func TestSaveMarkdownDocRejectsNonDocumentAndHiddenPaths(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260825010000-savepath1"
	setupMarkdownBoxForIndexTest(t, boxID)
	for _, candidate := range []string{"/notes/not-a-document.sy", "/.git/hooks/note.md", "/notes/.private.md"} {
		if _, _, err := SaveMarkdownDoc(boxID, candidate, "must not be written\n"); nil == err {
			t.Fatalf("expected an error saving forbidden Markdown path %q", candidate)
		}
		absPath := filepath.Join(util.DataDir, boxID, candidate)
		if _, statErr := os.Stat(absPath); !os.IsNotExist(statErr) {
			t.Fatalf("forbidden Markdown path %q was written, stat error: %v", candidate, statErr)
		}
	}
}

func TestSaveMarkdownDocCASRejectsStaleVersionWithoutWriting(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260826093000-savecas"
	setupMarkdownBoxForIndexTest(t, boxID)
	absPath := filepath.Join(util.DataDir, boxID, "notes", "race.md")
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); nil != err {
		t.Fatal(err)
	}
	const current = "# External winner\n"
	if err := os.WriteFile(absPath, []byte(current), 0644); nil != err {
		t.Fatal(err)
	}

	result, err := SaveMarkdownDocCAS(boxID, "/notes/race.md", "# Stale local edit\n", "stale-version", false)
	if nil != err {
		t.Fatal(err)
	}
	if !result.Conflict || result.Markdown != current || result.Version != markdownDocVersion([]byte(current)) {
		t.Fatalf("unexpected CAS conflict result: %+v", result)
	}
	if onDisk, readErr := os.ReadFile(absPath); nil != readErr || string(onDisk) != current {
		t.Fatalf("stale save changed disk: content=%q err=%v", onDisk, readErr)
	}
}

func TestSaveMarkdownDocCASRejectsAccidentalEmptyOverwriteWithoutWriting(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260826215000-saveempty"
	setupMarkdownBoxForIndexTest(t, boxID)
	absPath := filepath.Join(util.DataDir, boxID, "notes", "protected.md")
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); nil != err {
		t.Fatal(err)
	}
	const current = "# Keep this note\n"
	if err := os.WriteFile(absPath, []byte(current), 0644); nil != err {
		t.Fatal(err)
	}

	result, err := SaveMarkdownDocCAS(boxID, "/notes/protected.md", " \n\t", markdownDocVersion([]byte(current)), false)
	if nil != err {
		t.Fatal(err)
	}
	if !result.Rejected || result.Conflict || result.Markdown != current || "" == result.Message {
		t.Fatalf("unexpected empty-overwrite rejection: %+v", result)
	}
	if onDisk, readErr := os.ReadFile(absPath); nil != readErr || string(onDisk) != current {
		t.Fatalf("empty save changed disk: content=%q err=%v", onDisk, readErr)
	}
}

func TestApplyMarkdownChangeSetUsesCodeMirrorUTF16Offsets(t *testing.T) {
	tests := []struct {
		name      string
		source    string
		changeSet MarkdownChangeSet
		want      string
		wantErr   bool
	}{
		{
			name:   "multiple ranges",
			source: "abcdef",
			changeSet: MarkdownChangeSet{Length: 6, NewLength: 5, Changes: []MarkdownTextChange{
				{From: 1, To: 2, Insert: "X"},
				{From: 4, To: 6, Insert: "Y"},
			}},
			want: "aXcdY",
		},
		{
			name:   "astral characters",
			source: "a😀b",
			changeSet: MarkdownChangeSet{Length: 4, NewLength: 6, Changes: []MarkdownTextChange{
				{From: 1, To: 3, Insert: "🙂🙂"},
			}},
			want: "a🙂🙂b",
		},
		{
			name:   "reject split surrogate",
			source: "a😀b",
			changeSet: MarkdownChangeSet{Length: 4, NewLength: 4, Changes: []MarkdownTextChange{
				{From: 2, To: 2, Insert: ""},
			}},
			wantErr: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := applyMarkdownChangeSet([]byte(test.source), test.changeSet)
			if test.wantErr {
				if nil == err {
					t.Fatalf("expected invalid change-set error, got %q", got)
				}
				return
			}
			if nil != err || string(got) != test.want {
				t.Fatalf("apply changes = %q, %v; want %q", got, err, test.want)
			}
		})
	}
}

func TestSaveMarkdownDocChangesCASRejectsStaleVersionWithoutWriting(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260826221500-changecas"
	setupMarkdownBoxForIndexTest(t, boxID)
	absPath := filepath.Join(util.DataDir, boxID, "notes", "race.md")
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); nil != err {
		t.Fatal(err)
	}
	const current = "# External winner\n"
	if err := os.WriteFile(absPath, []byte(current), 0644); nil != err {
		t.Fatal(err)
	}
	changeSet := MarkdownChangeSet{Length: 18, NewLength: 18, Changes: []MarkdownTextChange{{From: 2, To: 10, Insert: "Local ed"}}}
	result, err := SaveMarkdownDocChangesCAS(boxID, "/notes/race.md", "stale-version", changeSet, false)
	if nil != err {
		t.Fatal(err)
	}
	if !result.Conflict || result.Markdown != current || result.Version != markdownDocVersion([]byte(current)) {
		t.Fatalf("unexpected incremental CAS conflict: %+v", result)
	}
	if onDisk, readErr := os.ReadFile(absPath); nil != readErr || string(onDisk) != current {
		t.Fatalf("stale incremental save changed disk: content=%q err=%v", onDisk, readErr)
	}
}
