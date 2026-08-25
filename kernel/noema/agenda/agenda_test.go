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
