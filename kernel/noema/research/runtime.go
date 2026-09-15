// Noema research execution runtime is Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package research

// This file deliberately contains only logical execution state.  A worker
// (Emacs) owns ACP processes and presents UI; it must
// hold a short-lived lease before it can advance a Run or broker a permission.

import (
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultLeaseTTL = 30 * time.Second
	minimumLeaseTTL = 5 * time.Second
	maximumLeaseTTL = 60 * time.Second
)

var runStatuses = map[string]bool{
	"preparing": true, "running": true, "waiting_permission": true,
	"waiting_input": true, "completed": true, "cancelled": true,
	"failed": true, "interrupted": true,
}

var terminalRunStatuses = map[string]bool{
	"completed": true, "cancelled": true, "failed": true, "interrupted": true,
}

// Artifact is immutable content addressed data used by a Run. Its bytes live
// beneath .agent/objects and its identity is recorded in state.sqlite.
type Artifact struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	SHA256    string `json:"sha256"`
	MediaType string `json:"mediaType"`
	ByteCount int64  `json:"byteCount"`
	CreatedAt string `json:"createdAt"`
}

// Run is one logical execution. It is independent of a particular worker
// process: worker ownership is represented exclusively by Lease.
type Run struct {
	ID                string `json:"id"`
	WorkstreamID      string `json:"workstreamId"`
	SessionID         string `json:"sessionId,omitempty"`
	NotebookID        string `json:"notebookId,omitempty"`
	CellID            string `json:"cellId,omitempty"`
	WorkNodeID        string `json:"workNodeId,omitempty"`
	SourceKind        string `json:"sourceKind"`
	ExecutionTarget   string `json:"executionTarget"`
	Status            string `json:"status"`
	SpecArtifactID    string `json:"specArtifactId"`
	ContextArtifactID string `json:"contextArtifactId,omitempty"`
	CreatedAt         string `json:"createdAt"`
	StartedAt         string `json:"startedAt,omitempty"`
	FinishedAt        string `json:"finishedAt,omitempty"`
	FailureReason     string `json:"failureReason,omitempty"`
	Version           int64  `json:"version"`
	// SessionName is the D-031 name this Run was routed to, if any.
	SessionName string `json:"sessionName,omitempty"`
}

// PrepareRunInput is intentionally a JSON object rather than an adapter-
// specific protocol payload. Node creates its deterministic RunSpec and the
// kernel writes its exact bytes to CAS before a worker is dispatched.
type PrepareRunInput struct {
	WorkstreamID    string             `json:"workstreamId"`
	SessionID       string             `json:"sessionId"`
	NotebookID      string             `json:"notebookId"`
	CellID          string             `json:"cellId"`
	WorkNodeID      string             `json:"workNodeId"`
	SourceKind      string             `json:"sourceKind"`
	ExecutionTarget string             `json:"executionTarget"`
	Spec            map[string]any     `json:"spec"`
	ContextManifest map[string]any     `json:"contextManifest"`
	ContextItems    []ContextItemInput `json:"contextItems"`
	// SessionName is the D-031 logical name Node's router chose.  A Run with
	// a session is bound immediately; a fresh Run binds when it attaches.
	SessionName *SessionNameIntent `json:"sessionName,omitempty"`
}

// ContextItemInput carries bytes over the trusted Node-to-kernel boundary.
// The kernel, rather than the worker, hashes and writes them to CAS.  The
// manifest stored with the Run contains only its resulting immutable refs.
type ContextItemInput struct {
	Ref           string `json:"ref"`
	ResolvedURI   string `json:"resolvedUri"`
	MediaType     string `json:"mediaType"`
	ContentBase64 string `json:"contentBase64"`
	Truncated     bool   `json:"truncated"`
}

// Lease gates all worker-originated state transitions for one logical
// Session. Epoch makes an old worker harmless after takeover.
type Lease struct {
	SessionID  string `json:"sessionId"`
	Owner      string `json:"owner"`
	Epoch      int64  `json:"epoch"`
	AcquiredAt string `json:"acquiredAt"`
	ExpiresAt  string `json:"expiresAt"`
}

type AcquireLeaseInput struct {
	SessionID string `json:"sessionId"`
	Owner     string `json:"owner"`
	TTLMillis int64  `json:"ttlMillis"`
}

type RenewLeaseInput struct {
	SessionID string `json:"sessionId"`
	Owner     string `json:"owner"`
	Epoch     int64  `json:"epoch"`
	TTLMillis int64  `json:"ttlMillis"`
}

// WorkerEvent is a normalized physical-worker fact. It never carries an ACP
// request object; permission requests use RequestPermission instead.
type WorkerEvent struct {
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
}

type ReportWorkerEventsInput struct {
	SessionID string        `json:"sessionId"`
	Owner     string        `json:"owner"`
	Epoch     int64         `json:"epoch"`
	RunID     string        `json:"runId"`
	Events    []WorkerEvent `json:"events"`
}

type StartRunInput struct {
	SessionID string `json:"sessionId"`
	Owner     string `json:"owner"`
	Epoch     int64  `json:"epoch"`
	RunID     string `json:"runId"`
}

// StartLocalRunInput crosses the trusted Node-to-kernel boundary for a
// project-file Run.  It intentionally has no Session or worker lease: the
// local project runner is owned by the Noema host, not by an ACP agent.
type StartLocalRunInput struct {
	RunID string `json:"runId"`
}

// ReportLocalRunEventsInput persists normalized output from the trusted local
// project runner.  The store accepts it only for an unattached project-file
// Run, so it cannot be used to bypass an ACP worker lease.
type ReportLocalRunEventsInput struct {
	RunID  string        `json:"runId"`
	Events []WorkerEvent `json:"events"`
}

// FailPreparedRunInput is the trusted pre-dispatch cleanup path. It exists so
// an adapter/configuration/session bootstrap failure cannot strand the unique
// open Run slot before a worker has started physical execution.
type FailPreparedRunInput struct {
	RunID         string `json:"runId"`
	FailureReason string `json:"failureReason"`
}

// CancelRunInput records a trusted user's cancellation intent.  It does not
// invent a terminal state: the physical ACP worker must first receive
// session/cancel and then report its observed outcome (or be killed after its
// grace period).  This avoids claiming that an in-flight side effect stopped
// when it has not.
type CancelRunInput struct {
	RunID       string `json:"runId"`
	RequestedBy string `json:"requestedBy"`
}

// AttachRunInput binds a pre-dispatch RunSpec to a session that a worker just
// created or resumed. This preserves the invariant that a RunSpec reaches CAS
// before physical ACP work begins, without inventing a native session id.
type AttachRunInput struct {
	SessionID string `json:"sessionId"`
	Owner     string `json:"owner"`
	Epoch     int64  `json:"epoch"`
	RunID     string `json:"runId"`
}

// Permission is an append-only audit record whose optimistic Version prevents
// two clients from accepting contradictory answers.
type Permission struct {
	ID              string           `json:"id"`
	RunID           string           `json:"runId"`
	SessionID       string           `json:"sessionId"`
	NativeRequestID string           `json:"nativeRequestId"`
	ActionSHA256    string           `json:"actionSha256"`
	Action          map[string]any   `json:"action"`
	Options         []map[string]any `json:"options"`
	State           string           `json:"state"`
	OptionID        string           `json:"optionId,omitempty"`
	DecidedBy       string           `json:"decidedBy,omitempty"`
	CreatedAt       string           `json:"createdAt"`
	ResolvedAt      string           `json:"resolvedAt,omitempty"`
	Epoch           int64            `json:"epoch"`
	Version         int64            `json:"version"`
}

type RequestPermissionInput struct {
	SessionID       string           `json:"sessionId"`
	Owner           string           `json:"owner"`
	Epoch           int64            `json:"epoch"`
	RunID           string           `json:"runId"`
	NativeRequestID string           `json:"nativeRequestId"`
	Action          map[string]any   `json:"action"`
	Options         []map[string]any `json:"options"`
}

type DecidePermissionInput struct {
	PermissionID    string `json:"permissionId"`
	OptionID        string `json:"optionId"`
	ExpectedVersion int64  `json:"expectedVersion"`
	DecidedBy       string `json:"decidedBy"`
}

// InputRequest is a structured, durable pause in one Run. The native request
// id remains opaque; only the worker holding Epoch can receive its answer.
type InputRequest struct {
	ID              string           `json:"id"`
	RunID           string           `json:"runId"`
	SessionID       string           `json:"sessionId"`
	NativeRequestID string           `json:"nativeRequestId"`
	Prompt          string           `json:"prompt"`
	InputKind       string           `json:"inputKind"`
	Options         []map[string]any `json:"options"`
	State           string           `json:"state"`
	Answer          any              `json:"answer,omitempty"`
	AnsweredBy      string           `json:"answeredBy,omitempty"`
	CreatedAt       string           `json:"createdAt"`
	ResolvedAt      string           `json:"resolvedAt,omitempty"`
	Epoch           int64            `json:"epoch"`
	Version         int64            `json:"version"`
}

type RequestInputInput struct {
	SessionID       string           `json:"sessionId"`
	Owner           string           `json:"owner"`
	Epoch           int64            `json:"epoch"`
	RunID           string           `json:"runId"`
	NativeRequestID string           `json:"nativeRequestId"`
	Prompt          string           `json:"prompt"`
	InputKind       string           `json:"inputKind"`
	Options         []map[string]any `json:"options"`
}

type RespondInputInput struct {
	RunID      string `json:"runId"`
	RequestID  string `json:"requestId"`
	Answer     any    `json:"answer"`
	AnsweredBy string `json:"answeredBy"`
}

