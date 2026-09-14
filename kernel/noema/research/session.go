// Noema research sessions are Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package research

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

var sessionStates = map[string]bool{
	"active": true, "warm": true, "archived": true, "lost": true,
}

var sessionTransports = map[string]bool{
	"acp": true, "cli": true, "pty": true,
}

// PromoteSessionInput describes a native agent session that is being attached
// to Noema. AttachedAt is deliberately assigned by the store; StartedAt is the
// native session's own creation time and may predate it.
type PromoteSessionInput struct {
	WorkstreamID    string         `json:"workstreamId"`
	Title           string         `json:"title"`
	Goal            string         `json:"goal"`
	Adapter         string         `json:"adapter"`
	Transport       string         `json:"transport"`
	NativeSessionID string         `json:"nativeSessionId"`
	ExecutionTarget string         `json:"executionTarget"`
	ParentSessionID string         `json:"parentSessionId"`
	ForkMode        string         `json:"forkMode"`
	StartedAt       string         `json:"startedAt"`
	Capabilities    map[string]any `json:"capabilities"`
}

// Session is Noema's durable logical identity for an external agent session.
type Session struct {
	ID              string         `json:"id"`
	WorkstreamID    string         `json:"workstreamId"`
	Adapter         string         `json:"adapter"`
	Transport       string         `json:"transport"`
	NativeSessionID string         `json:"nativeSessionId"`
	ExecutionTarget string         `json:"executionTarget"`
	ParentSessionID string         `json:"parentSessionId,omitempty"`
	ForkMode        string         `json:"forkMode,omitempty"`
	State           string         `json:"state"`
	Capabilities    map[string]any `json:"capabilities"`
	AttachedAt      string         `json:"attachedAt"`
	StartedAt       string         `json:"startedAt,omitempty"`
	LastSeenAt      string         `json:"lastSeenAt,omitempty"`
	Version         int64          `json:"version"`
	NewWorkstream   bool           `json:"newWorkstream,omitempty"`
	NewSession      bool           `json:"newSession,omitempty"`
}

// SessionFilter limits session listing without deriving one identity from
// another.
type SessionFilter struct {
	WorkstreamID string
	Adapter      string
	Limit        int
}

// ManualIntervention records an explicit handoff from the ACP UI to a native
// PTY. It never masquerades terminal input as worker Run events.
type ManualIntervention struct {
	ID        string   `json:"id"`
	SessionID string   `json:"sessionId"`
	Transport string   `json:"transport"`
	Command   []string `json:"command"`
	State     string   `json:"state"`
	StartedBy string   `json:"startedBy"`
	StartedAt string   `json:"startedAt"`
	EndedBy   string   `json:"endedBy,omitempty"`
	EndedAt   string   `json:"endedAt,omitempty"`
	Reason    string   `json:"reason,omitempty"`
	Version   int64    `json:"version"`
}

type BeginManualInterventionInput struct {
	SessionID       string   `json:"sessionId"`
	Command         []string `json:"command"`
	StartedBy       string   `json:"startedBy"`
	ExpectedVersion int64    `json:"expectedVersion"`
}

type EndManualInterventionInput struct {
	InterventionID  string `json:"interventionId"`
	EndedBy         string `json:"endedBy"`
	Reason          string `json:"reason"`
	ExpectedVersion int64  `json:"expectedVersion"`
}

