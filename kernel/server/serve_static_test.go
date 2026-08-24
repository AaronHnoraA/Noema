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

package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/gin-gonic/gin"
)

func TestCleanStaticRelativePath(t *testing.T) {
	if relativePath, ok := cleanStaticRelativePath("/package/index.js"); !ok ||
		filepath.ToSlash(relativePath) != "package/index.js" {
		t.Fatalf("unexpected clean path [%s], ok=%v", relativePath, ok)
	}
	for _, requestPath := range []string{"/../secret", "../secret", "/package/../../secret"} {
		if _, ok := cleanStaticRelativePath(requestPath); ok {
			t.Fatalf("path traversal should be rejected [%s]", requestPath)
		}
	}
}

func TestRegisterStaticFileHandlers(t *testing.T) {
	gin.SetMode(gin.TestMode)
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "package"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "package", "index.html"), []byte("content"), 0644); err != nil {
		t.Fatal(err)
	}

	engine := gin.New()
	group := engine.Group("/files/")
	registerStaticFileHandlers(group, root, true, func(_ *gin.Context, relativePath string) bool {
		return filepath.ToSlash(relativePath) == "package"
	})

	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/files/package/", nil))
	if recorder.Code != http.StatusOK || recorder.Body.String() != "content" {
		t.Fatalf("unexpected allowed response: status=%d body=%q", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/files/package/index.html", nil))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("access callback should deny the request, got %d", recorder.Code)
	}
}

func TestStaticFileNestedSymlinkEscape(t *testing.T) {
	gin.SetMode(gin.TestMode)
	root, outside := t.TempDir(), t.TempDir()
	packagePath := filepath.Join(root, "package")
	if err := os.MkdirAll(packagePath, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(packagePath, "escape")); err != nil {
		t.Skipf("create directory symlink failed: %s", err)
	}

	engine := gin.New()
	group := engine.Group("/files/")
	registerStaticFileHandlers(group, root, true, func(_ *gin.Context, _ string) bool {
		return true
	})

	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/files/package/escape/secret.txt", nil))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("nested symlink escape should be forbidden, got %d", recorder.Code)
	}
}

func TestWidgetResponseDisablesCache(t *testing.T) {
	gin.SetMode(gin.TestMode)
	originalDataDir, originalConf := util.DataDir, model.Conf
	util.DataDir = t.TempDir()
	model.Conf = model.NewAppConf()
	t.Cleanup(func() {
		util.DataDir = originalDataDir
		model.Conf = originalConf
	})

	widgetDir := filepath.Join(util.DataDir, "widgets", "example")
	if err := os.MkdirAll(widgetDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(widgetDir, "index.html"), []byte("content"), 0644); err != nil {
		t.Fatal(err)
	}

	engine := gin.New()
	engine.Use(func(c *gin.Context) {
		c.Set(model.RoleContextKey, model.RoleAdministrator)
		c.Next()
	})
	serveWidgets(engine)
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/widgets/example/", nil))
	if recorder.Code != http.StatusOK || recorder.Body.String() != "content" {
		t.Fatalf("unexpected widget response: status=%d body=%q", recorder.Code, recorder.Body.String())
	}
	if cacheControl := recorder.Header().Get("Cache-Control"); cacheControl != "private, no-store" {
		t.Fatalf("unexpected widget cache control [%s]", cacheControl)
	}
}
