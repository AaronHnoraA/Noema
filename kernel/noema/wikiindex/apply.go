package wikiindex

import (
	"database/sql"
	"errors"
	"fmt"
	"strconv"
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
	var key strings.Builder
	for index, value := range values {
		if index > 0 {
			key.WriteByte(0x1f)
		}
		switch v := value.(type) {
		case nil:
			key.WriteString("\x00nil")
		case sql.NullString:
			if v.Valid {
				key.WriteString("s:")
				key.WriteString(v.String)
			} else {
				key.WriteString("\x00nil")
			}
		case []byte:
			key.WriteString("s:")
			key.Write(v)
		case string:
			key.WriteString("s:")
			key.WriteString(v)
		case int:
			key.WriteString("n:")
			key.WriteString(strconv.FormatFloat(float64(v), 'g', -1, 64))
		case int64:
			key.WriteString("n:")
			key.WriteString(strconv.FormatFloat(float64(v), 'g', -1, 64))
		case float64:
			key.WriteString("n:")
			key.WriteString(strconv.FormatFloat(v, 'g', -1, 64))
		default:
			key.WriteString(fmt.Sprintf("?:%v", v))
		}
	}
	return key.String()
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
	changed, _, err = applyIndexCounting(db, idx, now)
	return changed, err
}

// applyIndexCounting is ApplyIndex that also says how many rows each table
// gained (a changed row is one removal and one insertion).
func applyIndexCounting(db *sql.DB, idx Index, now string) (changed int, inserted map[string]int, err error) {
	inserted = map[string]int{}
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return 0, nil, err
	}
	if version != SchemaVersion {
		return 0, nil, errors.New("wikiindex: schema differs; build in full")
	}
	tx, err := db.Begin()
	if err != nil {
		return 0, nil, err
	}
	defer tx.Rollback()
	for _, table := range desiredTables(idx, now) {
		// The scan watermark moves on every refresh; it is not a change.
		counts := table.name != "repository_index_state"
		// page_bigrams has no rowid; its rows are deleted by value.
		byValue := table.name == "page_bigrams"
		selectCols := strings.Join(table.columns, ", ")
		if !byValue {
			selectCols = "rowid, " + selectCols
		}
		rows, err := tx.Query("SELECT " + selectCols + " FROM " + table.name)
		if err != nil {
			return 0, nil, err
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
				return 0, nil, err
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
				return 0, nil, err
			}
			if counts {
				changed++
			}
		}
		placeholders := strings.TrimSuffix(strings.Repeat("?, ", len(table.columns)), ", ")
		for key, values := range table.rows {
			for missing := table.counts[key] - present[key]; missing > 0; missing-- {
				if _, err := tx.Exec("INSERT INTO "+table.name+" ("+strings.Join(table.columns, ", ")+") VALUES ("+placeholders+")", values...); err != nil {
					return 0, nil, fmt.Errorf("%s: %w", table.name, err)
				}
				if counts {
					changed++
				}
				inserted[table.name]++
			}
		}
	}
	for _, meta := range [][2]string{{"generation", idx.Generation}, {"updated_at", now}, {"last_mode", "incremental"},
		{"last_reason", "kernel"}, {"last_error", ""}, {"last_incremental_at", now}} {
		if _, err := tx.Exec("INSERT OR REPLACE INTO wiki_meta VALUES (?, ?)", meta[0], meta[1]); err != nil {
			return 0, nil, err
		}
	}
	return changed, inserted, tx.Commit()
}

// applyKnown brings a database whose rows are exactly PREVIOUS (the tables
// this process last wrote to it) to IDX, writing only the difference and
// reading nothing back.
func applyKnown(db *sql.DB, previous []*tableRows, idx Index, now string) (int, map[string]int, []*tableRows, error) {
	inserted := map[string]int{}
	next := desiredTables(idx, now)
	before := map[string]*tableRows{}
	for _, table := range previous {
		before[table.name] = table
	}
	tx, err := db.Begin()
	if err != nil {
		return 0, nil, nil, err
	}
	defer tx.Rollback()
	changed := 0
	for _, table := range next {
		old := before[table.name]
		if old == nil {
			return 0, nil, nil, errors.New("wikiindex: remembered tables are incomplete")
		}
		counts := table.name != "repository_index_state"
		where := make([]string, len(table.columns))
		for index, column := range table.columns {
			where[index] = column + " IS ?"
		}
		remove := "DELETE FROM " + table.name + " WHERE rowid = (SELECT rowid FROM " + table.name + " WHERE " + strings.Join(where, " AND ") + " LIMIT 1)"
		if table.name == "page_bigrams" {
			remove = "DELETE FROM page_bigrams WHERE bigram=? AND page_key=?"
		}
		for key, values := range old.rows {
			for extra := old.counts[key] - table.counts[key]; extra > 0; extra-- {
				if _, err := tx.Exec(remove, values...); err != nil {
					return 0, nil, nil, fmt.Errorf("%s: %w", table.name, err)
				}
				if counts {
					changed++
				}
			}
		}
		placeholders := strings.TrimSuffix(strings.Repeat("?, ", len(table.columns)), ", ")
		insert := "INSERT INTO " + table.name + " (" + strings.Join(table.columns, ", ") + ") VALUES (" + placeholders + ")"
		for key, values := range table.rows {
			for missing := table.counts[key] - old.counts[key]; missing > 0; missing-- {
				if _, err := tx.Exec(insert, values...); err != nil {
					return 0, nil, nil, fmt.Errorf("%s: %w", table.name, err)
				}
				if counts {
					changed++
				}
				inserted[table.name]++
			}
		}
	}
	for _, meta := range [][2]string{{"generation", idx.Generation}, {"updated_at", now}, {"last_mode", "incremental"},
		{"last_reason", "kernel"}, {"last_error", ""}, {"last_incremental_at", now}} {
		if _, err := tx.Exec("INSERT OR REPLACE INTO wiki_meta VALUES (?, ?)", meta[0], meta[1]); err != nil {
			return 0, nil, nil, err
		}
	}
	return changed, inserted, next, tx.Commit()
}
