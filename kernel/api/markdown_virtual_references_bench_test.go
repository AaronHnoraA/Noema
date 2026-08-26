package api

import (
	"bytes"
	"fmt"
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

// BenchmarkListMarkdownVirtualReferencesAPI includes loopback request decode
// and the full rich-note response encode for 499 mentioning sources.
func BenchmarkListMarkdownVirtualReferencesAPI(b *testing.B) {
	originalDataDir := util.DataDir
	util.DataDir = b.TempDir()
	b.Cleanup(func() { util.DataDir = originalDataDir })
	boxID := "20260826223000-virtualref-api"
	boxDir := filepath.Join(util.DataDir, boxID)
	if err := os.MkdirAll(boxDir, 0o755); err != nil {
		b.Fatal(err)
	}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Virtual-reference API benchmark"
	if err := (&model.Box{ID: boxID}).SaveConf(boxConf); err != nil {
		b.Fatal(err)
	}
	for index := 0; index < 500; index++ {
		id := fmt.Sprintf("note-%03d", index)
		title := fmt.Sprintf("Reference %03d", index)
		body := strings.Repeat("ordinary prose around Reference 000 and Alias 000. ", 32)
		if index == 0 {
			body = "The target owns itself."
		}
		source := fmt.Sprintf("---\nid: %s\ntitle: %s\naliases: (\"Alias %03d\")\n---\n# %s\n\n%s\n", id, title, index, title, body)
		if err := os.WriteFile(filepath.Join(boxDir, id+".md"), []byte(source), 0o644); err != nil {
			b.Fatal(err)
		}
	}
	if _, err := model.ListMarkdownVirtualReferences(boxID, "note-000", false); err != nil {
		b.Fatal(err)
	}
	gin.SetMode(gin.ReleaseMode)
	engine := gin.New()
	engine.POST("/api/noema/markdown/virtualReferences", listMarkdownVirtualReferences)
	payload := []byte(`{"notebook":"` + boxID + `","targetId":"note-000"}`)
	probe := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/noema/markdown/virtualReferences", bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(probe, request)
	if probe.Code != http.StatusOK {
		b.Fatalf("status = %d", probe.Code)
	}
	wireBytes := probe.Body.Len()
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		recorder := httptest.NewRecorder()
		request = httptest.NewRequest(http.MethodPost, "/api/noema/markdown/virtualReferences", bytes.NewReader(payload))
		request.Header.Set("Content-Type", "application/json")
		engine.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			b.Fatalf("status = %d", recorder.Code)
		}
	}
	b.ReportMetric(float64(wireBytes), "wire-B")
}
