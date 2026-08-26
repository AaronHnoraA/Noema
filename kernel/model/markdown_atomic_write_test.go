// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org

package model

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteMarkdownSourceAtomicReplacesExactBytes(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "note.md")
	if err := os.WriteFile(target, []byte("old"), 0o644); nil != err {
		t.Fatal(err)
	}
	want := []byte("# New\n\nexact bytes\x00included\n")
	if err := writeMarkdownSourceAtomic(target, want); nil != err {
		t.Fatal(err)
	}
	got, err := os.ReadFile(target)
	if nil != err {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("atomic Markdown write mismatch: got %q want %q", got, want)
	}
	temporary, err := filepath.Glob(filepath.Join(dir, ".note.md.noema-save-*"))
	if nil != err {
		t.Fatal(err)
	}
	if 0 != len(temporary) {
		t.Fatalf("atomic Markdown write leaked temporary files: %+v", temporary)
	}
}
