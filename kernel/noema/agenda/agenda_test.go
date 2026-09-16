package agenda

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

type sharedAgendaFixture struct {
	Name     string          `json:"name"`
	Request  EvaluateRequest `json:"request"`
	Expected EvaluateResult  `json:"expected"`
}

func TestSharedAgendaEvaluationFixtures(t *testing.T) {
	originalLocation := time.Local
	time.Local = time.FixedZone("AEST", 10*60*60)
	t.Cleanup(func() { time.Local = originalLocation })
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "agenda-evaluation-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []sharedAgendaFixture
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		fixture := fixture
		t.Run(fixture.Name, func(t *testing.T) {
			actual := Evaluate(fixture.Request)
			if !reflect.DeepEqual(actual, fixture.Expected) {
				actualJSON, _ := json.MarshalIndent(actual, "", "  ")
				expectedJSON, _ := json.MarshalIndent(fixture.Expected, "", "  ")
				t.Fatalf("agenda evaluation mismatch\nactual: %s\nexpected: %s", actualJSON, expectedJSON)
			}
		})
	}
}

func TestNativeClockIdentitySurvivesRenameAndDoesNotFallBackToTitle(t *testing.T) {
	file := "/project/work.noema"
	result := Evaluate(EvaluateRequest{
		Todos: []Todo{
			{ID: file + "#first", File: file, Text: "Renamed", Status: "todo", Canon: map[string]string{}},
			{ID: file + "#second", File: file, Text: "Old title", Status: "todo", Canon: map[string]string{}},
		},
		Clocks: []PlanningItem{
			{ID: "clock-a", File: file, Text: "Old title", NativeTodoID: file + "#first", Args: map[string]string{"from": "2026-09-16 09:00", "to": "2026-09-16 10:15"}},
			{ID: "clock-b", File: file, Text: "Old title", NativeTodoID: file + "#missing", Args: map[string]string{"from": "2026-09-16 10:00", "to": "2026-09-16 10:15"}},
			{ID: "clock-c", File: "/other/work.noema", Text: "Renamed", NativeTodoID: file + "#first", Args: map[string]string{"from": "2026-09-16 10:00", "to": "2026-09-16 10:15"}},
		},
		IncludePlanning: true, TodayMs: time.Date(2026, 9, 16, 12, 0, 0, 0, time.Local).UnixMilli(),
	})
	if result.Clocks[0].TodoID != file+"#first" || result.Clocks[1].TodoID != "" || result.Clocks[2].TodoID != "" {
		t.Fatalf("native clock reference fell back to a title or another file: %+v", result.Clocks)
	}
	brokenRefs := 0
	for _, lint := range result.ClockLints {
		if lint.Kind == "broken-clock-ref" {
			brokenRefs++
		}
	}
	if brokenRefs != 2 {
		t.Fatalf("missing invalid-reference diagnostics: %+v", result.ClockLints)
	}
	for _, task := range result.Clocktable.Tasks {
		if task.TodoID == file+"#first" && task.Minutes == 75 {
			return
		}
	}
	t.Fatalf("missing 75 minute native task total: %+v", result.Clocktable.Tasks)
}
