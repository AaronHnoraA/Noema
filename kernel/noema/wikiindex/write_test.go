package wikiindex

import (
	"database/sql"
	"encoding/json"

	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

// The kernel writes the same wiki.db rows Node writes for the same index:
// shared/wiki-db-fixtures.json holds Node's input and the tables it produced.
func TestWriteDatabaseMatchesNodeTables(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "wiki-db-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Index  Index                      `json:"index"`
		Tables map[string]json.RawMessage `json:"tables"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite3", filepath.Join(t.TempDir(), "wiki.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := WriteDatabase(db, fixture.Index, "2026-11-22T00:00:00.000Z"); err != nil {
		t.Fatal(err)
	}
	if err := WriteDatabase(db, fixture.Index, "later"); err == nil {
		t.Fatal("a second write into a built database must be refused")
	}
	var version int
	_ = db.QueryRow("PRAGMA user_version").Scan(&version)
	var wantVersion int
	_ = json.Unmarshal(fixture.Tables["user_version"], &wantVersion)
	if version != wantVersion {
		t.Fatalf("user_version %d, want %d", version, wantVersion)
	}
	queries := map[string]string{
		"pages_fts": "SELECT page_key, title, aliases, tags, path, body FROM pages_fts",
	}
	for _, table := range []string{"repositories", "files", "pages", "blocks", "aliases", "tags", "links",
		"dependencies", "diagnostics", "page_bigrams", "pages_fts"} {
		t.Run(table, func(t *testing.T) {
			query := queries[table]
			if query == "" {
				query = "SELECT * FROM " + table
			}
			have := rowsAsJSON(t, db, query)
			var wantRows []map[string]any
			if err := json.Unmarshal(fixture.Tables[table], &wantRows); err != nil {
				t.Fatal(err)
			}
			want := canonicalRows(wantRows)
			if !reflect.DeepEqual(want, have) {
				t.Fatalf("\nwant %v\nhave %v", want, have)
			}
		})
	}
}

func rowsAsJSON(t *testing.T, db *sql.DB, query string) []string {
	t.Helper()
	rows, err := db.Query(query)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	columns, _ := rows.Columns()
	out := []map[string]any{}
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for index := range values {
			pointers[index] = &values[index]
		}
		if err := rows.Scan(pointers...); err != nil {
			t.Fatal(err)
		}
		row := map[string]any{}
		for index, column := range columns {
			value := values[index]
			if bytes, ok := value.([]byte); ok {
				value = string(bytes)
			}
			row[column] = value
		}
		out = append(out, row)
	}
	return canonicalRows(out)
}

// canonicalRows makes rows comparable regardless of order and number types.
func canonicalRows(rows []map[string]any) []string {
	out := []string{}
	for _, row := range rows {
		normalized := map[string]any{}
		for key, value := range row {
			switch number := value.(type) {
			case int64:
				value = float64(number)
			case int:
				value = float64(number)
			}
			normalized[key] = value
		}
		encoded, _ := json.Marshal(normalized)
		out = append(out, string(encoded))
	}
	sort.Strings(out)
	return out
}
