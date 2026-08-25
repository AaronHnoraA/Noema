package model

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aaronhe/noema/kernel/filesys"
	noemaidentity "github.com/aaronhe/noema/kernel/noema/identity"
	noemaplanning "github.com/aaronhe/noema/kernel/noema/planning"
	"github.com/aaronhe/noema/kernel/util"
)

type sharedPlanningMutationFixture struct {
	Name     string                   `json:"name"`
	Input    string                   `json:"input"`
	Selector MarkdownPlanningSelector `json:"selector"`
	Mutation MarkdownPlanningMutation `json:"mutation"`
	Expected struct {
		Content    string `json:"content"`
		From       int    `json:"from"`
		To         int    `json:"to"`
		Source     string `json:"source"`
		NextSource string `json:"nextSource"`
	} `json:"expected"`
}

type sharedPlanningSemanticMutationFixture struct {
	Name           string                   `json:"name"`
	Input          string                   `json:"input"`
	Mutation       MarkdownPlanningMutation `json:"mutation"`
	ExpectedSource string                   `json:"expectedSource"`
}

func stubMarkdownPlanningSave(t *testing.T) {
	t.Helper()
	original := saveMarkdownPlanningDoc
	saveMarkdownPlanningDoc = func(boxID, path, markdown string) (string, []MarkdownBlockRef, error) {
		abs := filepath.Join(filesys.BoxRootPath(boxID), path)
		if err := os.MkdirAll(filepath.Dir(abs), 0755); err != nil {
			return "", nil, err
		}
		if err := os.WriteFile(abs, []byte(markdown), 0644); err != nil {
			return "", nil, err
		}
		return markdown, []MarkdownBlockRef{}, nil
	}
	t.Cleanup(func() { saveMarkdownPlanningDoc = original })
}

