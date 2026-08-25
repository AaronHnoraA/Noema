package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestLoadNoemaKatexMacrosAPI(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "macros.tex"), []byte(`\newcommand{\NoemaAPI}{\mathbf{N}}`), 0644); nil != err {
		t.Fatal(err)
	}
	engine := gin.New()
	engine.POST("/api/noema/config/katexMacros", loadNoemaKatexMacros)
	body, _ := json.Marshal(map[string]string{"dir": dir})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/noema/config/katexMacros", strings.NewReader(string(body)))
	request.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, request)

	response := markdownDocResponse{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); nil != err {
		t.Fatal(err)
	}
	if response.Code != 0 || !strings.Contains(string(response.Data), `"\\NoemaAPI":"\\mathbf{N}"`) {
		t.Fatalf("unexpected macros API response: %s", recorder.Body.String())
	}
}
