// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org

package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/model"
	"github.com/gin-gonic/gin"
)

func TestMarkdownSessionAPIProjectsKernelState(t *testing.T) {
	boxID := setupMarkdownDocAPITest(t)
	engine := gin.New()
	engine.POST("/api/noema/session/touchRecent", touchMarkdownRecentNote)
	engine.POST("/api/noema/session/touchPosition", touchMarkdownCursorPosition)
	engine.POST("/api/noema/session/read", readMarkdownSession)

	for route, body := range map[string]string{
		"/api/noema/session/touchRecent":   `{"notebook":"` + boxID + `","path":"/paper.md","openedAt":10}`,
		"/api/noema/session/touchPosition": `{"notebook":"` + boxID + `","path":"/paper.md","client":"left","mode":"source","from":4,"to":8,"scrollY":12,"updatedAt":20}`,
	} {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, route, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		engine.ServeHTTP(recorder, req)
		var resp markdownDocResponse
		if err := json.Unmarshal(recorder.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		if resp.Code != 0 {
			t.Fatalf("session touch failed for %s: %s", route, recorder.Body.String())
		}
	}

	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/noema/session/read", strings.NewReader(`{"notebook":"`+boxID+`"}`))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, req)
	var resp markdownDocResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	var state model.MarkdownSessionState
	if err := json.Unmarshal(resp.Data, &state); err != nil {
		t.Fatal(err)
	}
	if resp.Code != 0 || state.Source != "kernel-session" || len(state.Recent) != 1 || len(state.Positions) != 2 || state.Positions[0].Client != "left" {
		t.Fatalf("unexpected session projection: response=%s state=%+v", recorder.Body.String(), state)
	}
}

func TestMarkdownSessionAPIRejectsMissingIdentity(t *testing.T) {
	setupMarkdownDocAPITest(t)
	for route, handler := range map[string]gin.HandlerFunc{
		"/api/noema/session/read":          readMarkdownSession,
		"/api/noema/session/touchRecent":   touchMarkdownRecentNote,
		"/api/noema/session/touchPosition": touchMarkdownCursorPosition,
	} {
		engine := gin.New()
		engine.POST(route, handler)
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, route, strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		engine.ServeHTTP(recorder, req)
		var resp markdownDocResponse
		if err := json.Unmarshal(recorder.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		if resp.Code != -1 {
			t.Fatalf("expected missing identity rejection for %s: %s", route, recorder.Body.String())
		}
	}
}
