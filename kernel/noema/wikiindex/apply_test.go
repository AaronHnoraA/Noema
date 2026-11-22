package wikiindex

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func fixtureIndex(t *testing.T) Index {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "wiki-db-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Index Index `json:"index"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture.Index
}

func cloneIndex(t *testing.T, idx Index) Index {
	t.Helper()
	raw, _ := json.Marshal(idx)
	var out Index
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func openDB(t *testing.T, name string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite3", filepath.Join(t.TempDir(), name))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

var comparedTables = []string{"repositories", "repository_index_state", "files", "pages", "blocks", "aliases", "tags",
	"links", "dependencies", "diagnostics", "page_bigrams", "pages_fts", "pages_fts_trigram"}

func dump(t *testing.T, db *sql.DB) map[string][]string {
	out := map[string][]string{}
	for _, table := range comparedTables {
		query := "SELECT * FROM " + table
		if table == "pages_fts" || table == "pages_fts_trigram" {
			query = "SELECT page_key, title, aliases, tags, path, body FROM " + table
		}
		out[table] = rowsAsJSON(t, db, query)
	}
	return out
}

// Applying a changed index to a built database ends exactly where a full
// build of the changed index does.
func TestApplyIndexEndsWhereAFullBuildDoes(t *testing.T) {
	const now = "2026-11-22T00:00:00.000Z"
	before := fixtureIndex(t)
	after := cloneIndex(t, before)
	// A page disappears, one is retitled and rewritten, a link is added, a
	// file changes size, and a diagnostic appears.
	removed := after.Notes[0]
	after.Notes = after.Notes[1:]
	after.Notes[0].Title = "Retitled 新标题"
	after.Notes[0].SearchText += "\n新的段落 [[Nowhere]]\n"
	after.Notes[0].WikiLinks = append(after.Notes[0].WikiLinks, Link{Target: "Nowhere", Label: "Nowhere"})
	after.Notes[0].Tags = append(after.Notes[0].Tags, "added")
	after.Files[0].Size += 10
	after.Diagnostics = append(after.Diagnostics, Diagnostic{Code: "x", Severity: "warning", Message: "m", Path: removed.File})

	incremental := openDB(t, "incremental.db")
	if err := WriteDatabase(incremental, before, now); err != nil {
		t.Fatal(err)
	}
	changed, err := ApplyIndex(incremental, after, now)
	if err != nil {
		t.Fatal(err)
	}
	if changed == 0 {
		t.Fatal("nothing changed")
	}
	full := openDB(t, "full.db")
	if err := WriteDatabase(full, after, now); err != nil {
		t.Fatal(err)
	}
	want, have := dump(t, full), dump(t, incremental)
	for _, table := range comparedTables {
		if !reflect.DeepEqual(want[table], have[table]) {
			t.Errorf("%s differs\nwant %v\nhave %v", table, want[table], have[table])
		}
	}
	// Applying the same index again changes nothing.
	again, err := ApplyIndex(incremental, after, now)
	if err != nil {
		t.Fatal(err)
	}
	if again != 0 {
		t.Fatalf("re-applying an unchanged index changed %d rows", again)
	}
}

func TestApplyIndexRefusesAnotherSchema(t *testing.T) {
	db := openDB(t, "empty.db")
	if _, err := ApplyIndex(db, fixtureIndex(t), "now"); err == nil {
		t.Fatal("an unbuilt database must be refused")
	}
}
