package wikiindex

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// DatabaseFile is the vault's wiki.db.
func DatabaseFile(root string) string {
	return filepath.Join(root, ".noema", "wiki.db")
}

// RefreshResult says what a refresh did.
type RefreshResult struct {
	Mode    string `json:"mode"`
	Reason  string `json:"reason"`
	Changed int    `json:"changed"`
	// Inserted counts the rows each table gained: a page whose row changed
	// counts once in "pages".
	Inserted   map[string]int `json:"inserted"`
	Pages      int            `json:"pages"`
	Files      int            `json:"files"`
	Generation string         `json:"generation"`
	ElapsedMs  int64          `json:"elapsedMs"`
	Index      *Index         `json:"index,omitempty"`
}

var refreshMu sync.Mutex

// written remembers, per database file, the rows this process last wrote and
// the file's size and time right after, so the next refresh writes only the
// difference. Anything else touching the file voids it.
type writtenState struct {
	size   int64
	mtime  time.Time
	tables []*tableRows
}

var written = map[string]writtenState{}

func fileStamp(file string) (int64, time.Time, bool) {
	info, err := os.Stat(file)
	if err != nil {
		return 0, time.Time{}, false
	}
	return info.Size(), info.ModTime(), true
}

func remember(file string, tables []*tableRows) {
	if size, mtime, ok := fileStamp(file); ok {
		written[file] = writtenState{size: size, mtime: mtime, tables: tables}
	} else {
		delete(written, file)
	}
}

// Refresh rebuilds the vault's wiki.db from its files: in place, row by row,
// when the database has this schema, otherwise in full into a temporary file
// renamed over it, so a reader never sees a half-built index. Refreshes are
// serialized. FULL forces a full build.
func Refresh(root string, full bool) (RefreshResult, error) {
	refreshMu.Lock()
	defer refreshMu.Unlock()
	started := time.Now()
	idx, err := Scan(root)
	if err != nil {
		return RefreshResult{}, err
	}
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	file := DatabaseFile(root)
	result := RefreshResult{Pages: len(idx.Notes), Files: len(idx.Files), Generation: idx.Generation}
	reason := "forced"
	if !full {
		reason = schemaReason(file)
	}
	if reason == "" {
		db, err := sql.Open("sqlite3", file+"?_busy_timeout=5000")
		if err != nil {
			return result, err
		}
		defer db.Close()
		changed := 0
		state, known := written[file]
		if size, mtime, ok := fileStamp(file); known && ok && size == state.size && mtime.Equal(state.mtime) {
			var tables []*tableRows
			changed, result.Inserted, tables, err = applyKnown(db, state.tables, idx, now)
			if err != nil {
				delete(written, file)
				return result, err
			}
			db.Close()
			remember(file, tables)
		} else {
			changed, result.Inserted, err = applyIndexCounting(db, idx, now)
			if err != nil {
				delete(written, file)
				return result, err
			}
			db.Close()
			remember(file, desiredTables(idx, now))
		}
		result.Mode, result.Reason, result.Changed = "incremental", "changes", changed
	} else {
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			return result, err
		}
		temporary := filepath.Join(filepath.Dir(file), fmt.Sprintf(".wiki-kernel-%d-%d.db", os.Getpid(), time.Now().UnixNano()))
		defer os.Remove(temporary)
		db, err := sql.Open("sqlite3", temporary)
		if err != nil {
			return result, err
		}
		if err := WriteDatabase(db, idx, now); err != nil {
			db.Close()
			return result, err
		}
		if err := db.Close(); err != nil {
			return result, err
		}
		_ = os.Remove(file + "-wal")
		_ = os.Remove(file + "-shm")
		if err := os.Rename(temporary, file); err != nil {
			return result, err
		}
		remember(file, desiredTables(idx, now))
		result.Inserted = map[string]int{"pages": len(idx.Notes), "files": len(idx.Files)}
		result.Mode, result.Reason = "full", reason
	}
	result.ElapsedMs = time.Since(started).Milliseconds()
	result.Index = &idx
	return result, nil
}

// schemaReason is why the database at FILE needs a full build, or "".
func schemaReason(file string) string {
	if _, err := os.Stat(file); err != nil {
		return "no-db"
	}
	db, err := sql.Open("sqlite3", "file:"+file+"?mode=ro&_busy_timeout=3000")
	if err != nil {
		return "database-invalid"
	}
	defer db.Close()
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return "database-invalid"
	}
	if version != SchemaVersion {
		return "schema"
	}
	return ""
}
