package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	noemaattributeview "github.com/aaronhe/noema/kernel/noema/attributeview"
	"github.com/gin-gonic/gin"
)

func TestEvaluateNoemaAttributeViewAPI(t *testing.T) {
	engine := gin.New()
	engine.POST("/api/noema/attribute-view/evaluate", evaluateNoemaAttributeView)
	recorder := httptest.NewRecorder()
	body := `{"title":"Open","source":"columns: text, status\nfilter: status = todo","items":[{"id":"#a","kind":"todo","status":"todo","text":"Draft","file":"/a.md","line":2,"canon":{}},{"id":"#b","kind":"todo","status":"done","text":"Done","file":"/a.md","line":3,"canon":{}}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/noema/attribute-view/evaluate", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, req)
	var response markdownDocResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Code != 0 {
		t.Fatalf("attribute view evaluation failed: %s", recorder.Body.String())
	}
	var result noemaattributeview.Result
	if err := json.Unmarshal(response.Data, &result); err != nil {
		t.Fatal(err)
	}
	if result.Title != "Open" || result.Total != 1 || len(result.Rows) != 1 || result.Rows[0].ID != "#a" {
		t.Fatalf("unexpected attribute view evaluation: %+v", result)
	}
}

func TestEvaluateNoemaAttributeViewAPIRequiresItems(t *testing.T) {
	engine := gin.New()
	engine.POST("/api/noema/attribute-view/evaluate", evaluateNoemaAttributeView)
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/noema/attribute-view/evaluate", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, req)
	var response markdownDocResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Code != -1 {
		t.Fatalf("expected missing items rejection: %s", recorder.Body.String())
	}
}
