// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/cache"
	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/gin-gonic/gin"
)

func TestSetSortRejectsInvalidRequest(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.POST("/api/filetree/setSort", setSort)

	tests := []struct {
		name string
		body string
	}{
		{name: "empty", body: `{}`},
		{name: "null item", body: `{"docSorts":[null]}`},
		{name: "invalid ID", body: `{"docSorts":[{"id":"invalid","sort":0}]}`},
		{name: "missing sort", body: `{"docSorts":[{"id":"20260718000001-abcdefg"}]}`},
		{name: "fractional sort", body: `{"docSorts":[{"id":"20260718000001-abcdefg","sort":1.5}]}`},
		{name: "duplicate ID", body: `{"docSorts":[{"id":"20260718000001-abcdefg","sort":0},{"id":"20260718000001-abcdefg","sort":1}]}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/api/filetree/setSort", strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			engine.ServeHTTP(recorder, request)

			response := &struct {
				Code int `json:"code"`
			}{}
			if err := json.Unmarshal(recorder.Body.Bytes(), response); err != nil {
				t.Fatalf("unmarshal response failed: %v", err)
			}
			if response.Code != -1 {
				t.Fatalf("invalid request returned code %d: %s", response.Code, recorder.Body.String())
			}
		})
	}
}

func TestSetDocSortModeRejectsInvalidRequest(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.POST("/api/filetree/setDocSortMode", setDocSortMode)

	tests := []struct {
		name string
		body string
	}{
		{name: "empty", body: `{}`},
		{name: "missing sort mode", body: `{"id":"20260718000001-abcdefg"}`},
		{name: "invalid ID", body: `{"id":"invalid","sortMode":0}`},
		{name: "fractional sort mode", body: `{"id":"20260718000001-abcdefg","sortMode":1.5}`},
		{name: "string sort mode", body: `{"id":"20260718000001-abcdefg","sortMode":"1"}`},
		{name: "notebook fallback mode", body: `{"id":"20260718000001-abcdefg","sortMode":15}`},
		{name: "internal unassigned mode", body: `{"id":"20260718000001-abcdefg","sortMode":256}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/api/filetree/setDocSortMode", strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			engine.ServeHTTP(recorder, request)

			response := &struct {
				Code int `json:"code"`
			}{}
			if err := json.Unmarshal(recorder.Body.Bytes(), response); nil != err {
				t.Fatalf("unmarshal response failed: %v", err)
			}
			if -1 != response.Code {
				t.Fatalf("invalid request returned code %d: %s", response.Code, recorder.Body.String())
			}
		})
	}
}

func TestGetDocOptionallyReturnsEmbeddedDocInfo(t *testing.T) {
	gin.SetMode(gin.TestMode)

	const boxID = "20260812000000-boxinfo"
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

	box := &model.Box{ID: boxID}
	boxConf := conf.NewBoxConf()
	boxConf.Name = "Embedded document info test"
	boxConf.Closed = false
	if err := box.SaveConf(boxConf); nil != err {
		t.Fatalf("save test notebook config failed: %v", err)
	}
	treenode.InitBlockTree(true)
	tree := treenode.NewTree(boxID, "/20260812000001-docinfo.sy", "/Document", "Document")
	if _, err := filesys.WriteTree(tree); nil != err {
		t.Fatalf("write test tree failed: %v", err)
	}
	treenode.UpsertBlockTree(tree)
	t.Cleanup(func() {
		cache.RemoveTreeData(tree.ID)
		cache.RemoveDocIAL(tree.Path)
		treenode.CloseDatabase()
		model.Conf = originalConf
		util.DataDir = originalDataDir
		util.BlockTreeDBPath = originalBlockTreeDBPath
		if "" != originalBlockTreeDBPath {
			treenode.InitBlockTree(false)
		}
	})

	engine := gin.New()
	engine.POST("/api/filetree/getDoc", getDoc)
	request := func(body string) (data map[string]json.RawMessage) {
		t.Helper()
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/filetree/getDoc", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		engine.ServeHTTP(recorder, req)
		response := &struct {
			Code int                        `json:"code"`
			Msg  string                     `json:"msg"`
			Data map[string]json.RawMessage `json:"data"`
		}{}
		if err := json.Unmarshal(recorder.Body.Bytes(), response); nil != err {
			t.Fatalf("unmarshal document response failed: %v", err)
		}
		if 0 != response.Code {
			t.Fatalf("get document failed with code %d and message %q: %s", response.Code, response.Msg, recorder.Body.String())
		}
		return response.Data
	}

	withoutInfo := request(`{"id":"` + tree.ID + `"}`)
	if _, ok := withoutInfo["docInfo"]; ok {
		t.Fatalf("document info should be absent by default: %s", withoutInfo["docInfo"])
	}

	withInfo := request(`{"id":"` + tree.Root.FirstChild.ID + `","includeDocInfo":true}`)
	infoJSON, ok := withInfo["docInfo"]
	if !ok {
		t.Fatal("requested embedded document info is absent")
	}
	info := &model.BlockInfo{}
	if err := json.Unmarshal(infoJSON, info); nil != err {
		t.Fatalf("unmarshal embedded document info failed: %v", err)
	}
	if info.ID != tree.ID || info.RootID != tree.ID || info.Name != "Document" {
		t.Fatalf("unexpected embedded document info: %#v", info)
	}
}
