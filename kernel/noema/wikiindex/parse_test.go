package wikiindex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type fixtureFile struct {
	Version int `json:"version"`
	Cases   []struct {
		Name     string          `json:"name"`
		File     string          `json:"file"`
		Content  string          `json:"content"`
		Expected json.RawMessage `json:"expected"`
	} `json:"cases"`
}

// The shared per-note parse contract: the Node indexer is held to the same file
// by tests/wiki-note-parse-contract.test.ts.
func TestParseMatchesSharedFixtures(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "wiki-note-parse-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures fixtureFile
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures.Cases) == 0 {
		t.Fatal("no fixtures")
	}
	for _, c := range fixtures.Cases {
		t.Run(c.Name, func(t *testing.T) {
			got, _ := json.Marshal(Parse(c.Content, c.File))
			var want, have any
			_ = json.Unmarshal(c.Expected, &want)
			_ = json.Unmarshal(got, &have)
			if !reflect.DeepEqual(want, have) {
				t.Fatalf("\nwant %s\nhave %s", c.Expected, got)
			}
		})
	}
}