// PromoteSession creates an idempotent Noema binding for a native session.
// The Workstream and its event, when needed, are committed atomically with the
// Session and session.promoted event.
func (s *Store) PromoteSession(input PromoteSessionInput) (Session, error) {
	input.Adapter = strings.TrimSpace(input.Adapter)
	input.Transport = strings.TrimSpace(input.Transport)
	input.NativeSessionID = strings.TrimSpace(input.NativeSessionID)
	input.ExecutionTarget = strings.TrimSpace(input.ExecutionTarget)
	input.WorkstreamID = strings.TrimSpace(input.WorkstreamID)
	input.ParentSessionID = strings.TrimSpace(input.ParentSessionID)
	input.ForkMode = strings.TrimSpace(input.ForkMode)
	if input.Adapter == "" {
		return Session{}, errors.New("session adapter is required")
	}
	if !sessionTransports[input.Transport] {
		return Session{}, fmt.Errorf("unsupported session transport %q", input.Transport)
	}
	if input.NativeSessionID == "" {
		return Session{}, errors.New("native session id is required")
	}
	if input.ExecutionTarget == "" {
		return Session{}, errors.New("session execution target is required")
	}
	startedAt, err := parseOptionalTime(input.StartedAt)
	if err != nil {
		return Session{}, fmt.Errorf("invalid native session startedAt: %w", err)
	}
	capabilities := input.Capabilities
	if capabilities == nil {
		capabilities = map[string]any{}
	}
	capabilitiesJSON, err := json.Marshal(capabilities)
	if err != nil {
		return Session{}, fmt.Errorf("encode session capabilities: %w", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Session{}, err
	}
	defer func() { _ = tx.Rollback() }()

	if existing, found, err := findSessionByNativeBinding(tx, input.Adapter, input.NativeSessionID, input.ExecutionTarget); err != nil {
		return Session{}, err
	} else if found {
		if err := tx.Commit(); err != nil {
			return Session{}, err
		}
		return existing, nil
	}

	now := time.Now().UTC().Truncate(time.Millisecond)
	nowMs := now.UnixMilli()
	newWorkstream := false
	workstreamID := input.WorkstreamID
	if workstreamID == "" {
		workstreamID, err = prefixedUUID("ws_")
		if err != nil {
			return Session{}, err
		}
		newWorkstream = true
	} else if !strings.HasPrefix(workstreamID, "ws_") {
		return Session{}, errors.New("workstream id must start with ws_")
	}
	var workstreamExists int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM workstreams WHERE id = ?`, workstreamID).Scan(&workstreamExists); err != nil {
		return Session{}, err
	}
	if workstreamExists == 0 {
		newWorkstream = true
		title := strings.TrimSpace(input.Title)
		if title == "" {
			title = strings.TrimSpace(input.Goal)
		}
		if title == "" {
			title = input.Adapter + " session"
		}
		if _, err := tx.Exec(`INSERT INTO workstreams(id, title, status, created_at, updated_at) VALUES(?, ?, 'active', ?, ?)`,
			workstreamID, title, nowMs, nowMs); err != nil {
			return Session{}, err
		}
		if _, err := appendEvent(tx, Event{Type: "workstream.created", WorkstreamID: workstreamID}, nowMs,
			map[string]any{"title": title, "source": "session.promote"}); err != nil {
			return Session{}, err
		}
	}
	if input.ParentSessionID != "" {
		var exists int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM sessions WHERE id = ?`, input.ParentSessionID).Scan(&exists); err != nil {
			return Session{}, err
		}
		if exists == 0 {
			return Session{}, fmt.Errorf("parent session %q does not exist", input.ParentSessionID)
		}
	}
	sessionID, err := prefixedUUID("ses_")
	if err != nil {
		return Session{}, err
	}
	var startedValue any
	if !startedAt.IsZero() {
		startedValue = startedAt.UnixMilli()
	}
	if _, err := tx.Exec(`INSERT INTO sessions(
		id, workstream_id, adapter, transport, native_session_id, execution_target,
		parent_session_id, fork_mode, state, capabilities_json, attached_at, started_at, last_seen_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'warm', ?, ?, ?, ?)`,
		sessionID, workstreamID, input.Adapter, input.Transport, input.NativeSessionID, input.ExecutionTarget,
		nullable(input.ParentSessionID), input.ForkMode, string(capabilitiesJSON), nowMs, startedValue, nowMs); err != nil {
		return Session{}, err
	}
	payload := map[string]any{
		"adapter": input.Adapter, "transport": input.Transport,
		"native_session_id": input.NativeSessionID, "execution_target": input.ExecutionTarget,
	}
	if !startedAt.IsZero() {
		payload["started_at"] = formatMillis(startedAt.UnixMilli())
	}
	if _, err := appendEvent(tx, Event{Type: "session.promoted", WorkstreamID: workstreamID, SessionID: sessionID}, nowMs, payload); err != nil {
		return Session{}, err
	}
	if err := tx.Commit(); err != nil {
		return Session{}, err
	}
	return Session{
		ID: sessionID, WorkstreamID: workstreamID, Adapter: input.Adapter, Transport: input.Transport,
		NativeSessionID: input.NativeSessionID, ExecutionTarget: input.ExecutionTarget,
		ParentSessionID: input.ParentSessionID, ForkMode: input.ForkMode, State: "warm",
		Capabilities: capabilities, AttachedAt: formatMillis(nowMs), StartedAt: formatOptionalTime(startedAt),
		LastSeenAt: formatMillis(nowMs), Version: 1, NewWorkstream: newWorkstream, NewSession: true,
	}, nil
}

