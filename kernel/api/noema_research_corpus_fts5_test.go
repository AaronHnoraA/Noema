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

func TestNoemaResearchCorpusRoutesPreserveExactBlocks(t *testing.T) {
	gin.SetMode(gin.TestMode)
	root := t.TempDir()
	t.Cleanup(research.CloseAll)
	notebook := `{"nbformat":4,"nbformat_minor":5,"metadata":{"noema_research":{"schema":"noema.research-notebook/1","notebook_id":"nb_corpus_api","workstream_id":"ws_corpus_api","title":"Corpus API"}},"cells":[]}`
	if err := os.WriteFile(filepath.Join(root, "corpus.noema"), []byte(notebook), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "notes"), 0o755); err != nil {
		t.Fatal(err)
	}
	content := "# Evidence\n\nExact Ω source span with SEARCH_CANARY.\n"
	if err := os.WriteFile(filepath.Join(root, "notes", "evidence.md"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	engine := gin.New()
	engine.POST("/api/noema/research/index", noemaResearchIndex)
	engine.POST("/api/noema/research/corpus/index", noemaResearchCorpusIndex)
	engine.POST("/api/noema/research/corpus/index-files", noemaResearchCorpusIndexFiles)
	engine.POST("/api/noema/research/corpus/search", noemaResearchCorpusSearch)
	engine.POST("/api/noema/research/corpus/block/read", noemaResearchCorpusBlockRead)
	call := func(path string, body map[string]any) map[string]any {
		t.Helper()
		payload, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(payload)))
		request.Header.Set("Content-Type", "application/json")
		engine.ServeHTTP(recorder, request)
		var decoded map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
			t.Fatal(err)
		}
		if decoded["code"] != float64(0) {
			t.Fatalf("%s failed: %v", path, decoded)
		}
		return decoded
	}
	call("/api/noema/research/index", map[string]any{"root": root, "path": "corpus.noema", "actor": "test"})
	indexed := call("/api/noema/research/corpus/index", map[string]any{"root": root, "index": map[string]any{
		"workstreamId": "ws_corpus_api", "relativeRoot": "notes", "actor": "human:test",
	}})
	if data := indexed["data"].(map[string]any); data["createdSources"] != float64(1) || data["inferenceCalls"] != float64(0) {
		t.Fatalf("unexpected index result: %v", data)
	}
	searched := call("/api/noema/research/corpus/search", map[string]any{"root": root, "search": map[string]any{
		"workstreamId": "ws_corpus_api", "query": "SEARCH_CANARY", "limit": 10,
	}})
	hits := searched["data"].(map[string]any)["hits"].([]any)
	if len(hits) != 1 {
		t.Fatalf("unexpected corpus hits: %v", hits)
	}
	blockID := hits[0].(map[string]any)["blockId"].(string)
	read := call("/api/noema/research/corpus/block/read", map[string]any{"root": root, "id": blockID})
	if block := read["data"].(map[string]any); block["content"] != "Exact Ω source span with SEARCH_CANARY.\n" {
		t.Fatalf("exact block transport mismatch: %v", block)
	}

	updated := "# Evidence\n\nUpdated Ω source span with SEARCH_CANARY.\n"
	if err := os.WriteFile(filepath.Join(root, "notes", "evidence.md"), []byte(updated), 0o600); err != nil {
		t.Fatal(err)
	}
	targeted := call("/api/noema/research/corpus/index-files", map[string]any{"root": root, "index": map[string]any{
		"workstreamId": "ws_corpus_api", "paths": []string{"notes/evidence.md"}, "actor": "human:test",
	}})
	if data := targeted["data"].(map[string]any); data["parsedFiles"] != float64(1) || data["updatedSources"] != float64(1) {
		t.Fatalf("unexpected targeted result: %v", data)
	}
}
