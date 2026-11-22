package wikiindex

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// tableRows is one table's desired content, keyed by the whole row.
type tableRows struct {
	name    string
	columns []string
	rows    map[string][]any
	counts  map[string]int
}

func rowKey(values []any) string {
	parts := make([]string, len(values))
	for index, value := range values {
		switch v := value.(type) {
		case nil:
			parts[index] = "\x00nil"
		case sql.NullString:
			if v.Valid {
				parts[index] = "s:" + v.String
			} else {
				parts[index] = "\x00nil"
			}
		case []byte:
			parts[index] = "s:" + string(v)
		case string:
			parts[index] = "s:" + v
		case int:
			parts[index] = fmt.Sprintf("n:%v", float64(v))
		case int64:
			parts[index] = fmt.Sprintf("n:%v", float64(v))
		case float64:
			parts[index] = fmt.Sprintf("n:%v", v)
		default:
			parts[index] = fmt.Sprintf("?:%v", v)
		}
	}
	return strings.Join(parts, "\x1f")
}

// desiredTables is what a full build of IDX writes, table by table.
func desiredTables(idx Index, now string) []*tableRows {
	tables := map[string]*tableRows{}
	order := []string{}
	add := func(name string, _ []string, values ...any) {
		table := tables[name]
		key := rowKey(values)
		table.rows[key] = values
		table.counts[key]++
	}
	// Declare every table, so one that becomes empty is emptied.
	for name, columns := range map[string][]string{
		"repositories":           {"location_id", "repository_id", "identity_status", "partition", "name", "namespace", "qualified_namespace", "namespace_aliases", "path"},
		"repository_index_state": {"repository_id", "repository_uid", "head_sha", "scanned_at"},
		"files":                  {"repository_id", "path", "file", "kind", "extension", "size", "mtime", "git_status"},
		"pages":                  {"page_key", "page_id", "identity_status", "title", "namespace", "qualified_namespace", "namespace_source", "kind", "file", "workspace_path", "repository_path", "repository_id", "partition", "private", "redirect_to", "mtime", "created"},
		"blocks":                 {"block_id", "page_key", "kind", "env_kind", "label", "source_offset"},
		"aliases":                {"page_key", "alias"},
		"tags":                   {"page_key", "tag"},
		"links":                  {"source_key", "raw_target", "target_id", "target_block_id", "target_title", "status"},
		"dependencies":           {"source_key", "kind", "raw_target", "target_path", "status"},
		"diagnostics":            {"code", "severity", "message", "path"},
		"page_bigrams":           {"bigram", "page_key"},
		"pages_fts":              {"page_key", "title", "aliases", "tags", "path", "body"},
		"pages_fts_trigram":      {"page_key", "title", "aliases", "tags", "path", "body"},
	} {
		tables[name] = &tableRows{name: name, columns: columns, rows: map[string][]any{}, counts: map[string]int{}}
		order = append(order, name)
	}
	emit(idx, now, func(name string, values ...any) { add(name, nil, values...) })
	out := make([]*tableRows, 0, len(order))
	for _, name := range order {
		out = append(out, tables[name])
	}
	return out
}

// ApplyIndex brings an existing wiki.db to IDX by changing only the rows that
// differ, ending exactly where WriteDatabase(IDX) would: the invariant
// apply_test.go holds. A database of another schema is refused; the caller
// builds it in full instead.
func ApplyIndex(db *sql.DB, idx Index, now string) (changed int, err error) {
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return 0, err
	}
	if version != SchemaVersion {
		return 0, errors.New("wikiindex: schema differs; build in full")
	}
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	for _, table := range desiredTables(idx, now) {
		// page_bigrams has no rowid; its rows are deleted by value.
		byValue := table.name == "page_bigrams"
		selectCols := strings.Join(table.columns, ", ")
		if !byValue {
			selectCols = "rowid, " + selectCols
		}
		rows, err := tx.Query("SELECT " + selectCols + " FROM " + table.name)
		if err != nil {
			return 0, err
		}
		present := map[string]int{}
		type staleRow struct {
			rowid  int64
			values []any
		}
		stale := []staleRow{}
		offset := 1
		if byValue {
			offset = 0
		}
		for rows.Next() {
			values := make([]any, len(table.columns)+offset)
			pointers := make([]any, len(values))
			for index := range values {
				pointers[index] = &values[index]
			}
			if err := rows.Scan(pointers...); err != nil {
				rows.Close()
				return 0, err
			}
			key := rowKey(values[offset:])
			if present[key] < table.counts[key] {
				present[key]++
				continue
			}
			row := staleRow{values: values[offset:]}
			if !byValue {
				row.rowid = values[0].(int64)
			}
			stale = append(stale, row)
		}
		rows.Close()
		for _, row := range stale {
			if byValue {
				_, err = tx.Exec("DELETE FROM page_bigrams WHERE bigram=? AND page_key=?", row.values...)
			} else {
				_, err = tx.Exec("DELETE FROM "+table.name+" WHERE rowid=?", row.rowid)
			}
			if err != nil {
				return 0, err
			}
			changed++
		}
		placeholders := strings.TrimSuffix(strings.Repeat("?, ", len(table.columns)), ", ")
		for key, values := range table.rows {
			for missing := table.counts[key] - present[key]; missing > 0; missing-- {
				if _, err := tx.Exec("INSERT INTO "+table.name+" ("+strings.Join(table.columns, ", ")+") VALUES ("+placeholders+")", values...); err != nil {
					return 0, fmt.Errorf("%s: %w", table.name, err)
				}
				changed++
			}
		}
	}
	for _, meta := range [][2]string{{"generation", idx.Generation}, {"updated_at", now}, {"last_mode", "incremental"},
		{"last_reason", "kernel"}, {"last_error", ""}, {"last_incremental_at", now}} {
		if _, err := tx.Exec("INSERT OR REPLACE INTO wiki_meta VALUES (?, ?)", meta[0], meta[1]); err != nil {
			return 0, err
		}
	}
	return changed, tx.Commit()
}
