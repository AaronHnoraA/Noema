package attributeview

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type sharedFixture struct {
	Name     string  `json:"name"`
	Request  Request `json:"request"`
	Expected Result  `json:"expected"`
}

func TestSharedAttributeViewFixtures(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "attribute-view-fixtures.json"))
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
			actual := Evaluate(fixture.Request)
			if !reflect.DeepEqual(actual, fixture.Expected) {
				actualJSON, _ := json.MarshalIndent(actual, "", "  ")
				expectedJSON, _ := json.MarshalIndent(fixture.Expected, "", "  ")
				t.Fatalf("attribute view mismatch\nactual: %s\nexpected: %s", actualJSON, expectedJSON)
			}
		})
	}
}

func TestTypedVocabularyStaysComplete(t *testing.T) {
	if len(fieldTypes) != 17 {
		t.Fatalf("field type count = %d, want 17", len(fieldTypes))
	}
	if len(calcOperators) != 22 {
		t.Fatalf("calculation operator count = %d, want 22", len(calcOperators))
	}
	// Includes the 17 canonical operators plus legacy portable `in`/`not-in`
	// aliases retained for existing Markdown views.
	if len(filterOperators) != 19 {
		t.Fatalf("filter operator count = %d, want 19", len(filterOperators))
	}
}

func TestCollectionEqualityUsesSetSemantics(t *testing.T) {
	if !equalTypedValues("Research|draft|research", "draft|research", "mselect", 0) {
		t.Fatal("multi-select values with the same members should compare equal")
	}
	if equalTypedValues("research", "draft|research", "mselect", 0) {
		t.Fatal("multi-select values with different members should not compare equal")
	}
}
