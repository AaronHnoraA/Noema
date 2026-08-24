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
	"path/filepath"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/gin-gonic/gin"
)

// TestCreateNotebookAPIAcceptsMarkdownKind 补上手动 curl 冒烟测试真实运行的
// kernel 时发现的缺口：createNotebook 原来只接受 name，没有办法通过 API
// 建 markdown box。
func TestCreateNotebookAPIAcceptsMarkdownKind(t *testing.T) {
	gin.SetMode(gin.TestMode)

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
	treenode.InitBlockTree(true)
	t.Cleanup(func() {
		treenode.CloseDatabase()
		model.Conf = originalConf
		util.DataDir = originalDataDir
		util.BlockTreeDBPath = originalBlockTreeDBPath
	})

	engine := gin.New()
	engine.POST("/api/notebook/createNotebook", createNotebook)

	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/notebook/createNotebook", strings.NewReader(`{"name":"Markdown Vault","kind":"markdown"}`))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, req)

	var resp markdownDocResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); nil != err {
		t.Fatalf("unmarshal response failed: %v", err)
	}
	if 0 != resp.Code {
		t.Fatalf("createNotebook failed with code %d: %s", resp.Code, recorder.Body.String())
	}

	var data struct {
		Notebook struct {
			ID string `json:"id"`
		} `json:"notebook"`
	}
	if err := json.Unmarshal(resp.Data, &data); nil != err {
		t.Fatalf("unmarshal notebook data failed: %v", err)
	}
	if "" == data.Notebook.ID {
		t.Fatalf("missing notebook ID in response: %s", resp.Data)
	}

	box := &model.Box{ID: data.Notebook.ID}
	if conf.BoxKindMarkdown != box.GetConf().Kind {
		t.Fatalf("created notebook does not have Kind=markdown: %+v", box.GetConf())
	}
}
