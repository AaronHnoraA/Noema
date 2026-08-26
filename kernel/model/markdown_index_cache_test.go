// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org

package model

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	noemaplanning "github.com/aaronhe/noema/kernel/noema/planning"
	"github.com/aaronhe/noema/kernel/util"
)

func TestMarkdownIndexCachePersistsAndScopesPhysicalRoot(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	const boxID = "20260826123456-cache01"
	root := filepath.Join(t.TempDir(), "root")
	if err := os.MkdirAll(root, 0o755); nil != err {
		t.Fatal(err)
	}
	cache := newMarkdownIndexCache(root)
	cache.Entries["/note.md"] = markdownIndexCacheEntry{
		MtimeNs: 42, Size: 7, RootID: "root-id", Hash: "hash", SourceVersion: "version",
		PlanningCached: true, Planning: []noemaplanning.Node{{Title: "Task"}},
	}
	if err := saveMarkdownIndexCache(boxID, cache); nil != err {
		t.Fatal(err)
	}

	loaded := loadMarkdownIndexCache(boxID, root)
	if got := loaded.Entries["/note.md"]; !reflect.DeepEqual(got, cache.Entries["/note.md"]) {
		t.Fatalf("cache round trip mismatch: got %+v want %+v", got, cache.Entries["/note.md"])
	}
	otherRoot := filepath.Join(t.TempDir(), "other-root")
	if entries := loadMarkdownIndexCache(boxID, otherRoot).Entries; 0 != len(entries) {
		t.Fatalf("cache leaked across physical roots: %+v", entries)
	}
}

func TestMarkdownIndexCacheEntryRequiresFilesystemAndDatabaseIdentity(t *testing.T) {
	file := filepath.Join(t.TempDir(), "note.md")
	if err := os.WriteFile(file, []byte("content"), 0o644); nil != err {
		t.Fatal(err)
	}
	info, err := os.Stat(file)
	if nil != err {
		t.Fatal(err)
	}
	entry := markdownIndexCacheEntry{MtimeNs: info.ModTime().UnixNano(), Size: info.Size(), RootID: "root", Hash: "hash"}
	if !entry.matches(info, "root", "root", "hash") {
		t.Fatal("matching cache identity was rejected")
	}
	for name, matched := range map[string]bool{
		"blocktree root": entry.matches(info, "other", "root", "hash"),
		"SQL root":       entry.matches(info, "root", "other", "hash"),
		"SQL hash":       entry.matches(info, "root", "root", "other"),
	} {
		if matched {
			t.Fatalf("%s mismatch reused the cache", name)
		}
	}
}
