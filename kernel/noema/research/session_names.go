// Noema research session names are Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package research

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// D-031: a SessionName is the human handle for a logical agent conversation
// inside one repository.  It is not a physical Session: when a native session
// is lost and a fresh one replaces it, the name is rebound and its generation
// increments.  The store is already repository-scoped (`.agent/state.sqlite'),
// so names are unique per project root.

var sessionNamePattern = regexp.MustCompile(`^[\p{L}\p{N}][\p{L}\p{N}._/@-]*$`)

// ReservedSessionNames are directive keywords and can never be names.
var ReservedSessionNames = map[string]bool{"fresh": true, "continue": true, "fork": true}

// SessionKeywordLookalikes are words written for a keyword.  They are refused
// as names so a mistyped keyword fails loudly instead of silently creating a
// named session.  The table is shared with Node and Emacs.
var SessionKeywordLookalikes = map[string]string{
	"refresh": "fresh", "renew": "fresh", "new": "fresh", "reset": "fresh", "restart": "fresh",
	"resume": "continue", "cont": "continue", "continued": "continue", "same": "continue",
	"forked": "fork",
}

// SessionKeywordSuggestion returns the keyword NAME was probably meant to be,
// or "" when NAME is an ordinary session name.
func SessionKeywordSuggestion(name string) string {
	word := strings.ToLower(strings.TrimSpace(name))
	if ReservedSessionNames[word] {
		return word
	}
	return SessionKeywordLookalikes[word]
}

// PiSessionName is the per-project coordinator conversation (D-032).
const PiSessionName = "pi"

var sessionNameOrigins = map[string]int{"derived": 1, "pi": 2, "user": 3, "system": 4}

// SessionNameIntent is what Node's deterministic router decided a Run uses.
type SessionNameIntent struct {
	Name       string `json:"name"`
	Agent      string `json:"agent"`
	ParentName string `json:"parentName,omitempty"`
	ForkMode   string `json:"forkMode,omitempty"`
	Origin     string `json:"origin"`
}

// SessionName is the projection shown in Emacs and to the Pi coordinator.
type SessionName struct {
	Name            string         `json:"name"`
	Agent           string         `json:"agent"`
	SessionID       string         `json:"sessionId,omitempty"`
	NativeSessionID string         `json:"nativeSessionId,omitempty"`
	SessionState    string         `json:"sessionState,omitempty"`
	ExecutionTarget string         `json:"executionTarget,omitempty"`
	Capabilities    map[string]any `json:"capabilities,omitempty"`
	ParentName      string         `json:"parentName,omitempty"`
	ForkMode        string         `json:"forkMode,omitempty"`
	Origin          string         `json:"origin"`
	State           string         `json:"state"`
	Generation      int64          `json:"generation"`
	Aliases         []string       `json:"aliases"`
	LastRun         *Run           `json:"lastRun,omitempty"`
	OpenRun         bool           `json:"openRun"`
	// Usage is the latest token and context-window report of the bound
	// Session, so a person can see which conversation is near its limit.
	Usage *SessionUsage `json:"usage,omitempty"`
	CreatedAt       string         `json:"createdAt"`
	UpdatedAt       string         `json:"updatedAt"`
	Version         int64          `json:"version"`
}

type RenameSessionNameInput struct {
	Name    string `json:"name"`
	NewName string `json:"newName"`
	Actor   string `json:"actor"`
}

type ArchiveSessionNameInput struct {
	Name     string `json:"name"`
	Archived bool   `json:"archived"`
	Actor    string `json:"actor"`
}

// ValidateSessionName enforces the D-031 grammar shared with Node and Emacs.
func ValidateSessionName(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return errors.New("session name is required")
	}
	if len([]rune(name)) > 80 {
		return fmt.Errorf("session name %q is longer than 80 characters", name)
	}
	if ReservedSessionNames[name] {
		return fmt.Errorf("%q is a reserved @@session keyword, not a name", name)
	}
	if meant := SessionKeywordSuggestion(name); meant != "" {
		return fmt.Errorf("%q is not an @@session keyword; did you mean @@session(%s)?", name, meant)
	}
	if !sessionNamePattern.MatchString(name) {
		return fmt.Errorf("invalid session name %q", name)
	}
	return nil
}

