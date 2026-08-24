// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/gin-gonic/gin"
)

type markdownDocResponse struct {
	Code int             `json:"code"`
	Msg  string          `json:"msg"`
	Data json.RawMessage `json:"data"`
}

func setupMarkdownDocAPITest(t *testing.T) (boxID string) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	boxID = "20260825040000-apimdbox"
	originalConf := model.Conf
	originalDataDir := util.DataDir
	originalBlockTreeDBPath := util.BlockTreeDBPath
	tempDir := t.TempDir()
	util.DataDir = filepath.Join(tempDir, "data")
	util.BlockTreeDBPath = filepath.Join(tempDir, "blocktree.db")
	model.Conf = model.NewAppConf()
	model.Conf.Editor = conf.NewEditor()
	model.Conf.Export = conf.NewExport()
	model.Conf.FileTree = conf.NewFileTree()
	model.Conf.NotebookCrypto = conf.NewNotebookCrypto()
	model.Conf.Sync = conf.NewSync()
	model.Conf.Search = conf.NewSearch()

	box := &model.Box{ID: boxID}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Markdown doc API test"
	if err := box.SaveConf(boxConf); nil != err {
		t.Fatalf("save box conf failed: %s", err)
	}
	treenode.InitBlockTree(true)

	t.Cleanup(func() {
		treenode.CloseDatabase()
		model.Conf = originalConf
		util.DataDir = originalDataDir
		util.BlockTreeDBPath = originalBlockTreeDBPath
	})
	return boxID
}

func TestLoadMarkdownDocAPIRejectsMissingFields(t *testing.T) {
	setupMarkdownDocAPITest(t)

	engine := gin.New()
	engine.POST("/api/noema/markdown/loadDoc", loadMarkdownDoc)

	for _, body := range []string{`{}`, `{"notebook":"x"}`, `{"path":"/a.md"}`} {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/loadDoc", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		engine.ServeHTTP(recorder, req)

		var resp markdownDocResponse
		if err := json.Unmarshal(recorder.Body.Bytes(), &resp); nil != err {
			t.Fatalf("unmarshal response failed: %v", err)
		}
		if -1 != resp.Code {
			t.Fatalf("request %s: expected code -1, got %d: %s", body, resp.Code, recorder.Body.String())
		}
	}
}

func TestLoadMarkdownDocAPIReturnsEmptyDocForMissingPath(t *testing.T) {
	boxID := setupMarkdownDocAPITest(t)

	engine := gin.New()
	engine.POST("/api/noema/markdown/loadDoc", loadMarkdownDoc)

	body := `{"notebook":"` + boxID + `","path":"/never-created.md"}`
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/loadDoc", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, req)

	var resp markdownDocResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); nil != err {
		t.Fatalf("unmarshal response failed: %v", err)
	}
	if 0 != resp.Code {
		t.Fatalf("expected success loading a not-yet-created path, got code %d: %s", resp.Code, recorder.Body.String())
	}
	var data struct {
		Markdown string `json:"markdown"`
	}
	if err := json.Unmarshal(resp.Data, &data); nil != err {
		t.Fatalf("unmarshal data failed: %v", err)
	}
	if "" != data.Markdown {
		t.Fatalf("expected empty markdown, got %q", data.Markdown)
	}
}

func TestListMarkdownDocsAPI(t *testing.T) {
	boxID := setupMarkdownDocAPITest(t)

	mustWrite := func(rel string) {
		abs := filepath.Join(util.DataDir, boxID, rel)
		if err := os.MkdirAll(filepath.Dir(abs), 0755); nil != err {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte("# "+rel+"\n"), 0644); nil != err {
			t.Fatal(err)
		}
	}
	mustWrite("/alpha.md")
	mustWrite("/notes/beta.md")

	engine := gin.New()
	engine.POST("/api/noema/markdown/listDocs", listMarkdownDocs)

	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/listDocs", strings.NewReader(`{"notebook":"`+boxID+`"}`))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, req)

	var resp markdownDocResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); nil != err {
		t.Fatalf("unmarshal response failed: %v", err)
	}
	if 0 != resp.Code {
		t.Fatalf("listMarkdownDocs failed with code %d: %s", resp.Code, recorder.Body.String())
	}

	var data struct {
		Docs []model.MarkdownDocSummary `json:"docs"`
	}
	if err := json.Unmarshal(resp.Data, &data); nil != err {
		t.Fatalf("unmarshal data failed: %v", err)
	}
	if 2 != len(data.Docs) {
		t.Fatalf("expected 2 docs, got %+v", data.Docs)
	}
	if "/alpha.md" != data.Docs[0].Path || "/notes/beta.md" != data.Docs[1].Path {
		t.Fatalf("unexpected doc order/paths: %+v", data.Docs)
	}
}

func TestLoadMarkdownDocAPIRejectsNonMarkdownBox(t *testing.T) {
	setupMarkdownDocAPITest(t)

	syBoxID := "20260825040000-apisybox"
	box := &model.Box{ID: syBoxID}
	if err := box.SaveConf(box.GetConf()); nil != err { // 默认 Kind 是 sy
		t.Fatal(err)
	}

	engine := gin.New()
	engine.POST("/api/noema/markdown/loadDoc", loadMarkdownDoc)

	body := `{"notebook":"` + syBoxID + `","path":"/a.md"}`
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/loadDoc", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, req)

	var resp markdownDocResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); nil != err {
		t.Fatalf("unmarshal response failed: %v", err)
	}
	if -1 != resp.Code {
		t.Fatalf("expected an error loading a non-markdown box, got code %d: %s", resp.Code, recorder.Body.String())
	}
}
