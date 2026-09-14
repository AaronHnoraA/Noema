// Noema research history index is Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package research

import (
	"bufio"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const maxHistoryRecordBytes = 4 << 20

var historySchema = []string{
	`CREATE TABLE IF NOT EXISTS history_sources (
		id            TEXT PRIMARY KEY,
		kind          TEXT NOT NULL,
		root_path     TEXT NOT NULL,
		project_root  TEXT NOT NULL DEFAULT '',
		indexed_at    INTEGER NOT NULL,
		file_count    INTEGER NOT NULL,
		record_count  INTEGER NOT NULL,
		unknown_count INTEGER NOT NULL,
		errors_json   TEXT NOT NULL DEFAULT '[]'
	)`,
	`CREATE TABLE IF NOT EXISTS history_records (
		id                TEXT PRIMARY KEY CHECK (id LIKE 'hist_%'),
		source_id         TEXT NOT NULL REFERENCES history_sources(id) ON DELETE CASCADE,
		source_kind       TEXT NOT NULL,
		project_root      TEXT NOT NULL DEFAULT '',
		session_id        TEXT NOT NULL DEFAULT '',
		native_session_id TEXT NOT NULL DEFAULT '',
		role              TEXT NOT NULL DEFAULT '',
		timestamp_ms      INTEGER NOT NULL,
		source_path       TEXT NOT NULL,
		ordinal           INTEGER NOT NULL,
		content           TEXT NOT NULL,
		content_sha256    TEXT NOT NULL,
		locator_json      TEXT NOT NULL DEFAULT '{}'
	)`,
	`CREATE INDEX IF NOT EXISTS idx_history_records_project ON history_records(project_root, timestamp_ms DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_history_records_source ON history_records(source_kind, timestamp_ms DESC)`,
	`CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
		id UNINDEXED, content, tokenize = 'unicode61 remove_diacritics 2'
	)`,
	`CREATE VIRTUAL TABLE IF NOT EXISTS artifact_blocks_fts USING fts5(
		block_id UNINDEXED,
		workstream_id UNINDEXED,
		source_id UNINDEXED,
		artifact_id UNINDEXED,
		source_uri UNINDEXED,
		byte_start UNINDEXED,
		byte_end UNINDEXED,
		content,
		tokenize = 'unicode61 remove_diacritics 2'
	)`,
	`CREATE TABLE IF NOT EXISTS artifact_fts_sources (
		source_id    TEXT PRIMARY KEY,
		workstream_id TEXT NOT NULL,
		first_rowid  INTEGER NOT NULL CHECK (first_rowid > 0),
		last_rowid   INTEGER NOT NULL CHECK (last_rowid >= first_rowid)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_artifact_fts_sources_workstream
		ON artifact_fts_sources(workstream_id, source_id)`,
	// Older search.sqlite files only contain the FTS projection.  Backfill the
	// row ranges once so future targeted updates can delete by the FTS rowid
	// index instead of scanning every UNINDEXED source_id value.
	`INSERT INTO artifact_fts_sources(source_id, workstream_id, first_rowid, last_rowid)
		SELECT source_id, workstream_id, MIN(rowid), MAX(rowid)
		FROM artifact_blocks_fts
		WHERE NOT EXISTS (SELECT 1 FROM artifact_fts_sources LIMIT 1)
		GROUP BY source_id, workstream_id`,
	`CREATE TABLE IF NOT EXISTS artifact_fts_generations (
		workstream_id TEXT PRIMARY KEY,
		generation    INTEGER NOT NULL CHECK (generation >= 0)
	)`,
}

// HistorySource selects one read-only native history tree. ProjectRoot is a
// fallback for records whose native format does not carry its own cwd/scope.
type HistorySource struct {
	Kind        string `json:"kind"`
	Path        string `json:"path"`
	ProjectRoot string `json:"projectRoot"`
}

// HistorySourceResult reports a rebuild without treating unknown native
// record types as failures.
type HistorySourceResult struct {
	Kind           string   `json:"kind"`
	Path           string   `json:"path"`
	Files          int      `json:"files"`
	Records        int      `json:"records"`
	UnknownRecords int      `json:"unknownRecords"`
	Errors         []string `json:"errors"`
}

// HistoryIndexResult is the complete result of one explicit rebuild.
type HistoryIndexResult struct {
	IndexedAt string                `json:"indexedAt"`
	Sources   []HistorySourceResult `json:"sources"`
	Records   int                   `json:"records"`
}

// HistorySearchOptions applies deterministic metadata filters before FTS.
type HistorySearchOptions struct {
	Query       string
	ProjectRoot string
	Source      string
	Limit       int
}

// HistoryRecord is a precisely addressable native history fragment.
type HistoryRecord struct {
	ID              string         `json:"id"`
	Source          string         `json:"source"`
	ProjectRoot     string         `json:"projectRoot,omitempty"`
	SessionID       string         `json:"sessionId,omitempty"`
	NativeSessionID string         `json:"nativeSessionId,omitempty"`
	Role            string         `json:"role,omitempty"`
	Timestamp       string         `json:"timestamp"`
	SourcePath      string         `json:"sourcePath"`
	Ordinal         int            `json:"ordinal"`
	Excerpt         string         `json:"excerpt,omitempty"`
	Content         string         `json:"content,omitempty"`
	Locator         map[string]any `json:"locator"`
}

type indexedHistoryRecord struct {
	HistoryRecord
	timestampMs int64
}

// IndexHistory rebuilds only the explicitly supplied read-only sources.
func (s *Store) IndexHistory(sources []HistorySource) (HistoryIndexResult, error) {
	if len(sources) == 0 {
		return HistoryIndexResult{}, errors.New("at least one history source is required")
	}
	s.historyMu.Lock()
	defer s.historyMu.Unlock()
	db, err := s.openHistoryDB()
	if err != nil {
		return HistoryIndexResult{}, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	result := HistoryIndexResult{IndexedAt: formatMillis(now.UnixMilli()), Sources: []HistorySourceResult{}}
	for _, source := range sources {
		normalized, err := normalizeHistorySource(source)
		if err != nil {
			return HistoryIndexResult{}, err
		}
		records, sourceResult, err := readHistorySource(normalized)
		if err != nil {
			return HistoryIndexResult{}, err
		}
		tx, err := db.Begin()
		if err != nil {
			return HistoryIndexResult{}, err
		}
		sourceID := historySourceID(normalized)
		if _, err := tx.Exec(`DELETE FROM history_fts WHERE id IN (SELECT id FROM history_records WHERE source_id = ?)`, sourceID); err != nil {
			_ = tx.Rollback()
			return HistoryIndexResult{}, err
		}
		if _, err := tx.Exec(`DELETE FROM history_records WHERE source_id = ?`, sourceID); err != nil {
			_ = tx.Rollback()
			return HistoryIndexResult{}, err
		}
		errorsJSON, _ := json.Marshal(sourceResult.Errors)
		if _, err := tx.Exec(`INSERT INTO history_sources(id, kind, root_path, project_root, indexed_at, file_count, record_count, unknown_count, errors_json)
			VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET indexed_at=excluded.indexed_at, file_count=excluded.file_count,
				record_count=excluded.record_count, unknown_count=excluded.unknown_count, errors_json=excluded.errors_json`,
			sourceID, normalized.Kind, normalized.Path, normalized.ProjectRoot, now.UnixMilli(), sourceResult.Files,
			sourceResult.Records, sourceResult.UnknownRecords, string(errorsJSON)); err != nil {
			_ = tx.Rollback()
			return HistoryIndexResult{}, err
		}
		for _, record := range records {
			locatorJSON, _ := json.Marshal(record.Locator)
			if _, err := tx.Exec(`INSERT INTO history_records(id, source_id, source_kind, project_root, session_id,
				native_session_id, role, timestamp_ms, source_path, ordinal, content, content_sha256, locator_json)
				VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, record.ID, sourceID, record.Source,
				record.ProjectRoot, record.SessionID, record.NativeSessionID, record.Role, record.timestampMs,
				record.SourcePath, record.Ordinal, record.Content, sha256String(record.Content), string(locatorJSON)); err != nil {
				_ = tx.Rollback()
				return HistoryIndexResult{}, err
			}
			if _, err := tx.Exec(`INSERT INTO history_fts(id, content) VALUES(?, ?)`, record.ID, record.Content); err != nil {
				_ = tx.Rollback()
				return HistoryIndexResult{}, err
			}
		}
		if err := tx.Commit(); err != nil {
			return HistoryIndexResult{}, err
		}
		result.Records += len(records)
		result.Sources = append(result.Sources, sourceResult)
	}
	return result, nil
}

// SearchHistory applies project/source filters and then uses FTS5. Each hit is
// a single native message, so its id can be handed directly to Peek/Read.
func (s *Store) SearchHistory(options HistorySearchOptions) ([]HistoryRecord, error) {
	query := strings.TrimSpace(options.Query)
	if query == "" {
		return nil, errors.New("history search query is required")
	}
	limit := options.Limit
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	projectRoot := normalizeOptionalPath(options.ProjectRoot)
	s.historyMu.Lock()
	defer s.historyMu.Unlock()
	db, err := s.openHistoryDB()
	if err != nil {
		return nil, err
	}
	sqlQuery := `SELECT r.id, r.source_kind, r.project_root, r.session_id, r.native_session_id, r.role,
		r.timestamp_ms, r.source_path, r.ordinal, snippet(history_fts, 1, '<mark>', '</mark>', '…', 24), r.locator_json
		FROM history_fts JOIN history_records r ON r.id = history_fts.id
		WHERE history_fts MATCH ?`
	args := []any{historyFTSQuery(query)}
	if projectRoot != "" {
		sqlQuery += ` AND r.project_root = ?`
		args = append(args, projectRoot)
	}
	if source := strings.TrimSpace(options.Source); source != "" {
		sqlQuery += ` AND r.source_kind = ?`
		args = append(args, source)
	}
	sqlQuery += ` ORDER BY bm25(history_fts), r.timestamp_ms DESC, r.id LIMIT ?`
	args = append(args, limit)
	rows, err := db.Query(sqlQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("search history: %w", err)
	}
	defer rows.Close()
	result := []HistoryRecord{}
	for rows.Next() {
		var record HistoryRecord
		var timestampMs int64
		var locatorJSON string
		if err := rows.Scan(&record.ID, &record.Source, &record.ProjectRoot, &record.SessionID,
			&record.NativeSessionID, &record.Role, &timestampMs, &record.SourcePath, &record.Ordinal,
			&record.Excerpt, &locatorJSON); err != nil {
			return nil, err
		}
		record.Timestamp = formatMillis(timestampMs)
		decodeLocator(locatorJSON, &record)
		result = append(result, record)
	}
	return result, rows.Err()
}

// PeekHistory returns a bounded exact fragment for one search hit.
func (s *Store) PeekHistory(id string, maxRunes int) (HistoryRecord, error) {
	if maxRunes <= 0 || maxRunes > 8000 {
		maxRunes = 1200
	}
	record, err := s.readHistoryRecord(id)
	if err != nil {
		return HistoryRecord{}, err
	}
	runes := []rune(record.Content)
	if len(runes) > maxRunes {
		record.Content = string(runes[:maxRunes]) + "…"
	}
	return record, nil
}

// ReadHistory returns the complete exact native fragment for one search hit.
func (s *Store) ReadHistory(id string) (HistoryRecord, error) {
	return s.readHistoryRecord(id)
}

func (s *Store) readHistoryRecord(id string) (HistoryRecord, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return HistoryRecord{}, errors.New("history record id is required")
	}
	s.historyMu.Lock()
	defer s.historyMu.Unlock()
	db, err := s.openHistoryDB()
	if err != nil {
		return HistoryRecord{}, err
	}
	var record HistoryRecord
	var timestampMs int64
	var locatorJSON string
	err = db.QueryRow(`SELECT id, source_kind, project_root, session_id, native_session_id, role,
		timestamp_ms, source_path, ordinal, content, locator_json FROM history_records WHERE id = ?`, id).
		Scan(&record.ID, &record.Source, &record.ProjectRoot, &record.SessionID, &record.NativeSessionID,
			&record.Role, &timestampMs, &record.SourcePath, &record.Ordinal, &record.Content, &locatorJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return HistoryRecord{}, fmt.Errorf("history record %q not found", id)
	}
	if err != nil {
		return HistoryRecord{}, err
	}
	record.Timestamp = formatMillis(timestampMs)
	decodeLocator(locatorJSON, &record)
	return record, nil
}

func (s *Store) openHistoryDB() (*sql.DB, error) {
	if s.historyDB != nil {
		return s.historyDB, nil
	}
	path := filepath.Join(s.root, StateDirName, "search.sqlite")
	dsn := path + "?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on&_synchronous=NORMAL&_txlock=immediate"
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open research history index: %w", err)
	}
	db.SetMaxOpenConns(2)
	for _, statement := range historySchema {
		if _, err := db.Exec(statement); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("migrate research history index (the kernel must be built with FTS5): %w", err)
		}
	}
	s.historyDB = db
	return db, nil
}

func normalizeHistorySource(source HistorySource) (HistorySource, error) {
	source.Kind = strings.ToLower(strings.TrimSpace(source.Kind))
	switch source.Kind {
	case "magent", "codex", "claude", "agent-shell", "noema-transcript":
	default:
		return HistorySource{}, fmt.Errorf("unsupported history source kind %q", source.Kind)
	}
	if strings.TrimSpace(source.Path) == "" || !filepath.IsAbs(source.Path) {
		return HistorySource{}, errors.New("history source path must be absolute")
	}
	path, err := filepath.Abs(filepath.Clean(source.Path))
	if err != nil {
		return HistorySource{}, err
	}
	if _, err := os.Stat(path); err != nil {
		return HistorySource{}, fmt.Errorf("history source path: %w", err)
	}
	source.Path = path
	source.ProjectRoot = normalizeOptionalPath(source.ProjectRoot)
	return source, nil
}

func readHistorySource(source HistorySource) ([]indexedHistoryRecord, HistorySourceResult, error) {
	result := HistorySourceResult{Kind: source.Kind, Path: source.Path, Errors: []string{}}
	files, err := historyFiles(source)
	if err != nil {
		return nil, result, err
	}
	result.Files = len(files)
	records := []indexedHistoryRecord{}
	for _, path := range files {
		var parsed []indexedHistoryRecord
		var unknown int
		var diagnostics []string
		switch source.Kind {
		case "magent", "agent-shell":
			if source.Kind == "agent-shell" && strings.EqualFold(filepath.Ext(path), ".md") {
				parsed, unknown, diagnostics = parseAgentShellTranscript(path, source)
			} else {
				parsed, unknown, diagnostics = parseJSONHistory(path, source)
			}
		case "codex":
			parsed, unknown, diagnostics = parseCodexHistory(path, source)
		case "claude":
			parsed, unknown, diagnostics = parseClaudeHistory(path, source)
		case "noema-transcript":
			parsed, unknown, diagnostics = parseGenericJSONLHistory(path, source)
		}
		records = append(records, parsed...)
		result.UnknownRecords += unknown
		for _, diagnostic := range diagnostics {
			result.Errors = append(result.Errors, filepath.Base(path)+": "+diagnostic)
		}
	}
	result.Records = len(records)
	return records, result, nil
}

func historyFiles(source HistorySource) ([]string, error) {
	info, err := os.Stat(source.Path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return []string{source.Path}, nil
	}
	files := []string{}
	err = filepath.WalkDir(source.Path, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		if (source.Kind == "magent" || source.Kind == "agent-shell") && ext == ".json" {
			files = append(files, path)
		} else if source.Kind == "agent-shell" && ext == ".md" {
			files = append(files, path)
		} else if source.Kind != "magent" && source.Kind != "agent-shell" && ext == ".jsonl" {
			files = append(files, path)
		}
		return nil
	})
	sort.Strings(files)
	return files, err
}

var agentShellSection = regexp.MustCompile(`^## (User|Agent) \(([^)]+)\)$`)

func parseAgentShellTranscript(path string, source HistorySource) ([]indexedHistoryRecord, int, []string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, []string{err.Error()}
	}
	info, _ := os.Stat(path)
	fallback := time.Now().UTC()
	if info != nil {
		fallback = info.ModTime().UTC()
	}
	lines := strings.Split(string(data), "\n")
	project, nativeID := source.ProjectRoot, ""
	for _, line := range lines {
		if strings.HasPrefix(line, "**Working Directory:** ") {
			project = strings.TrimSpace(strings.TrimPrefix(line, "**Working Directory:** "))
		}
		if strings.HasPrefix(line, "**Session ID:** ") {
			nativeID = strings.TrimSpace(strings.TrimPrefix(line, "**Session ID:** "))
		}
	}
	project = normalizeOptionalPath(project)
	records := []indexedHistoryRecord{}
	role, timestamp := "", fallback
	sectionStart := 0
	content := []string{}
	flush := func() {
		if role == "" {
			content = nil
			return
		}
		for len(content) > 0 && strings.TrimSpace(content[0]) == "" {
			content = content[1:]
		}
		for len(content) > 0 && strings.TrimSpace(content[len(content)-1]) == "" {
			content = content[:len(content)-1]
		}
		if role == "user" {
			for index, line := range content {
				content[index] = strings.TrimPrefix(line, "> ")
			}
		}
		text := strings.TrimSpace(strings.Join(content, "\n"))
		if text != "" {
			records = append(records, makeHistoryRecord(source.Kind, project, "", nativeID, role,
				path, sectionStart, timestamp, text))
		}
		content = nil
	}
	unknown := 0
	for lineNumber, line := range lines {
		if strings.HasPrefix(line, "## ") {
			flush()
			role = ""
			match := agentShellSection.FindStringSubmatch(line)
			if len(match) == 3 {
				if match[1] == "User" {
					role = "user"
				} else {
					role = "assistant"
				}
				sectionStart = lineNumber
				if parsed, err := time.ParseInLocation("2006-01-02 15:04:05", match[2], time.Local); err == nil {
					timestamp = parsed.UTC().Truncate(time.Millisecond)
				} else {
					timestamp = fallback
					unknown++
				}
			} else {
				unknown++
			}
			continue
		}
		if role != "" {
			content = append(content, line)
		}
	}
	flush()
	return records, unknown, nil
}

func parseJSONHistory(path string, source HistorySource) ([]indexedHistoryRecord, int, []string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, []string{err.Error()}
	}
	var root map[string]any
	if err := json.Unmarshal(data, &root); err != nil {
		return nil, 0, []string{err.Error()}
	}
	project := stringValue(root["project-root"])
	if project == "" {
		project = stringValue(root["projectRoot"])
	}
	if project == "" {
		project = source.ProjectRoot
	}
	project = normalizeOptionalPath(project)
	sessionID := stringValue(root["id"])
	nativeID := stringValue(root["native-session-id"])
	if nativeID == "" {
		nativeID = stringValue(root["nativeSessionId"])
	}
	values, _ := root["messages"].([]any)
	if len(values) == 0 {
		values, _ = root["history"].([]any)
	}
	info, _ := os.Stat(path)
	fallbackTime := time.Now().UTC()
	if info != nil {
		fallbackTime = info.ModTime().UTC()
	}
	records := []indexedHistoryRecord{}
	unknown := 0
	for ordinal, value := range values {
		message, ok := value.(map[string]any)
		if !ok {
			unknown++
			continue
		}
		role := stringValue(message["role"])
		content := extractText(message["content"])
		if strings.TrimSpace(content) == "" {
			unknown++
			continue
		}
		timestamp := parseHistoryTime(message["timestamp"], fallbackTime)
		records = append(records, makeHistoryRecord(source.Kind, project, sessionID, nativeID, role, path, ordinal, timestamp, content))
	}
	if len(values) == 0 {
		unknown++
	}
	return records, unknown, nil
}

func parseCodexHistory(path string, source HistorySource) ([]indexedHistoryRecord, int, []string) {
	return parseJSONLLines(path, func(lines []map[string]any, fallback time.Time) ([]indexedHistoryRecord, int) {
		project, nativeID := source.ProjectRoot, ""
		for _, line := range lines {
			if stringValue(line["type"]) != "session_meta" {
				continue
			}
			payload, _ := line["payload"].(map[string]any)
			project = firstNonEmpty(stringValue(payload["cwd"]), project)
			nativeID = stringValue(payload["id"])
			break
		}
		project = normalizeOptionalPath(project)
		records, unknown := []indexedHistoryRecord{}, 0
		seen := map[string]bool{}
		for ordinal, line := range lines {
			if stringValue(line["type"]) != "response_item" {
				unknown++
				continue
			}
			payload, _ := line["payload"].(map[string]any)
			role := stringValue(payload["role"])
			if role == "" || (stringValue(payload["type"]) != "message" && payload["content"] == nil) {
				unknown++
				continue
			}
			content := extractText(payload["content"])
			key := role + "\x00" + content
			if strings.TrimSpace(content) == "" || seen[key] {
				unknown++
				continue
			}
			seen[key] = true
			timestamp := parseHistoryTime(line["timestamp"], fallback)
			records = append(records, makeHistoryRecord(source.Kind, project, "", nativeID, role, path, ordinal, timestamp, content))
		}
		return records, unknown
	})
}

func parseClaudeHistory(path string, source HistorySource) ([]indexedHistoryRecord, int, []string) {
	return parseJSONLLines(path, func(lines []map[string]any, fallback time.Time) ([]indexedHistoryRecord, int) {
		records, unknown := []indexedHistoryRecord{}, 0
		seen := map[string]bool{}
		for ordinal, line := range lines {
			typ := stringValue(line["type"])
			if typ != "user" && typ != "assistant" {
				unknown++
				continue
			}
			message, _ := line["message"].(map[string]any)
			role := firstNonEmpty(stringValue(message["role"]), typ)
			content := extractText(message["content"])
			key := stringValue(line["uuid"])
			if key == "" {
				key = role + "\x00" + content
			}
			if strings.TrimSpace(content) == "" || seen[key] {
				unknown++
				continue
			}
			seen[key] = true
			project := normalizeOptionalPath(firstNonEmpty(stringValue(line["cwd"]), source.ProjectRoot))
			nativeID := stringValue(line["sessionId"])
			timestamp := parseHistoryTime(line["timestamp"], fallback)
			records = append(records, makeHistoryRecord(source.Kind, project, "", nativeID, role, path, ordinal, timestamp, content))
		}
		return records, unknown
	})
}

func parseGenericJSONLHistory(path string, source HistorySource) ([]indexedHistoryRecord, int, []string) {
	return parseJSONLLines(path, func(lines []map[string]any, fallback time.Time) ([]indexedHistoryRecord, int) {
		records, unknown := []indexedHistoryRecord{}, 0
		for ordinal, line := range lines {
			role := stringValue(line["role"])
			content := extractText(line["content"])
			if strings.TrimSpace(content) == "" {
				unknown++
				continue
			}
			project := normalizeOptionalPath(firstNonEmpty(stringValue(line["projectRoot"]), source.ProjectRoot))
			records = append(records, makeHistoryRecord(source.Kind, project, stringValue(line["sessionId"]),
				stringValue(line["nativeSessionId"]), role, path, ordinal, parseHistoryTime(line["timestamp"], fallback), content))
		}
		return records, unknown
	})
}

func parseJSONLLines(path string, project func([]map[string]any, time.Time) ([]indexedHistoryRecord, int)) ([]indexedHistoryRecord, int, []string) {
	file, err := os.Open(path)
	if err != nil {
		return nil, 0, []string{err.Error()}
	}
	defer file.Close()
	info, _ := file.Stat()
	fallback := time.Now().UTC()
	if info != nil {
		fallback = info.ModTime().UTC()
	}
	lines := []map[string]any{}
	unknown := 0
	diagnostics := []string{}
	reader := bufio.NewReaderSize(file, 64*1024)
	lineNumber := 0
	for {
		data, readErr := reader.ReadBytes('\n')
		if len(data) > 0 {
			lineNumber++
			if len(data) > maxHistoryRecordBytes {
				unknown++
				diagnostics = append(diagnostics, fmt.Sprintf("line %d exceeds %d bytes", lineNumber, maxHistoryRecordBytes))
			} else {
				var value map[string]any
				if err := json.Unmarshal(data, &value); err != nil {
					unknown++
					diagnostics = append(diagnostics, fmt.Sprintf("line %d is not valid JSON", lineNumber))
				} else {
					lines = append(lines, value)
				}
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			diagnostics = append(diagnostics, readErr.Error())
			break
		}
	}
	records, projectedUnknown := project(lines, fallback)
	return records, unknown + projectedUnknown, diagnostics
}

func makeHistoryRecord(source, project, sessionID, nativeID, role, path string, ordinal int, timestamp time.Time, content string) indexedHistoryRecord {
	content = strings.TrimSpace(content)
	seed := strings.Join([]string{source, path, fmt.Sprint(ordinal), role, content}, "\x00")
	id := "hist_" + sha256String(seed)[:32]
	return indexedHistoryRecord{HistoryRecord: HistoryRecord{
		ID: id, Source: source, ProjectRoot: project, SessionID: sessionID, NativeSessionID: nativeID,
		Role: role, Timestamp: formatMillis(timestamp.UnixMilli()), SourcePath: path, Ordinal: ordinal,
		Content: content, Locator: map[string]any{"path": path, "record": ordinal},
	}, timestampMs: timestamp.UnixMilli()}
}

func extractText(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		parts := []string{}
		for _, item := range typed {
			if text := strings.TrimSpace(extractText(item)); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	case map[string]any:
		for _, key := range []string{"text", "result", "content"} {
			if text := strings.TrimSpace(extractText(typed[key])); text != "" {
				return text
			}
		}
	}
	return ""
}

func parseHistoryTime(value any, fallback time.Time) time.Time {
	text := stringValue(value)
	if parsed, err := time.Parse(time.RFC3339Nano, text); err == nil {
		return parsed.UTC().Truncate(time.Millisecond)
	}
	return fallback.UTC().Truncate(time.Millisecond)
}

func historyFTSQuery(value string) string {
	parts := strings.Fields(value)
	quoted := make([]string, 0, len(parts))
	for _, part := range parts {
		quoted = append(quoted, `"`+strings.ReplaceAll(part, `"`, `""`)+`"`)
	}
	return strings.Join(quoted, " AND ")
}

func historySourceID(source HistorySource) string {
	return "source_" + sha256String(source.Kind + "\x00" + source.Path)[:32]
}

func sha256String(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func stringValue(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func normalizeOptionalPath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || !filepath.IsAbs(value) {
		return value
	}
	clean := filepath.Clean(value)
	if resolved, err := filepath.EvalSymlinks(clean); err == nil {
		return resolved
	}
	return clean
}

func decodeLocator(raw string, record *HistoryRecord) {
	record.Locator = map[string]any{}
	_ = json.Unmarshal([]byte(raw), &record.Locator)
}