func normalizeIntent(intent SessionNameIntent) (SessionNameIntent, error) {
	intent.Name = strings.TrimSpace(intent.Name)
	intent.Agent = strings.ToLower(strings.TrimSpace(intent.Agent))
	intent.ParentName = strings.TrimSpace(intent.ParentName)
	intent.ForkMode = strings.TrimSpace(intent.ForkMode)
	intent.Origin = strings.TrimSpace(intent.Origin)
	if err := ValidateSessionName(intent.Name); err != nil {
		return intent, err
	}
	if intent.Agent == "" {
		return intent, errors.New("session name needs an agent")
	}
	if _, ok := sessionNameOrigins[intent.Origin]; !ok {
		return intent, fmt.Errorf("unsupported session name origin %q", intent.Origin)
	}
	if intent.Name == PiSessionName && intent.Origin != "system" {
		return intent, errors.New("the pi session name is reserved for the project coordinator")
	}
	return intent, nil
}

// protectedFrom reports whether actor may not change a name of origin.  Pi
// carries the user's instructions but never outranks what the user pinned.
func protectedFrom(origin, actor string) bool {
	if origin == "system" {
		return true
	}
	return actor == "pi" && origin == "user"
}

func resolveNameTx(q interface {
	QueryRow(string, ...any) *sql.Row
}, name string) (string, error) {
	name = strings.TrimSpace(name)
	var canonical string
	err := q.QueryRow(`SELECT name FROM session_names WHERE name = ?
		UNION ALL SELECT name FROM session_name_aliases WHERE alias = ? LIMIT 1`, name, name).Scan(&canonical)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return canonical, err
}

type sessionNameRow struct {
	name, sessionID, agent, parent, forkMode, origin, state string
	generation, createdAt, updatedAt, version            int64
}

func loadNameRowTx(q interface {
	QueryRow(string, ...any) *sql.Row
}, name string) (sessionNameRow, bool, error) {
	var row sessionNameRow
	err := q.QueryRow(`SELECT name, COALESCE(session_id, ''), agent, parent_name, fork_mode, origin, state,
		generation, created_at, updated_at, version FROM session_names WHERE name = ?`, name).
		Scan(&row.name, &row.sessionID, &row.agent, &row.parent, &row.forkMode, &row.origin, &row.state,
			&row.generation, &row.createdAt, &row.updatedAt, &row.version)
	if errors.Is(err, sql.ErrNoRows) {
		return row, false, nil
	}
	return row, err == nil, err
}

// checkIntentTx rejects an intent whose name already belongs to another agent.
func checkIntentTx(tx *sql.Tx, intent SessionNameIntent) (SessionNameIntent, error) {
	intent, err := normalizeIntent(intent)
	if err != nil {
		return intent, err
	}
	canonical, err := resolveNameTx(tx, intent.Name)
	if err != nil {
		return intent, err
	}
	if canonical == "" {
		return intent, nil
	}
	intent.Name = canonical
	row, _, err := loadNameRowTx(tx, canonical)
	if err != nil {
		return intent, err
	}
	if row.agent != intent.Agent {
		return intent, fmt.Errorf("session name %q belongs to agent %s, not %s; use @@session(%s:new-name) to hand it over",
			canonical, row.agent, intent.Agent, canonical)
	}
	if row.state == "archived" {
		return intent, fmt.Errorf("session name %q is archived; unarchive it first", canonical)
	}
	return intent, nil
}

// bindSessionNameTx points intent's name at sessionID, creating it when new.
func bindSessionNameTx(tx *sql.Tx, intent SessionNameIntent, sessionID, workstreamID string, nowMs int64) error {
	intent, err := checkIntentTx(tx, intent)
	if err != nil {
		return err
	}
	row, found, err := loadNameRowTx(tx, intent.Name)
	if err != nil {
		return err
	}
	if !found {
		if _, err := tx.Exec(`INSERT INTO session_names(name, session_id, agent, parent_name, fork_mode, origin, generation, created_at, updated_at)
			VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?)`, intent.Name, nullable(sessionID), intent.Agent, intent.ParentName,
			intent.ForkMode, intent.Origin, nowMs, nowMs); err != nil {
			return err
		}
	} else {
		origin := row.origin
		if sessionNameOrigins[intent.Origin] > sessionNameOrigins[origin] {
			origin = intent.Origin
		}
		generation := row.generation
		if sessionID != "" && row.sessionID != sessionID {
			generation++
		}
		boundSession := row.sessionID
		if sessionID != "" {
			boundSession = sessionID
		}
		parent, forkMode := row.parent, row.forkMode
		if parent == "" {
			parent, forkMode = intent.ParentName, intent.ForkMode
		}
		if _, err := tx.Exec(`UPDATE session_names SET session_id = ?, origin = ?, generation = ?, parent_name = ?, fork_mode = ?,
			updated_at = ?, version = version + 1 WHERE name = ?`, nullable(boundSession), origin, generation, parent, forkMode,
			nowMs, intent.Name); err != nil {
			return err
		}
		if boundSession == row.sessionID && origin == row.origin {
			return nil
		}
	}
	_, err = appendEvent(tx, Event{Type: "session.name.bound", WorkstreamID: workstreamID, SessionID: sessionID}, nowMs,
		map[string]any{"name": intent.Name, "agent": intent.Agent, "origin": intent.Origin,
			"parent_name": intent.ParentName, "fork_mode": intent.ForkMode})
	return err
}

