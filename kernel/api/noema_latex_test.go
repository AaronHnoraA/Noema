package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func latexTestRequest(t *testing.T, handler gin.HandlerFunc, path, body string) map[string]any {
	t.Helper()
	engine := gin.New()
	engine.POST(path, handler)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, request)
	var response map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); nil != err {
		t.Fatal(err)
	}
	return response
}

func TestNoemaLatexTransformAPIs(t *testing.T) {
	prepared := latexTestRequest(t, prepareNoemaLatexPandoc, "/prepare", `{
        "markdown":"---\ntitle: YAML\n---\n#+begin meta\ntitle: Noema\n#+end meta\nVisible @@cite(refs) [Key].",
        "citationKeyMap":{"refs\u0000Key":"refs:Key"}
    }`)
	if prepared["code"].(float64) != 0 {
		t.Fatalf("prepare failed: %+v", prepared)
	}
	data := prepared["data"].(map[string]any)
	if data["meta"].(map[string]any)["title"] != "Noema" || !strings.Contains(data["markdown"].(string), `\cite{refs:Key}`) {
		t.Fatalf("unexpected prepared payload: %+v", data)
	}

	metadata := latexTestRequest(t, extractNoemaLatexMetadata, "/metadata", `{"markdown":"---\ndate: 2026-08-26\n---"}`)
	if metadata["code"].(float64) != 0 || metadata["data"].(map[string]any)["meta"].(map[string]any)["date"] != "2026-08-26" {
		t.Fatalf("unexpected metadata payload: %+v", metadata)
	}

	postprocessed := latexTestRequest(t, postprocessNoemaLatexPandoc, "/postprocess", `{"latex":"Body   \n\n\nTail   "}`)
	if postprocessed["code"].(float64) != 0 || postprocessed["data"].(map[string]any)["latex"] != "Body\n\nTail\n" {
		t.Fatalf("unexpected postprocess payload: %+v", postprocessed)
	}

	plan := latexTestRequest(t, planNoemaLatexTemplate, "/template", `{"template":"A {{ title }} B {{body}}","allowedKeys":["title","body"]}`)
	if plan["code"].(float64) != 0 || len(plan["data"].(map[string]any)["placeholders"].([]any)) != 2 {
		t.Fatalf("unexpected template plan: %+v", plan)
	}
}

func TestNoemaLatexTransformAPIsRequireSourceFields(t *testing.T) {
	for _, test := range []struct {
		path    string
		handler gin.HandlerFunc
		message string
	}{
		{"/prepare", prepareNoemaLatexPandoc, "markdown is required"},
		{"/metadata", extractNoemaLatexMetadata, "markdown is required"},
		{"/postprocess", postprocessNoemaLatexPandoc, "latex is required"},
		{"/template", planNoemaLatexTemplate, "template is required"},
	} {
		response := latexTestRequest(t, test.handler, test.path, `{}`)
		if response["code"].(float64) == 0 || response["msg"] != test.message {
			t.Fatalf("%s did not fail closed: %+v", test.path, response)
		}
	}
}
