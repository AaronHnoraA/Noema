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

func TestSaveMarkdownDocAPIReturnsCASConflictWithoutWriting(t *testing.T) {
	boxID := setupMarkdownDocAPITest(t)
	absPath := filepath.Join(util.DataDir, boxID, "plain.md")
	const current = "# Disk winner\n"
	if err := os.WriteFile(absPath, []byte(current), 0644); nil != err {
		t.Fatal(err)
	}

	engine := gin.New()
	engine.POST("/api/noema/markdown/saveDoc", saveMarkdownDoc)
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/saveDoc", strings.NewReader(
		`{"notebook":"`+boxID+`","path":"/plain.md","markdown":"# Stale local edit\n","expectedVersion":"stale-version"}`,
	))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, req)

	var resp markdownDocResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); nil != err {
		t.Fatal(err)
	}
	if resp.Code != 0 {
		t.Fatalf("save API conflict failed: %s", recorder.Body.String())
	}
	var data model.MarkdownDocCASResult
	if err := json.Unmarshal(resp.Data, &data); nil != err {
		t.Fatal(err)
	}
	if !data.Conflict || data.Markdown != current || data.Version == "" {
		t.Fatalf("unexpected save conflict projection: %+v", data)
	}
	if onDisk, err := os.ReadFile(absPath); nil != err || string(onDisk) != current {
		t.Fatalf("stale API save changed disk: content=%q err=%v", onDisk, err)
	}
}

func TestMutateMarkdownMetaAPIRequiresIntentAndReturnsKernelProjection(t *testing.T) {
	boxID := setupMarkdownDocAPITest(t)
	path := filepath.Join(util.DataDir, boxID, "plain.md")
	if err := os.WriteFile(path, []byte("# Plain\n"), 0644); err != nil {
		t.Fatal(err)
	}
	engine := gin.New()
	engine.POST("/api/noema/markdown/mutateMeta", mutateMarkdownMeta)

	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/mutateMeta", strings.NewReader(
		`{"notebook":"`+boxID+`","path":"/plain.md","action":"remove"}`))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, req)
	var resp markdownDocResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Code != 0 {
		t.Fatalf("metadata no-op failed: %s", recorder.Body.String())
	}
	var data model.MarkdownMetaMutationResult
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.Changed || data.Markdown != "# Plain\n" || data.Source != "kernel-meta" {
		t.Fatalf("unexpected metadata projection: %+v", data)
	}

	for _, body := range []string{`{}`, `{"notebook":"box"}`, `{"notebook":"box","path":"/a.md"}`} {
		recorder = httptest.NewRecorder()
		req = httptest.NewRequest(http.MethodPost, "/api/noema/markdown/mutateMeta", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		engine.ServeHTTP(recorder, req)
		if err := json.Unmarshal(recorder.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		if resp.Code != -1 {
			t.Fatalf("expected missing metadata intent rejection for %s: %s", body, recorder.Body.String())
		}
	}
}

func TestListMarkdownRelationshipsAPIRejectsMissingNotebook(t *testing.T) {
	setupMarkdownDocAPITest(t)
	engine := gin.New()
	engine.POST("/api/noema/markdown/listRelationships", listMarkdownRelationships)
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/listRelationships", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, req)
	var resp markdownDocResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); nil != err {
		t.Fatalf("unmarshal response failed: %v", err)
	}
	if -1 != resp.Code {
		t.Fatalf("expected missing notebook rejection, got %s", recorder.Body.String())
	}
}

func TestListMarkdownPlanningAPI(t *testing.T) {
	boxID := setupMarkdownDocAPITest(t)
	abs := filepath.Join(util.DataDir, boxID, "agenda.md")
	if err := os.WriteFile(abs, []byte("@@todo(doing) [API planning] {due: tomorrow}\n"), 0644); nil != err {
		t.Fatal(err)
	}

	engine := gin.New()
	engine.POST("/api/noema/markdown/listPlanning", listMarkdownPlanning)
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/listPlanning", strings.NewReader(`{"notebook":"`+boxID+`","path":"/agenda.md"}`))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, req)

	var resp markdownDocResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); nil != err {
		t.Fatal(err)
	}
	if resp.Code != 0 {
		t.Fatalf("planning API failed: %s", recorder.Body.String())
	}
	var data struct {
		Documents []model.MarkdownPlanningDocument `json:"documents"`
	}
	if err := json.Unmarshal(resp.Data, &data); nil != err {
		t.Fatal(err)
	}
	if len(data.Documents) != 1 || len(data.Documents[0].Nodes) != 1 || data.Documents[0].Nodes[0].Title != "API planning" {
		t.Fatalf("unexpected planning API response: %+v", data.Documents)
	}
}