func recordRunSessionNameTx(tx *sql.Tx, runID string, intent SessionNameIntent) error {
	_, err := tx.Exec(`INSERT INTO run_session_names(run_id, name, agent, parent_name, fork_mode, origin) VALUES(?, ?, ?, ?, ?, ?)`,
		runID, intent.Name, intent.Agent, intent.ParentName, intent.ForkMode, intent.Origin)
	return err
}

func runSessionNameTx(tx *sql.Tx, runID string) (SessionNameIntent, bool, error) {
	var intent SessionNameIntent
	err := tx.QueryRow(`SELECT name, agent, parent_name, fork_mode, origin FROM run_session_names WHERE run_id = ?`, runID).
		Scan(&intent.Name, &intent.Agent, &intent.ParentName, &intent.ForkMode, &intent.Origin)
	if errors.Is(err, sql.ErrNoRows) {
		return intent, false, nil
	}
	return intent, err == nil, err
}

// sessionHasNameTx reports whether a physical Session is reachable by a name.
// Named sessions may serve several workstreams in one repository.
func sessionHasNameTx(tx *sql.Tx, sessionID string) (bool, error) {
	var count int
	err := tx.QueryRow(`SELECT COUNT(*) FROM session_names WHERE session_id = ?`, sessionID).Scan(&count)
	return count > 0, err
}

// leaseCoversWorkstreamTx reports whether a lease on sessionID may act for a
// Run of runWorkstream.  Equal workstreams always qualify; a named session
// additionally serves the other workstreams of its repository.
func leaseCoversWorkstreamTx(tx *sql.Tx, sessionID, runWorkstream, leaseWorkstream string) bool {
	if runWorkstream == leaseWorkstream {
		return true
	}
	named, err := sessionHasNameTx(tx, sessionID)
	return err == nil && named
}

// DeclareSessionName creates an unbound name (for example a fork prepared
// from Emacs or by Pi before its first Run).  Existing names keep their
// binding; a higher-authority origin is recorded.
func (s *Store) DeclareSessionName(intent SessionNameIntent) (SessionName, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return SessionName{}, err
	}
	defer func() { _ = tx.Rollback() }()
	nowMs := time.Now().UTC().UnixMilli()
	if intent.ParentName != "" {
		parent, err := resolveNameTx(tx, intent.ParentName)
		if err != nil {
			return SessionName{}, err
		}
		if parent == "" {
			return SessionName{}, fmt.Errorf("parent session name %q does not exist", intent.ParentName)
		}
		intent.ParentName = parent
	}
	if err := bindSessionNameTx(tx, intent, "", "", nowMs); err != nil {
		return SessionName{}, err
	}
	name, err := resolveNameTx(tx, intent.Name)
	if err != nil {
		return SessionName{}, err
	}
	if err := tx.Commit(); err != nil {
		return SessionName{}, err
	}
	return s.GetSessionName(name)
}

