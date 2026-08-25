package katexmacros

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type sharedFixture struct {
	Name   string            `json:"name"`
	Files  []File            `json:"files"`
	Macros map[string]string `json:"macros"`
	Errors []ParseError      `json:"errors"`
}

func TestSharedKatexMacroFixtures(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "katex-macro-fixtures.json"))
	if nil != err {
		t.Fatal(err)
	}
	fixtures := []sharedFixture{}
	if err = json.Unmarshal(raw, &fixtures); nil != err {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		fixture := fixture
		t.Run(fixture.Name, func(t *testing.T) {
			result := Parse(fixture.Files)
			if !reflect.DeepEqual(result.Macros, fixture.Macros) || !reflect.DeepEqual(result.Errors, fixture.Errors) {
				t.Fatalf("fixture mismatch: result=%+v expected macros=%+v errors=%+v", result, fixture.Macros, fixture.Errors)
			}
		})
	}
}

func TestLoadReadsOnlySortedTexFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "b.tex"), []byte(`\renewcommand{\X}{b}`), 0644); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.tex"), []byte(`\newcommand{\X}{a}`), 0644); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ignored.TEX"), []byte(`\newcommand{\Y}{bad}`), 0644); nil != err {
		t.Fatal(err)
	}
	result := Load(dir)
	if result.Macros[`\X`] != "b" || result.Macros[`\Y`] != "" || len(result.Errors) != 0 {
		t.Fatalf("unexpected loaded macros: %+v", result)
	}
}
