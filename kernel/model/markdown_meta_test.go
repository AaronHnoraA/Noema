// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org

package model

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/filesys"
	noemaidentity "github.com/aaronhe/noema/kernel/noema/identity"
	"github.com/aaronhe/noema/kernel/util"
)

func setupMarkdownMetaTest(t *testing.T) (boxID, path, absPath string) {
	t.Helper()
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })
	boxID = "20260826090000-metatest"
	setupMarkdownBoxForIndexTest(t, boxID)
	path = "/paper.md"
	absPath = filepath.Join(filesys.BoxRootPath(boxID), path)
	return
}

func stubMarkdownMetaPersistence(t *testing.T) {
	t.Helper()
	originalSave := saveMarkdownMetaDoc
	originalID := newMarkdownMetaID
	originalToday := markdownMetaToday
	saveMarkdownMetaDoc = func(boxID, path, markdown string) (string, []MarkdownBlockRef, error) {
		absPath := filepath.Join(filesys.BoxRootPath(boxID), path)
		if err := os.MkdirAll(filepath.Dir(absPath), 0755); err != nil {
			return "", nil, err
		}
		if err := os.WriteFile(absPath, []byte(markdown), 0644); err != nil {
			return "", nil, err
		}
		return markdown, []MarkdownBlockRef{}, nil
	}
	newMarkdownMetaID = func() (string, error) { return "0198fc34-7b32-7a11-8cb4-6c40e3b33d68", nil }
	markdownMetaToday = func() string { return "2026-08-26" }
	t.Cleanup(func() {
		saveMarkdownMetaDoc = originalSave
		newMarkdownMetaID = originalID
		markdownMetaToday = originalToday
	})
}

func TestMutateMarkdownMetaUsesEditorSnapshotAndPersistsPortableIdentity(t *testing.T) {
	boxID, path, absPath := setupMarkdownMetaTest(t)
	stubMarkdownMetaPersistence(t)
	if err := os.WriteFile(absPath, []byte("# Old disk\n"), 0644); err != nil {
		t.Fatal(err)
	}
	editor := "# Live editor\n\nUnsaved paragraph.\n"
	project := "source-authority"
	tags := []string{"kernel", "meta"}
	result, err := MutateMarkdownMeta(MarkdownMetaMutationRequest{
		Notebook: boxID, Path: path, Action: "add", Markdown: &editor,
		Project: &project, Tags: &tags,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || result.Source != "kernel-meta" || !noemaidentity.IsUUIDv7(result.ID) ||
		!strings.Contains(result.Markdown, "title: Live editor\n") || !strings.Contains(result.Markdown, "project: source-authority\n") {
		t.Fatalf("unexpected metadata result: %+v\n%s", result, result.Markdown)
	}
	raw, readErr := os.ReadFile(absPath)
	if readErr != nil || string(raw) != result.Markdown || !strings.Contains(string(raw), "Unsaved paragraph.") {
		t.Fatalf("editor source was not persisted exactly around the patch: %q, %v", raw, readErr)
	}
}

func TestMutateMarkdownMetaRejectsStaleVersionBeforeSave(t *testing.T) {
	boxID, path, absPath := setupMarkdownMetaTest(t)
	stubMarkdownMetaPersistence(t)
	source := "#+begin meta\nid: legacy\ntitle: Paper\ndate: 2026-01-01\nkind: default\ntags:\nrefs:\n#+end meta\n\n# Paper\n"
	if err := os.WriteFile(absPath, []byte(source), 0644); err != nil {
		t.Fatal(err)
	}
	tags := []string{"new"}
	_, err := MutateMarkdownMeta(MarkdownMetaMutationRequest{
		Notebook: boxID, Path: path, Action: "tag", ExpectedVersion: strings.Repeat("0", 64), Tags: &tags,
	})
	if !errors.Is(err, ErrMarkdownMetaVersionConflict) {
		t.Fatalf("expected version conflict, got %v", err)
	}
	raw, _ := os.ReadFile(absPath)
	if string(raw) != source {
		t.Fatalf("stale mutation changed source: %q", raw)
	}
}

func TestMutateMarkdownMetaRejectsInvalidAllocatorIdentity(t *testing.T) {
	boxID, path, absPath := setupMarkdownMetaTest(t)
	stubMarkdownMetaPersistence(t)
	if err := os.WriteFile(absPath, []byte("# Paper\n"), 0644); err != nil {
		t.Fatal(err)
	}
	newMarkdownMetaID = func() (string, error) { return "legacy-id", nil }
	_, err := MutateMarkdownMeta(MarkdownMetaMutationRequest{Notebook: boxID, Path: path, Action: "add"})
	if err == nil || !strings.Contains(err.Error(), "non-UUIDv7") {
		t.Fatalf("expected invalid allocator rejection, got %v", err)
	}
	raw, _ := os.ReadFile(absPath)
	if string(raw) != "# Paper\n" {
		t.Fatalf("invalid allocator changed source: %q", raw)
	}
}

func TestMutateMarkdownMetaPersistsLiveSourceWhenIntentIsSemanticNoop(t *testing.T) {
	boxID, path, absPath := setupMarkdownMetaTest(t)
	stubMarkdownMetaPersistence(t)
	disk := "#+begin meta\nid: legacy\ntitle: Paper\ndate: 2026-01-01\nkind: default\ntags: kernel\nrefs:\n#+end meta\n\n# Paper\n"
	if err := os.WriteFile(absPath, []byte(disk), 0644); err != nil {
		t.Fatal(err)
	}
	live := disk + "\nUnsaved editor paragraph.\n"
	tags := []string{"kernel"}
	result, err := MutateMarkdownMeta(MarkdownMetaMutationRequest{
		Notebook: boxID, Path: path, Action: "add", Markdown: &live, Tags: &tags,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || result.Markdown != live {
		t.Fatalf("live source no-op was not treated as a persistence change: %+v", result)
	}
	raw, _ := os.ReadFile(absPath)
	if string(raw) != live {
		t.Fatalf("live editor source was discarded: %q", raw)
	}
}