// BindSessionName points a name at an already-promoted Session.  The Pi
// coordinator uses origin system for the reserved `pi' name; a human may
// name a live agent buffer.
func (s *Store) BindSessionName(intent SessionNameIntent, sessionID string) (SessionName, error) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return SessionName{}, errors.New("binding a session name needs a session id")
	}
	if intent.Origin == "system" && strings.TrimSpace(intent.Name) != PiSessionName {
		return SessionName{}, errors.New("only the pi coordinator name has system origin")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return SessionName{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var workstreamID, adapter string
	if err := tx.QueryRow(`SELECT workstream_id, adapter FROM sessions WHERE id = ?`, sessionID).Scan(&workstreamID, &adapter); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return SessionName{}, fmt.Errorf("session %q not found", sessionID)
		}
		return SessionName{}, err
	}
	if strings.TrimSpace(intent.Agent) == "" {
		intent.Agent = adapter
	}
	if err := bindSessionNameTx(tx, intent, sessionID, workstreamID, time.Now().UTC().UnixMilli()); err != nil {
		return SessionName{}, err
	}
	name, err := resolveNameTx(tx, intent.Name)
	if err != nil {
		return SessionName{}, err
	}
	if err := tx.Commit(); err != nil {
		return SessionName{}, err
	}
	return s.GetSessionName(name)
}

// GetSessionName resolves NAME or one of its aliases.
func (s *Store) GetSessionName(name string) (SessionName, error) {
	canonical, err := resolveNameTx(s.db, name)
	if err != nil {
		return SessionName{}, err
	}
	if canonical == "" {
		return SessionName{}, fmt.Errorf("session name %q not found", strings.TrimSpace(name))
	}
	names, err := s.listSessionNames(`WHERE n.name = ?`, canonical)
	if err != nil {
		return SessionName{}, err
	}
	if len(names) == 0 {
		return SessionName{}, fmt.Errorf("session name %q not found", canonical)
	}
	return names[0], nil
}

// ListSessionNames returns every name, most recently updated first.
func (s *Store) ListSessionNames(includeArchived bool) ([]SessionName, error) {
	if includeArchived {
		return s.listSessionNames("")
	}
	return s.listSessionNames(`WHERE n.state = 'active'`)
}

