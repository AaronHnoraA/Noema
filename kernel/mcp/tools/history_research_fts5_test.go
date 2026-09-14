//go:build fts5

package tools

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/noema/research"
)

func TestHistoryToolReadsResearchConversationIndex(t *testing.T) {
	root := t.TempDir()
	t.Cleanup(research.CloseAll)
	historyPath := filepath.Join(t.TempDir(), "transcript.jsonl")
	line, _ := json.Marshal(map[string]any{
		"sessionId": "ses_test", "projectRoot": root, "role": "assistant",
		"timestamp": "2026-09-12T01:00:00Z", "content": "The exact research history fragment",
	})
	if err := os.WriteFile(historyPath, append(line, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := research.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.IndexHistory([]research.HistorySource{{Kind: "noema-transcript", Path: historyPath, ProjectRoot: root}}); err != nil {
		t.Fatal(err)
	}
	searched, err := historyHandler(map[string]any{"action": "search", "root": root, "query": "exact history"})
	if err != nil || searched.IsError || len(searched.Content) != 1 {
		t.Fatalf("search failed: %+v (%v)", searched, err)
	}
	var payload struct {
		Hits []research.HistoryRecord `json:"hits"`
	}
	if err := json.Unmarshal([]byte(searched.Content[0].Text), &payload); err != nil || len(payload.Hits) != 1 {
		t.Fatalf("search payload mismatch: %s (%v)", searched.Content[0].Text, err)
	}
	read, err := historyHandler(map[string]any{"action": "read", "root": root, "id": payload.Hits[0].ID})
	if err != nil || read.IsError || len(read.Content) != 1 {
		t.Fatalf("read failed: %+v (%v)", read, err)
	}
	var record research.HistoryRecord
	if err := json.Unmarshal([]byte(read.Content[0].Text), &record); err != nil || record.Content != "The exact research history fragment" {
		t.Fatalf("read payload mismatch: %s (%v)", read.Content[0].Text, err)
	}
}
