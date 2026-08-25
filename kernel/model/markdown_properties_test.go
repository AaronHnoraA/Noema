// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org

package model

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/util"
)

func TestListMarkdownPropertyBlocksScansPortableAnchors(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })
	boxID := "20260825000000-props01"
	setupMarkdownBoxForIndexTest(t, boxID)
	id := "0198fc34-7b32-7a11-8cb4-6c40e3b33d68"
	if err := os.WriteFile(filepath.Join(util.DataDir, boxID, "note.md"), []byte("Claim {#"+id+" status=draft owner=\"Aaron He\"}\n"), 0644); nil != err {
		t.Fatal(err)
	}
	documents, err := ListMarkdownPropertyBlocks(boxID, "/note.md")
	if nil != err {
		t.Fatal(err)
	}
	if len(documents) != 1 || len(documents[0].Blocks) != 1 {
		t.Fatalf("unexpected property documents: %+v", documents)
	}
	block := documents[0].Blocks[0]
	if block.CanonicalID != id || block.Text != "Claim" || block.Properties["status"] != "draft" || block.Properties["owner"] != "Aaron He" {
		t.Fatalf("unexpected portable property block: %+v", block)
	}
}

func TestMutateMarkdownPropertyUsesVersionAndStableIdentity(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })
	boxID := "20260825000000-props02"
	setupMarkdownBoxForIndexTest(t, boxID)
	id := "0198fc34-7b32-7a11-8cb4-6c40e3b33d68"
	abs := filepath.Join(util.DataDir, boxID, "note.md")
	source := "Claim {#" + id + " status=draft owner='Aaron He'}\n"
	if err := os.WriteFile(abs, []byte(source), 0644); nil != err {
		t.Fatal(err)
	}
	documents, err := ListMarkdownPropertyBlocks(boxID, "/note.md")
	if nil != err {
		t.Fatal(err)
	}
	originalSave := saveMarkdownPropertyDoc
	saveMarkdownPropertyDoc = func(_ string, _ string, markdown string) (string, []MarkdownBlockRef, error) {
		return markdown, []MarkdownBlockRef{}, os.WriteFile(abs, []byte(markdown), 0644)
	}
	t.Cleanup(func() { saveMarkdownPropertyDoc = originalSave })
	value := "Noema Team"
	result, err := MutateMarkdownProperty(MarkdownPropertyMutationRequest{
		Notebook: boxID, Path: "/note.md", ExpectedVersion: documents[0].Version,
		ID: "#" + id, Key: "owner", Value: &value,
	})
	if nil != err || !result.Changed {
		t.Fatalf("property mutation failed: %+v, %v", result, err)
	}
	raw, _ := os.ReadFile(abs)
	if string(raw) != "Claim {#"+id+" status=draft owner='Noema Team'}\n" {
		t.Fatalf("unexpected mutation bytes: %s", raw)
	}
	_, err = MutateMarkdownProperty(MarkdownPropertyMutationRequest{
		Notebook: boxID, Path: "/note.md", ExpectedVersion: documents[0].Version,
		ID: id, Key: "status", Value: &value,
	})
	if !errors.Is(err, ErrMarkdownPropertyVersionConflict) {
		t.Fatalf("expected stale version conflict, got %v", err)
	}
}