func (s *Store) listSessionNames(where string, args ...any) ([]SessionName, error) {
	rows, err := s.db.Query(`SELECT n.name, COALESCE(n.session_id, ''), n.agent, n.parent_name, n.fork_mode, n.origin, n.state,
		n.generation, n.created_at, n.updated_at, n.version,
		COALESCE(se.native_session_id, ''), COALESCE(se.state, ''), COALESCE(se.execution_target, ''), COALESCE(se.capabilities_json, '{}')
		FROM session_names n LEFT JOIN sessions se ON se.id = n.session_id `+where+` ORDER BY n.updated_at DESC, n.name`, args...)
	if err != nil {
		return nil, err
	}
	result := []SessionName{}
	for rows.Next() {
		var name SessionName
		var createdAt, updatedAt int64
		var capabilities string
		if err := rows.Scan(&name.Name, &name.SessionID, &name.Agent, &name.ParentName, &name.ForkMode, &name.Origin, &name.State,
			&name.Generation, &createdAt, &updatedAt, &name.Version,
			&name.NativeSessionID, &name.SessionState, &name.ExecutionTarget, &capabilities); err != nil {
			_ = rows.Close()
			return nil, err
		}
		name.CreatedAt, name.UpdatedAt = formatMillis(createdAt), formatMillis(updatedAt)
		name.Capabilities = map[string]any{}
		_ = json.Unmarshal([]byte(capabilities), &name.Capabilities)
		result = append(result, name)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for index := range result {
		if err := s.enrichSessionName(&result[index]); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func (s *Store) enrichSessionName(name *SessionName) error {
	name.Aliases = []string{}
	aliases, err := s.db.Query(`SELECT alias FROM session_name_aliases WHERE name = ? ORDER BY alias`, name.Name)
	if err != nil {
		return err
	}
	for aliases.Next() {
		var alias string
		if err := aliases.Scan(&alias); err != nil {
			_ = aliases.Close()
			return err
		}
		name.Aliases = append(name.Aliases, alias)
	}
	if err := aliases.Close(); err != nil {
		return err
	}
	if name.SessionID == "" {
		return nil
	}
	var usage SessionUsage
	var usageUpdatedAt int64
	err = s.db.QueryRow(`SELECT total_tokens, input_tokens, output_tokens, thought_tokens, cached_tokens,
		context_used, context_size, updated_at FROM session_usage WHERE session_id = ?`, name.SessionID).
		Scan(&usage.TotalTokens, &usage.InputTokens, &usage.OutputTokens, &usage.ThoughtTokens, &usage.CachedTokens,
			&usage.ContextUsed, &usage.ContextSize, &usageUpdatedAt)
	if err == nil {
		usage.SessionID, usage.UpdatedAt = name.SessionID, formatMillis(usageUpdatedAt)
		name.Usage = &usage
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	run, err := scanRun(s.db.QueryRow(runSelect+` WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, name.SessionID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	name.LastRun = &run
	name.OpenRun = run.Status == "preparing" || run.Status == "running" ||
		run.Status == "waiting_permission" || run.Status == "waiting_input"
	return nil
}

// RenameSessionName renames NAME and keeps the old spelling as an alias, so
// `@@session(old)' in documents that are not open keeps resolving.
func (s *Store) RenameSessionName(input RenameSessionNameInput) (SessionName, error) {
	input.NewName, input.Actor = strings.TrimSpace(input.NewName), strings.TrimSpace(input.Actor)
	if err := ValidateSessionName(input.NewName); err != nil {
		return SessionName{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return SessionName{}, err
	}
	defer func() { _ = tx.Rollback() }()
	canonical, err := resolveNameTx(tx, input.Name)
	if err != nil {
		return SessionName{}, err
	}
	if canonical == "" {
		return SessionName{}, fmt.Errorf("session name %q not found", input.Name)
	}
	row, _, err := loadNameRowTx(tx, canonical)
	if err != nil {
		return SessionName{}, err
	}
	if protectedFrom(row.origin, input.Actor) {
		return SessionName{}, fmt.Errorf("session name %q was set by %s and cannot be renamed by %s", canonical, row.origin, input.Actor)
	}
	if existing, err := resolveNameTx(tx, input.NewName); err != nil {
		return SessionName{}, err
	} else if existing != "" && existing != canonical {
		return SessionName{}, fmt.Errorf("session name %q is already in use", input.NewName)
	}
	nowMs := time.Now().UTC().UnixMilli()
	if input.NewName != canonical {
		if _, err := tx.Exec(`DELETE FROM session_name_aliases WHERE alias = ?`, input.NewName); err != nil {
			return SessionName{}, err
		}
		if _, err := tx.Exec(`UPDATE session_names SET name = ?, updated_at = ?, version = version + 1 WHERE name = ?`,
			input.NewName, nowMs, canonical); err != nil {
			return SessionName{}, err
		}
		if _, err := tx.Exec(`UPDATE session_names SET parent_name = ? WHERE parent_name = ?`, input.NewName, canonical); err != nil {
			return SessionName{}, err
		}
		if _, err := tx.Exec(`INSERT INTO session_name_aliases(alias, name) VALUES(?, ?)`, canonical, input.NewName); err != nil {
			return SessionName{}, err
		}
		if _, err := appendEvent(tx, Event{Type: "session.name.renamed", SessionID: row.sessionID}, nowMs,
			map[string]any{"name": input.NewName, "previous": canonical, "actor": input.Actor}); err != nil {
			return SessionName{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return SessionName{}, err
	}
	return s.GetSessionName(input.NewName)
}

// ArchiveSessionName hides or restores NAME without deleting its history.
func (s *Store) ArchiveSessionName(input ArchiveSessionNameInput) (SessionName, error) {
	input.Actor = strings.TrimSpace(input.Actor)
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return SessionName{}, err
	}
	defer func() { _ = tx.Rollback() }()
	canonical, err := resolveNameTx(tx, input.Name)
	if err != nil {
		return SessionName{}, err
	}
	if canonical == "" {
		return SessionName{}, fmt.Errorf("session name %q not found", input.Name)
	}
	row, _, err := loadNameRowTx(tx, canonical)
	if err != nil {
		return SessionName{}, err
	}
	if protectedFrom(row.origin, input.Actor) {
		return SessionName{}, fmt.Errorf("session name %q was set by %s and cannot be archived by %s", canonical, row.origin, input.Actor)
	}
	state := "active"
	if input.Archived {
		state = "archived"
	}
	nowMs := time.Now().UTC().UnixMilli()
	if row.state != state {
		if _, err := tx.Exec(`UPDATE session_names SET state = ?, updated_at = ?, version = version + 1 WHERE name = ?`,
			state, nowMs, canonical); err != nil {
			return SessionName{}, err
		}
		if _, err := appendEvent(tx, Event{Type: "session.name." + state, SessionID: row.sessionID}, nowMs,
			map[string]any{"name": canonical, "actor": input.Actor}); err != nil {
			return SessionName{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return SessionName{}, err
	}
	return s.GetSessionName(canonical)
}