func TestListMarkdownPropertyBlocksAPI(t *testing.T) {
	boxID := setupMarkdownDocAPITest(t)
	id := "0198fc34-7b32-7a11-8cb4-6c40e3b33d68"
	abs := filepath.Join(util.DataDir, boxID, "properties.md")
	if err := os.WriteFile(abs, []byte("Claim {#"+id+" status=draft}\n"), 0644); nil != err {
		t.Fatal(err)
	}

	engine := gin.New()
	engine.POST("/api/noema/markdown/listPropertyBlocks", listMarkdownPropertyBlocks)
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/listPropertyBlocks", strings.NewReader(`{"notebook":"`+boxID+`","path":"/properties.md"}`))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, req)
	var resp markdownDocResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); nil != err {
		t.Fatal(err)
	}
	if resp.Code != 0 {
		t.Fatalf("property block API failed: %s", recorder.Body.String())
	}
	var data struct {
		Documents []model.MarkdownPropertyDocument `json:"documents"`
	}
	if err := json.Unmarshal(resp.Data, &data); nil != err {
		t.Fatal(err)
	}
	if len(data.Documents) != 1 || len(data.Documents[0].Blocks) != 1 || data.Documents[0].Blocks[0].CanonicalID != id {
		t.Fatalf("unexpected property block response: %+v", data.Documents)
	}
}

func TestLoadMarkdownBibliographyAPI(t *testing.T) {
	boxID := setupMarkdownDocAPITest(t)
	noteDir := filepath.Join(util.DataDir, boxID, "notes")
	if err := os.MkdirAll(filepath.Join(noteDir, "bib"), 0755); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(noteDir, "bib", "refs.bib"), []byte("@book{Ada, author={Lovelace, Ada}, title={Notes}, year={1843}}"), 0644); nil != err {
		t.Fatal(err)
	}

	engine := gin.New()
	engine.POST("/api/noema/markdown/loadBibliography", loadMarkdownBibliography)
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/loadBibliography", strings.NewReader(
		`{"notebook":"`+boxID+`","path":"/notes/note.md","metadata":"#+begin meta\n#+end meta\n"}`,
	))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, req)

	var resp markdownDocResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); nil != err {
		t.Fatal(err)
	}
	if 0 != resp.Code {
		t.Fatalf("bibliography API failed: %s", recorder.Body.String())
	}
	var data struct {
		Source string `json:"source"`
		Files  []struct {
			Path    string `json:"path"`
			Entries []struct {
				Key string `json:"key"`
			} `json:"entries"`
		} `json:"files"`
	}
	if err := json.Unmarshal(resp.Data, &data); nil != err {
		t.Fatal(err)
	}
	if "kernel-bibliography" != data.Source || 1 != len(data.Files) || "notes/bib/refs.bib" != data.Files[0].Path || "Ada" != data.Files[0].Entries[0].Key {
		t.Fatalf("unexpected bibliography response: %+v", data)
	}
}

func TestLoadMarkdownBibliographyAPIRejectsMissingFields(t *testing.T) {
	setupMarkdownDocAPITest(t)
	engine := gin.New()
	engine.POST("/api/noema/markdown/loadBibliography", loadMarkdownBibliography)
	for _, body := range []string{`{}`, `{"notebook":"box"}`, `{"notebook":"box","path":"/note.md"}`} {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/loadBibliography", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		engine.ServeHTTP(recorder, req)
		var resp markdownDocResponse
		if err := json.Unmarshal(recorder.Body.Bytes(), &resp); nil != err {
			t.Fatal(err)
		}
		if -1 != resp.Code {
			t.Fatalf("expected missing-field rejection for %s: %s", body, recorder.Body.String())
		}
	}
}

func TestMoveMarkdownPathAPIsRejectMissingFields(t *testing.T) {
	setupMarkdownDocAPITest(t)
	for route, handler := range map[string]gin.HandlerFunc{
		"/api/noema/markdown/moveDoc":  moveMarkdownDoc,
		"/api/noema/markdown/movePath": moveMarkdownPath,
	} {
		engine := gin.New()
		engine.POST(route, handler)
		for _, body := range []string{`{}`, `{"notebook":"box"}`, `{"notebook":"box","fromPath":"/a.md"}`} {
			recorder := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, route, strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			engine.ServeHTTP(recorder, req)
			var resp markdownDocResponse
			if err := json.Unmarshal(recorder.Body.Bytes(), &resp); nil != err {
				t.Fatal(err)
			}
			if -1 != resp.Code {
				t.Fatalf("expected missing-field rejection for %s %s: %s", route, body, recorder.Body.String())
			}
		}
	}
}

