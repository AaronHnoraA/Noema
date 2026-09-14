package research

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestMigrationAddsCellProposalAcceptanceReservationWithoutLosingRows(t *testing.T) {
	db, err := sql.Open("sqlite3", filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	statements := []string{
		`PRAGMA foreign_keys = ON`,
		`CREATE TABLE workstreams (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', notebook_id TEXT,
			status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
			version INTEGER NOT NULL DEFAULT 1)`,
		`CREATE TABLE proposals (
			id TEXT PRIMARY KEY, client_request_id TEXT NOT NULL UNIQUE, workstream_id TEXT NOT NULL REFERENCES workstreams(id),
			kind TEXT NOT NULL, payload_json TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')), proposed_by TEXT NOT NULL,
			source_adapter TEXT NOT NULL, created_at INTEGER NOT NULL, reviewed_by TEXT NOT NULL DEFAULT '',
			reviewed_at INTEGER, rejection_reason TEXT NOT NULL DEFAULT '', accepted_ref TEXT NOT NULL DEFAULT '',
			reviewed_payload_json TEXT, version INTEGER NOT NULL DEFAULT 1)`,
		`CREATE INDEX idx_proposals_attention ON proposals(status, created_at, id)`,
		`CREATE INDEX idx_proposals_workstream ON proposals(workstream_id, created_at DESC, id DESC)`,
		`INSERT INTO workstreams(id, created_at, updated_at) VALUES('ws_migration', 1, 1)`,
		`INSERT INTO proposals(id, client_request_id, workstream_id, kind, payload_json, payload_sha256,
			status, proposed_by, source_adapter, created_at) VALUES(
			'prop_migration', 'migration-1', 'ws_migration', 'cell.create', '{}', 'digest',
			'pending', 'agent:test', 'test', 1)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := migrate(db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE proposals SET status = 'accepting' WHERE id = 'prop_migration'`); err != nil {
		t.Fatalf("v8 status constraint was not installed: %v", err)
	}
	var status, version string
	if err := db.QueryRow(`SELECT status FROM proposals WHERE id = 'prop_migration'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE proposals SET kind = 'job.create' WHERE id = 'prop_migration'`); err != nil {
		t.Fatalf("v9 Proposal kind constraint was not installed: %v", err)
	}
	if status != "accepting" || version != "15" {
		t.Fatalf("unexpected migrated Proposal status=%q schema=%q", status, version)
	}
}

type testCell struct {
	id       string
	cellType string
	meta     map[string]any
	source   any
}

func writeTestNotebook(t *testing.T, root, rel, title string, cells []testCell) {
	t.Helper()
	rawCells := make([]map[string]any, 0, len(cells))
	for _, cell := range cells {
		cellType := cell.cellType
		if cellType == "" {
			cellType = "markdown"
		}
		metadata := map[string]any{"kept": true}
		if cell.meta != nil {
			metadata[Namespace] = cell.meta
		}
		raw := map[string]any{"id": cell.id, "cell_type": cellType, "metadata": metadata, "source": cell.source}
		if cellType == "code" {
			raw["outputs"] = []any{}
			raw["execution_count"] = nil
		}
		rawCells = append(rawCells, raw)
	}
	document := map[string]any{
		"nbformat":       4,
		"nbformat_minor": 5,
		"metadata": map[string]any{
			Namespace: map[string]any{
				"schema":        NotebookSchema,
				"notebook_id":   "nb_test",
				"workstream_id": "ws_test",
				"title":         title,
			},
		},
		"cells": rawCells,
	}
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func openTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	root := t.TempDir()
	t.Cleanup(CloseAll)
	store, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	return store, root
}

func eventTypes(events []Event) []string {
	types := make([]string, 0, len(events))
	for _, event := range events {
		types = append(types, event.Type)
	}
	return types
}

func TestParseNotebookProjectsResearchCells(t *testing.T) {
	data := []byte(`{
	  "nbformat": 4, "nbformat_minor": 5,
	  "metadata": {"noema_research": {"schema": "noema.research-notebook/1", "notebook_id": "nb_1", "title": "T"}},
	  "cells": [
	    {"id": "c-q", "cell_type": "markdown", "source": ["Can ", "we?"], "metadata": {"noema_research": {"kind": "question", "title": "Q"}}},
	    {"id": "c-w", "cell_type": "markdown", "source": "Try", "metadata": {"noema_research": {"kind": "work", "state": "open", "lineage": ["c-q", "c-q", " "]}}},
	    {"id": "c-n", "cell_type": "markdown", "source": "note", "metadata": {}},
	    {"id": "c-code", "cell_type": "code", "source": "1+1", "metadata": {}, "outputs": []}
	  ]
	}`)
	notebook, err := ParseNotebook(data)
	if err != nil {
		t.Fatal(err)
	}
	if notebook.ID != "nb_1" || len(notebook.Cells) != 4 {
		t.Fatalf("unexpected notebook %+v", notebook)
	}
	if notebook.Cells[0].SourceSHA256 != sha256Hex([]byte("Can we?")) {
		t.Fatal("source arrays must be joined before hashing")
	}
	if got := notebook.Cells[1].Lineage; len(got) != 1 || got[0] != notebook.Cells[0].WorkNodeID {
		t.Fatalf("lineage must be unique and trimmed: %v", got)
	}
	if notebook.Cells[2].Kind != "note" || notebook.Cells[3].Kind != "code" {
		t.Fatalf("default kinds wrong: %q %q", notebook.Cells[2].Kind, notebook.Cells[3].Kind)
	}
}

func TestParseNotebookKeepsCodeCellRoleSeparateFromWorkNode(t *testing.T) {
	data := []byte(`{
	  "nbformat": 4, "nbformat_minor": 5,
	  "metadata": {"noema_research": {
	    "schema": "noema.work-document/2", "notebook_id": "nb_v2",
	    "work_nodes": [{"id": "wn_baseline", "kind": "work", "title": "Baseline", "state": "active"}],
	    "dependencies": []
	  }},
	  "cells": [
	    {"id": "c-work", "cell_type": "markdown", "source": "Implement", "metadata": {"noema_research": {"work_node_id": "wn_baseline"}}},
	    {"id": "c-code", "cell_type": "code", "source": "print(1)", "metadata": {"noema_research": {"work_node_id": "wn_baseline"}}, "outputs": []}
	  ]
	}`)
	notebook, err := ParseNotebook(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(notebook.WorkNodes) != 1 || notebook.Cells[0].Kind != "work" {
		t.Fatalf("unexpected WorkNode projection: %+v", notebook)
	}
	if notebook.Cells[1].Kind != "code" || notebook.Cells[1].WorkNodeID != "wn_baseline" {
		t.Fatalf("code Cell must participate without becoming the WorkNode: %+v", notebook.Cells[1])
	}
}

func TestParseNotebookRejectsInvalidDocuments(t *testing.T) {
	cases := map[string]string{
		"schema":     `{"metadata": {"noema": {"source_file": "x.md"}}, "cells": []}`,
		"duplicate":  `{"metadata": {"noema_research": {"schema": "noema.research-notebook/1", "notebook_id": "nb"}}, "cells": [{"id": "a", "cell_type": "markdown"}, {"id": "a", "cell_type": "markdown"}]}`,
		"kind":       `{"metadata": {"noema_research": {"schema": "noema.research-notebook/1", "notebook_id": "nb"}}, "cells": [{"id": "a", "cell_type": "markdown", "metadata": {"noema_research": {"kind": "task"}}}]}`,
		"id":         `{"metadata": {"noema_research": {"schema": "noema.research-notebook/1", "notebook_id": "nb"}}, "cells": [{"id": "bad id", "cell_type": "markdown"}]}`,
		"work-cycle": `{"metadata": {"noema_research": {"schema": "noema.work-document/2", "notebook_id": "nb", "work_nodes": [{"id":"wn_a","kind":"work"},{"id":"wn_b","kind":"work"}], "dependencies": [{"id":"dep_a","from":"wn_a","to":"wn_b","type":"lineage"},{"id":"dep_b","from":"wn_b","to":"wn_a","type":"depends"}]}}, "cells": []}`,
	}
	for name, body := range cases {
		if _, err := ParseNotebook([]byte(body)); err == nil {
			t.Fatalf("%s: expected an error", name)
		}
	}
	if _, err := ParseNotebook([]byte(cases["schema"])); err != ErrNotResearchNotebook {
		t.Fatalf("sidecar notebooks must report ErrNotResearchNotebook, got %v", err)
	}
}

func TestIndexNotebookRecordsSemanticDiffs(t *testing.T) {
	store, root := openTestStore(t)
	rel := "research/bound.noema"
	writeTestNotebook(t, root, rel, "Bound", []testCell{
		{id: "c-q", meta: map[string]any{"kind": "question", "title": "Improve bound"}, source: "Can O(n log n) become O(n)?"},
		{id: "c-w", meta: map[string]any{"kind": "work", "title": "Spectral", "state": "open", "lineage": []string{"c-q"}}, source: "Investigate"},
		{id: "c-x", meta: map[string]any{"kind": "work", "title": "Numerics", "state": "open", "lineage": []string{"c-q", "c-missing"}}, source: "Run"},
	})

	first, err := store.IndexNotebook(rel, IndexOptions{Actor: "test", Reason: "create"})
	if err != nil {
		t.Fatal(err)
	}
	if first.Cells != 3 || first.Edges != 2 || first.DanglingEdges != 1 {
		t.Fatalf("unexpected first index %+v", first)
	}
	if got := eventTypes(first.Events); len(got) != 1 || got[0] != "research.notebook.indexed" {
		t.Fatalf("first index must record one indexed event, got %v", got)
	}
	if first.Events[0].Payload["actor"] != "test" || first.Events[0].Payload["reason"] != "create" {
		t.Fatalf("event attribution missing: %+v", first.Events[0].Payload)
	}
	location, err := store.ResolveResearchCell("nb_test", "c-w")
	if err != nil || location.Path != rel || location.Revision != first.Revision {
		t.Fatalf("deep-link cell resolution must use the indexed path: %+v (%v)", location, err)
	}
	if _, err := store.ResolveResearchCell("nb_test", "missing"); err == nil {
		t.Fatal("deep-link cell resolution must reject unknown cells")
	}

	again, err := store.IndexNotebook(rel, IndexOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !again.Unchanged || len(again.Events) != 0 {
		t.Fatalf("reindexing identical bytes must be a no-op: %+v", again)
	}

	writeTestNotebook(t, root, rel, "Bound", []testCell{
		{id: "c-q", meta: map[string]any{"kind": "question", "title": "Improve bound"}, source: "Can O(n log n) become O(n)?"},
		{id: "c-w", meta: map[string]any{"kind": "work", "title": "Spectral route", "state": "dropped", "dropped_reason": "needs uniform gap", "lineage": []string{"c-q"}}, source: "Investigate"},
		{id: "c-k", meta: map[string]any{"kind": "checkpoint", "title": "Reversibility invalid", "lineage": []string{"c-w"}}, source: "Lemma 4"},
		{id: "c-x", meta: map[string]any{"kind": "work", "title": "Numerics", "state": "open", "lineage": []string{"c-k"}, "depends": []string{"c-k"}}, source: "Run"},
	})
	status, err := store.Status(rel)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Stale || status.NotebookID != "nb_test" {
		t.Fatalf("a changed file must be stale: %+v", status)
	}
	second, err := store.IndexNotebook(rel, IndexOptions{Actor: "emacs", Reason: "sync"})
	if err != nil {
		t.Fatal(err)
	}
	types := strings.Join(eventTypes(second.Events), ",")
	for _, want := range []string{"research.cell.created", "research.cell.updated", "research.cell.state_changed", "research.relation.changed"} {
		if !strings.Contains(types, want) {
			t.Fatalf("missing %s in %s", want, types)
		}
	}
	for _, event := range second.Events {
		if event.Type == "research.cell.state_changed" {
			if event.CellID != "c-w" || event.Payload["to"] != "dropped" || event.Payload["reason_text"] != "needs uniform gap" {
				t.Fatalf("unexpected state event %+v", event)
			}
		}
		if event.Type == "research.relation.changed" && event.CellID == "c-x" && event.Payload["type"] == "lineage" {
			added, _ := event.Payload["added"].([]string)
			removed, _ := event.Payload["removed"].([]string)
			if len(added) != 1 || added[0] != legacyWorkNodeID("nb_test", "c-k") ||
				len(removed) != 1 || removed[0] != legacyWorkNodeID("nb_test", "c-q") {
				t.Fatalf("unexpected lineage change %+v", event.Payload)
			}
		}
	}
	status, err = store.Status(rel)
	if err != nil {
		t.Fatal(err)
	}
	if status.Stale {
		t.Fatalf("index must be current after reindex: %+v", status)
	}

	writeTestNotebook(t, root, rel, "Bound", []testCell{
		{id: "c-q", meta: map[string]any{"kind": "question", "title": "Improve bound"}, source: "Can O(n log n) become O(n)?"},
	})
	third, err := store.IndexNotebook(rel, IndexOptions{})
	if err != nil {
		t.Fatal(err)
	}
	deleted := 0
	for _, event := range third.Events {
		if event.Type == "research.cell.deleted" {
			deleted++
		}
	}
	if deleted != 3 || third.Edges != 0 {
		t.Fatalf("deleting cells must record deletions and drop edges: %+v", third)
	}

	all, err := store.Events("nb_test", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) < 1+len(second.Events)+len(third.Events) {
		t.Fatalf("events were not persisted: %d", len(all))
	}
	for index := 1; index < len(all); index++ {
		if all[index].Seq <= all[index-1].Seq {
			t.Fatal("events must be ordered by seq")
		}
	}
	tail, err := store.Events("nb_test", all[0].Seq, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 2 || tail[0].Seq <= all[0].Seq {
		t.Fatalf("after/limit not honoured: %+v", tail)
	}
	if _, err := os.Stat(filepath.Join(root, StateDirName, "state.sqlite")); err != nil {
		t.Fatalf("state must live under .agent: %v", err)
	}
	ignore, err := os.ReadFile(filepath.Join(root, StateDirName, ".gitignore"))
	if err != nil || string(ignore) != "*\n" {
		t.Fatalf(".agent must ignore itself, got %q (%v)", ignore, err)
	}
}

func TestResolveRejectsEscapingPaths(t *testing.T) {
	store, root := openTestStore(t)
	for _, rel := range []string{"", "../outside.noema", "/abs.noema", filepath.Join(root, "a.noema"), "ordinary.ipynb", "notes/a.md"} {
		if _, err := store.IndexNotebook(rel, IndexOptions{}); err == nil {
			t.Fatalf("path %q must be rejected", rel)
		}
	}
	if _, err := Open("relative/root"); err == nil {
		t.Fatal("relative repository roots must be rejected")
	}
}

func TestIndexNotebookHandlesReplacedFile(t *testing.T) {
	store, root := openTestStore(t)
	rel := "a.noema"
	writeTestNotebook(t, root, rel, "A", []testCell{{id: "c-1", meta: map[string]any{"kind": "question"}, source: "?"}})
	if _, err := store.IndexNotebook(rel, IndexOptions{}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatal(err)
	}
	replaced := strings.Replace(string(data), `"nb_test"`, `"nb_other"`, 1)
	if err := os.WriteFile(filepath.Join(root, rel), []byte(replaced), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := store.IndexNotebook(rel, IndexOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.NotebookID != "nb_other" || result.Events[0].Type != "research.notebook.indexed" {
		t.Fatalf("a different notebook at the same path must be indexed fresh: %+v", result)
	}
	var count int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM notebooks`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("the replaced notebook row must be removed, have %d", count)
	}
}

func TestPromoteSessionPersistsNativeAndAttachedTimes(t *testing.T) {
	store, _ := openTestStore(t)
	startedAt := "2026-09-12T03:04:05.678Z"
	promoted, err := store.PromoteSession(PromoteSessionInput{
		Title:           "Investigate indexing",
		Adapter:         "magent",
		Transport:       "acp",
		NativeSessionID: "native-123",
		ExecutionTarget: "/tmp/project",
		StartedAt:       startedAt,
		Capabilities:    map[string]any{"resume": true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !promoted.NewSession || !promoted.NewWorkstream || promoted.ID == "" || promoted.WorkstreamID == "" {
		t.Fatalf("promotion must create both identities: %+v", promoted)
	}
	if promoted.StartedAt != startedAt || promoted.AttachedAt == "" || promoted.AttachedAt == promoted.StartedAt {
		t.Fatalf("native and attachment time must stay distinct: %+v", promoted)
	}
	if promoted.State != "warm" || promoted.Capabilities["resume"] != true {
		t.Fatalf("unexpected promoted session: %+v", promoted)
	}

	again, err := store.PromoteSession(PromoteSessionInput{
		Title:           "Ignored duplicate",
		Adapter:         "magent",
		Transport:       "acp",
		NativeSessionID: "native-123",
		ExecutionTarget: "/tmp/project",
	})
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != promoted.ID || again.NewSession || again.AttachedAt != promoted.AttachedAt {
		t.Fatalf("promotion must be idempotent: first=%+v second=%+v", promoted, again)
	}

	loaded, err := store.GetSession(promoted.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.NativeSessionID != "native-123" || loaded.StartedAt != startedAt {
		t.Fatalf("session did not persist: %+v", loaded)
	}
	listed, err := store.ListSessions(SessionFilter{WorkstreamID: promoted.WorkstreamID})
	if err != nil || len(listed) != 1 || listed[0].ID != promoted.ID {
		t.Fatalf("session list mismatch: %+v (%v)", listed, err)
	}
	events, err := store.Events("", 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(eventTypes(events), ","); got != "workstream.created,session.promoted" {
		t.Fatalf("promotion events must be atomic and singular, got %s", got)
	}
	if events[1].SessionID != promoted.ID || events[1].WorkstreamID != promoted.WorkstreamID {
		t.Fatalf("session event references missing: %+v", events[1])
	}

	CloseAll()
	reopened, err := Open(store.root)
	if err != nil {
		t.Fatal(err)
	}
	afterRestart, err := reopened.GetSession(promoted.ID)
	if err != nil || afterRestart.AttachedAt != promoted.AttachedAt || afterRestart.StartedAt != startedAt {
		t.Fatalf("session must survive restart: %+v (%v)", afterRestart, err)
	}
}

func TestManualInterventionIsAnIdleVersionedSessionHandoff(t *testing.T) {
	store, root := openTestStore(t)
	session, err := store.PromoteSession(PromoteSessionInput{
		Title: "Takeover", Adapter: "codex", Transport: "acp", NativeSessionID: "native-takeover", ExecutionTarget: root,
	})
	if err != nil {
		t.Fatal(err)
	}
	intervention, err := store.BeginManualIntervention(BeginManualInterventionInput{
		SessionID: session.ID, Command: []string{"codex", "resume", "native-takeover"}, StartedBy: "emacs", ExpectedVersion: session.Version,
	})
	if err != nil || intervention.State != "active" || intervention.Transport != "pty" || intervention.Version != 1 {
		t.Fatalf("unexpected manual takeover: %+v (%v)", intervention, err)
	}
	if loaded, err := store.GetSession(session.ID); err != nil || loaded.State != "active" || loaded.Version != session.Version+1 {
		t.Fatalf("takeover must version and activate Session: %+v (%v)", loaded, err)
	}
	if _, err := store.BeginManualIntervention(BeginManualInterventionInput{
		SessionID: session.ID, Command: []string{"codex", "resume", "native-takeover"}, StartedBy: "emacs", ExpectedVersion: session.Version + 1,
	}); err == nil {
		t.Fatal("one Session cannot have two active manual interventions")
	}
	ended, err := store.EndManualIntervention(EndManualInterventionInput{
		InterventionID: intervention.ID, EndedBy: "emacs", Reason: "return to agent-shell", ExpectedVersion: intervention.Version,
	})
	if err != nil || ended.State != "ended" || ended.EndedAt == "" || ended.Version != 2 {
		t.Fatalf("unexpected handback: %+v (%v)", ended, err)
	}
	if _, err := store.EndManualIntervention(EndManualInterventionInput{
		InterventionID: intervention.ID, EndedBy: "emacs", ExpectedVersion: intervention.Version,
	}); err == nil {
		t.Fatal("a second handback must conflict")
	}
	if loaded, err := store.GetSession(session.ID); err != nil || loaded.State != "warm" {
		t.Fatalf("handback must make Session resumable: %+v (%v)", loaded, err)
	}
	events, err := store.Events("", 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	phases := []string{}
	for _, event := range events {
		if event.Type == "session.manual_intervention" {
			phases = append(phases, runtimeStringValue(event.Payload["phase"]))
		}
	}
	if !reflect.DeepEqual(phases, []string{"started", "ended"}) {
		t.Fatalf("manual intervention events must bracket PTY ownership: %v", phases)
	}
}

func TestPromoteSessionValidatesIdentityAndParent(t *testing.T) {
	store, _ := openTestStore(t)
	base := PromoteSessionInput{Adapter: "codex", Transport: "acp", NativeSessionID: "n", ExecutionTarget: "/repo"}
	for name, mutate := range map[string]func(*PromoteSessionInput){
		"adapter":    func(value *PromoteSessionInput) { value.Adapter = "" },
		"transport":  func(value *PromoteSessionInput) { value.Transport = "stdio" },
		"native":     func(value *PromoteSessionInput) { value.NativeSessionID = "" },
		"target":     func(value *PromoteSessionInput) { value.ExecutionTarget = "" },
		"workstream": func(value *PromoteSessionInput) { value.WorkstreamID = "bad" },
		"parent":     func(value *PromoteSessionInput) { value.ParentSessionID = "ses_missing" },
		"time":       func(value *PromoteSessionInput) { value.StartedAt = "yesterday" },
	} {
		input := base
		mutate(&input)
		if _, err := store.PromoteSession(input); err == nil {
			t.Fatalf("%s: expected validation error", name)
		}
	}
}