func TestSharedMarkdownPlanningMutationFixtures(t *testing.T) {
	stubMarkdownPlanningSave(t)
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })
	raw, err := os.ReadFile(filepath.Join("..", "..", "shared", "planning-mutation-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []sharedPlanningMutationFixture
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for i, fixture := range fixtures {
		boxID := "20260825000000-mutfix" + string(rune('a'+i))
		setupMarkdownBoxForIndexTest(t, boxID)
		path := "/fixture.md"
		abs := filepath.Join(util.DataDir, boxID, path)
		if err = os.WriteFile(abs, []byte(fixture.Input), 0644); err != nil {
			t.Fatal(err)
		}
		result, mutateErr := MutateMarkdownPlanning(MarkdownPlanningMutationRequest{
			Notebook: boxID, Path: path, Selector: fixture.Selector, Mutation: fixture.Mutation,
		})
		if mutateErr != nil {
			t.Fatalf("%s: %v", fixture.Name, mutateErr)
		}
		written, _ := os.ReadFile(abs)
		if string(written) != fixture.Expected.Content || result.From != fixture.Expected.From || result.To != fixture.Expected.To || result.Source != fixture.Expected.Source || result.NextSource != fixture.Expected.NextSource {
			t.Fatalf("%s mismatch: result=%+v content=%q expected=%+v", fixture.Name, result, written, fixture.Expected)
		}
	}
}

func TestSharedMarkdownPlanningSemanticMutationFixtures(t *testing.T) {
	stubMarkdownPlanningSave(t)
	originalLocation := time.Local
	time.Local = time.FixedZone("AEST", 10*60*60)
	t.Cleanup(func() { time.Local = originalLocation })
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })
	raw, err := os.ReadFile(filepath.Join("..", "..", "shared", "planning-semantic-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []sharedPlanningSemanticMutationFixture
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for i, fixture := range fixtures {
		boxID := "20260825000000-semfix" + string(rune('a'+i))
		setupMarkdownBoxForIndexTest(t, boxID)
		path := "/fixture.md"
		abs := filepath.Join(util.DataDir, boxID, path)
		if err = os.WriteFile(abs, []byte(fixture.Input), 0644); err != nil {
			t.Fatal(err)
		}
		kind := ""
		if fixture.Mutation.Type == "patch-todo" || fixture.Mutation.Type == "insert-clock" {
			kind = "todo"
		}
		result, mutateErr := MutateMarkdownPlanning(MarkdownPlanningMutationRequest{
			Notebook: boxID, Path: path, Selector: MarkdownPlanningSelector{Kind: kind, Index: intPointer(0)}, Mutation: fixture.Mutation,
		})
		if mutateErr != nil {
			t.Fatalf("%s: %v", fixture.Name, mutateErr)
		}
		written, _ := os.ReadFile(abs)
		expected := fixture.ExpectedSource
		if fixture.Mutation.Type == "insert-clock" {
			expected = fixture.Input + "\n" + fixture.ExpectedSource + "\n"
		}
		if string(written) != expected || result.NextSource == "" {
			t.Fatalf("%s mismatch: result=%+v content=%q expected=%q", fixture.Name, result, written, expected)
		}
	}
}

func intPointer(value int) *int { return &value }

func TestMutateMarkdownPlanningReplacesByUTF16SpanWithVersionPrecondition(t *testing.T) {
	stubMarkdownPlanningSave(t)
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })
	boxID := "20260825000000-planmut1"
	setupMarkdownBoxForIndexTest(t, boxID)
	path := "/agenda.md"
	abs := filepath.Join(util.DataDir, boxID, path)
	source := "标题😀\n@@todo(doing) [旧任务] {id: task01, due: tomorrow}\n"
	if err := os.WriteFile(abs, []byte(source), 0644); nil != err {
		t.Fatal(err)
	}
	documents, err := ListMarkdownPlanning(boxID, path)
	if err != nil || len(documents) != 1 || len(documents[0].Nodes) != 1 {
		t.Fatalf("planning setup failed: documents=%+v err=%v", documents, err)
	}
	node := documents[0].Nodes[0]
	replacement := "@@todo(done) [旧任务] {id=task01, due=2026-09-01}"
	result, err := MutateMarkdownPlanning(MarkdownPlanningMutationRequest{
		Notebook: boxID, Path: path, ExpectedVersion: documents[0].Version,
		Selector: MarkdownPlanningSelector{Kind: "todo", Index: &node.Span.From, Source: node.Raw, Title: node.Title},
		Mutation: MarkdownPlanningMutation{Type: "replace", Source: replacement},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || result.From != node.Span.From || result.Node == nil || result.Node.Status != "done" {
		t.Fatalf("unexpected mutation result: %+v", result)
	}
	raw, err := os.ReadFile(abs)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(raw); got != "标题😀\n"+replacement+"\n" {
		t.Fatalf("mutation changed unrelated UTF-8 source: %q", got)
	}
	_, err = MutateMarkdownPlanning(MarkdownPlanningMutationRequest{
		Notebook: boxID, Path: path, ExpectedVersion: documents[0].Version,
		Selector: MarkdownPlanningSelector{Kind: "todo", Title: node.Title},
		Mutation: MarkdownPlanningMutation{Type: "replace", Source: replacement},
	})
	if !errors.Is(err, ErrMarkdownPlanningVersionConflict) {
		t.Fatalf("expected version conflict, got %v", err)
	}
}

func TestMutateMarkdownPlanningInsertsClockAfterTodoLine(t *testing.T) {
	stubMarkdownPlanningSave(t)
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })
	boxID := "20260825000000-planmut2"
	setupMarkdownBoxForIndexTest(t, boxID)
	path := "/agenda.md"
	abs := filepath.Join(util.DataDir, boxID, path)
	if err := os.WriteFile(abs, []byte("prefix @@todo [Task] {id: task01} suffix\nAfter\n"), 0644); nil != err {
		t.Fatal(err)
	}
	result, err := MutateMarkdownPlanning(MarkdownPlanningMutationRequest{
		Notebook: boxID, Path: path,
		Selector: MarkdownPlanningSelector{Kind: "todo", ID: "#task01"},
		Mutation: MarkdownPlanningMutation{Type: "insert-after", Source: "@@clock [Task]{from: 2026-08-25 12:00, task: #task01}"},
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(abs)
	if !strings.Contains(string(raw), "suffix\n@@clock [Task]{from: 2026-08-25 12:00, task: #task01}\nAfter") {
		t.Fatalf("clock was not inserted after the containing todo line: %q", raw)
	}
	if result.Node == nil || result.Node.Kind != "clock" {
		t.Fatalf("inserted clock node missing from result: %+v", result)
	}
}

func TestMutateMarkdownPlanningAppendsToNewDocument(t *testing.T) {
	stubMarkdownPlanningSave(t)
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })
	boxID := "20260825000000-planmut3"
	setupMarkdownBoxForIndexTest(t, boxID)
	path := "/new/inbox.markdown"
	result, err := MutateMarkdownPlanning(MarkdownPlanningMutationRequest{
		Notebook: boxID, Path: path,
		Mutation: MarkdownPlanningMutation{Type: "append", Source: "@@todo [New] {id: new001}", InitialContent: "# Inbox\n"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Node == nil || result.Node.Title != "New" {
		t.Fatalf("appended node missing: %+v", result)
	}
	raw, _ := os.ReadFile(filepath.Join(util.DataDir, boxID, path))
	if string(raw) != "# Inbox\n\n@@todo [New] {id: new001}\n" {
		t.Fatalf("unexpected appended document: %q", raw)
	}
}

func TestMutateMarkdownPlanningCreatesTodoSemantically(t *testing.T) {
	stubMarkdownPlanningSave(t)
	originalLocation := time.Local
	time.Local = time.FixedZone("AEST", 10*60*60)
	t.Cleanup(func() { time.Local = originalLocation })
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })
	boxID := "20260825000000-planmut4"
	setupMarkdownBoxForIndexTest(t, boxID)
	if err := os.WriteFile(filepath.Join(util.DataDir, boxID, "existing.md"), []byte("@@todo [Existing] {id=abc123}\n"), 0644); err != nil {
		t.Fatal(err)
	}

	originalTodoID, originalDocumentID := newMarkdownPlanningTodoID, newMarkdownPlanningDocumentID
	idCalls := 0
	newMarkdownPlanningTodoID = func() (string, error) {
		idCalls++
		if idCalls == 1 {
			return "abc123", nil
		}
		return "def456", nil
	}
	const documentID = "019d2a10-bfa1-7e1b-8c21-a1f9c4f31f10"
	newMarkdownPlanningDocumentID = func() (string, error) { return documentID, nil }
	t.Cleanup(func() {
		newMarkdownPlanningTodoID = originalTodoID
		newMarkdownPlanningDocumentID = originalDocumentID
	})

	now := time.Date(2026, time.August, 25, 9, 30, 0, 0, time.Local)
	path := "/new/my-inbox.markdown"
	result, err := MutateMarkdownPlanning(MarkdownPlanningMutationRequest{
		Notebook: boxID, Path: path,
		Mutation: MarkdownPlanningMutation{Type: "append-todo", Create: &noemaplanning.TodoCreate{
			Title: "Created in Go", Status: "active", NowMs: now.UnixMilli(),
			Attrs: map[string]string{"ddl": "tomorrow", "prio": "a"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if idCalls != 2 || result.Node == nil || result.Node.Attrs["id"] != "def456" || result.Node.Status != "doing" {
		t.Fatalf("unexpected semantic create result: calls=%d result=%+v", idCalls, result)
	}
	if !noemaidentity.IsUUIDv7(documentID) {
		t.Fatalf("fixture document ID is not UUIDv7: %s", documentID)
	}
	raw, _ := os.ReadFile(filepath.Join(util.DataDir, boxID, path))
	content := string(raw)
	for _, wanted := range []string{
		"id: " + documentID,
		"title: My Inbox",
		"date: 2026-08-25",
		"# My Inbox",
		"@@todo(doing) [Created in Go] {id=def456, ddl=2026-08-26, prio=A}",
	} {
		if !strings.Contains(content, wanted) {
			t.Fatalf("semantic create output missing %q: %q", wanted, content)
		}
	}
	if result.NextSource != result.Node.Raw || strings.Contains(result.NextSource, "#+begin meta") {
		t.Fatalf("created source/result boundary is wrong: %+v", result)
	}
}