// PrepareRun persists a CAS-backed specification and creates a logical Run in
// a single database transaction. Writing a content-addressed object before
// that transaction is safe: a failed transaction can only leave unreachable,
// immutable bytes that a later janitor may collect.
func (s *Store) PrepareRun(input PrepareRunInput) (Run, error) {
	input.WorkstreamID = strings.TrimSpace(input.WorkstreamID)
	input.SessionID = strings.TrimSpace(input.SessionID)
	input.NotebookID = strings.TrimSpace(input.NotebookID)
	input.CellID = strings.TrimSpace(input.CellID)
	input.WorkNodeID = strings.TrimSpace(input.WorkNodeID)
	input.SourceKind = strings.TrimSpace(input.SourceKind)
	input.ExecutionTarget = strings.TrimSpace(input.ExecutionTarget)
	if !strings.HasPrefix(input.WorkstreamID, "ws_") {
		return Run{}, errors.New("run workstream id must start with ws_")
	}
	if !runSourceKinds[input.SourceKind] {
		return Run{}, fmt.Errorf("unsupported run source kind %q", input.SourceKind)
	}
	if input.ExecutionTarget == "" || !filepath.IsAbs(input.ExecutionTarget) {
		return Run{}, errors.New("run execution target must be an absolute path")
	}
	if input.Spec == nil {
		return Run{}, errors.New("run spec is required")
	}
	if (input.SourceKind == "work-cell" || input.SourceKind == "project-file") &&
		(input.NotebookID == "" || input.CellID == "" || !strings.HasPrefix(input.WorkNodeID, "wn_")) {
		return Run{}, errors.New("work-cell and project-file runs require notebook, cell, and WorkNode ids")
	}

	contextItems, contextArtifacts, err := s.freezeContextItems(input.ContextItems)
	if err != nil {
		return Run{}, err
	}
	var contextArtifact Artifact

	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Run{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var count int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM workstreams WHERE id = ?`, input.WorkstreamID).Scan(&count); err != nil {
		return Run{}, err
	}
	if count == 0 {
		return Run{}, fmt.Errorf("workstream %q not found", input.WorkstreamID)
	}
	if input.SessionID != "" {
		var sessionWorkstream, sessionTarget string
		if err := tx.QueryRow(`SELECT workstream_id, execution_target FROM sessions WHERE id = ?`, input.SessionID).
			Scan(&sessionWorkstream, &sessionTarget); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return Run{}, fmt.Errorf("session %q not found", input.SessionID)
			}
			return Run{}, err
		}
		named, err := sessionHasNameTx(tx, input.SessionID)
		if err != nil {
			return Run{}, err
		}
		// A named logical session serves every workstream of its repository
		// (D-031); an anonymous one stays inside the workstream it began in.
		if (sessionWorkstream != input.WorkstreamID && !named) || filepath.Clean(sessionTarget) != filepath.Clean(input.ExecutionTarget) {
			return Run{}, errors.New("run session does not belong to the workstream and execution target")
		}
	}
	var sessionIntent SessionNameIntent
	if input.SessionName != nil {
		if sessionIntent, err = checkIntentTx(tx, *input.SessionName); err != nil {
			return Run{}, err
		}
		if row, found, err := loadNameRowTx(tx, sessionIntent.Name); err != nil {
			return Run{}, err
		} else if found && input.SessionID != "" && row.sessionID != "" && row.sessionID != input.SessionID {
			return Run{}, fmt.Errorf("session name %q is bound to another session", sessionIntent.Name)
		}
	}
	for index, artifact := range contextArtifacts {
		contextArtifacts[index], err = ensureArtifactTx(tx, artifact)
		if err != nil {
			return Run{}, err
		}
		contextItems[index]["artifact_id"] = contextArtifacts[index].ID
	}
	manifestValue := input.ContextManifest
	if len(contextItems) > 0 {
		manifestValue = map[string]any{}
		for key, value := range input.ContextManifest {
			manifestValue[key] = value
		}
		manifestValue["items"] = contextItems
	}
	if manifestValue != nil {
		manifest, err := json.Marshal(manifestValue)
		if err != nil {
			return Run{}, fmt.Errorf("encode run context manifest: %w", err)
		}
		contextArtifact, err = s.putArtifactBytes("context-manifest", "application/json", manifest)
		if err != nil {
			return Run{}, err
		}
		if contextArtifact, err = ensureArtifactTx(tx, contextArtifact); err != nil {
			return Run{}, err
		}
	}
	runID, err := prefixedUUID("run_")
	if err != nil {
		return Run{}, err
	}
	storedSpec := input.Spec
	storedSpec["run_id"] = runID
	if contextArtifact.ID != "" {
		storedSpec["context_manifest"] = "cas:sha256:" + contextArtifact.SHA256
	}
	spec, err := json.Marshal(storedSpec)
	if err != nil {
		return Run{}, fmt.Errorf("encode run spec: %w", err)
	}
	specArtifact, err := s.putArtifactBytes("run-spec", "application/json", spec)
	if err != nil {
		return Run{}, err
	}
	if specArtifact, err = ensureArtifactTx(tx, specArtifact); err != nil {
		return Run{}, err
	}
	// The API returns this exact value to Node so the worker never receives a
	// pre-CAS draft that differs from the immutable object it references.
	now := time.Now().UTC().Truncate(time.Millisecond)
	nowMs := now.UnixMilli()
	if _, err := tx.Exec(`INSERT INTO runs(id, workstream_id, session_id, notebook_id, cell_id, work_node_id, source_kind, execution_target,
		status, spec_artifact_id, context_artifact_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?)`,
		runID, input.WorkstreamID, nullable(input.SessionID), nullable(input.NotebookID), nullable(input.CellID), nullable(input.WorkNodeID), input.SourceKind,
		filepath.Clean(input.ExecutionTarget), specArtifact.ID, nullable(contextArtifact.ID), nowMs); err != nil {
		return Run{}, err
	}
	if _, err := appendEvent(tx, Event{Type: "run.preparing", WorkstreamID: input.WorkstreamID, NotebookID: input.NotebookID,
		CellID: input.CellID, WorkNodeID: input.WorkNodeID, RunID: runID, SessionID: input.SessionID}, nowMs, map[string]any{
		"source_kind": input.SourceKind, "spec_artifact_id": specArtifact.ID, "context_artifact_id": contextArtifact.ID,
	}); err != nil {
		return Run{}, err
	}
	if input.SessionName != nil {
		if err := recordRunSessionNameTx(tx, runID, sessionIntent); err != nil {
			return Run{}, err
		}
		if input.SessionID != "" {
			if err := bindSessionNameTx(tx, sessionIntent, input.SessionID, input.WorkstreamID, nowMs); err != nil {
				return Run{}, err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return Run{}, err
	}
	return Run{ID: runID, WorkstreamID: input.WorkstreamID, SessionID: input.SessionID, NotebookID: input.NotebookID,
		CellID: input.CellID, WorkNodeID: input.WorkNodeID, SourceKind: input.SourceKind, ExecutionTarget: filepath.Clean(input.ExecutionTarget), Status: "preparing",
		SpecArtifactID: specArtifact.ID, ContextArtifactID: contextArtifact.ID, CreatedAt: formatMillis(nowMs), Version: 1}, nil
}

var runSourceKinds = map[string]bool{"work-cell": true, "project-file": true, "prompt-file": true, "promoted-session": true}

// GetRun returns durable state only; it never asks a worker whether a process
// still exists.
func (s *Store) GetRun(id string) (Run, error) {
	run, err := scanRun(s.db.QueryRow(runSelect+` WHERE id = ?`, strings.TrimSpace(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return Run{}, fmt.Errorf("run %q not found", id)
	}
	return run, err
}

// RequestRunCancellation durably records an intent before Node delivers the
// matching command to the owning worker.  Repeating the request is harmless;
// only one cancel-request event is retained for a Run.
func (s *Store) RequestRunCancellation(input CancelRunInput) (Run, error) {
	input.RunID, input.RequestedBy = strings.TrimSpace(input.RunID), strings.TrimSpace(input.RequestedBy)
	if input.RunID == "" || input.RequestedBy == "" {
		return Run{}, errors.New("run id and cancellation requester are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Run{}, err
	}
	defer func() { _ = tx.Rollback() }()
	run, err := scanRun(tx.QueryRow(runSelect+` WHERE id = ?`, input.RunID))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Run{}, fmt.Errorf("run %q not found", input.RunID)
		}
		return Run{}, err
	}
	if terminalRunStatuses[run.Status] {
		return Run{}, fmt.Errorf("run %q is already %s", run.ID, run.Status)
	}
	var prior int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM events WHERE run_id = ? AND type = 'run.cancel.requested'`, run.ID).Scan(&prior); err != nil {
		return Run{}, err
	}
	if prior == 0 {
		nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
		if _, err := appendEvent(tx, Event{Type: "run.cancel.requested", WorkstreamID: run.WorkstreamID, NotebookID: run.NotebookID,
			CellID: run.CellID, RunID: run.ID, SessionID: run.SessionID}, nowMs, map[string]any{"requested_by": input.RequestedBy}); err != nil {
			return Run{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Run{}, err
	}
	return run, nil
}

// GetArtifact returns immutable artifact metadata without exposing its bytes.
func (s *Store) GetArtifact(id string) (Artifact, error) {
	artifact, err := scanArtifact(s.db.QueryRow(artifactSelect+` WHERE id = ?`, strings.TrimSpace(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return Artifact{}, fmt.Errorf("artifact %q not found", id)
	}
	return artifact, err
}

// ReadArtifact returns the exact immutable bytes recorded by the store. The
// path is derived from a database digest, never from untrusted user input.
func (s *Store) ReadArtifact(id string) (Artifact, []byte, error) {
	artifact, err := s.GetArtifact(id)
	if err != nil {
		return Artifact{}, nil, err
	}
	if len(artifact.SHA256) != 64 {
		return Artifact{}, nil, fmt.Errorf("artifact %q has an invalid digest", id)
	}
	data, err := os.ReadFile(filepath.Join(s.root, StateDirName, "objects", "sha256", artifact.SHA256[:2], artifact.SHA256[2:]))
	if err != nil {
		return Artifact{}, nil, fmt.Errorf("read artifact %q: %w", id, err)
	}
	actual := sha256.Sum256(data)
	if hex.EncodeToString(actual[:]) != artifact.SHA256 {
		return Artifact{}, nil, fmt.Errorf("artifact %q digest verification failed", id)
	}
	return artifact, data, nil
}

type RunFilter struct {
	WorkstreamID string
	SessionID    string
	Limit        int
}

// RunLive is a durable snapshot for read-only web/Emacs projections.
type RunLive struct {
	Run    Run     `json:"run"`
	Events []Event `json:"events"`
	Seq    int64   `json:"seq"`
}

// Attention is the read-only projection of runtime facts requiring a human
// decision. Proposals join this projection in Phase F; they deliberately do
// not get a second mutable queue or authority here.
type Attention struct {
	Permissions   []Permission   `json:"permissions"`
	InputRequests []InputRequest `json:"inputRequests"`
	InputRuns     []Run          `json:"inputRuns"`
	Proposals     []Proposal     `json:"proposals"`
}

// ListAttention derives the attention inbox from authoritative row states.
// Nothing is acknowledged or mutated by opening the view.
func (s *Store) ListAttention() (Attention, error) {
	permissionRows, err := s.db.Query(permissionSelect + ` WHERE state = 'pending' ORDER BY created_at, id`)
	if err != nil {
		return Attention{}, err
	}
	permissions := []Permission{}
	for permissionRows.Next() {
		permission, err := scanPermission(permissionRows)
		if err != nil {
			_ = permissionRows.Close()
			return Attention{}, err
		}
		permissions = append(permissions, permission)
	}
	if err := permissionRows.Close(); err != nil {
		return Attention{}, err
	}
	if err := permissionRows.Err(); err != nil {
		return Attention{}, err
	}
	runRows, err := s.db.Query(runSelect + ` WHERE status = 'waiting_input' ORDER BY created_at, id`)
	if err != nil {
		return Attention{}, err
	}
	defer runRows.Close()
	inputRuns := []Run{}
	for runRows.Next() {
		run, err := scanRun(runRows)
		if err != nil {
			return Attention{}, err
		}
		inputRuns = append(inputRuns, run)
	}
	if err := runRows.Err(); err != nil {
		return Attention{}, err
	}
	inputRows, err := s.db.Query(inputRequestSelect + ` WHERE state = 'pending' ORDER BY created_at, id`)
	if err != nil {
		return Attention{}, err
	}
	inputRequests := []InputRequest{}
	for inputRows.Next() {
		request, err := scanInputRequest(inputRows)
		if err != nil {
			_ = inputRows.Close()
			return Attention{}, err
		}
		inputRequests = append(inputRequests, request)
	}
	if err := inputRows.Close(); err != nil {
		return Attention{}, err
	}
	if err := inputRows.Err(); err != nil {
		return Attention{}, err
	}
	proposals, err := s.ListProposals(ProposalFilter{Status: "pending", Limit: 1000})
	if err != nil {
		return Attention{}, err
	}
	accepting, err := s.ListProposals(ProposalFilter{Status: "accepting", Limit: 1000})
	if err != nil {
		return Attention{}, err
	}
	proposals = append(proposals, accepting...)
	return Attention{Permissions: permissions, InputRequests: inputRequests, InputRuns: inputRuns, Proposals: proposals}, nil
}

// LiveRun returns one Run plus only its append-only events after a sequence.
// It never consults the physical worker, so refreshes are deterministic.
func (s *Store) LiveRun(id string, after int64, limit int) (RunLive, error) {
	run, err := s.GetRun(id)
	if err != nil {
		return RunLive{}, err
	}
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	rows, err := s.db.Query(`SELECT seq, id, type, ts, COALESCE(workstream_id, ''), COALESCE(notebook_id, ''), COALESCE(cell_id, ''), COALESCE(work_node_id, ''),
		COALESCE(run_id, ''), COALESCE(session_id, ''), COALESCE(causation_id, ''), payload_json
		FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`, run.ID, after, limit)
	if err != nil {
		return RunLive{}, err
	}
	defer rows.Close()
	events := []Event{}
	seq := after
	for rows.Next() {
		var event Event
		var ts int64
		var payload string
		if err := rows.Scan(&event.Seq, &event.ID, &event.Type, &ts, &event.WorkstreamID, &event.NotebookID, &event.CellID, &event.WorkNodeID,
			&event.RunID, &event.SessionID, &event.CausationID, &payload); err != nil {
			return RunLive{}, err
		}
		event.TS = formatMillis(ts)
		if err := json.Unmarshal([]byte(payload), &event.Payload); err != nil {
			event.Payload = map[string]any{}
		}
		events = append(events, event)
		seq = event.Seq
	}
	if err := rows.Err(); err != nil {
		return RunLive{}, err
	}
	return RunLive{Run: run, Events: events, Seq: seq}, nil
}

func (s *Store) ListRuns(filter RunFilter) ([]Run, error) {
	limit := filter.Limit
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	query, args := runSelect+` WHERE 1 = 1`, []any{}
	if value := strings.TrimSpace(filter.WorkstreamID); value != "" {
		query += ` AND workstream_id = ?`
		args = append(args, value)
	}
	if value := strings.TrimSpace(filter.SessionID); value != "" {
		query += ` AND session_id = ?`
		args = append(args, value)
	}
	query += ` ORDER BY created_at DESC, id LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	runs := []Run{}
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

const runSelect = `SELECT id, workstream_id, COALESCE(session_id, ''), COALESCE(notebook_id, ''), COALESCE(cell_id, ''), COALESCE(work_node_id, ''),
	source_kind, execution_target, status, spec_artifact_id, COALESCE(context_artifact_id, ''), created_at,
	COALESCE(started_at, 0), COALESCE(finished_at, 0), failure_reason, version,
	COALESCE((SELECT name FROM run_session_names WHERE run_session_names.run_id = runs.id), '') FROM runs`

func scanRun(row rowScanner) (Run, error) {
	var run Run
	var createdAt, startedAt, finishedAt int64
	err := row.Scan(&run.ID, &run.WorkstreamID, &run.SessionID, &run.NotebookID, &run.CellID, &run.WorkNodeID, &run.SourceKind,
		&run.ExecutionTarget, &run.Status, &run.SpecArtifactID, &run.ContextArtifactID, &createdAt, &startedAt, &finishedAt,
		&run.FailureReason, &run.Version, &run.SessionName)
	if err != nil {
		return Run{}, err
	}
	run.CreatedAt = formatMillis(createdAt)
	if startedAt > 0 {
		run.StartedAt = formatMillis(startedAt)
	}
	if finishedAt > 0 {
		run.FinishedAt = formatMillis(finishedAt)
	}
	return run, nil
}

const artifactSelect = `SELECT id, kind, sha256, media_type, byte_count, created_at FROM artifacts`

func scanArtifact(row rowScanner) (Artifact, error) {
	var artifact Artifact
	var createdAt int64
	if err := row.Scan(&artifact.ID, &artifact.Kind, &artifact.SHA256, &artifact.MediaType, &artifact.ByteCount, &createdAt); err != nil {
		return Artifact{}, err
	}
	artifact.CreatedAt = formatMillis(createdAt)
	return artifact, nil
}

// AcquireLease either creates a lease, refreshes this owner's lease with a new
// epoch, or rejects a live competing worker.  Takeover is possible precisely
// after expiry; callers cannot force it early.
func (s *Store) AcquireLease(input AcquireLeaseInput) (Lease, error) {
	input.SessionID, input.Owner = strings.TrimSpace(input.SessionID), strings.TrimSpace(input.Owner)
	if input.SessionID == "" || input.Owner == "" {
		return Lease{}, errors.New("lease session id and owner are required")
	}
	ttl := leaseTTL(input.TTLMillis)
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Lease{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var workstreamID string
	if err := tx.QueryRow(`SELECT workstream_id FROM sessions WHERE id = ?`, input.SessionID).Scan(&workstreamID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Lease{}, fmt.Errorf("session %q not found", input.SessionID)
		}
		return Lease{}, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	nowMs, expiresMs := now.UnixMilli(), now.Add(ttl).UnixMilli()
	var previousOwner string
	var previousEpoch, previousExpiry int64
	err = tx.QueryRow(`SELECT owner, epoch, expires_at FROM leases WHERE session_id = ?`, input.SessionID).
		Scan(&previousOwner, &previousEpoch, &previousExpiry)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Lease{}, err
	}
	if err == nil && previousExpiry > nowMs && previousOwner != input.Owner {
		return Lease{}, fmt.Errorf("session %q is leased by another worker until %s", input.SessionID, formatMillis(previousExpiry))
	}
	epoch := previousEpoch + 1
	if epoch < 1 {
		epoch = 1
	}
	if _, err := tx.Exec(`INSERT INTO leases(session_id, owner, epoch, acquired_at, expires_at) VALUES(?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET owner = excluded.owner, epoch = excluded.epoch,
		acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`, input.SessionID, input.Owner, epoch, nowMs, expiresMs); err != nil {
		return Lease{}, err
	}
	if _, err := tx.Exec(`UPDATE sessions SET state = 'active', last_seen_at = ?, version = version + 1 WHERE id = ?`, nowMs, input.SessionID); err != nil {
		return Lease{}, err
	}
	if _, err := appendEvent(tx, Event{Type: "lease.acquired", WorkstreamID: workstreamID, SessionID: input.SessionID}, nowMs,
		map[string]any{"owner": input.Owner, "epoch": epoch, "expires_at": formatMillis(expiresMs)}); err != nil {
		return Lease{}, err
	}
	if err := tx.Commit(); err != nil {
		return Lease{}, err
	}
	return Lease{SessionID: input.SessionID, Owner: input.Owner, Epoch: epoch, AcquiredAt: formatMillis(nowMs), ExpiresAt: formatMillis(expiresMs)}, nil
}

func (s *Store) RenewLease(input RenewLeaseInput) (Lease, error) {
	input.SessionID, input.Owner = strings.TrimSpace(input.SessionID), strings.TrimSpace(input.Owner)
	if input.SessionID == "" || input.Owner == "" || input.Epoch < 1 {
		return Lease{}, errors.New("lease session id, owner, and epoch are required")
	}
	ttl := leaseTTL(input.TTLMillis)
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Lease{}, err
	}
	defer func() { _ = tx.Rollback() }()
	now := time.Now().UTC().Truncate(time.Millisecond)
	nowMs, expiresMs := now.UnixMilli(), now.Add(ttl).UnixMilli()
	var acquiredAt, expiresAt int64
	if err := tx.QueryRow(`SELECT acquired_at, expires_at FROM leases WHERE session_id = ? AND owner = ? AND epoch = ?`,
		input.SessionID, input.Owner, input.Epoch).Scan(&acquiredAt, &expiresAt); err != nil {
		return Lease{}, staleLeaseError(err, input.SessionID)
	}
	if expiresAt <= nowMs {
		return Lease{}, fmt.Errorf("lease for session %q has expired", input.SessionID)
	}
	if _, err := tx.Exec(`UPDATE leases SET expires_at = ? WHERE session_id = ? AND owner = ? AND epoch = ?`,
		expiresMs, input.SessionID, input.Owner, input.Epoch); err != nil {
		return Lease{}, err
	}
	if _, err := tx.Exec(`UPDATE sessions SET last_seen_at = ?, version = version + 1 WHERE id = ?`, nowMs, input.SessionID); err != nil {
		return Lease{}, err
	}
	if err := tx.Commit(); err != nil {
		return Lease{}, err
	}
	return Lease{SessionID: input.SessionID, Owner: input.Owner, Epoch: input.Epoch, AcquiredAt: formatMillis(acquiredAt), ExpiresAt: formatMillis(expiresMs)}, nil
}

func leaseTTL(millis int64) time.Duration {
	if millis <= 0 {
		return defaultLeaseTTL
	}
	ttl := time.Duration(millis) * time.Millisecond
	if ttl < minimumLeaseTTL {
		return minimumLeaseTTL
	}
	if ttl > maximumLeaseTTL {
		return maximumLeaseTTL
	}
	return ttl
}

func staleLeaseError(err error, sessionID string) error {
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("no current lease for session %q", sessionID)
	}
	return err
}

func requireLease(tx *sql.Tx, sessionID, owner string, epoch, nowMs int64) (string, error) {
	var workstreamID, actualOwner string
	var actualEpoch, expiresAt int64
	err := tx.QueryRow(`SELECT s.workstream_id, l.owner, l.epoch, l.expires_at FROM sessions s
		JOIN leases l ON l.session_id = s.id WHERE s.id = ?`, sessionID).
		Scan(&workstreamID, &actualOwner, &actualEpoch, &expiresAt)
	if err != nil {
		return "", staleLeaseError(err, sessionID)
	}
	if actualOwner != owner || actualEpoch != epoch || expiresAt <= nowMs {
		return "", fmt.Errorf("stale lease for session %q", sessionID)
	}
	return workstreamID, nil
}

func requireDecisionEpoch(tx *sql.Tx, sessionID string, epoch, nowMs int64) error {
	var actualEpoch, expiresAt int64
	if err := tx.QueryRow(`SELECT epoch, expires_at FROM leases WHERE session_id = ?`, sessionID).Scan(&actualEpoch, &expiresAt); err != nil {
		return staleLeaseError(err, sessionID)
	}
	if epoch < 1 || actualEpoch != epoch || expiresAt <= nowMs {
		return fmt.Errorf("stale lease epoch for session %q", sessionID)
	}
	return nil
}

// StartRun is the boundary between a persisted RunSpec and physical process
// execution. A session admits only one unfinished Run at once.
func (s *Store) StartRun(input StartRunInput) (Run, error) {
	input.SessionID, input.Owner, input.RunID = strings.TrimSpace(input.SessionID), strings.TrimSpace(input.Owner), strings.TrimSpace(input.RunID)
	if input.SessionID == "" || input.Owner == "" || input.Epoch < 1 || input.RunID == "" {
		return Run{}, errors.New("run id and current worker lease are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Run{}, err
	}
	defer func() { _ = tx.Rollback() }()
	now := time.Now().UTC().Truncate(time.Millisecond)
	nowMs := now.UnixMilli()
	workstreamID, err := requireLease(tx, input.SessionID, input.Owner, input.Epoch, nowMs)
	if err != nil {
		return Run{}, err
	}
	run, err := scanRun(tx.QueryRow(runSelect+` WHERE id = ?`, input.RunID))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Run{}, fmt.Errorf("run %q not found", input.RunID)
		}
		return Run{}, err
	}
	if run.SessionID != input.SessionID || !leaseCoversWorkstreamTx(tx, input.SessionID, run.WorkstreamID, workstreamID) {
		return Run{}, errors.New("run is not attached to this leased session")
	}
	if run.Status != "preparing" {
		return Run{}, fmt.Errorf("run %q cannot start from %s", input.RunID, run.Status)
	}
	var activeID string
	err = tx.QueryRow(`SELECT id FROM runs WHERE session_id = ? AND id != ? AND status IN ('preparing', 'running', 'waiting_permission', 'waiting_input') LIMIT 1`,
		input.SessionID, input.RunID).Scan(&activeID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Run{}, err
	}
	if activeID != "" {
		return Run{}, fmt.Errorf("session already has unfinished run %q", activeID)
	}
	if _, err := tx.Exec(`UPDATE runs SET status = 'running', started_at = ?, version = version + 1 WHERE id = ? AND version = ?`, nowMs, input.RunID, run.Version); err != nil {
		return Run{}, err
	}
	if _, err := appendEvent(tx, Event{Type: "run.started", WorkstreamID: workstreamID, NotebookID: run.NotebookID, CellID: run.CellID,
		WorkNodeID: run.WorkNodeID,
		RunID:      run.ID, SessionID: input.SessionID}, nowMs, map[string]any{"owner": input.Owner, "epoch": input.Epoch}); err != nil {
		return Run{}, err
	}
	if err := tx.Commit(); err != nil {
		return Run{}, err
	}
	run.Status, run.StartedAt, run.Version = "running", formatMillis(nowMs), run.Version+1
	return run, nil
}

// StartLocalRun starts a non-agent project-file execution.  This narrow
// trusted path is separate from StartRun so an ACP Run always remains fenced
// by its current Session lease.
func (s *Store) StartLocalRun(input StartLocalRunInput) (Run, error) {
	input.RunID = strings.TrimSpace(input.RunID)
	if input.RunID == "" {
		return Run{}, errors.New("local run id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Run{}, err
	}
	defer func() { _ = tx.Rollback() }()
	run, err := scanRun(tx.QueryRow(runSelect+` WHERE id = ?`, input.RunID))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Run{}, fmt.Errorf("run %q not found", input.RunID)
		}
		return Run{}, err
	}
	if run.SourceKind != "project-file" || run.SessionID != "" {
		return Run{}, errors.New("local execution requires an unattached project-file run")
	}
	if run.Status != "preparing" {
		return Run{}, fmt.Errorf("run %q cannot start locally from %s", run.ID, run.Status)
	}
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	result, err := tx.Exec(`UPDATE runs SET status = 'running', started_at = ?, version = version + 1 WHERE id = ? AND version = ?`,
		nowMs, run.ID, run.Version)
	if err != nil {
		return Run{}, err
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return Run{}, errors.New("local run changed concurrently")
	}
	if _, err := appendEvent(tx, Event{Type: "run.started", WorkstreamID: run.WorkstreamID, NotebookID: run.NotebookID,
		CellID: run.CellID, WorkNodeID: run.WorkNodeID, RunID: run.ID}, nowMs,
		map[string]any{"owner": "node:project-runner", "local": true}); err != nil {
		return Run{}, err
	}
	if err := tx.Commit(); err != nil {
		return Run{}, err
	}
	run.Status, run.StartedAt, run.Version = "running", formatMillis(nowMs), run.Version+1
	return run, nil
}

// FailPreparedRun records a failure before physical execution starts. It is
// idempotent after a successful failure transition, but refuses to rewrite a
// Run which may already have produced side effects.
func (s *Store) FailPreparedRun(input FailPreparedRunInput) (Run, error) {
	input.RunID, input.FailureReason = strings.TrimSpace(input.RunID), strings.TrimSpace(input.FailureReason)
	if input.RunID == "" || input.FailureReason == "" {
		return Run{}, errors.New("prepared run failure requires run id and reason")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Run{}, err
	}
	defer func() { _ = tx.Rollback() }()
	run, err := scanRun(tx.QueryRow(runSelect+` WHERE id = ?`, input.RunID))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Run{}, fmt.Errorf("run %q not found", input.RunID)
		}
		return Run{}, err
	}
	if run.Status == "failed" {
		return run, nil
	}
	if run.Status != "preparing" {
		return Run{}, fmt.Errorf("run %q cannot fail before dispatch from %s", input.RunID, run.Status)
	}
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	run, err = updateRunStatusTx(tx, run, "failed", nowMs, input.FailureReason)
	if err != nil {
		return Run{}, err
	}
	if _, err := appendEvent(tx, Event{Type: "run.status.changed", WorkstreamID: run.WorkstreamID,
		NotebookID: run.NotebookID, CellID: run.CellID, RunID: run.ID, SessionID: run.SessionID}, nowMs,
		map[string]any{"status": "failed", "failure_reason": input.FailureReason, "phase": "preparing"}); err != nil {
		return Run{}, err
	}
	if err := tx.Commit(); err != nil {
		return Run{}, err
	}
	return run, nil
}

// AttachRunToSession may be called exactly once, while a Run is preparing.
// The caller must own a live lease on the target Session, which fences an old
// Emacs process from attaching a freshly-created native session incorrectly.
func (s *Store) AttachRunToSession(input AttachRunInput) (Run, error) {
	input.SessionID, input.Owner, input.RunID = strings.TrimSpace(input.SessionID), strings.TrimSpace(input.Owner), strings.TrimSpace(input.RunID)
	if input.SessionID == "" || input.Owner == "" || input.Epoch < 1 || input.RunID == "" {
		return Run{}, errors.New("run attachment requires a run and current worker lease")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Run{}, err
	}
	defer func() { _ = tx.Rollback() }()
	now := time.Now().UTC().Truncate(time.Millisecond)
	nowMs := now.UnixMilli()
	workstreamID, err := requireLease(tx, input.SessionID, input.Owner, input.Epoch, nowMs)
	if err != nil {
		return Run{}, err
	}
	run, err := scanRun(tx.QueryRow(runSelect+` WHERE id = ?`, input.RunID))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Run{}, fmt.Errorf("run %q not found", input.RunID)
		}
		return Run{}, err
	}
	if run.Status != "preparing" || run.SessionID != "" {
		return Run{}, fmt.Errorf("run %q is already attached or no longer preparing", input.RunID)
	}
	if !leaseCoversWorkstreamTx(tx, input.SessionID, run.WorkstreamID, workstreamID) {
		return Run{}, errors.New("run does not belong to the leased session workstream")
	}
	var target string
	if err := tx.QueryRow(`SELECT execution_target FROM sessions WHERE id = ?`, input.SessionID).Scan(&target); err != nil {
		return Run{}, err
	}
	if filepath.Clean(target) != filepath.Clean(run.ExecutionTarget) {
		return Run{}, errors.New("run execution target does not match leased session")
	}
	if _, err := tx.Exec(`UPDATE runs SET session_id = ?, version = version + 1 WHERE id = ? AND version = ? AND session_id IS NULL`,
		input.SessionID, run.ID, run.Version); err != nil {
		return Run{}, err
	}
	if _, err := appendEvent(tx, Event{Type: "run.session.attached", WorkstreamID: run.WorkstreamID, NotebookID: run.NotebookID,
		CellID: run.CellID, RunID: run.ID, SessionID: input.SessionID}, nowMs, map[string]any{"owner": input.Owner, "epoch": input.Epoch}); err != nil {
		return Run{}, err
	}
	if intent, found, err := runSessionNameTx(tx, run.ID); err != nil {
		return Run{}, err
	} else if found {
		if err := bindSessionNameTx(tx, intent, input.SessionID, run.WorkstreamID, nowMs); err != nil {
			return Run{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Run{}, err
	}
	run.SessionID, run.Version = input.SessionID, run.Version+1
	return run, nil
}

// ReportWorkerEvents persists normalized output facts. A status change must be
// a dedicated run.status.changed event with a supported target state; terminal states
// receive a finished timestamp atomically with their event.
func (s *Store) ReportWorkerEvents(input ReportWorkerEventsInput) ([]Event, error) {
	input.SessionID, input.Owner, input.RunID = strings.TrimSpace(input.SessionID), strings.TrimSpace(input.Owner), strings.TrimSpace(input.RunID)
	if input.SessionID == "" || input.Owner == "" || input.Epoch < 1 || input.RunID == "" || len(input.Events) == 0 {
		return nil, errors.New("run events require a run and current worker lease")
	}
	if len(input.Events) > 200 {
		return nil, errors.New("worker event batch exceeds 200 events")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	now := time.Now().UTC().Truncate(time.Millisecond)
	nowMs := now.UnixMilli()
	workstreamID, err := requireLease(tx, input.SessionID, input.Owner, input.Epoch, nowMs)
	if err != nil {
		return nil, err
	}
	run, err := scanRun(tx.QueryRow(runSelect+` WHERE id = ?`, input.RunID))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("run %q not found", input.RunID)
		}
		return nil, err
	}
	if run.SessionID != input.SessionID || !leaseCoversWorkstreamTx(tx, input.SessionID, run.WorkstreamID, workstreamID) {
		return nil, errors.New("run is not attached to this leased session")
	}
	if terminalRunStatuses[run.Status] {
		return nil, fmt.Errorf("run %q is already %s", run.ID, run.Status)
	}
	result := make([]Event, 0, len(input.Events))
	for _, draft := range input.Events {
		draft.Type = strings.TrimSpace(draft.Type)
		if !strings.HasPrefix(draft.Type, "run.") || draft.Type == "run.permission.requested" {
			return nil, fmt.Errorf("unsupported worker event type %q", draft.Type)
		}
		payload := draft.Payload
		if payload == nil {
			payload = map[string]any{}
		}
		if draft.Type == "run.status.changed" {
			next, _ := payload["status"].(string)
			next = strings.TrimSpace(next)
			if !runStatuses[next] || next == "preparing" || next == "waiting_permission" {
				return nil, fmt.Errorf("invalid worker run status %q", next)
			}
			if run, err = updateRunStatusTx(tx, run, next, nowMs, runtimeStringValue(payload["failure_reason"])); err != nil {
				return nil, err
			}
			if terminalRunStatuses[next] {
				normalized := make(map[string]any, len(payload))
				for key, value := range payload {
					if key != "result_text" && key != "transcript_text" {
						normalized[key] = value
					}
				}
				artifacts := []struct {
					field, kind, mediaType, resultField string
				}{
					{"result_text", "handoff", "text/markdown; charset=utf-8", "handoff_artifact_id"},
					{"transcript_text", "transcript", "text/plain; charset=utf-8", "transcript_artifact_id"},
				}
				for _, pending := range artifacts {
					content := runtimeStringValue(payload[pending.field])
					if content == "" {
						continue
					}
					artifact, err := s.putArtifactBytes(pending.kind, pending.mediaType, []byte(content))
					if err != nil {
						return nil, err
					}
					artifact, err = ensureArtifactTx(tx, artifact)
					if err != nil {
						return nil, err
					}
					normalized[pending.resultField] = artifact.ID
					created, err := appendEvent(tx, Event{Type: "artifact.created", WorkstreamID: workstreamID, NotebookID: run.NotebookID,
						CellID: run.CellID, RunID: run.ID, SessionID: input.SessionID}, nowMs,
						map[string]any{"artifact_id": artifact.ID, "kind": artifact.Kind, "sha256": artifact.SHA256,
							"media_type": artifact.MediaType, "byte_count": artifact.ByteCount})
					if err != nil {
						return nil, err
					}
					result = append(result, created)
				}
				payload = normalized
				expired, err := expirePendingPermissionsTx(tx, run, input.SessionID, nowMs, "run became terminal")
				if err != nil {
					return nil, err
				}
				result = append(result, expired...)
				inputExpired, err := expirePendingInputsTx(tx, run, input.SessionID, nowMs, "run became terminal")
				if err != nil {
					return nil, err
				}
				result = append(result, inputExpired...)
			}
		}
		event, err := appendEvent(tx, Event{Type: draft.Type, WorkstreamID: workstreamID, NotebookID: run.NotebookID,
			CellID: run.CellID, WorkNodeID: run.WorkNodeID, RunID: run.ID, SessionID: input.SessionID}, nowMs, payload)
		if err != nil {
			return nil, err
		}
		result = append(result, event)
	}
	if _, err := tx.Exec(`UPDATE sessions SET last_seen_at = ?, version = version + 1 WHERE id = ?`, nowMs, input.SessionID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

// ReportLocalRunEvents is the durable output path for a Noema-hosted script or
// notebook process.  It accepts only unattached project-file Runs; agent Runs
// must continue to use ReportWorkerEvents with a live lease.
func (s *Store) ReportLocalRunEvents(input ReportLocalRunEventsInput) ([]Event, error) {
	input.RunID = strings.TrimSpace(input.RunID)
	if input.RunID == "" || len(input.Events) == 0 {
		return nil, errors.New("local run events require a run and at least one event")
	}
	if len(input.Events) > 200 {
		return nil, errors.New("local run event batch exceeds 200 events")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	run, err := scanRun(tx.QueryRow(runSelect+` WHERE id = ?`, input.RunID))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("run %q not found", input.RunID)
		}
		return nil, err
	}
	if run.SourceKind != "project-file" || run.SessionID != "" {
		return nil, errors.New("local events require an unattached project-file run")
	}
	if run.Status != "running" {
		return nil, fmt.Errorf("local run %q cannot accept events from %s", run.ID, run.Status)
	}
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	result := make([]Event, 0, len(input.Events))
	for _, draft := range input.Events {
		draft.Type = strings.TrimSpace(draft.Type)
		if !strings.HasPrefix(draft.Type, "run.") || draft.Type == "run.permission.requested" {
			return nil, fmt.Errorf("unsupported local run event type %q", draft.Type)
		}
		payload := draft.Payload
		if payload == nil {
			payload = map[string]any{}
		}
		if draft.Type == "run.status.changed" {
			next, _ := payload["status"].(string)
			next = strings.TrimSpace(next)
			if !terminalRunStatuses[next] {
				return nil, fmt.Errorf("invalid local run status %q", next)
			}
			if run, err = updateRunStatusTx(tx, run, next, nowMs, runtimeStringValue(payload["failure_reason"])); err != nil {
				return nil, err
			}
			normalized := make(map[string]any, len(payload))
			for key, value := range payload {
				if key != "result_text" && key != "transcript_text" {
					normalized[key] = value
				}
			}
			for _, pending := range []struct {
				field, kind, mediaType, resultField string
			}{
				{"result_text", "handoff", "text/markdown; charset=utf-8", "handoff_artifact_id"},
				{"transcript_text", "transcript", "text/plain; charset=utf-8", "transcript_artifact_id"},
			} {
				content := runtimeStringValue(payload[pending.field])
				if content == "" {
					continue
				}
				artifact, artifactErr := s.putArtifactBytes(pending.kind, pending.mediaType, []byte(content))
				if artifactErr != nil {
					return nil, artifactErr
				}
				artifact, artifactErr = ensureArtifactTx(tx, artifact)
				if artifactErr != nil {
					return nil, artifactErr
				}
				normalized[pending.resultField] = artifact.ID
				created, artifactErr := appendEvent(tx, Event{Type: "artifact.created", WorkstreamID: run.WorkstreamID,
					NotebookID: run.NotebookID, CellID: run.CellID, WorkNodeID: run.WorkNodeID, RunID: run.ID}, nowMs,
					map[string]any{"artifact_id": artifact.ID, "kind": artifact.Kind, "sha256": artifact.SHA256,
						"media_type": artifact.MediaType, "byte_count": artifact.ByteCount})
				if artifactErr != nil {
					return nil, artifactErr
				}
				result = append(result, created)
			}
			payload = normalized
		}
		event, eventErr := appendEvent(tx, Event{Type: draft.Type, WorkstreamID: run.WorkstreamID,
			NotebookID: run.NotebookID, CellID: run.CellID, WorkNodeID: run.WorkNodeID, RunID: run.ID}, nowMs, payload)
		if eventErr != nil {
			return nil, eventErr
		}
		result = append(result, event)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

func expirePendingPermissionsTx(tx *sql.Tx, run Run, sessionID string, nowMs int64, reason string) ([]Event, error) {
	rows, err := tx.Query(permissionSelect+` WHERE run_id = ? AND state = 'pending' ORDER BY created_at, id`, run.ID)
	if err != nil {
		return nil, err
	}
	pending := []Permission{}
	for rows.Next() {
		permission, err := scanPermission(rows)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		pending = append(pending, permission)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	events := make([]Event, 0, len(pending))
	for _, permission := range pending {
		if _, err := tx.Exec(`UPDATE permissions SET state = 'expired', resolved_at = ?, version = version + 1
			WHERE id = ? AND state = 'pending'`, nowMs, permission.ID); err != nil {
			return nil, err
		}
		event, err := appendEvent(tx, Event{Type: "permission.expired", WorkstreamID: run.WorkstreamID,
			NotebookID: run.NotebookID, CellID: run.CellID, RunID: run.ID, SessionID: sessionID}, nowMs,
			map[string]any{"permission_id": permission.ID, "reason": reason})
		if err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, nil
}

func updateRunStatusTx(tx *sql.Tx, run Run, next string, nowMs int64, failureReason string) (Run, error) {
	if !runStatuses[next] || terminalRunStatuses[run.Status] {
		return Run{}, fmt.Errorf("invalid run transition %s -> %s", run.Status, next)
	}
	if next == "running" && run.Status == "preparing" {
		return Run{}, errors.New("only StartRun can transition a prepared run to running")
	}
	finished := any(nil)
	if terminalRunStatuses[next] {
		finished = nowMs
	}
	if _, err := tx.Exec(`UPDATE runs SET status = ?, finished_at = ?, failure_reason = ?, version = version + 1 WHERE id = ? AND version = ?`,
		next, finished, failureReason, run.ID, run.Version); err != nil {
		return Run{}, err
	}
	run.Status, run.FailureReason, run.Version = next, failureReason, run.Version+1
	if terminalRunStatuses[next] {
		run.FinishedAt = formatMillis(nowMs)
	}
	return run, nil
}

// RequestPermission creates one idempotent brokered permission request. It is
// deliberately separate from ReportWorkerEvents so raw ACP callback objects
// cannot accidentally be persisted or sent across process boundaries.
func (s *Store) RequestPermission(input RequestPermissionInput) (Permission, error) {
	input.SessionID, input.Owner, input.RunID = strings.TrimSpace(input.SessionID), strings.TrimSpace(input.Owner), strings.TrimSpace(input.RunID)
	input.NativeRequestID = strings.TrimSpace(input.NativeRequestID)
	if input.SessionID == "" || input.Owner == "" || input.Epoch < 1 || input.RunID == "" || input.NativeRequestID == "" {
		return Permission{}, errors.New("permission requires a run, native request id, and current worker lease")
	}
	if input.Action == nil || len(input.Options) == 0 {
		return Permission{}, errors.New("permission action and options are required")
	}
	actionJSON, err := json.Marshal(input.Action)
	if err != nil {
		return Permission{}, fmt.Errorf("encode permission action: %w", err)
	}
	optionsJSON, err := json.Marshal(input.Options)
	if err != nil {
		return Permission{}, fmt.Errorf("encode permission options: %w", err)
	}
	actionDigest := sha256.Sum256(actionJSON)
	actionSHA := hex.EncodeToString(actionDigest[:])
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Permission{}, err
	}
	defer func() { _ = tx.Rollback() }()
	now := time.Now().UTC().Truncate(time.Millisecond)
	nowMs := now.UnixMilli()
	workstreamID, err := requireLease(tx, input.SessionID, input.Owner, input.Epoch, nowMs)
	if err != nil {
		return Permission{}, err
	}
	if existing, found, err := findPermissionByNativeRequest(tx, input.SessionID, input.NativeRequestID); err != nil {
		return Permission{}, err
	} else if found {
		if existing.ActionSHA256 != actionSHA {
			return Permission{}, errors.New("native permission request id was reused with a different action")
		}
		if err := tx.Commit(); err != nil {
			return Permission{}, err
		}
		return existing, nil
	}
	run, err := scanRun(tx.QueryRow(runSelect+` WHERE id = ?`, input.RunID))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Permission{}, fmt.Errorf("run %q not found", input.RunID)
		}
		return Permission{}, err
	}
	if run.SessionID != input.SessionID || !leaseCoversWorkstreamTx(tx, input.SessionID, run.WorkstreamID, workstreamID) || run.Status != "running" {
		return Permission{}, errors.New("permission can only be requested by a running leased run")
	}
	decision, err := policyDecisionForTx(tx, run, input.Action, input.Options)
	if err != nil {
		return Permission{}, err
	}
	if decision.DecidedBy != "" && decision.OptionID == "" {
		return Permission{}, errors.New("agent permission request has no option compatible with the enforced project policy")
	}
	permissionID, err := prefixedUUID("perm_")
	if err != nil {
		return Permission{}, err
	}
	state, optionID, decidedBy := "pending", "", ""
	var resolvedAt any
	if decision.DecidedBy != "" {
		state, optionID, decidedBy, resolvedAt = "resolved", decision.OptionID, decision.DecidedBy, nowMs
	}
	if _, err := tx.Exec(`INSERT INTO permissions(id, run_id, session_id, native_request_id, action_sha256, action_json, options_json,
		state, option_id, decided_by, created_at, resolved_at, lease_epoch) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		permissionID, run.ID, input.SessionID, input.NativeRequestID, actionSHA, string(actionJSON), string(optionsJSON), state,
		optionID, decidedBy, nowMs, resolvedAt, input.Epoch); err != nil {
		return Permission{}, err
	}
	if state == "pending" {
		if _, err := updateRunStatusTx(tx, run, "waiting_permission", nowMs, ""); err != nil {
			return Permission{}, err
		}
	}
	if _, err := appendEvent(tx, Event{Type: "permission.requested", WorkstreamID: workstreamID, NotebookID: run.NotebookID,
		CellID: run.CellID, RunID: run.ID, SessionID: input.SessionID}, nowMs,
		map[string]any{"permission_id": permissionID, "action_sha256": actionSHA, "action": input.Action, "options": input.Options,
			"auto_decision": optionID, "policy_reason": decision.Reason}); err != nil {
		return Permission{}, err
	}
	if state == "resolved" {
		if _, err := appendEvent(tx, Event{Type: "permission.resolved", WorkstreamID: workstreamID, NotebookID: run.NotebookID,
			CellID: run.CellID, RunID: run.ID, SessionID: input.SessionID}, nowMs,
			map[string]any{"permission_id": permissionID, "option_id": optionID, "decided_by": decidedBy, "reason": decision.Reason}); err != nil {
			return Permission{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Permission{}, err
	}
	return Permission{ID: permissionID, RunID: run.ID, SessionID: input.SessionID, NativeRequestID: input.NativeRequestID,
		ActionSHA256: actionSHA, Action: input.Action, Options: input.Options, State: state, OptionID: optionID, DecidedBy: decidedBy,
		CreatedAt: formatMillis(nowMs), ResolvedAt: formatOptionalMillis(resolvedAt), Epoch: input.Epoch, Version: 1}, nil
}

func (s *Store) GetPermission(id string) (Permission, error) {
	permission, err := scanPermission(s.db.QueryRow(permissionSelect+` WHERE id = ?`, strings.TrimSpace(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return Permission{}, fmt.Errorf("permission %q not found", id)
	}
	return permission, err
}

// DecidePermission uses expectedVersion, allowing clients to safely render a
// pending decision while another trusted client is looking at the same request.
func (s *Store) DecidePermission(input DecidePermissionInput) (Permission, error) {
	input.PermissionID, input.OptionID, input.DecidedBy = strings.TrimSpace(input.PermissionID), strings.TrimSpace(input.OptionID), strings.TrimSpace(input.DecidedBy)
	if input.PermissionID == "" || input.OptionID == "" || input.DecidedBy == "" || input.ExpectedVersion < 1 {
		return Permission{}, errors.New("permission id, option id, expected version, and decider are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Permission{}, err
	}
	defer func() { _ = tx.Rollback() }()
	permission, err := scanPermission(tx.QueryRow(permissionSelect+` WHERE id = ?`, input.PermissionID))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Permission{}, fmt.Errorf("permission %q not found", input.PermissionID)
		}
		return Permission{}, err
	}
	if permission.State != "pending" {
		return Permission{}, fmt.Errorf("permission %q is already %s", input.PermissionID, permission.State)
	}
	if permission.Version != input.ExpectedVersion {
		return Permission{}, fmt.Errorf("permission %q version conflict", input.PermissionID)
	}
	if err := requireDecisionEpoch(tx, permission.SessionID, permission.Epoch, time.Now().UTC().UnixMilli()); err != nil {
		return Permission{}, err
	}
	if !permissionHasOption(permission.Options, input.OptionID) {
		return Permission{}, fmt.Errorf("permission option %q was not offered", input.OptionID)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	nowMs := now.UnixMilli()
	updated, err := tx.Exec(`UPDATE permissions SET state = 'resolved', option_id = ?, decided_by = ?, resolved_at = ?, version = version + 1
		WHERE id = ? AND state = 'pending' AND version = ?`, input.OptionID, input.DecidedBy, nowMs, permission.ID, input.ExpectedVersion)
	if err != nil {
		return Permission{}, err
	}
	rows, err := updated.RowsAffected()
	if err != nil {
		return Permission{}, err
	}
	if rows != 1 {
		return Permission{}, fmt.Errorf("permission %q version conflict", input.PermissionID)
	}
	run, err := scanRun(tx.QueryRow(runSelect+` WHERE id = ?`, permission.RunID))
	if err != nil {
		return Permission{}, err
	}
	if run.Status == "waiting_permission" {
		if _, err := updateRunStatusTx(tx, run, "running", nowMs, ""); err != nil {
			return Permission{}, err
		}
	}
	if _, err := appendEvent(tx, Event{Type: "permission.resolved", WorkstreamID: run.WorkstreamID, NotebookID: run.NotebookID,
		CellID: run.CellID, RunID: run.ID, SessionID: permission.SessionID}, nowMs,
		map[string]any{"permission_id": permission.ID, "option_id": input.OptionID, "decided_by": input.DecidedBy}); err != nil {
		return Permission{}, err
	}
	if strings.HasSuffix(strings.ToLower(input.OptionID), "_always") {
		if _, err := createPermissionRuleTx(tx, permission, run, input.OptionID, input.DecidedBy, nowMs); err != nil {
			return Permission{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Permission{}, err
	}
	permission.State, permission.OptionID, permission.DecidedBy, permission.ResolvedAt, permission.Version = "resolved", input.OptionID, input.DecidedBy, formatMillis(nowMs), permission.Version+1
	return permission, nil
}

const permissionSelect = `SELECT id, run_id, session_id, native_request_id, action_sha256, action_json, options_json, state,
	option_id, decided_by, created_at, COALESCE(resolved_at, 0), lease_epoch, version FROM permissions`

func scanPermission(row rowScanner) (Permission, error) {
	var permission Permission
	var action, options string
	var createdAt, resolvedAt int64
	err := row.Scan(&permission.ID, &permission.RunID, &permission.SessionID, &permission.NativeRequestID, &permission.ActionSHA256,
		&action, &options, &permission.State, &permission.OptionID, &permission.DecidedBy, &createdAt, &resolvedAt, &permission.Epoch, &permission.Version)
	if err != nil {
		return Permission{}, err
	}
	if err := json.Unmarshal([]byte(action), &permission.Action); err != nil {
		return Permission{}, fmt.Errorf("decode permission action: %w", err)
	}
	if err := json.Unmarshal([]byte(options), &permission.Options); err != nil {
		return Permission{}, fmt.Errorf("decode permission options: %w", err)
	}
	permission.CreatedAt = formatMillis(createdAt)
	if resolvedAt > 0 {
		permission.ResolvedAt = formatMillis(resolvedAt)
	}
	return permission, nil
}

func findPermissionByNativeRequest(tx *sql.Tx, sessionID, nativeRequestID string) (Permission, bool, error) {
	permission, err := scanPermission(tx.QueryRow(permissionSelect+` WHERE session_id = ? AND native_request_id = ?`, sessionID, nativeRequestID))
	if errors.Is(err, sql.ErrNoRows) {
		return Permission{}, false, nil
	}
	return permission, err == nil, err
}

func permissionHasOption(options []map[string]any, optionID string) bool {
	for _, option := range options {
		for _, key := range []string{"optionId", "option_id", "id"} {
			if value, _ := option[key].(string); value == optionID {
				return true
			}
		}
	}
	return false
}

// RequestInput pauses a leased running Run for one structured human answer.
// It is separate from the free-form event endpoint so the question and its
// responder remain authoritative and idempotent.
func (s *Store) RequestInput(input RequestInputInput) (InputRequest, error) {
	input.SessionID, input.Owner, input.RunID = strings.TrimSpace(input.SessionID), strings.TrimSpace(input.Owner), strings.TrimSpace(input.RunID)
	input.NativeRequestID, input.Prompt, input.InputKind = strings.TrimSpace(input.NativeRequestID), strings.TrimSpace(input.Prompt), strings.TrimSpace(input.InputKind)
	if input.InputKind == "" {
		input.InputKind = "text"
	}
	if input.SessionID == "" || input.Owner == "" || input.Epoch < 1 || input.RunID == "" || input.NativeRequestID == "" || input.Prompt == "" {
		return InputRequest{}, errors.New("input request requires a run, prompt, native request id, and current worker lease")
	}
	if len(input.Prompt) > 32*1024 || len(input.Options) > 100 {
		return InputRequest{}, errors.New("input request exceeds its size limit")
	}
	if input.InputKind != "text" && input.InputKind != "select" && input.InputKind != "confirm" && input.InputKind != "json" {
		return InputRequest{}, fmt.Errorf("unsupported input kind %q", input.InputKind)
	}
	optionsJSON, err := json.Marshal(input.Options)
	if err != nil || len(optionsJSON) > 64*1024 {
		return InputRequest{}, errors.New("input request options are not valid bounded JSON")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return InputRequest{}, err
	}
	defer func() { _ = tx.Rollback() }()
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	workstreamID, err := requireLease(tx, input.SessionID, input.Owner, input.Epoch, nowMs)
	if err != nil {
		return InputRequest{}, err
	}
	if existing, found, err := findInputByNativeRequest(tx, input.SessionID, input.NativeRequestID); err != nil {
		return InputRequest{}, err
	} else if found {
		encodedExisting, _ := json.Marshal(existing.Options)
		if existing.RunID != input.RunID || existing.Prompt != input.Prompt || existing.InputKind != input.InputKind || string(encodedExisting) != string(optionsJSON) || existing.Epoch != input.Epoch {
			return InputRequest{}, errors.New("native input request id was reused with different content or epoch")
		}
		if err := tx.Commit(); err != nil {
			return InputRequest{}, err
		}
		return existing, nil
	}
	run, err := scanRun(tx.QueryRow(runSelect+` WHERE id = ?`, input.RunID))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return InputRequest{}, fmt.Errorf("run %q not found", input.RunID)
		}
		return InputRequest{}, err
	}
	if run.SessionID != input.SessionID || !leaseCoversWorkstreamTx(tx, input.SessionID, run.WorkstreamID, workstreamID) || run.Status != "running" {
		return InputRequest{}, errors.New("input can only be requested by a running leased run")
	}
	requestID, err := prefixedUUID("input_")
	if err != nil {
		return InputRequest{}, err
	}
	if _, err := tx.Exec(`INSERT INTO input_requests(id, run_id, session_id, native_request_id, prompt, input_kind, options_json,
		state, created_at, lease_epoch) VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, requestID, run.ID, input.SessionID,
		input.NativeRequestID, input.Prompt, input.InputKind, string(optionsJSON), nowMs, input.Epoch); err != nil {
		return InputRequest{}, err
	}
	if run, err = updateRunStatusTx(tx, run, "waiting_input", nowMs, ""); err != nil {
		return InputRequest{}, err
	}
	if _, err := appendEvent(tx, Event{Type: "run.input_required", WorkstreamID: workstreamID, NotebookID: run.NotebookID,
		CellID: run.CellID, RunID: run.ID, SessionID: input.SessionID}, nowMs, map[string]any{
		"request_id": requestID, "native_request_id": input.NativeRequestID, "prompt": input.Prompt,
		"input_kind": input.InputKind, "options": input.Options, "epoch": input.Epoch,
	}); err != nil {
		return InputRequest{}, err
	}
	if err := tx.Commit(); err != nil {
		return InputRequest{}, err
	}
	return InputRequest{ID: requestID, RunID: run.ID, SessionID: input.SessionID, NativeRequestID: input.NativeRequestID,
		Prompt: input.Prompt, InputKind: input.InputKind, Options: input.Options, State: "pending", CreatedAt: formatMillis(nowMs),
		Epoch: input.Epoch, Version: 1}, nil
}

// RespondInput atomically records the first answer and returns the epoch that
// Node must put on the downlink command. A stale or expired worker can never
// receive an answer intended for its predecessor.
func (s *Store) RespondInput(input RespondInputInput) (InputRequest, error) {
	input.RunID, input.RequestID, input.AnsweredBy = strings.TrimSpace(input.RunID), strings.TrimSpace(input.RequestID), strings.TrimSpace(input.AnsweredBy)
	if input.RunID == "" || input.RequestID == "" || input.AnsweredBy == "" || input.Answer == nil {
		return InputRequest{}, errors.New("input response requires run id, request id, answer, and responder")
	}
	answerJSON, err := json.Marshal(input.Answer)
	if err != nil || len(answerJSON) > 64*1024 {
		return InputRequest{}, errors.New("input answer is not valid bounded JSON")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return InputRequest{}, err
	}
	defer func() { _ = tx.Rollback() }()
	request, err := scanInputRequest(tx.QueryRow(inputRequestSelect+` WHERE id = ? AND run_id = ?`, input.RequestID, input.RunID))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return InputRequest{}, fmt.Errorf("input request %q not found for run %q", input.RequestID, input.RunID)
		}
		return InputRequest{}, err
	}
	if request.State != "pending" {
		return InputRequest{}, fmt.Errorf("input request %q is already %s", request.ID, request.State)
	}
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	if err := requireDecisionEpoch(tx, request.SessionID, request.Epoch, nowMs); err != nil {
		return InputRequest{}, err
	}
	run, err := scanRun(tx.QueryRow(runSelect+` WHERE id = ?`, request.RunID))
	if err != nil {
		return InputRequest{}, err
	}
	if run.Status != "waiting_input" {
		return InputRequest{}, fmt.Errorf("run %q is not waiting for input", run.ID)
	}
	updated, err := tx.Exec(`UPDATE input_requests SET state = 'resolved', answer_json = ?, answered_by = ?, resolved_at = ?, version = version + 1
		WHERE id = ? AND state = 'pending' AND version = ?`, string(answerJSON), input.AnsweredBy, nowMs, request.ID, request.Version)
	if err != nil {
		return InputRequest{}, err
	}
	if rows, err := updated.RowsAffected(); err != nil || rows != 1 {
		return InputRequest{}, fmt.Errorf("input request %q version conflict", request.ID)
	}
	if run, err = updateRunStatusTx(tx, run, "running", nowMs, ""); err != nil {
		return InputRequest{}, err
	}
	if _, err := appendEvent(tx, Event{Type: "input_resolved", WorkstreamID: run.WorkstreamID, NotebookID: run.NotebookID,
		CellID: run.CellID, RunID: run.ID, SessionID: run.SessionID}, nowMs, map[string]any{
		"request_id": request.ID, "answered_by": input.AnsweredBy, "epoch": request.Epoch,
	}); err != nil {
		return InputRequest{}, err
	}
	if err := tx.Commit(); err != nil {
		return InputRequest{}, err
	}
	request.State, request.Answer, request.AnsweredBy = "resolved", input.Answer, input.AnsweredBy
	request.ResolvedAt, request.Version = formatMillis(nowMs), request.Version+1
	return request, nil
}

func (s *Store) GetInputRequest(id string) (InputRequest, error) {
	request, err := scanInputRequest(s.db.QueryRow(inputRequestSelect+` WHERE id = ?`, strings.TrimSpace(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return InputRequest{}, fmt.Errorf("input request %q not found", id)
	}
	return request, err
}

const inputRequestSelect = `SELECT id, run_id, session_id, native_request_id, prompt, input_kind, options_json, state,
	COALESCE(answer_json, 'null'), answered_by, created_at, COALESCE(resolved_at, 0), lease_epoch, version FROM input_requests`

func scanInputRequest(row rowScanner) (InputRequest, error) {
	var request InputRequest
	var optionsJSON, answerJSON string
	var createdAt, resolvedAt int64
	if err := row.Scan(&request.ID, &request.RunID, &request.SessionID, &request.NativeRequestID, &request.Prompt, &request.InputKind,
		&optionsJSON, &request.State, &answerJSON, &request.AnsweredBy, &createdAt, &resolvedAt, &request.Epoch, &request.Version); err != nil {
		return InputRequest{}, err
	}
	if err := json.Unmarshal([]byte(optionsJSON), &request.Options); err != nil {
		return InputRequest{}, fmt.Errorf("decode input options: %w", err)
	}
	if answerJSON != "null" {
		if err := json.Unmarshal([]byte(answerJSON), &request.Answer); err != nil {
			return InputRequest{}, fmt.Errorf("decode input answer: %w", err)
		}
	}
	request.CreatedAt = formatMillis(createdAt)
	if resolvedAt > 0 {
		request.ResolvedAt = formatMillis(resolvedAt)
	}
	return request, nil
}

func findInputByNativeRequest(tx *sql.Tx, sessionID, nativeRequestID string) (InputRequest, bool, error) {
	request, err := scanInputRequest(tx.QueryRow(inputRequestSelect+` WHERE session_id = ? AND native_request_id = ?`, sessionID, nativeRequestID))
	if errors.Is(err, sql.ErrNoRows) {
		return InputRequest{}, false, nil
	}
	return request, err == nil, err
}

func expirePendingInputsTx(tx *sql.Tx, run Run, sessionID string, nowMs int64, reason string) ([]Event, error) {
	rows, err := tx.Query(inputRequestSelect+` WHERE run_id = ? AND state = 'pending' ORDER BY created_at, id`, run.ID)
	if err != nil {
		return nil, err
	}
	pending := []InputRequest{}
	for rows.Next() {
		request, err := scanInputRequest(rows)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		pending = append(pending, request)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	events := make([]Event, 0, len(pending))
	for _, request := range pending {
		if _, err := tx.Exec(`UPDATE input_requests SET state = 'expired', resolved_at = ?, version = version + 1 WHERE id = ? AND state = 'pending'`, nowMs, request.ID); err != nil {
			return nil, err
		}
		event, err := appendEvent(tx, Event{Type: "input_expired", WorkstreamID: run.WorkstreamID, NotebookID: run.NotebookID,
			CellID: run.CellID, RunID: run.ID, SessionID: sessionID}, nowMs, map[string]any{"request_id": request.ID, "reason": reason})
		if err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, nil
}

func runtimeStringValue(value any) string {
	result, _ := value.(string)
	return strings.TrimSpace(result)
}

func formatOptionalMillis(value any) string {
	if millis, ok := value.(int64); ok && millis > 0 {
		return formatMillis(millis)
	}
	return ""
}

// ExpireLeases performs conservative recovery after a worker disappears:
// pending permissions expire and unfinished runs become explicitly interrupted.
// It never assumes that a physical agent can be resumed.
func (s *Store) ExpireLeases() ([]Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	now := time.Now().UTC().Truncate(time.Millisecond)
	nowMs := now.UnixMilli()
	rows, err := tx.Query(`SELECT l.session_id, s.workstream_id FROM leases l JOIN sessions s ON s.id = l.session_id WHERE l.expires_at <= ?`, nowMs)
	if err != nil {
		return nil, err
	}
	type expiredLease struct{ sessionID, workstreamID string }
	expired := []expiredLease{}
	for rows.Next() {
		var item expiredLease
		if err := rows.Scan(&item.sessionID, &item.workstreamID); err != nil {
			_ = rows.Close()
			return nil, err
		}
		expired = append(expired, item)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	interrupted := []Run{}
	for _, lease := range expired {
		activeRows, err := tx.Query(runSelect+` WHERE session_id = ? AND status IN ('preparing', 'running', 'waiting_permission', 'waiting_input')`, lease.sessionID)
		if err != nil {
			return nil, err
		}
		for activeRows.Next() {
			run, err := scanRun(activeRows)
			if err != nil {
				_ = activeRows.Close()
				return nil, err
			}
			if _, err := updateRunStatusTx(tx, run, "interrupted", nowMs, "worker lease expired"); err != nil {
				_ = activeRows.Close()
				return nil, err
			}
			if _, err := appendEvent(tx, Event{Type: "run.interrupted", WorkstreamID: run.WorkstreamID, NotebookID: run.NotebookID,
				CellID: run.CellID, RunID: run.ID, SessionID: run.SessionID}, nowMs, map[string]any{"reason": "worker lease expired"}); err != nil {
				_ = activeRows.Close()
				return nil, err
			}
			if _, err := expirePendingInputsTx(tx, run, lease.sessionID, nowMs, "worker lease expired"); err != nil {
				_ = activeRows.Close()
				return nil, err
			}
			run.Status, run.FinishedAt, run.FailureReason, run.Version = "interrupted", formatMillis(nowMs), "worker lease expired", run.Version+1
			interrupted = append(interrupted, run)
		}
		if err := activeRows.Close(); err != nil {
			return nil, err
		}
		pendingPermissions, err := tx.Query(permissionSelect+` WHERE session_id = ? AND state = 'pending'`, lease.sessionID)
		if err != nil {
			return nil, err
		}
		pending := []Permission{}
		for pendingPermissions.Next() {
			permission, err := scanPermission(pendingPermissions)
			if err != nil {
				_ = pendingPermissions.Close()
				return nil, err
			}
			pending = append(pending, permission)
		}
		if err := pendingPermissions.Close(); err != nil {
			return nil, err
		}
		for _, permission := range pending {
			if _, err := tx.Exec(`UPDATE permissions SET state = 'expired', resolved_at = ?, version = version + 1 WHERE id = ? AND state = 'pending'`, nowMs, permission.ID); err != nil {
				return nil, err
			}
			if _, err := appendEvent(tx, Event{Type: "permission.expired", WorkstreamID: lease.workstreamID, RunID: permission.RunID,
				SessionID: lease.sessionID}, nowMs, map[string]any{"permission_id": permission.ID, "reason": "worker lease expired"}); err != nil {
				return nil, err
			}
		}
		if _, err := tx.Exec(`UPDATE sessions SET state = 'warm', version = version + 1 WHERE id = ?`, lease.sessionID); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(`DELETE FROM leases WHERE session_id = ?`, lease.sessionID); err != nil {
			return nil, err
		}
		if _, err := appendEvent(tx, Event{Type: "lease.expired", WorkstreamID: lease.workstreamID, SessionID: lease.sessionID}, nowMs, nil); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return interrupted, nil
}

func (s *Store) putArtifactBytes(kind, mediaType string, data []byte) (Artifact, error) {
	kind, mediaType = strings.TrimSpace(kind), strings.TrimSpace(mediaType)
	if kind == "" || mediaType == "" {
		return Artifact{}, errors.New("artifact kind and media type are required")
	}
	digest := sha256.Sum256(data)
	hexDigest := hex.EncodeToString(digest[:])
	path := filepath.Join(s.root, StateDirName, "objects", "sha256", hexDigest[:2], hexDigest[2:])
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return Artifact{}, fmt.Errorf("create artifact directory: %w", err)
	}
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		temp, err := os.CreateTemp(filepath.Dir(path), ".artifact-*")
		if err != nil {
			return Artifact{}, fmt.Errorf("create artifact: %w", err)
		}
		name := temp.Name()
		defer func() { _ = os.Remove(name) }()
		if _, err := temp.Write(data); err != nil {
			_ = temp.Close()
			return Artifact{}, fmt.Errorf("write artifact: %w", err)
		}
		if err := temp.Chmod(0o600); err != nil {
			_ = temp.Close()
			return Artifact{}, fmt.Errorf("protect artifact: %w", err)
		}
		if err := temp.Close(); err != nil {
			return Artifact{}, fmt.Errorf("close artifact: %w", err)
		}
		if err := os.Rename(name, path); err != nil && !errors.Is(err, os.ErrExist) {
			return Artifact{}, fmt.Errorf("store artifact: %w", err)
		}
	} else if err != nil {
		return Artifact{}, fmt.Errorf("stat artifact: %w", err)
	}
	id, err := prefixedUUID("art_")
	if err != nil {
		return Artifact{}, err
	}
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	return Artifact{ID: id, Kind: kind, SHA256: hexDigest, MediaType: mediaType, ByteCount: int64(len(data)), CreatedAt: formatMillis(nowMs)}, nil
}

// freezeContextItems hashes the exact Node-resolved bytes before Run creation.
// Keeping both the content object and its manifest local to this function makes
// it impossible for a worker to substitute a same-named file after dispatch.
func (s *Store) freezeContextItems(inputs []ContextItemInput) ([]map[string]any, []Artifact, error) {
	if len(inputs) == 0 {
		return nil, nil, nil
	}
	if len(inputs) > 256 {
		return nil, nil, errors.New("run context contains more than 256 items")
	}
	items := make([]map[string]any, 0, len(inputs))
	artifacts := make([]Artifact, 0, len(inputs))
	var total int64
	for index, input := range inputs {
		ref, resolvedURI := strings.TrimSpace(input.Ref), strings.TrimSpace(input.ResolvedURI)
		if ref == "" || resolvedURI == "" {
			return nil, nil, fmt.Errorf("context item %d requires ref and resolved uri", index)
		}
		bytes, err := base64.StdEncoding.DecodeString(strings.TrimSpace(input.ContentBase64))
		if err != nil {
			return nil, nil, fmt.Errorf("decode context item %d: %w", index, err)
		}
		total += int64(len(bytes))
		if total > 64*1024 {
			return nil, nil, errors.New("run context exceeds the 64 KiB injection limit")
		}
		mediaType := strings.TrimSpace(input.MediaType)
		if mediaType == "" {
			mediaType = "text/plain; charset=utf-8"
		}
		artifact, err := s.putArtifactBytes("context-item", mediaType, bytes)
		if err != nil {
			return nil, nil, err
		}
		items = append(items, map[string]any{
			"ref": ref, "resolved_uri": resolvedURI, "sha256": artifact.SHA256,
			"bytes": artifact.ByteCount, "truncated": input.Truncated,
		})
		artifacts = append(artifacts, artifact)
	}
	return items, artifacts, nil
}

func ensureArtifactTx(tx *sql.Tx, artifact Artifact) (Artifact, error) {
	if artifact.ID == "" {
		return Artifact{}, errors.New("artifact id is required")
	}
	var existingID string
	err := tx.QueryRow(`SELECT id FROM artifacts WHERE kind = ? AND sha256 = ?`, artifact.Kind, artifact.SHA256).Scan(&existingID)
	if err == nil {
		artifact.ID = existingID
		return artifact, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Artifact{}, err
	}
	_, err = tx.Exec(`INSERT INTO artifacts(id, kind, sha256, media_type, byte_count, created_at) VALUES(?, ?, ?, ?, ?, ?)`,
		artifact.ID, artifact.Kind, artifact.SHA256, artifact.MediaType, artifact.ByteCount, parseMillis(artifact.CreatedAt))
	if err != nil {
		return Artifact{}, err
	}
	return artifact, nil
}

func parseMillis(value string) int64 {
	parsed, err := time.Parse("2006-01-02T15:04:05.000Z07:00", value)
	if err != nil {
		return time.Now().UTC().UnixMilli()
	}
	return parsed.UnixMilli()
}
