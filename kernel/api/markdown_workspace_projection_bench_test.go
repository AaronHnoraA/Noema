package api

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/gin-gonic/gin"
)

// BenchmarkListMarkdownWorkspaceProjectionAPI includes request decoding and
// response JSON encoding, complementing the model benchmark with the bytes
// that cross the Node-to-Go loopback boundary.
func BenchmarkListMarkdownWorkspaceProjectionAPI(b *testing.B) {
	originalDataDir := util.DataDir
	util.DataDir = b.TempDir()
	b.Cleanup(func() { util.DataDir = originalDataDir })
	boxID := "20260826220000-apiwire"
	boxDir := filepath.Join(util.DataDir, boxID)
	if err := os.MkdirAll(boxDir, 0o755); nil != err {
		b.Fatal(err)
	}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Workspace projection API benchmark"
	if err := (&model.Box{ID: boxID}).SaveConf(boxConf); nil != err {
		b.Fatal(err)
	}
	for index := 0; index < 500; index++ {
		source := fmt.Sprintf("---\nid: note-%03d\ntitle: Note %03d\ntags: planning benchmark\nproject: Noema\n---\n# Note %03d\n\n@@todo(doing) [Task %03d] {id=task-%03d, ddl=tomorrow}\n\nClaim %03d {#0198fc34-7b32-7a11-8cb4-%012x status=draft owner=Go}\n", index, index, index, index, index, index, index)
		if err := os.WriteFile(filepath.Join(boxDir, fmt.Sprintf("note-%03d.md", index)), []byte(source), 0o644); nil != err {
			b.Fatal(err)
		}
	}
	if _, err := model.ListMarkdownWorkspaceProjection(boxID, true); nil != err {
		b.Fatal(err)
	}

	gin.SetMode(gin.ReleaseMode)
	engine := gin.New()
	engine.POST("/api/noema/markdown/workspaceProjection", listMarkdownWorkspaceProjection)
	payload := []byte(`{"notebook":"` + boxID + `","includeProperties":true}`)
	probe := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/workspaceProjection", bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(probe, request)
	if probe.Code != http.StatusOK {
		b.Fatalf("status = %d", probe.Code)
	}
	wireBytes := probe.Body.Len()
	b.ReportAllocs()
	b.ResetTimer()
	b.ReportMetric(float64(wireBytes), "wire-B")
	for range b.N {
		recorder := httptest.NewRecorder()
		request = httptest.NewRequest(http.MethodPost, "/api/noema/markdown/workspaceProjection", bytes.NewReader(payload))
		request.Header.Set("Content-Type", "application/json")
		engine.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			b.Fatalf("status = %d", recorder.Code)
		}
	}
}