// GetSession returns one durable Session without consulting a live process.
func (s *Store) GetSession(id string) (Session, error) {
	row := s.db.QueryRow(sessionSelect+` WHERE id = ?`, strings.TrimSpace(id))
	session, err := scanSession(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, fmt.Errorf("session %q not found", id)
	}
	return session, err
}

// ListSessions returns stable newest-first Session projections.
func (s *Store) ListSessions(filter SessionFilter) ([]Session, error) {
	limit := filter.Limit
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	query := sessionSelect + ` WHERE 1 = 1`
	args := []any{}
	if value := strings.TrimSpace(filter.WorkstreamID); value != "" {
		query += ` AND workstream_id = ?`
		args = append(args, value)
	}
	if value := strings.TrimSpace(filter.Adapter); value != "" {
		query += ` AND adapter = ?`
		args = append(args, value)
	}
	query += ` ORDER BY attached_at DESC, id LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Session{}
	for rows.Next() {
		session, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, session)
	}
	return result, rows.Err()
}

const sessionSelect = `SELECT id, workstream_id, adapter, transport, native_session_id, execution_target,
	COALESCE(parent_session_id, ''), fork_mode, state, capabilities_json, attached_at,
	COALESCE(started_at, 0), COALESCE(last_seen_at, 0), version FROM sessions`

type rowScanner interface {
	Scan(dest ...any) error
}

func scanSession(row rowScanner) (Session, error) {
	var session Session
	var capabilities string
	var attachedAt, startedAt, lastSeenAt int64
	err := row.Scan(&session.ID, &session.WorkstreamID, &session.Adapter, &session.Transport,
		&session.NativeSessionID, &session.ExecutionTarget, &session.ParentSessionID, &session.ForkMode,
		&session.State, &capabilities, &attachedAt, &startedAt, &lastSeenAt, &session.Version)
	if err != nil {
		return Session{}, err
	}
	session.AttachedAt = formatMillis(attachedAt)
	if startedAt > 0 {
		session.StartedAt = formatMillis(startedAt)
	}
	if lastSeenAt > 0 {
		session.LastSeenAt = formatMillis(lastSeenAt)
	}
	if err := json.Unmarshal([]byte(capabilities), &session.Capabilities); err != nil {
		session.Capabilities = map[string]any{}
	}
	return session, nil
}

func findSessionByNativeBinding(tx *sql.Tx, adapter, nativeID, target string) (Session, bool, error) {
	session, err := scanSession(tx.QueryRow(sessionSelect+` WHERE adapter = ? AND native_session_id = ? AND execution_target = ?`,
		adapter, nativeID, target))
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, false, nil
	}
	return session, err == nil, err
}

// BeginManualIntervention hands an idle logical Session to a native PTY. A
// document Run or live worker lease makes takeover unsafe and is rejected.
func (s *Store) BeginManualIntervention(input BeginManualInterventionInput) (ManualIntervention, error) {
	input.SessionID, input.StartedBy = strings.TrimSpace(input.SessionID), strings.TrimSpace(input.StartedBy)
	if input.SessionID == "" || input.StartedBy == "" || input.ExpectedVersion < 1 || len(input.Command) == 0 || len(input.Command) > 32 {
		return ManualIntervention{}, errors.New("manual intervention requires session, command, actor, and expected session version")
	}
	command := make([]string, len(input.Command))
	for index, part := range input.Command {
		command[index] = strings.TrimSpace(part)
		if command[index] == "" || len(command[index]) > 4096 || strings.ContainsRune(command[index], 0) {
			return ManualIntervention{}, errors.New("manual intervention command contains an invalid argument")
		}
	}
	commandJSON, err := json.Marshal(command)
	if err != nil || len(commandJSON) > 64*1024 {
		return ManualIntervention{}, errors.New("manual intervention command is not valid bounded JSON")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return ManualIntervention{}, err
	}
	defer func() { _ = tx.Rollback() }()
	session, err := scanSession(tx.QueryRow(sessionSelect+` WHERE id = ?`, input.SessionID))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ManualIntervention{}, fmt.Errorf("session %q not found", input.SessionID)
		}
		return ManualIntervention{}, err
	}
	if session.Version != input.ExpectedVersion {
		return ManualIntervention{}, fmt.Errorf("session %q version conflict", input.SessionID)
	}
	if session.State == "archived" || session.State == "lost" {
		return ManualIntervention{}, fmt.Errorf("session %q cannot be taken over from state %s", session.ID, session.State)
	}
	var openRuns int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM runs WHERE session_id = ? AND status IN ('preparing', 'running', 'waiting_permission', 'waiting_input')`, session.ID).Scan(&openRuns); err != nil {
		return ManualIntervention{}, err
	}
	if openRuns != 0 {
		return ManualIntervention{}, fmt.Errorf("session %q has an unfinished Run", session.ID)
	}
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	var leaseExpiry int64
	if err := tx.QueryRow(`SELECT expires_at FROM leases WHERE session_id = ?`, session.ID).Scan(&leaseExpiry); err == nil {
		if leaseExpiry > nowMs {
			return ManualIntervention{}, fmt.Errorf("session %q still has a live worker lease", session.ID)
		}
		if _, err := tx.Exec(`DELETE FROM leases WHERE session_id = ? AND expires_at <= ?`, session.ID, nowMs); err != nil {
			return ManualIntervention{}, err
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return ManualIntervention{}, err
	}
	var active int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM manual_interventions WHERE session_id = ? AND state = 'active'`, session.ID).Scan(&active); err != nil {
		return ManualIntervention{}, err
	}
	if active != 0 {
		return ManualIntervention{}, fmt.Errorf("session %q already has an active manual intervention", session.ID)
	}
	id, err := prefixedUUID("manual_")
	if err != nil {
		return ManualIntervention{}, err
	}
	if _, err := tx.Exec(`INSERT INTO manual_interventions(id, session_id, transport, command_json, state, started_by, started_at)
		VALUES(?, ?, 'pty', ?, 'active', ?, ?)`, id, session.ID, string(commandJSON), input.StartedBy, nowMs); err != nil {
		return ManualIntervention{}, err
	}
	updated, err := tx.Exec(`UPDATE sessions SET state = 'active', last_seen_at = ?, version = version + 1 WHERE id = ? AND version = ?`,
		nowMs, session.ID, input.ExpectedVersion)
	if err != nil {
		return ManualIntervention{}, err
	}
	if rows, err := updated.RowsAffected(); err != nil || rows != 1 {
		return ManualIntervention{}, fmt.Errorf("session %q version conflict", session.ID)
	}
	if _, err := appendEvent(tx, Event{Type: "session.manual_intervention", WorkstreamID: session.WorkstreamID, SessionID: session.ID}, nowMs,
		map[string]any{"intervention_id": id, "phase": "started", "transport": "pty", "command": command, "actor": input.StartedBy}); err != nil {
		return ManualIntervention{}, err
	}
	if err := tx.Commit(); err != nil {
		return ManualIntervention{}, err
	}
	return ManualIntervention{ID: id, SessionID: session.ID, Transport: "pty", Command: command, State: "active",
		StartedBy: input.StartedBy, StartedAt: formatMillis(nowMs), Version: 1}, nil
}

func (s *Store) EndManualIntervention(input EndManualInterventionInput) (ManualIntervention, error) {
	input.InterventionID, input.EndedBy, input.Reason = strings.TrimSpace(input.InterventionID), strings.TrimSpace(input.EndedBy), strings.TrimSpace(input.Reason)
	if input.InterventionID == "" || input.EndedBy == "" || input.ExpectedVersion < 1 {
		return ManualIntervention{}, errors.New("ending manual intervention requires id, actor, and expected version")
	}
	if len(input.Reason) > 4096 {
		return ManualIntervention{}, errors.New("manual intervention reason is too large")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return ManualIntervention{}, err
	}
	defer func() { _ = tx.Rollback() }()
	intervention, err := scanManualIntervention(tx.QueryRow(manualInterventionSelect+` WHERE id = ?`, input.InterventionID))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ManualIntervention{}, fmt.Errorf("manual intervention %q not found", input.InterventionID)
		}
		return ManualIntervention{}, err
	}
	if intervention.State != "active" {
		return ManualIntervention{}, fmt.Errorf("manual intervention %q is already %s", intervention.ID, intervention.State)
	}
	if intervention.Version != input.ExpectedVersion {
		return ManualIntervention{}, fmt.Errorf("manual intervention %q version conflict", intervention.ID)
	}
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	updated, err := tx.Exec(`UPDATE manual_interventions SET state = 'ended', ended_by = ?, ended_at = ?, reason = ?, version = version + 1
		WHERE id = ? AND state = 'active' AND version = ?`, input.EndedBy, nowMs, input.Reason, intervention.ID, input.ExpectedVersion)
	if err != nil {
		return ManualIntervention{}, err
	}
	if rows, err := updated.RowsAffected(); err != nil || rows != 1 {
		return ManualIntervention{}, fmt.Errorf("manual intervention %q version conflict", intervention.ID)
	}
	var workstreamID string
	if err := tx.QueryRow(`SELECT workstream_id FROM sessions WHERE id = ?`, intervention.SessionID).Scan(&workstreamID); err != nil {
		return ManualIntervention{}, err
	}
	if _, err := tx.Exec(`UPDATE sessions SET state = 'warm', last_seen_at = ?, version = version + 1 WHERE id = ?`, nowMs, intervention.SessionID); err != nil {
		return ManualIntervention{}, err
	}
	if _, err := appendEvent(tx, Event{Type: "session.manual_intervention", WorkstreamID: workstreamID, SessionID: intervention.SessionID}, nowMs,
		map[string]any{"intervention_id": intervention.ID, "phase": "ended", "transport": "pty", "actor": input.EndedBy, "reason": input.Reason}); err != nil {
		return ManualIntervention{}, err
	}
	if err := tx.Commit(); err != nil {
		return ManualIntervention{}, err
	}
	intervention.State, intervention.EndedBy, intervention.EndedAt = "ended", input.EndedBy, formatMillis(nowMs)
	intervention.Reason, intervention.Version = input.Reason, intervention.Version+1
	return intervention, nil
}

func (s *Store) GetManualIntervention(id string) (ManualIntervention, error) {
	intervention, err := scanManualIntervention(s.db.QueryRow(manualInterventionSelect+` WHERE id = ?`, strings.TrimSpace(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return ManualIntervention{}, fmt.Errorf("manual intervention %q not found", id)
	}
	return intervention, err
}

const manualInterventionSelect = `SELECT id, session_id, transport, command_json, state, started_by, started_at,
	ended_by, COALESCE(ended_at, 0), reason, version FROM manual_interventions`

func scanManualIntervention(row rowScanner) (ManualIntervention, error) {
	var intervention ManualIntervention
	var commandJSON string
	var startedAt, endedAt int64
	if err := row.Scan(&intervention.ID, &intervention.SessionID, &intervention.Transport, &commandJSON, &intervention.State,
		&intervention.StartedBy, &startedAt, &intervention.EndedBy, &endedAt, &intervention.Reason, &intervention.Version); err != nil {
		return ManualIntervention{}, err
	}
	if err := json.Unmarshal([]byte(commandJSON), &intervention.Command); err != nil {
		return ManualIntervention{}, fmt.Errorf("decode manual intervention command: %w", err)
	}
	intervention.StartedAt = formatMillis(startedAt)
	if endedAt > 0 {
		intervention.EndedAt = formatMillis(endedAt)
	}
	return intervention, nil
}

func appendEvent(tx *sql.Tx, event Event, nowMs int64, payload map[string]any) (Event, error) {
	id, err := prefixedUUID("evt_")
	if err != nil {
		return Event{}, err
	}
	// A Run is durably attached to both the concrete Cell that launched it and
	// the stable WorkNode whose work it advances. Keep every Run-scoped event
	// queryable by that WorkNode even when a caller only supplies run_id.
	if event.WorkNodeID == "" && event.RunID != "" {
		if err := tx.QueryRow(`SELECT COALESCE(work_node_id, '') FROM runs WHERE id = ?`, event.RunID).Scan(&event.WorkNodeID); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return Event{}, err
		}
	}
	if payload == nil {
		payload = map[string]any{}
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return Event{}, err
	}
	inserted, err := tx.Exec(`INSERT INTO events(id, type, ts, workstream_id, notebook_id, cell_id, work_node_id, run_id, session_id, causation_id, payload_json)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, event.Type, nowMs, nullable(event.WorkstreamID), nullable(event.NotebookID),
		nullable(event.CellID), nullable(event.WorkNodeID), nullable(event.RunID), nullable(event.SessionID), nullable(event.CausationID), string(payloadJSON))
	if err != nil {
		return Event{}, err
	}
	seq, err := inserted.LastInsertId()
	if err != nil {
		return Event{}, err
	}
	event.ID, event.Seq, event.TS, event.Payload = id, seq, formatMillis(nowMs), payload
	return event, nil
}

func prefixedUUID(prefix string) (string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", err
	}
	return prefix + id.String(), nil
}

func parseOptionalTime(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, err
	}
	return parsed.UTC().Truncate(time.Millisecond), nil
}

func formatOptionalTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return formatMillis(value.UnixMilli())
}
