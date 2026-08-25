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
