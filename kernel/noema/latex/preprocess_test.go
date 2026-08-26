package latex

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

type transformFixture struct {
	Cases []struct {
		Name     string        `json:"name"`
		Markdown string        `json:"markdown"`
		Options  Options       `json:"options"`
		Expected PrepareResult `json:"expected"`
	} `json:"cases"`
	ErrorCases []struct {
		Name     string `json:"name"`
		Markdown string `json:"markdown"`
		Message  string `json:"message"`
	} `json:"errorCases"`
	Postprocess struct {
		Input    string `json:"input"`
		Expected string `json:"expected"`
	} `json:"postprocess"`
}

func TestPrepareErrorsMatchSharedJavaScriptContract(t *testing.T) {
	fixture := loadTransformFixture(t)
	for _, test := range fixture.ErrorCases {
		t.Run(test.Name, func(t *testing.T) {
			_, err := Prepare(test.Markdown, Options{})
			if err == nil || err.Error() != test.Message {
				t.Fatalf("expected %q, got %v", test.Message, err)
			}
		})
	}
}

func loadTransformFixture(t *testing.T) transformFixture {
	t.Helper()
	data, err := os.ReadFile("../../../shared/latex-transform-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture transformFixture
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func TestPrepareMatchesSharedJavaScriptContract(t *testing.T) {
	fixture := loadTransformFixture(t)
	for _, test := range fixture.Cases {
		t.Run(test.Name, func(t *testing.T) {
			actual, err := Prepare(test.Markdown, test.Options)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(test.Expected, actual) {
				expectedJSON, _ := json.MarshalIndent(test.Expected, "", "  ")
				actualJSON, _ := json.MarshalIndent(actual, "", "  ")
				t.Fatalf("contract mismatch\nexpected: %s\nactual:   %s", expectedJSON, actualJSON)
			}
		})
	}
}

func TestPostprocessPandocLatexMatchesSharedJavaScriptContract(t *testing.T) {
	fixture := loadTransformFixture(t)
	if actual := PostprocessPandocLatex(fixture.Postprocess.Input); fixture.Postprocess.Expected != actual {
		t.Fatalf("expected %q, got %q", fixture.Postprocess.Expected, actual)
	}
}

func TestPrepareFailsClosedOnMalformedPrivateSyntax(t *testing.T) {
	for _, test := range []struct {
		name, markdown, message string
	}{
		{"unknown-mark", "Text @@latexmk(typo) here.", "Unknown @@latexmk mark"},
		{"unclosed-private", "@@todo [private] {\nkey: value", "Unclosed Noema planning block"},
		{"unclosed-comment", "Visible\n<!-- private", "Unclosed HTML comment"},
		{"unclosed-math", "$$\nx", "Unclosed display math"},
		{"mismatched-env", "#+begin theorem\ntext\n#+end proof", "Mismatched Noema block"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := Prepare(test.markdown, Options{})
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("expected %q, got %v", test.message, err)
			}
		})
	}
}

func TestPlanTemplateProducesSynchronousExecutionPlan(t *testing.T) {
	plan, err := PlanTemplate(`A {{ title }} B {{body}} C {{title}}`, []string{"title", "body"})
	if err != nil {
		t.Fatal(err)
	}
	expectedSegments := []string{"A ", " B ", " C ", ""}
	expectedPlaceholders := []string{"title", "body", "title"}
	if !reflect.DeepEqual(expectedSegments, plan.Segments) || !reflect.DeepEqual(expectedPlaceholders, plan.Placeholders) {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	if _, err = PlanTemplate(`{{boddy}}`, []string{"body"}); err == nil || !strings.Contains(err.Error(), "Unknown LaTeX template placeholder") {
		t.Fatalf("expected unknown placeholder failure, got %v", err)
	}
}
