// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package filesys

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/88250/lute/parse"
	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/util"
)

func withMarkdownBox(t *testing.T, boxID string) {
	t.Helper()
	originalProvider := BoxKindProvider
	BoxKindProvider = func(id string) string {
		if id == boxID {
			return conf.BoxKindMarkdown
		}
		return conf.BoxKindSy
	}
	t.Cleanup(func() {
		BoxKindProvider = originalProvider
	})
}

func TestBoxKindDefaultsToSyWhenUnset(t *testing.T) {
	originalProvider := BoxKindProvider
	BoxKindProvider = nil
	t.Cleanup(func() { BoxKindProvider = originalProvider })

	if isMarkdownBox("any-box") {
		t.Fatal("box kind must default to sy when no provider is injected")
	}
	if conf.BoxKindSy != boxKind("any-box") {
		t.Fatalf("unexpected default box kind [%s]", boxKind("any-box"))
	}
}

func TestWriteTreeThenLoadTreeRoundTripsMarkdownBox(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260824230000-mdbox01"
	withMarkdownBox(t, boxID)

	luteEngine := util.NewLute()
	source := "# Title\n\nSee @@cmd(foo, bar) for details.\n\n#+begin note\nSome text.\n#+end note\n\n$$\nx^2 + y^2 = z^2\n$$\n"
	tree := parse.Parse(boxID, []byte(source), luteEngine.ParseOptions)
	tree.Box = boxID
	tree.Path = "/notes/hello.md"
	tree.Root.Path = tree.Path

	if _, err := WriteTree(tree); nil != err {
		t.Fatalf("WriteTree failed: %s", err)
	}

	absPath := filepath.Join(util.DataDir, boxID, tree.Path)
	raw, err := os.ReadFile(absPath)
	if nil != err {
		t.Fatalf("read written file failed: %s", err)
	}
	written := string(raw)
	if strings.HasPrefix(strings.TrimSpace(written), "{") {
		t.Fatalf("markdown box wrote JSON instead of markdown: %s", written)
	}
	for _, want := range []string{"@@cmd(foo, bar)", "#+begin note", "#+end note", "x^2 + y^2 = z^2"} {
		if !strings.Contains(written, want) {
			t.Fatalf("written markdown lost %q:\n%s", want, written)
		}
	}

	writtenID := tree.Root.ID
	if "" == writtenID {
		t.Fatal("tree root ID was not assigned on first write")
	}

	reloaded, err := LoadTree(boxID, tree.Path, luteEngine)
	if nil != err {
		t.Fatalf("LoadTree failed: %s", err)
	}
	if reloaded.ID != writtenID {
		t.Fatalf("reloaded tree ID [%s] != written tree ID [%s] — doc-level IAL was not recovered", reloaded.ID, writtenID)
	}
	if reloaded.HPath != "/notes/hello" {
		t.Fatalf("unexpected markdown HPath [%s]", reloaded.HPath)
	}

	// 二次读取的树再写一次应当稳定（幂等）：不应生成新的 ID 或改变已写内容之外的字节。
	if _, err := WriteTree(reloaded); nil != err {
		t.Fatalf("second WriteTree failed: %s", err)
	}
	raw2, err := os.ReadFile(absPath)
	if nil != err {
		t.Fatalf("read re-written file failed: %s", err)
	}
	if string(raw2) != written {
		t.Fatalf("re-writing a freshly reloaded tree changed the file bytes:\nfirst:\n%s\nsecond:\n%s", written, string(raw2))
	}
}

func TestWriteTreeStillWritesJSONForSyBox(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	originalProvider := BoxKindProvider
	BoxKindProvider = nil // no provider injected -> defaults to sy, matching production boot order before model.init runs
	t.Cleanup(func() { BoxKindProvider = originalProvider })

	boxID := "20260824230000-sybox01"
	rootID := "20260824230001-syroot1"
	luteEngine := util.NewLute()
	tree := parse.Parse(boxID, []byte("content"), luteEngine.ParseOptions)
	tree.Box = boxID
	tree.Path = "/" + rootID + ".sy"
	tree.Root.ID = rootID
	tree.ID = rootID
	tree.Root.SetIALAttr("id", rootID)

	if _, err := WriteTree(tree); nil != err {
		t.Fatalf("WriteTree failed: %s", err)
	}

	absPath := filepath.Join(util.DataDir, boxID, tree.Path)
	raw, err := os.ReadFile(absPath)
	if nil != err {
		t.Fatalf("read written file failed: %s", err)
	}
	if !strings.HasPrefix(strings.TrimSpace(string(raw)), "{") {
		t.Fatalf("sy box did not write JSON: %s", raw)
	}
}
