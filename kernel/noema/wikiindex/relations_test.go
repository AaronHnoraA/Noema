package wikiindex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The shared relationship contract: the Node indexer is held to the same file
// by tests/wiki-note-parse-contract.test.ts.
func TestResolveMatchesSharedFixtures(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "wiki-relationship-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Cases []struct {
			Name     string          `json:"name"`
			Pages    []Page          `json:"pages"`
			Expected json.RawMessage `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures.Cases) == 0 {
		t.Fatal("no fixtures")
	}
	for _, c := range fixtures.Cases {
		t.Run(c.Name, func(t *testing.T) {
			got, _ := json.Marshal(Resolve(c.Pages))
			var want, have any
			_ = json.Unmarshal(c.Expected, &want)
			_ = json.Unmarshal(got, &have)
			if !reflect.DeepEqual(want, have) {
				t.Fatalf("\nwant %s\nhave %s", c.Expected, got)
			}
		})
	}
}
