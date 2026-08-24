// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

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

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/gin-gonic/gin"
)

// TestSaveThenLoadMarkdownDocViaAPI 是 saveDoc/loadDoc 两个新端点的完整端到端
// 验证，含 saveMarkdownDoc 内部对 model.SaveMarkdownDoc → UpsertIndexes →
// sql.UpsertTreeQueue 的调用——这一步需要项目的 fts5 cgo 编译支持，见
// markdown_doc_save_fts5_test.go（model 包）顶部关于这个 tag 为什么必需的
// 说明。不需要碰 sql 层的校验分支测试见 markdown_doc_test.go。
//
//	go test -tags fts5 ./api/... -run TestSaveThenLoadMarkdownDocViaAPI
func TestSaveThenLoadMarkdownDocViaAPI(t *testing.T) {
	gin.SetMode(gin.TestMode)

	workspaceDir := t.TempDir()
	util.WorkspaceDir = workspaceDir
	util.ConfDir = filepath.Join(workspaceDir, "conf")
	util.DataDir = filepath.Join(workspaceDir, "data")
	util.HistoryDir = filepath.Join(workspaceDir, "history")
	util.TempDir = filepath.Join(workspaceDir, "temp")
	util.QueueDir = filepath.Join(util.TempDir, "queue")
	util.DBPath = filepath.Join(util.TempDir, util.DBName)
	util.HistoryDBPath = filepath.Join(util.TempDir, "history.db")
	util.AssetContentDBPath = filepath.Join(util.TempDir, "asset_content.db")
	util.BlockTreeDBPath = filepath.Join(util.TempDir, "blocktree.db")
	for _, dir := range []string{util.ConfDir, util.DataDir, util.HistoryDir, util.TempDir, util.QueueDir} {
		if err := os.MkdirAll(dir, 0755); nil != err {
			t.Fatalf("create test directory [%s] failed: %v", dir, err)
		}
	}

	model.Conf = model.NewAppConf()
	model.Conf.Editor = conf.NewEditor()
	model.Conf.Export = conf.NewExport()
	model.Conf.FileTree = conf.NewFileTree()
	model.Conf.NotebookCrypto = conf.NewNotebookCrypto()
	model.Conf.Sync = conf.NewSync()
	model.Conf.Search = conf.NewSearch()

	boxID := "20260825040000-apifts501"
	box := &model.Box{ID: boxID}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "API fts5 test"
	if err := box.SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}

	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)

	engine := gin.New()
	engine.POST("/api/noema/markdown/loadDoc", loadMarkdownDoc)
	engine.POST("/api/noema/markdown/saveDoc", saveMarkdownDoc)

	post := func(path, body string) markdownDocResponse {
		t.Helper()
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		engine.ServeHTTP(recorder, req)
		var resp markdownDocResponse
		if err := json.Unmarshal(recorder.Body.Bytes(), &resp); nil != err {
			t.Fatalf("unmarshal response failed: %v", err)
		}
		return resp
	}

	relPath := "/notes/hello.md"
	source := "# Title\n\nSee @@cmd(foo) here.\n"
	saveBody, err := json.Marshal(map[string]string{
		"notebook": boxID,
		"path":     relPath,
		"markdown": source,
	})
	if nil != err {
		t.Fatal(err)
	}
	saveResp := post("/api/noema/markdown/saveDoc", string(saveBody))
	if 0 != saveResp.Code {
		t.Fatalf("save failed with code %d: %s", saveResp.Code, saveResp.Msg)
	}

	var saveData struct {
		Markdown string                   `json:"markdown"`
		Blocks   []model.MarkdownBlockRef `json:"blocks"`
	}
	if err := json.Unmarshal(saveResp.Data, &saveData); nil != err {
		t.Fatalf("unmarshal save data failed: %v", err)
	}
	if !strings.Contains(saveData.Markdown, "@@cmd(foo)") {
		t.Fatalf("private syntax lost on save: %s", saveData.Markdown)
	}
	var docID string
	for _, b := range saveData.Blocks {
		if "NodeDocument" == b.Type {
			docID = b.ID
		}
	}
	if "" == docID {
		t.Fatalf("missing document root block ref: %+v", saveData.Blocks)
	}

	sql.FlushQueue()

	loadBody, err := json.Marshal(map[string]string{"notebook": boxID, "path": relPath})
	if nil != err {
		t.Fatal(err)
	}
	loadResp := post("/api/noema/markdown/loadDoc", string(loadBody))
	if 0 != loadResp.Code {
		t.Fatalf("load failed with code %d: %s", loadResp.Code, loadResp.Msg)
	}

	var loadData struct {
		Markdown string                   `json:"markdown"`
		Blocks   []model.MarkdownBlockRef `json:"blocks"`
	}
	if err := json.Unmarshal(loadResp.Data, &loadData); nil != err {
		t.Fatalf("unmarshal load data failed: %v", err)
	}
	if loadData.Markdown != saveData.Markdown {
		t.Fatalf("load returned different bytes than save:\nsave:\n%s\nload:\n%s", saveData.Markdown, loadData.Markdown)
	}
	var loadDocID string
	for _, b := range loadData.Blocks {
		if "NodeDocument" == b.Type {
			loadDocID = b.ID
		}
	}
	if loadDocID != docID {
		t.Fatalf("document ID not stable across save/load via API: save=%s load=%s", docID, loadDocID)
	}
}