func TestMutateMarkdownPropertyBlockAPIRejectsMissingFields(t *testing.T) {
	setupMarkdownDocAPITest(t)
	engine := gin.New()
	engine.POST("/api/noema/markdown/mutatePropertyBlock", mutateMarkdownPropertyBlock)
	for _, body := range []string{`{}`, `{"notebook":"box","path":"/a.md"}`, `{"notebook":"box","path":"/a.md","id":"uuid"}`} {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/mutatePropertyBlock", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		engine.ServeHTTP(recorder, req)
		var resp markdownDocResponse
		if err := json.Unmarshal(recorder.Body.Bytes(), &resp); nil != err {
			t.Fatal(err)
		}
		if resp.Code != -1 {
			t.Fatalf("expected missing-field rejection for %s: %s", body, recorder.Body.String())
		}
	}
}

func TestMutateMarkdownPlanningAPIRejectsMissingFields(t *testing.T) {
	setupMarkdownDocAPITest(t)
	engine := gin.New()
	engine.POST("/api/noema/markdown/mutatePlanning", mutateMarkdownPlanning)
	for _, body := range []string{`{}`, `{"notebook":"box"}`, `{"notebook":"box","path":"/a.md"}`} {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/mutatePlanning", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		engine.ServeHTTP(recorder, req)
		var resp markdownDocResponse
		if err := json.Unmarshal(recorder.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		if resp.Code != -1 {
			t.Fatalf("expected missing-field rejection for %s: %s", body, recorder.Body.String())
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

func TestStoreMarkdownAssetAPIs(t *testing.T) {
	boxID := setupMarkdownDocAPITest(t)
	engine := gin.New()
	engine.POST("/api/noema/markdown/storeAsset", storeMarkdownAsset)
	engine.POST("/api/noema/markdown/storeAssetFromPath", storeMarkdownAssetFromPath)

	request := func(endpoint, body string) (resp markdownDocResponse) {
		t.Helper()
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, endpoint, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		engine.ServeHTTP(recorder, req)
		if err := json.Unmarshal(recorder.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		if resp.Code != 0 {
			t.Fatalf("asset request failed: %s", recorder.Body.String())
		}
		return
	}

	encoded := request("/api/noema/markdown/storeAsset", `{"notebook":"`+boxID+`","path":"/topic.md","name":"plot.png","type":"image/png","data":"UE5H"}`)
	var first model.MarkdownAsset
	if err := json.Unmarshal(encoded.Data, &first); err != nil {
		t.Fatal(err)
	}
	if first.MarkdownPath != "./images/topic/plot.png" || first.Source != "kernel-assets" {
		t.Fatalf("unexpected encoded asset result: %+v", first)
	}

	source := filepath.Join(t.TempDir(), "paper.pdf")
	if err := os.WriteFile(source, []byte("PDF"), 0644); err != nil {
		t.Fatal(err)
	}
	imported := request("/api/noema/markdown/storeAssetFromPath", `{"notebook":"`+boxID+`","path":"/topic.md","sourcePath":"`+source+`"}`)
	var second model.MarkdownAsset
	if err := json.Unmarshal(imported.Data, &second); err != nil {
		t.Fatal(err)
	}
	if second.MarkdownPath != "./attachments/topic/paper.pdf" || second.Type != "application/pdf" {
		t.Fatalf("unexpected imported asset result: %+v", second)
	}
}

func TestStoreMarkdownAssetAPIRejectsInvalidBase64(t *testing.T) {
	boxID := setupMarkdownDocAPITest(t)
	engine := gin.New()
	engine.POST("/api/noema/markdown/storeAsset", storeMarkdownAsset)
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/storeAsset", strings.NewReader(
		`{"notebook":"`+boxID+`","path":"/topic.md","data":"not base64"}`))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, req)
	var resp markdownDocResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Code != -1 || !strings.Contains(resp.Msg, "base64") {
		t.Fatalf("expected base64 rejection, got %s", recorder.Body.String())
	}
}

func TestListUnusedMarkdownAssetsAPI(t *testing.T) {
	boxID := setupMarkdownDocAPITest(t)
	assetPath := filepath.Join(util.DataDir, boxID, "attachments", "topic", "orphan.pdf")
	if err := os.MkdirAll(filepath.Dir(assetPath), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(assetPath, []byte("orphan"), 0644); err != nil {
		t.Fatal(err)
	}
	engine := gin.New()
	engine.POST("/api/noema/markdown/listUnusedAssets", listUnusedMarkdownAssets)
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/listUnusedAssets", strings.NewReader(
		`{"notebook":"`+boxID+`","includePublic":true}`))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, req)
	var resp markdownDocResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Code != 0 {
		t.Fatalf("list unused assets failed: %s", recorder.Body.String())
	}
	var data struct {
		Assets []model.MarkdownUnusedAsset `json:"assets"`
		Source string                      `json:"source"`
	}
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.Source != "kernel-assets" || len(data.Assets) != 1 || data.Assets[0].Path != "attachments/topic/orphan.pdf" {
		t.Fatalf("unexpected unused asset response: %+v", data)
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
