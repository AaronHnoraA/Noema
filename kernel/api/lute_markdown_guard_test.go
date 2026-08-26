// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

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
	"github.com/aaronhe/noema/kernel/util"
	"github.com/gin-gonic/gin"
)

func TestHTML2BlockDOMRejectsMarkdownNotebookBeforeExtractingAssets(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = filepath.Join(t.TempDir(), "data")
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260826050000-htmlgrd"
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	if err := (&model.Box{ID: boxID}).SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.POST("/api/lute/html2BlockDOM", html2BlockDOM)
	recorder := httptest.NewRecorder()
	body := `{"notebook":"` + boxID + `","dom":"<img src=\"data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=\">"}`
	request := httptest.NewRequest(http.MethodPost, "/api/lute/html2BlockDOM", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, request)

	response := &struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}{}
	if err := json.Unmarshal(recorder.Body.Bytes(), response); nil != err {
		t.Fatal(err)
	}
	if -1 != response.Code || !strings.Contains(response.Msg, model.ErrMarkdownNativeDocumentTree.Error()) {
		t.Fatalf("Markdown HTML conversion entered native asset pipeline: %s", recorder.Body.String())
	}
	if _, err := os.Stat(filepath.Join(util.DataDir, "assets")); !os.IsNotExist(err) {
		t.Fatalf("HTML conversion created shadow/global assets before rejection: %v", err)
	}
}
