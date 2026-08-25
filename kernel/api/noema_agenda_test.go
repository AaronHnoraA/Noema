package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	noemaagenda "github.com/aaronhe/noema/kernel/noema/agenda"
	"github.com/gin-gonic/gin"
)

func TestEvaluateNoemaAgendaAPI(t *testing.T) {
	engine := gin.New()
	engine.POST("/api/noema/agenda/evaluate", evaluateNoemaAgenda)
	recorder := httptest.NewRecorder()
	body := `{"todayMs":1787623200000,"todos":[{"id":"#a","status":"doing","text":"first","file":"/a.md","noteTitle":"A","index":0,"line":1,"canon":{}},{"id":"#b","status":"todo","text":"second","file":"/a.md","noteTitle":"A","index":10,"line":2,"canon":{"after":"#a"}}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/noema/agenda/evaluate", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, req)
	var response markdownDocResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Code != 0 {
		t.Fatalf("agenda evaluation failed: %s", recorder.Body.String())
	}
	var result noemaagenda.EvaluateResult
	if err := json.Unmarshal(response.Data, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Todos) != 2 || result.Todos[1].EffectiveStatus != "blocked" || len(result.Todos[1].BlockedBy) != 1 || result.Todos[1].BlockedBy[0] != "#a" {
		t.Fatalf("unexpected agenda evaluation: %+v", result)
	}
}

func TestEvaluateNoemaAgendaAPIRequiresTodos(t *testing.T) {
	engine := gin.New()
	engine.POST("/api/noema/agenda/evaluate", evaluateNoemaAgenda)
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/noema/agenda/evaluate", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, req)
	var response markdownDocResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Code != -1 {
		t.Fatalf("expected missing todos rejection: %s", recorder.Body.String())
	}
}
