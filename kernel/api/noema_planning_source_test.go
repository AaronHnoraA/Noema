package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestPlanningSourceAPIWithoutRegisteredBoxOrFilesystem(t *testing.T) {
	router := gin.New()
	router.POST("/source", computeNoemaPlanningSource)
	request := func(body string) map[string]interface{} {
		t.Helper()
		r := httptest.NewRequest(http.MethodPost, "/source", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var result map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	parsed := request(`{"content":"🚀\n@@todo [Remote] {id=abc123}\n"}`)
	if parsed["code"] != float64(0) {
		t.Fatal(parsed)
	}
	data := parsed["data"].(map[string]interface{})
	nodes := data["nodes"].([]interface{})
	if len(nodes) != 1 {
		t.Fatal(parsed)
	}
	node := nodes[0].(map[string]interface{})
	if node["span"].(map[string]interface{})["from"] != float64(3) {
		t.Fatal(node)
	}
	patched := request(`{"content":"@@todo [Remote] {id=abc123}\nTail","selector":{"id":"#abc123"},"mutation":{"type":"patch-todo","todo":{"status":"doing"}}}`)
	if patched["code"] != float64(0) || !strings.Contains(patched["data"].(map[string]interface{})["content"].(string), "@@todo(doing)") {
		t.Fatal(patched)
	}
	for _, body := range []string{`{"mutation":{"type":"unknown"}}`, `{"mutation":{"type":"append-todo"}}`, `{"content":`} {
		if result := request(body); result["code"] == float64(0) {
			t.Fatalf("invalid request accepted: %+v", result)
		}
	}
}
