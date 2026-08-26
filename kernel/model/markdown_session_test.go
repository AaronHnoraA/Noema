// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org

package model

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/aaronhe/noema/kernel/util"
)

func setupMarkdownSessionTest(t *testing.T, boxID string) {
	t.Helper()
	originalDataDir := util.DataDir
	originalNow := markdownSessionNow
	util.DataDir = t.TempDir()
	markdownSessionNow = func() float64 { return 99 }
	t.Cleanup(func() {
		util.DataDir = originalDataDir
		markdownSessionNow = originalNow
	})
	setupMarkdownBoxForIndexTest(t, boxID)
}

func TestMarkdownSessionRecentNotesAreRelativeBoundedAndStable(t *testing.T) {
	boxID := "20260826094000-session"
	setupMarkdownSessionTest(t, boxID)

	for _, entry := range []MarkdownRecentNote{
		{Notebook: boxID, Path: "/older.md", OpenedAt: 5},
		{Notebook: boxID, Path: "/newer.md", OpenedAt: 8},
		{Notebook: boxID, Path: "/older.md", OpenedAt: 3},
	} {
		if _, err := TouchMarkdownRecentNote(entry); err != nil {
			t.Fatal(err)
		}
	}
	state, err := ReadMarkdownSession(boxID)
	if err != nil {
		t.Fatal(err)
	}
	if state.Source != "kernel-session" || len(state.Recent) != 2 || state.Recent[0].Path != "/newer.md" || state.Recent[1].OpenedAt != 5 {
		t.Fatalf("unexpected recent state: %+v", state)
	}
	if _, err = TouchMarkdownRecentNote(MarkdownRecentNote{Notebook: boxID, Path: "/.git/private.md", OpenedAt: 10}); err == nil {
		t.Fatal("expected hidden session path to be rejected")
	}
	raw, err := os.ReadFile(markdownSessionStatePath(boxID))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), util.DataDir) || !strings.Contains(string(raw), `"path": "/newer.md"`) {
		t.Fatalf("session state must persist repository-relative paths only: %s", raw)
	}
	for i := 0; i < 26; i++ {
		state, err = TouchMarkdownRecentNote(MarkdownRecentNote{
			Notebook: boxID, Path: fmt.Sprintf("/bulk-%02d.md", i), OpenedAt: float64(100 + i),
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(state.Recent) != markdownRecentNoteLimit || state.Recent[0].Path != "/bulk-25.md" || state.Recent[len(state.Recent)-1].Path != "/bulk-02.md" {
		t.Fatalf("recent state was not capped newest-first: %+v", state.Recent)
	}
}

func TestMarkdownSessionCursorWritesPreserveSplitClients(t *testing.T) {
	boxID := "20260826094001-session"
	setupMarkdownSessionTest(t, boxID)
	entries := []MarkdownCursorPosition{
		{Notebook: boxID, Path: "/split.md", Client: "left-pane", Mode: "markdown", From: 10, To: 10, ScrollY: 100, UpdatedAt: 10},
		{Notebook: boxID, Path: "/split.md", Client: "right-pane", Mode: "source", From: 90, To: 91, ScrollY: 900, UpdatedAt: 20},
	}
	start := make(chan struct{})
	var wait sync.WaitGroup
	wait.Add(len(entries))
	errs := make(chan error, len(entries))
	for _, entry := range entries {
		go func(entry MarkdownCursorPosition) {
			defer wait.Done()
			<-start
			_, err := TouchMarkdownCursorPosition(entry)
			errs <- err
		}(entry)
	}
	close(start)
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}

	state, err := ReadMarkdownSession(boxID)
	if err != nil {
		t.Fatal(err)
	}
	byClient := map[string]MarkdownCursorPosition{}
	for _, position := range state.Positions {
		byClient[position.Client] = position
	}
	if byClient["left-pane"].From != 10 || byClient["right-pane"].From != 90 || byClient[""].From != 90 || byClient[""].Mode != "source" {
		t.Fatalf("split cursor slots were lost or merged incorrectly: %+v", state.Positions)
	}

	state, err = TouchMarkdownCursorPosition(MarkdownCursorPosition{
		Notebook: boxID, Path: "/split.md", Mode: "unexpected", From: -2, To: -1, ScrollY: -3,
	})
	if err != nil {
		t.Fatal(err)
	}
	if state.Positions[0].Mode != "markdown" || state.Positions[0].From != 0 || state.Positions[0].To != 0 || state.Positions[0].ScrollY != 0 || state.Positions[0].UpdatedAt != 99 {
		t.Fatalf("cursor normalization changed: %+v", state.Positions[0])
	}
	bulk := make([]MarkdownCursorPosition, 0, markdownCursorPositionLimit+5)
	for i := 0; i < markdownCursorPositionLimit+5; i++ {
		bulk = append(bulk, MarkdownCursorPosition{
			Notebook: boxID, Path: fmt.Sprintf("/position-%03d.md", i), UpdatedAt: float64(i + 1),
		})
	}
	bulk = normalizeMarkdownCursorPositions(boxID, bulk)
	if len(bulk) != markdownCursorPositionLimit || bulk[0].Path != "/position-244.md" || bulk[len(bulk)-1].Path != "/position-005.md" {
		t.Fatalf("cursor positions were not capped newest-first: first=%+v last=%+v count=%d", bulk[0], bulk[len(bulk)-1], len(bulk))
	}
}

func TestMarkdownSessionRecoversCorruptOptionalStateOnTouch(t *testing.T) {
	boxID := "20260826094002-session"
	setupMarkdownSessionTest(t, boxID)
	statePath := markdownSessionStatePath(boxID)
	if err := os.MkdirAll(filepath.Dir(statePath), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, []byte("not-json"), 0644); err != nil {
		t.Fatal(err)
	}
	state, err := TouchMarkdownRecentNote(MarkdownRecentNote{Notebook: boxID, Path: "/recovered.md", OpenedAt: 7})
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Recent) != 1 || state.Recent[0].Path != "/recovered.md" {
		t.Fatalf("corrupt session state was not recovered: %+v", state)
	}
}

func TestMarkdownSessionRejectsNotebookPathEscape(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })
	if _, err := ReadMarkdownSession("../escape"); err == nil {
		t.Fatal("expected session notebook path escape to be rejected")
	}
}
