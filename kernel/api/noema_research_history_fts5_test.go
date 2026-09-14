//go:build fts5

package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/noema/research"
	"github.com/gin-gonic/gin"
)

func TestNoemaResearchHistoryRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	root := t.TempDir()
	t.Cleanup(research.CloseAll)
	historyPath := filepath.Join(t.TempDir(), "transcript.jsonl")
	line := `{"sessionId":"ses_native","nativeSessionId":"native_1","projectRoot":"` + root + `","role":"assistant","timestamp":"2026-09-12T01:00:00Z","content":"A precise spectral fragment"}`
	if err := os.WriteFile(historyPath, []byte(line+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	engine := gin.New()
	engine.POST("/history/index", noemaResearchHistoryIndex)
	engine.POST("/history/search", noemaResearchHistorySearch)
	engine.POST("/history/peek", noemaResearchHistoryPeek)
	engine.POST("/history/read", noemaResearchHistoryReadFull)
	call := func(path string, body map[string]any) map[string]any {
		t.Helper()
		payload, _ := json.Marshal(body)
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(payload)))
		request.Header.Set("Content-Type", "application/json")
		engine.ServeHTTP(recorder, request)
		var decoded map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
			t.Fatal(err)
		}
		return decoded
	}
	indexed := call("/history/index", map[string]any{"root": root, "sources": []any{
		map[string]any{"kind": "noema-transcript", "path": historyPath, "projectRoot": root},
	}})
	if indexed["code"].(float64) != 0 || indexed["data"].(map[string]any)["records"].(float64) != 1 {
		t.Fatalf("unexpected index response: %v", indexed)
	}
	searched := call("/history/search", map[string]any{"root": root, "query": "spectral", "projectRoot": root})
	hits := searched["data"].(map[string]any)["hits"].([]any)
	if len(hits) != 1 {
		t.Fatalf("unexpected search response: %v", searched)
	}
	id := hits[0].(map[string]any)["id"].(string)
	peeked := call("/history/peek", map[string]any{"root": root, "id": id, "maxRunes": 9})
	if content := peeked["data"].(map[string]any)["content"]; content != "A precise…" {
		t.Fatalf("unexpected peek response: %v", peeked)
	}
	read := call("/history/read", map[string]any{"root": root, "id": id})
	if content := read["data"].(map[string]any)["content"]; content != "A precise spectral fragment" {
		t.Fatalf("unexpected read response: %v", read)
	}
}
