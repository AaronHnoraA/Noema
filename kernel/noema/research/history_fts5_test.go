//go:build fts5

package research

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeHistoryJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeHistoryJSONL(t *testing.T, path string, values ...any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	parts := make([]string, 0, len(values))
	for _, value := range values {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		parts = append(parts, string(data))
	}
	if err := os.WriteFile(path, []byte(strings.Join(parts, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestHistoryIndexSearchPeekReadAndProjectFilters(t *testing.T) {
	store, _ := openTestStore(t)
	sourceRoot := t.TempDir()
	projectA := t.TempDir()
	projectB := t.TempDir()
	writeHistoryJSON(t, filepath.Join(sourceRoot, "a.json"), map[string]any{
		"id": "magent-a", "project-root": projectA,
		"messages": []any{
			map[string]any{"role": "user", "content": "Investigate the spectral bound", "timestamp": "2026-09-12T01:00:00Z"},
			map[string]any{"role": "assistant", "content": "The logarithmic loss is avoidable", "timestamp": "2026-09-12T01:01:00Z"},
			map[string]any{"future-record": true},
		},
	})
	writeHistoryJSON(t, filepath.Join(sourceRoot, "b.json"), map[string]any{
		"id": "magent-b", "project-root": projectB,
		"messages": []any{map[string]any{"role": "user", "content": "Spectral notes for another project"}},
	})
	result, err := store.IndexHistory([]HistorySource{{Kind: "magent", Path: sourceRoot}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Records != 3 || len(result.Sources) != 1 || result.Sources[0].UnknownRecords != 1 {
		t.Fatalf("unexpected history index result: %+v", result)
	}
	if _, err := os.Stat(filepath.Join(store.root, StateDirName, "search.sqlite")); err != nil {
		t.Fatalf("history index must live in .agent/search.sqlite: %v", err)
	}

	hits, err := store.SearchHistory(HistorySearchOptions{Query: "spectral", ProjectRoot: projectA, Source: "magent"})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].NativeSessionID != "" || hits[0].SessionID != "magent-a" || !strings.Contains(hits[0].Excerpt, "<mark>") {
		t.Fatalf("metadata-filtered search mismatch: %+v", hits)
	}
	peek, err := store.PeekHistory(hits[0].ID, 12)
	if err != nil || peek.Content != "Investigate …" {
		t.Fatalf("peek mismatch: %+v (%v)", peek, err)
	}
	read, err := store.ReadHistory(hits[0].ID)
	if err != nil || read.Content != "Investigate the spectral bound" || read.Locator["record"] != float64(0) {
		t.Fatalf("read mismatch: %+v (%v)", read, err)
	}

	// A rebuild replaces this source's projection rather than duplicating it.
	if _, err := store.IndexHistory([]HistorySource{{Kind: "magent", Path: sourceRoot}}); err != nil {
		t.Fatal(err)
	}
	hits, err = store.SearchHistory(HistorySearchOptions{Query: "spectral", Source: "magent"})
	if err != nil || len(hits) != 2 {
		t.Fatalf("idempotent rebuild mismatch: %+v (%v)", hits, err)
	}
}

func TestHistoryNativeAdaptersIgnoreUnknownRecords(t *testing.T) {
	store, _ := openTestStore(t)
	root := t.TempDir()
	project := t.TempDir()
	codex := filepath.Join(root, "codex.jsonl")
	writeHistoryJSONL(t, codex,
		map[string]any{"type": "session_meta", "timestamp": "2026-09-12T01:00:00Z", "payload": map[string]any{"id": "codex-native", "cwd": project}},
		map[string]any{"type": "future_event", "payload": map[string]any{"opaque": true}},
		map[string]any{"type": "response_item", "timestamp": "2026-09-12T01:01:00Z", "payload": map[string]any{
			"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "Codex exact fragment"}},
		}},
	)
	claude := filepath.Join(root, "claude.jsonl")
	writeHistoryJSONL(t, claude,
		map[string]any{"type": "permission-mode", "sessionId": "claude-native"},
		map[string]any{"type": "assistant", "sessionId": "claude-native", "cwd": project, "timestamp": "2026-09-12T02:00:00Z",
			"message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "Claude exact fragment"}}}},
	)
	indexed, err := store.IndexHistory([]HistorySource{
		{Kind: "codex", Path: codex},
		{Kind: "claude", Path: claude},
	})
	if err != nil {
		t.Fatal(err)
	}
	if indexed.Records != 2 || indexed.Sources[0].UnknownRecords == 0 || indexed.Sources[1].UnknownRecords == 0 {
		t.Fatalf("unknown native records must be counted and ignored: %+v", indexed)
	}
	for _, source := range []string{"codex", "claude"} {
		hits, err := store.SearchHistory(HistorySearchOptions{Query: "exact fragment", ProjectRoot: project, Source: source})
		if err != nil || len(hits) != 1 || hits[0].NativeSessionID != source+"-native" {
			t.Fatalf("%s adapter mismatch: %+v (%v)", source, hits, err)
		}
	}
}

func TestHistoryAgentShellMarkdownTranscript(t *testing.T) {
	store, _ := openTestStore(t)
	project := t.TempDir()
	transcripts := filepath.Join(project, ".agent-shell", "transcripts")
	if err := os.MkdirAll(transcripts, 0o755); err != nil {
		t.Fatal(err)
	}
	transcript := `# Agent Shell Transcript

**Agent:** Codex
**Started:** 2026-09-12 01:00:00
**Working Directory:** ` + project + `
**Session ID:** acp-native-1

---

## User (2026-09-12 01:01:00)

Find the spectral obstruction.

## Agent's Thoughts (2026-09-12 01:01:01)

Private thought is not a conversation answer.

## Agent (2026-09-12 01:02:00)

The obstruction is local.
`
	if err := os.WriteFile(filepath.Join(transcripts, "session.md"), []byte(transcript), 0o600); err != nil {
		t.Fatal(err)
	}
	indexed, err := store.IndexHistory([]HistorySource{{Kind: "agent-shell", Path: transcripts, ProjectRoot: project}})
	if err != nil {
		t.Fatal(err)
	}
	if indexed.Records != 2 || indexed.Sources[0].UnknownRecords != 1 {
		t.Fatalf("unexpected transcript projection: %+v", indexed)
	}
	hits, err := store.SearchHistory(HistorySearchOptions{Query: "obstruction", ProjectRoot: project, Source: "agent-shell"})
	if err != nil || len(hits) != 2 {
		t.Fatalf("agent-shell search mismatch: %+v (%v)", hits, err)
	}
	for _, hit := range hits {
		if hit.NativeSessionID != "acp-native-1" {
			t.Fatalf("native ACP identity missing: %+v", hit)
		}
		read, err := store.ReadHistory(hit.ID)
		if err != nil || strings.Contains(read.Content, "Private thought") {
			t.Fatalf("thought section leaked into conversation record: %+v (%v)", read, err)
		}
	}
}
