package planning

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

type sharedFixture struct {
	Name     string `json:"name"`
	Input    string `json:"input"`
	Wanted   string `json:"wanted"`
	Expected []Node `json:"expected"`
}

type sharedSemanticFixture struct {
	Name     string `json:"name"`
	Input    string `json:"input"`
	Mutation struct {
		Type  string             `json:"type"`
		Todo  TodoPatch          `json:"todo"`
		Attrs map[string]*string `json:"attrs"`
	} `json:"mutation"`
	ExpectedSource string `json:"expectedSource"`
}

func TestSharedPlanningSemanticFixtures(t *testing.T) {
	originalLocation := time.Local
	time.Local = time.FixedZone("AEST", 10*60*60)
	t.Cleanup(func() { time.Local = originalLocation })
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "planning-semantic-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []sharedSemanticFixture
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		fixture := fixture
		t.Run(fixture.Name, func(t *testing.T) {
			wanted := ""
			if fixture.Mutation.Type == "patch-todo" || fixture.Mutation.Type == "insert-clock" {
				wanted = "todo"
			}
			nodes := Scan(fixture.Input, wanted)
			if len(nodes) == 0 || nodes[0].Span.From != 0 {
				t.Fatalf("semantic fixture has no root planning node: %q", fixture.Input)
			}
			actual := ""
			switch fixture.Mutation.Type {
			case "patch-todo":
				actual = PatchTodoSource(nodes[0], fixture.Mutation.Todo)
			case "patch-node":
				actual = PatchNodeSource(nodes[0], fixture.Mutation.Attrs, nil)
			case "insert-clock":
				actual = ClockSourceForTodo(nodes[0], fixture.Mutation.Attrs)
			default:
				t.Fatalf("unknown semantic fixture mutation %q", fixture.Mutation.Type)
			}
			if actual != fixture.ExpectedSource {
				t.Fatalf("semantic serializer mismatch\nactual:   %q\nexpected: %q", actual, fixture.ExpectedSource)
			}
		})
	}
}

func TestCreateTodoSourceOwnsNewItemSemantics(t *testing.T) {
	location := time.FixedZone("AEST", 10*60*60)
	now := time.Date(2026, time.August, 25, 9, 30, 0, 0, location)
	source, err := CreateTodoSource(TodoCreate{
		Title: " Ship ] plan\\ ", Status: "active", NowMs: now.UnixMilli(),
		Attrs: map[string]string{
			"ddl": "tomorrow", "prio": "a", "progress": "160", "repeat": "invalid",
			"tags": "alpha beta", "done": "2026-08-25",
		},
	}, "#abc123")
	if err != nil {
		t.Fatal(err)
	}
	want := `@@todo(doing) [Ship \] plan\\] {id=abc123, ddl=2026-08-26, prio=A, progress=100, tags="alpha beta"}`
	if source != want {
		t.Fatalf("created todo source mismatch\nactual:   %q\nexpected: %q", source, want)
	}
	if _, err = CreateTodoSource(TodoCreate{}, "abc123"); err == nil {
		t.Fatal("empty todo title should fail")
	}
}

func TestParseDateValueCanonicalFastPathAndFallbacks(t *testing.T) {
	location := time.FixedZone("AEST", 10*60*60)
	originalLocation := time.Local
	time.Local = location
	t.Cleanup(func() { time.Local = originalLocation })
	now := time.Date(2026, time.August, 25, 9, 30, 0, 0, location)
	tests := []struct {
		raw     string
		want    string
		hasTime bool
	}{
		{raw: "2026-08", want: "2026-08-01"},
		{raw: "2026-08-26", want: "2026-08-26"},
		{raw: "2026-08-26 9:05", want: "2026-08-26 09:05", hasTime: true},
		{raw: "2026-08-26T19:05", want: "2026-08-26 19:05", hasTime: true},
		{raw: "2026年8月26日", want: "2026-08-26"},
		{raw: "8/26", want: "2026-08-26"},
		{raw: "tomorrow", want: "2026-08-26"},
	}
	for _, test := range tests {
		value, hasTime, ok := ParseDateValue(test.raw, now)
		if !ok {
			t.Fatalf("ParseDateValue(%q) failed", test.raw)
		}
		format := "2006-01-02"
		if test.hasTime {
			format += " 15:04"
		}
		if got := value.Format(format); got != test.want || hasTime != test.hasTime {
			t.Fatalf("ParseDateValue(%q) = %q, hasTime=%v; want %q, %v", test.raw, got, hasTime, test.want, test.hasTime)
		}
	}
}

func TestSharedPlanningFixtures(t *testing.T) {
	fixturePath := filepath.Join("..", "..", "..", "shared", "planning-fixtures.json")
	raw, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []sharedFixture
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		fixture := fixture
		t.Run(fixture.Name, func(t *testing.T) {
			actual := Scan(fixture.Input, fixture.Wanted)
			if !reflect.DeepEqual(actual, fixture.Expected) {
				actualJSON, _ := json.MarshalIndent(actual, "", "  ")
				expectedJSON, _ := json.MarshalIndent(fixture.Expected, "", "  ")
				t.Fatalf("planning parser mismatch\nactual: %s\nexpected: %s", actualJSON, expectedJSON)
			}
		})
	}
}

func TestScanDocumentExcludesMetaSummaryWithoutShiftingUTF16Spans(t *testing.T) {
	source := "#+begin meta\n#+begin summary\n示例😀 @@todo [not live]\n#+end summary\n#+end meta\n正文😀 @@todo [live]\n"
	nodes := ScanDocument(source, "todo")
	if len(nodes) != 1 || nodes[0].Title != "live" {
		t.Fatalf("expected only live todo, got %+v", nodes)
	}
	want := utf16Length(source[:len("#+begin meta\n#+begin summary\n示例😀 @@todo [not live]\n#+end summary\n#+end meta\n正文😀 ")])
	if nodes[0].Span.From != want {
		t.Fatalf("UTF-16 offset shifted after masked summary: got %d, want %d", nodes[0].Span.From, want)
	}
}
