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
	engine.POST("/api/noema/markdown/applyChanges", applyMarkdownDocChanges)

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
		Version  string                   `json:"version"`
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

	changeBody, err := json.Marshal(map[string]any{
		"notebook":        boxID,
		"path":            relPath,
		"expectedVersion": saveData.Version,
		"changes": map[string]any{
			"length":    len(source),
			"newLength": len(source) + 1,
			"changes":   []map[string]any{{"from": 2, "to": 7, "insert": "Titled"}},
		},
	})
	if nil != err {
		t.Fatal(err)
	}
	changeResp := post("/api/noema/markdown/applyChanges", string(changeBody))
	if 0 != changeResp.Code {
		t.Fatalf("incremental save failed with code %d: %s", changeResp.Code, changeResp.Msg)
	}
	if strings.Contains(string(changeResp.Data), `"markdown"`) {
		t.Fatalf("successful incremental response unnecessarily returned full Markdown: %s", changeResp.Data)
	}
	source = "# Titled\n\nSee @@cmd(foo) here.\n"

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
	if loadData.Markdown != source {
		t.Fatalf("load returned different bytes after incremental save:\nwant:\n%s\nload:\n%s", source, loadData.Markdown)
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

func TestRegisterExternalMarkdownBoxAPIPreservesMissingShadows(t *testing.T) {
	gin.SetMode(gin.TestMode)

	workspaceDir := t.TempDir()
	originalConf := model.Conf
	originalWorkspaceDir := util.WorkspaceDir
	originalConfDir := util.ConfDir
	originalDataDir := util.DataDir
	originalHistoryDir := util.HistoryDir
	originalTempDir := util.TempDir
	originalQueueDir := util.QueueDir
	originalDBPath := util.DBPath
	originalHistoryDBPath := util.HistoryDBPath
	originalAssetContentDBPath := util.AssetContentDBPath
	originalBlockTreeDBPath := util.BlockTreeDBPath
	t.Cleanup(func() {
		model.Conf = originalConf
		util.WorkspaceDir = originalWorkspaceDir
		util.ConfDir = originalConfDir
		util.DataDir = originalDataDir
		util.HistoryDir = originalHistoryDir
		util.TempDir = originalTempDir
		util.QueueDir = originalQueueDir
		util.DBPath = originalDBPath
		util.HistoryDBPath = originalHistoryDBPath
		util.AssetContentDBPath = originalAssetContentDBPath
		util.BlockTreeDBPath = originalBlockTreeDBPath
	})
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
			t.Fatal(err)
		}
	}
	model.Conf = model.NewAppConf()
	model.Conf.Editor = conf.NewEditor()
	model.Conf.Export = conf.NewExport()
	model.Conf.FileTree = conf.NewFileTree()
	model.Conf.NotebookCrypto = conf.NewNotebookCrypto()
	model.Conf.Sync = conf.NewSync()
	model.Conf.Search = conf.NewSearch()

	activeRoot := filepath.Join(t.TempDir(), "active")
	staleRoot := filepath.Join(t.TempDir(), "stale")
	if err := os.MkdirAll(activeRoot, 0755); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(activeRoot, "ready.md"), []byte("# Ready before attach\n\nfirstmountreadinessomega\n"), 0644); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(activeRoot, "removed.md"), []byte("# Removed later\n\nofflineremovalalpha\n"), 0644); nil != err {
		t.Fatal(err)
	}
	if err := os.MkdirAll(staleRoot, 0755); nil != err {
		t.Fatal(err)
	}
	stale, err := model.RegisterExternalMarkdownBox(
		"Stale", staleRoot, "0198fc34-7b32-7a11-8cb4-6c40e3b33d74",
	)
	if nil != err {
		t.Fatal(err)
	}
	if err = os.RemoveAll(staleRoot); nil != err {
		t.Fatal(err)
	}

	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)

	engine := gin.New()
	engine.POST("/api/noema/markdown/registerExternalBox", registerExternalMarkdownBox)
	body, err := json.Marshal(map[string]string{
		"name":         "Active",
		"root":         activeRoot,
		"repositoryId": "0198fc34-7b32-7a11-8cb4-6c40e3b33d75",
	})
	if nil != err {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/registerExternalBox", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, req)

	var resp markdownDocResponse
	if err = json.Unmarshal(recorder.Body.Bytes(), &resp); nil != err {
		t.Fatal(err)
	}
	if 0 != resp.Code {
		t.Fatalf("register external box failed: %s", recorder.Body.String())
	}
	var data struct {
		Box model.ExternalMarkdownBox `json:"box"`
	}
	if err = json.Unmarshal(resp.Data, &data); nil != err {
		t.Fatal(err)
	}
	if strings.Contains(string(resp.Data), `"pruned"`) {
		t.Fatalf("registration exposed a destructive automatic prune result: %s", resp.Data)
	}
	resolvedActiveRoot, err := filepath.EvalSymlinks(activeRoot)
	if nil != err {
		t.Fatal(err)
	}
	if data.Box.Root != resolvedActiveRoot {
		t.Fatalf("active registration root mismatch: got %q want %q", data.Box.Root, resolvedActiveRoot)
	}
	if _, statErr := os.Stat(filepath.Join(util.DataDir, stale.ID, ".siyuan", "conf.json")); nil != statErr {
		t.Fatalf("registering another repository deleted the missing shadow identity: %v", statErr)
	}
	if _, statErr := os.Stat(activeRoot); nil != statErr {
		t.Fatalf("active external repository was changed or removed: %v", statErr)
	}
	// registerExternalBox is the supervisor's readiness boundary. Do not flush
	// or execute task queues here: the handler itself must not return until a
	// freshly mounted root is present in SQL/FTS.
	blocks := sql.SelectBlocksRawStmtArgs(
		"SELECT * FROM blocks WHERE box = ? AND path = ?",
		[]any{data.Box.ID, "/ready.md"},
		32,
	)
	if len(blocks) != 1 {
		t.Fatalf("registration returned before initial Markdown index committed: %+v", blocks)
	}
	results, matched, _, _, _ := model.FullTextSearchBlock(
		"firstmountreadinessomega", []string{data.Box.ID}, nil, nil, nil, 0, 0, 0, 1, 32,
	)
	if matched != 1 || len(results) != 1 || results[0].Path != "/ready.md" {
		t.Fatalf("registration returned before initial FTS was ready: matched=%d results=%+v", matched, results)
	}

	// Simulate edits made while the app is not running: stop the process-local
	// watcher, then modify, add, and delete sources. Re-registering an already
	// open persisted box must reconcile all three before returning.
	model.CloseWatchMarkdownBox(data.Box.ID)
	if err = os.WriteFile(filepath.Join(activeRoot, "ready.md"), []byte("# Ready after restart\n\nofflineeditbeta\n"), 0644); nil != err {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(activeRoot, "added.markdown"), []byte("# Added offline\n\nofflineaddgamma\n"), 0644); nil != err {
		t.Fatal(err)
	}
	if err = os.Remove(filepath.Join(activeRoot, "removed.md")); nil != err {
		t.Fatal(err)
	}
	secondRecorder := httptest.NewRecorder()
	secondReq := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/registerExternalBox", strings.NewReader(string(body)))
	secondReq.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(secondRecorder, secondReq)
	var secondResp markdownDocResponse
	if err = json.Unmarshal(secondRecorder.Body.Bytes(), &secondResp); nil != err {
		t.Fatal(err)
	}
	if 0 != secondResp.Code {
		t.Fatalf("warm registration reconciliation failed: %s", secondRecorder.Body.String())
	}
	t.Cleanup(func() { model.CloseWatchMarkdownBox(data.Box.ID) })
	if removed := sql.SelectBlocksRawStmtArgs(
		"SELECT * FROM blocks WHERE box = ? AND path = ?", []any{data.Box.ID, "/removed.md"}, 32,
	); 0 != len(removed) {
		t.Fatalf("offline deletion survived warm reconciliation: %+v", removed)
	}
	for query, wantPath := range map[string]string{
		"offlineeditbeta": "/ready.md",
		"offlineaddgamma": "/added.markdown",
	} {
		results, matched, _, _, _ = model.FullTextSearchBlock(
			query, []string{data.Box.ID}, nil, nil, nil, 0, 0, 0, 1, 32,
		)
		if matched != 1 || len(results) != 1 || results[0].Path != wantPath {
			t.Fatalf("warm reconciliation FTS mismatch for %q: matched=%d results=%+v", query, matched, results)
		}
	}
	for _, staleQuery := range []string{"firstmountreadinessomega", "offlineremovalalpha"} {
		results, matched, _, _, _ = model.FullTextSearchBlock(
			staleQuery, []string{data.Box.ID}, nil, nil, nil, 0, 0, 0, 1, 32,
		)
		if matched != 0 || len(results) != 0 {
			t.Fatalf("stale FTS content survived warm reconciliation for %q: matched=%d results=%+v", staleQuery, matched, results)
		}
	}
}
