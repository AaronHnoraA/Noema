// Noema research orchestration is Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package research

// This file owns the Phase F Task/Job/Invocation/Worker/Delegation authority.
// Adapters may ask for work, but only this store may claim it, freeze an
// Invocation, account inference, fence completion with a lease, or decide
// whether a failed attempt is safe to replay.

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

const maxOrchestrationJSONBytes = 1024 * 1024

var orchestrationNamePattern = regexp.MustCompile(`^[a-z][a-z0-9._:-]{0,127}$`)

var taskStates = map[string]bool{
	"open": true, "blocked": true, "completed": true, "cancelled": true,
}

var workerKinds = map[string]bool{
	"deterministic": true, "pi": true, "pi-orchestrator": true, "acp": true,
	"jupyter": true, "remote": true, "compatibility": true,
}

var workerStates = map[string]bool{"available": true, "draining": true, "offline": true}

var jobStates = map[string]bool{
	"queued": true, "claimed": true, "running": true, "input_required": true,
	"permission_required": true, "completed": true, "failed": true,
	"orphaned": true, "cancelled": true,
}

var inferencePolicies = map[string]bool{"forbidden": true, "optional": true, "required": true}

var effectClasses = map[string]bool{
	"pure": true, "idempotent": true, "derived-state-write": true,
	"workspace-mutating": true, "external-mutating": true, "unknown": true,
}

var retryPolicies = map[string]bool{"none": true, "safe_only": true, "manual": true}

// Task is a durable semantic objective. It is deliberately distinct from a
// notebook Work cell and from the legacy kernel/task indexing queue.
type Task struct {
	ID                 string   `json:"id"`
	ClientRequestID    string   `json:"clientRequestId"`
	WorkstreamID       string   `json:"workstreamId"`
	ParentTaskID       string   `json:"parentTaskId,omitempty"`
	Title              string   `json:"title"`
	Objective          string   `json:"objective"`
	AcceptanceCriteria []any    `json:"acceptanceCriteria"`
	State              string   `json:"state"`
	Priority           int      `json:"priority"`
	Disclosure         string   `json:"disclosure"`
	CreatedBy          string   `json:"createdBy"`
	OriginProposalID   string   `json:"originProposalId,omitempty"`
	CreatedAt          string   `json:"createdAt"`
	UpdatedAt          string   `json:"updatedAt"`
	Version            int64    `json:"version"`
	DependsOn          []string `json:"dependsOn"`
}

type TaskSpec struct {
	ID                 string   `json:"id"`
	ParentTaskID       string   `json:"parentTaskId"`
	Title              string   `json:"title"`
	Objective          string   `json:"objective"`
	AcceptanceCriteria []any    `json:"acceptanceCriteria"`
	State              string   `json:"state"`
	Priority           int      `json:"priority"`
	Disclosure         string   `json:"disclosure"`
	DependsOn          []string `json:"dependsOn"`
}

type CreateTaskInput struct {
	ClientRequestID string   `json:"clientRequestId"`
	WorkstreamID    string   `json:"workstreamId"`
	Task            TaskSpec `json:"task"`
	CreatedBy       string   `json:"createdBy"`
}

type TaskFilter struct {
	WorkstreamID string
	State        string
	Limit        int
	IncludeLocal bool
}

type TransitionTaskInput struct {
	TaskID          string `json:"taskId"`
	State           string `json:"state"`
	ExpectedVersion int64  `json:"expectedVersion"`
	ChangedBy       string `json:"changedBy"`
	Reason          string `json:"reason"`
}

type Worker struct {
	ID               string   `json:"id"`
	Kind             string   `json:"kind"`
	Profile          string   `json:"profile,omitempty"`
	Transport        string   `json:"transport"`
	Capabilities     []string `json:"capabilities"`
	InferenceCapable bool     `json:"inferenceCapable"`
	State            string   `json:"state"`
	RegisteredAt     string   `json:"registeredAt"`
	LastSeenAt       string   `json:"lastSeenAt"`
	Version          int64    `json:"version"`
}

type RegisterWorkerInput struct {
	ID               string   `json:"id"`
	Kind             string   `json:"kind"`
	Profile          string   `json:"profile"`
	Transport        string   `json:"transport"`
	Capabilities     []string `json:"capabilities"`
	InferenceCapable bool     `json:"inferenceCapable"`
	State            string   `json:"state"`
}

type InferenceSpec struct {
	Policy            string `json:"policy"`
	LocalPreferred    bool   `json:"localPreferred"`
	MinimumCapability string `json:"minimumCapability"`
}

type EffectSpec struct {
	Class string `json:"class"`
}

type BudgetSpec struct {
	InputTokensMax           int64   `json:"inputTokensMax"`
	OutputTokensMax          int64   `json:"outputTokensMax"`
	CostUSDMax               float64 `json:"costUsdMax"`
	WallTimeSecondsMax       int64   `json:"wallTimeSecondsMax"`
	RemoteDisclosureBytesMax int64   `json:"remoteDisclosureBytesMax"`
}

type RetrySpec struct {
	Policy      string `json:"policy"`
	AttemptsMax int    `json:"attemptsMax"`
}

type JobSpec struct {
	ID                  string         `json:"id"`
	TaskID              string         `json:"taskId"`
	Kind                string         `json:"kind"`
	DependsOn           []string       `json:"dependsOn"`
	Inputs              map[string]any `json:"inputs"`
	Requirements        map[string]any `json:"requirements"`
	Inference           InferenceSpec  `json:"inference"`
	Effects             EffectSpec     `json:"effects"`
	Budget              BudgetSpec     `json:"budget"`
	Retry               RetrySpec      `json:"retry"`
	CompletionCondition map[string]any `json:"completionCondition"`
}

type CreateJobInput struct {
	ClientRequestID string  `json:"clientRequestId"`
	WorkstreamID    string  `json:"workstreamId"`
	Job             JobSpec `json:"job"`
	CreatedBy       string  `json:"createdBy"`
}

type Job struct {
	ID                  string         `json:"id"`
	ClientRequestID     string         `json:"clientRequestId"`
	WorkstreamID        string         `json:"workstreamId"`
	TaskID              string         `json:"taskId"`
	Kind                string         `json:"kind"`
	DependsOn           []string       `json:"dependsOn"`
	State               string         `json:"state"`
	Inputs              map[string]any `json:"inputs"`
	Requirements        map[string]any `json:"requirements"`
	Inference           InferenceSpec  `json:"inference"`
	Effects             EffectSpec     `json:"effects"`
	Budget              BudgetSpec     `json:"budget"`
	Retry               RetrySpec      `json:"retry"`
	AttemptsStarted     int            `json:"attemptsStarted"`
	DeterministicState  string         `json:"deterministicState"`
	CompletionCondition map[string]any `json:"completionCondition"`
	OriginProposalID    string         `json:"originProposalId,omitempty"`
	CreatedBy           string         `json:"createdBy"`
	CreatedAt           string         `json:"createdAt"`
	UpdatedAt           string         `json:"updatedAt"`
	FinishedAt          string         `json:"finishedAt,omitempty"`
	FailureReason       string         `json:"failureReason,omitempty"`
	LeaseEpoch          int64          `json:"leaseEpoch"`
	Version             int64          `json:"version"`
}

type JobFilter struct {
	WorkstreamID string
	TaskID       string
	State        string
	Limit        int
}

const taskSelect = `SELECT id, client_request_id, workstream_id, COALESCE(parent_task_id, ''), title, objective,
	acceptance_criteria_json, state, priority, disclosure, created_by, origin_proposal_id, created_at, updated_at, version FROM tasks`

const workerSelect = `SELECT id, kind, profile, transport, capabilities_json, inference_capable, state,
	registered_at, last_seen_at, version FROM workers`

const jobSelect = `SELECT id, client_request_id, workstream_id, task_id, kind, state, inputs_json,
	requirements_json, inference_policy, local_preferred, minimum_capability, effect_class, budget_json,
	retry_policy, attempts_max, attempts_started, deterministic_state, completion_condition_json,
	origin_proposal_id, created_by, created_at, updated_at, COALESCE(finished_at, 0), failure_reason,
	lease_epoch, version FROM jobs`

func orchestrationRequestDigest(kind string, value any) (string, error) {
	_, digest, err := canonicalJSON(map[string]any{"schema": "noema.orchestration-request/1", "kind": kind, "value": value})
	return digest, err
}

func matchingRequestDigestTx(tx *sql.Tx, query, requestID, digest, noun string) (bool, error) {
	var stored string
	err := tx.QueryRow(query, requestID).Scan(&stored)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if stored == "" || stored != digest {
		return false, fmt.Errorf("%s request id was already used for different content", noun)
	}
	return true, nil
}

func (s *Store) CreateTask(input CreateTaskInput) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Task{}, err
	}
	defer func() { _ = tx.Rollback() }()
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	task, err := createTaskTx(tx, input, "", nowMs)
	if err != nil {
		return Task{}, err
	}
	if err := tx.Commit(); err != nil {
		return Task{}, err
	}
	return task, nil
}

func createTaskTx(tx *sql.Tx, input CreateTaskInput, proposalID string, nowMs int64) (Task, error) {
	input.ClientRequestID = strings.TrimSpace(input.ClientRequestID)
	input.WorkstreamID, input.CreatedBy = strings.TrimSpace(input.WorkstreamID), strings.TrimSpace(input.CreatedBy)
	if input.ClientRequestID == "" || len(input.ClientRequestID) > 200 || !strings.HasPrefix(input.WorkstreamID, "ws_") ||
		input.CreatedBy == "" || len(input.CreatedBy) > 200 {
		return Task{}, errors.New("task requires a bounded request id, workstream, and creator")
	}
	spec := input.Task
	spec.ID, spec.ParentTaskID = strings.TrimSpace(spec.ID), strings.TrimSpace(spec.ParentTaskID)
	spec.Title, spec.Objective = strings.TrimSpace(spec.Title), strings.TrimSpace(spec.Objective)
	spec.State, spec.Disclosure = strings.TrimSpace(spec.State), strings.TrimSpace(spec.Disclosure)
	if spec.ID != "" && (!strings.HasPrefix(spec.ID, "task_") || !orchestrationNamePattern.MatchString(spec.ID)) {
		return Task{}, errors.New("task id is invalid")
	}
	if spec.Title == "" || len(spec.Title) > 500 || spec.Objective == "" || len(spec.Objective) > 65536 {
		return Task{}, errors.New("task title and objective are required and bounded")
	}
	if spec.State == "" {
		spec.State = "open"
	}
	if !taskStates[spec.State] || spec.Priority < -100 || spec.Priority > 100 {
		return Task{}, errors.New("task state or priority is invalid")
	}
	if spec.Disclosure == "" {
		spec.Disclosure = "project"
	}
	if spec.Disclosure != "project" && spec.Disclosure != "local_only" {
		return Task{}, errors.New("task disclosure must be project or local_only")
	}
	if len(spec.AcceptanceCriteria) > 128 {
		return Task{}, errors.New("task has too many acceptance criteria")
	}
	if spec.AcceptanceCriteria == nil {
		spec.AcceptanceCriteria = []any{}
	}
	criteriaJSON, _, err := canonicalJSON(spec.AcceptanceCriteria)
	if err != nil || len(criteriaJSON) > maxOrchestrationJSONBytes {
		return Task{}, errors.New("task acceptance criteria are invalid or too large")
	}
	for _, dependency := range spec.DependsOn {
		dependency = strings.TrimSpace(dependency)
		if !strings.HasPrefix(dependency, "task_") || len(dependency) > 160 {
			return Task{}, errors.New("task dependencies are invalid or too numerous")
		}
	}
	dependencies := uniqueBoundedStrings(spec.DependsOn, 128, 160)
	if len(dependencies) != len(uniqueStrings(spec.DependsOn)) {
		return Task{}, errors.New("task dependencies are invalid or too numerous")
	}
	spec.DependsOn = dependencies
	for _, dependency := range dependencies {
		if dependency == spec.ID {
			return Task{}, errors.New("task cannot depend on itself")
		}
	}
	requestDigest, err := orchestrationRequestDigest("task.create", map[string]any{
		"workstreamId": input.WorkstreamID, "createdBy": input.CreatedBy, "originProposalId": proposalID, "task": spec,
	})
	if err != nil {
		return Task{}, err
	}
	matched, err := matchingRequestDigestTx(tx, `SELECT request_sha256 FROM tasks WHERE client_request_id = ?`,
		input.ClientRequestID, requestDigest, "task")
	if err != nil {
		return Task{}, err
	}
	if matched {
		prior, err := scanTask(tx.QueryRow(taskSelect+` WHERE client_request_id = ?`, input.ClientRequestID))
		if err != nil {
			return Task{}, err
		}
		return attachTaskEdgesTx(tx, prior)
	}
	var workstream string
	if err := tx.QueryRow(`SELECT id FROM workstreams WHERE id = ?`, input.WorkstreamID).Scan(&workstream); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Task{}, fmt.Errorf("workstream %q not found", input.WorkstreamID)
		}
		return Task{}, err
	}
	if spec.ID == "" {
		spec.ID, err = prefixedUUID("task_")
		if err != nil {
			return Task{}, err
		}
	}
	if spec.ParentTaskID != "" {
		if err := requireTaskWorkstreamTx(tx, spec.ParentTaskID, input.WorkstreamID); err != nil {
			return Task{}, err
		}
	}
	for _, dependency := range dependencies {
		if err := requireTaskWorkstreamTx(tx, dependency, input.WorkstreamID); err != nil {
			return Task{}, err
		}
	}
	if _, err := tx.Exec(`INSERT INTO tasks(id, client_request_id, request_sha256, workstream_id, parent_task_id, title, objective,
		acceptance_criteria_json, state, priority, disclosure, created_by, origin_proposal_id, created_at, updated_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, spec.ID, input.ClientRequestID, requestDigest, input.WorkstreamID,
		nullable(spec.ParentTaskID), spec.Title, spec.Objective, string(criteriaJSON), spec.State, spec.Priority,
		spec.Disclosure, input.CreatedBy, proposalID, nowMs, nowMs); err != nil {
		return Task{}, err
	}
	if spec.ParentTaskID != "" {
		if _, err := tx.Exec(`INSERT INTO task_edges(parent_task_id, child_task_id, type, created_at)
			VALUES(?, ?, 'decomposes', ?)`, spec.ParentTaskID, spec.ID, nowMs); err != nil {
			return Task{}, err
		}
	}
	for _, dependency := range dependencies {
		if _, err := tx.Exec(`INSERT INTO task_edges(parent_task_id, child_task_id, type, created_at)
			VALUES(?, ?, 'depends', ?)`, dependency, spec.ID, nowMs); err != nil {
			return Task{}, err
		}
	}
	task := Task{ID: spec.ID, ClientRequestID: input.ClientRequestID, WorkstreamID: input.WorkstreamID,
		ParentTaskID: spec.ParentTaskID, Title: spec.Title, Objective: spec.Objective,
		AcceptanceCriteria: spec.AcceptanceCriteria, State: spec.State, Priority: spec.Priority,
		Disclosure: spec.Disclosure, CreatedBy: input.CreatedBy, OriginProposalID: proposalID,
		CreatedAt: formatMillis(nowMs), UpdatedAt: formatMillis(nowMs), Version: 1, DependsOn: dependencies}
	if _, err := appendEvent(tx, Event{Type: "task.created", WorkstreamID: input.WorkstreamID}, nowMs,
		map[string]any{"task_id": task.ID, "parent_task_id": task.ParentTaskID, "created_by": task.CreatedBy,
			"origin_proposal_id": proposalID, "disclosure": task.Disclosure}); err != nil {
		return Task{}, err
	}
	return task, nil
}

func (s *Store) GetTask(id string) (Task, error) {
	task, err := scanTask(s.db.QueryRow(taskSelect+` WHERE id = ?`, strings.TrimSpace(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, fmt.Errorf("task %q not found", id)
	}
	if err != nil {
		return Task{}, err
	}
	return s.attachTaskEdges(task)
}

func (s *Store) ListTasks(filter TaskFilter) ([]Task, error) {
	limit := filter.Limit
	if limit < 1 || limit > 1000 {
		limit = 200
	}
	query, args := taskSelect+` WHERE 1 = 1`, []any{}
	if value := strings.TrimSpace(filter.WorkstreamID); value != "" {
		query += ` AND workstream_id = ?`
		args = append(args, value)
	}
	if value := strings.TrimSpace(filter.State); value != "" {
		if !taskStates[value] {
			return nil, errors.New("task state is invalid")
		}
		query += ` AND state = ?`
		args = append(args, value)
	}
	if !filter.IncludeLocal {
		query += ` AND disclosure <> 'local_only'`
	}
	query += ` ORDER BY priority DESC, created_at, id LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Task{}
	for rows.Next() {
		task, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, task)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for index := range result {
		result[index], err = s.attachTaskEdges(result[index])
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

func (s *Store) TransitionTask(input TransitionTaskInput) (Task, error) {
	input.TaskID, input.State = strings.TrimSpace(input.TaskID), strings.TrimSpace(input.State)
	input.ChangedBy, input.Reason = strings.TrimSpace(input.ChangedBy), strings.TrimSpace(input.Reason)
	if !strings.HasPrefix(input.TaskID, "task_") || !taskStates[input.State] || input.ExpectedVersion < 1 ||
		input.ChangedBy == "" || len(input.ChangedBy) > 200 || len(input.Reason) > 4000 {
		return Task{}, errors.New("task transition is invalid")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Task{}, err
	}
	defer func() { _ = tx.Rollback() }()
	task, err := scanTask(tx.QueryRow(taskSelect+` WHERE id = ?`, input.TaskID))
	if err != nil {
		return Task{}, err
	}
	if task.Version != input.ExpectedVersion || task.State == "completed" || task.State == "cancelled" {
		return Task{}, errors.New("task transition lost optimistic concurrency or task is terminal")
	}
	if task.State == input.State {
		return Task{}, errors.New("task transition does not change state")
	}
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	updated, err := tx.Exec(`UPDATE tasks SET state = ?, updated_at = ?, version = version + 1
		WHERE id = ? AND version = ?`, input.State, nowMs, task.ID, input.ExpectedVersion)
	if err != nil {
		return Task{}, err
	}
	if count, _ := updated.RowsAffected(); count != 1 {
		return Task{}, errors.New("task transition lost optimistic concurrency")
	}
	previous := task.State
	task.State, task.UpdatedAt, task.Version = input.State, formatMillis(nowMs), task.Version+1
	if _, err := appendEvent(tx, Event{Type: "task.state.changed", WorkstreamID: task.WorkstreamID}, nowMs,
		map[string]any{"task_id": task.ID, "from": previous, "to": task.State,
			"changed_by": input.ChangedBy, "reason": input.Reason}); err != nil {
		return Task{}, err
	}
	if err := tx.Commit(); err != nil {
		return Task{}, err
	}
	return s.attachTaskEdges(task)
}

func (s *Store) RegisterWorker(input RegisterWorkerInput) (Worker, error) {
	input.ID, input.Kind = strings.TrimSpace(input.ID), strings.TrimSpace(input.Kind)
	input.Profile, input.Transport, input.State = strings.TrimSpace(input.Profile), strings.TrimSpace(input.Transport), strings.TrimSpace(input.State)
	if input.State == "" {
		input.State = "available"
	}
	if !strings.HasPrefix(input.ID, "worker:") || len(input.ID) > 200 || !workerKinds[input.Kind] ||
		input.Transport == "" || len(input.Transport) > 100 || len(input.Profile) > 100 || !workerStates[input.State] {
		return Worker{}, errors.New("worker identity, kind, transport, or state is invalid")
	}
	capabilities := uniqueBoundedStrings(input.Capabilities, 256, 160)
	if len(capabilities) != len(uniqueStrings(input.Capabilities)) {
		return Worker{}, errors.New("worker capabilities are invalid or too numerous")
	}
	capabilitiesJSON, _, _ := canonicalJSON(capabilities)
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Worker{}, err
	}
	defer func() { _ = tx.Rollback() }()
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	prior, err := scanWorker(tx.QueryRow(workerSelect+` WHERE id = ?`, input.ID))
	if err == nil {
		if prior.Kind != input.Kind || prior.Profile != input.Profile || prior.Transport != input.Transport ||
			prior.InferenceCapable != input.InferenceCapable || strings.Join(prior.Capabilities, "\x00") != strings.Join(capabilities, "\x00") {
			return Worker{}, errors.New("logical worker identity is already registered with a different immutable profile")
		}
		if _, err := tx.Exec(`UPDATE workers SET state = ?, last_seen_at = ?, version = version + 1 WHERE id = ?`,
			input.State, nowMs, input.ID); err != nil {
			return Worker{}, err
		}
		prior.State, prior.LastSeenAt, prior.Version = input.State, formatMillis(nowMs), prior.Version+1
		if err := tx.Commit(); err != nil {
			return Worker{}, err
		}
		return prior, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Worker{}, err
	}
	if _, err := tx.Exec(`INSERT INTO workers(id, kind, profile, transport, capabilities_json,
		inference_capable, state, registered_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		input.ID, input.Kind, input.Profile, input.Transport, string(capabilitiesJSON), input.InferenceCapable,
		input.State, nowMs, nowMs); err != nil {
		return Worker{}, err
	}
	worker := Worker{ID: input.ID, Kind: input.Kind, Profile: input.Profile, Transport: input.Transport,
		Capabilities: capabilities, InferenceCapable: input.InferenceCapable, State: input.State,
		RegisteredAt: formatMillis(nowMs), LastSeenAt: formatMillis(nowMs), Version: 1}
	if _, err := appendEvent(tx, Event{Type: "worker.registered"}, nowMs,
		map[string]any{"worker_id": worker.ID, "kind": worker.Kind, "profile": worker.Profile,
			"transport": worker.Transport, "inference_capable": worker.InferenceCapable}); err != nil {
		return Worker{}, err
	}
	if err := tx.Commit(); err != nil {
		return Worker{}, err
	}
	return worker, nil
}

func (s *Store) GetWorker(id string) (Worker, error) {
	worker, err := scanWorker(s.db.QueryRow(workerSelect+` WHERE id = ?`, strings.TrimSpace(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return Worker{}, fmt.Errorf("worker %q not found", id)
	}
	return worker, err
}

func (s *Store) ListWorkers(state string, limit int) ([]Worker, error) {
	if limit < 1 || limit > 1000 {
		limit = 200
	}
	query, args := workerSelect+` WHERE 1 = 1`, []any{}
	if state = strings.TrimSpace(state); state != "" {
		if !workerStates[state] {
			return nil, errors.New("worker state is invalid")
		}
		query += ` AND state = ?`
		args = append(args, state)
	}
	query += ` ORDER BY last_seen_at DESC, id LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	workers := []Worker{}
	for rows.Next() {
		worker, err := scanWorker(rows)
		if err != nil {
			return nil, err
		}
		workers = append(workers, worker)
	}
	return workers, rows.Err()
}

func (s *Store) CreateJob(input CreateJobInput) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Job{}, err
	}
	defer func() { _ = tx.Rollback() }()
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	job, err := createJobTx(tx, input, "", nowMs)
	if err != nil {
		return Job{}, err
	}
	if err := tx.Commit(); err != nil {
		return Job{}, err
	}
	return job, nil
}

func createJobTx(tx *sql.Tx, input CreateJobInput, proposalID string, nowMs int64) (Job, error) {
	input.ClientRequestID = strings.TrimSpace(input.ClientRequestID)
	input.WorkstreamID, input.CreatedBy = strings.TrimSpace(input.WorkstreamID), strings.TrimSpace(input.CreatedBy)
	if input.ClientRequestID == "" || len(input.ClientRequestID) > 200 || !strings.HasPrefix(input.WorkstreamID, "ws_") ||
		input.CreatedBy == "" || len(input.CreatedBy) > 200 {
		return Job{}, errors.New("job requires a bounded request id, workstream, and creator")
	}
	spec := input.Job
	spec.ID, spec.TaskID, spec.Kind = strings.TrimSpace(spec.ID), strings.TrimSpace(spec.TaskID), strings.TrimSpace(spec.Kind)
	if (spec.ID != "" && (!strings.HasPrefix(spec.ID, "job_") || !orchestrationNamePattern.MatchString(spec.ID))) ||
		!strings.HasPrefix(spec.TaskID, "task_") || spec.Kind == "" || len(spec.Kind) > 160 {
		return Job{}, errors.New("job id, task, or kind is invalid")
	}
	spec.Inference.Policy = strings.TrimSpace(spec.Inference.Policy)
	spec.Inference.MinimumCapability = strings.TrimSpace(spec.Inference.MinimumCapability)
	if !inferencePolicies[spec.Inference.Policy] || len(spec.Inference.MinimumCapability) > 160 {
		return Job{}, errors.New("job inference policy is invalid")
	}
	spec.Effects.Class = strings.TrimSpace(spec.Effects.Class)
	if !effectClasses[spec.Effects.Class] {
		return Job{}, errors.New("job effect class is invalid")
	}
	spec.Retry.Policy = strings.TrimSpace(spec.Retry.Policy)
	if spec.Retry.Policy == "" {
		spec.Retry.Policy = "none"
	}
	if spec.Retry.AttemptsMax == 0 {
		spec.Retry.AttemptsMax = 1
	}
	if !retryPolicies[spec.Retry.Policy] || spec.Retry.AttemptsMax < 1 || spec.Retry.AttemptsMax > 100 {
		return Job{}, errors.New("job retry policy is invalid")
	}
	if spec.Inference.Policy == "optional" && spec.Retry.AttemptsMax < 2 {
		return Job{}, errors.New("optional inference jobs need at least two attempts for deterministic-first execution")
	}
	if err := validateBudget(spec.Budget); err != nil {
		return Job{}, err
	}
	if spec.Inputs == nil {
		spec.Inputs = map[string]any{}
	}
	if spec.Requirements == nil {
		spec.Requirements = map[string]any{}
	}
	if spec.CompletionCondition == nil {
		spec.CompletionCondition = map[string]any{}
	}
	for _, dependency := range spec.DependsOn {
		dependency = strings.TrimSpace(dependency)
		if !strings.HasPrefix(dependency, "job_") || len(dependency) > 200 {
			return Job{}, errors.New("job dependencies are invalid or too numerous")
		}
	}
	dependencies := uniqueBoundedStrings(spec.DependsOn, 256, 200)
	if len(dependencies) != len(uniqueStrings(spec.DependsOn)) {
		return Job{}, errors.New("job dependencies are invalid or too numerous")
	}
	spec.DependsOn = dependencies
	for _, dependency := range dependencies {
		if dependency == spec.ID {
			return Job{}, errors.New("job cannot depend on itself")
		}
	}
	capabilities := uniqueBoundedStrings(jsonStringArray(spec.Requirements["capabilities"]), 256, 160)
	if len(capabilities) != len(uniqueStrings(jsonStringArray(spec.Requirements["capabilities"]))) {
		return Job{}, errors.New("job capability requirements are invalid or too numerous")
	}
	spec.Requirements["capabilities"] = capabilities
	inputsJSON, _, inputsErr := canonicalJSON(spec.Inputs)
	requirementsJSON, _, requirementsErr := canonicalJSON(spec.Requirements)
	budgetJSON, _, budgetErr := canonicalJSON(spec.Budget)
	completionJSON, _, completionErr := canonicalJSON(spec.CompletionCondition)
	if inputsErr != nil || requirementsErr != nil || budgetErr != nil || completionErr != nil ||
		len(inputsJSON)+len(requirementsJSON)+len(budgetJSON)+len(completionJSON) > maxOrchestrationJSONBytes {
		return Job{}, errors.New("job specification is invalid or too large")
	}
	requestDigest, err := orchestrationRequestDigest("job.create", map[string]any{
		"workstreamId": input.WorkstreamID, "createdBy": input.CreatedBy, "originProposalId": proposalID, "job": spec,
	})
	if err != nil {
		return Job{}, err
	}
	matched, err := matchingRequestDigestTx(tx, `SELECT request_sha256 FROM jobs WHERE client_request_id = ?`,
		input.ClientRequestID, requestDigest, "job")
	if err != nil {
		return Job{}, err
	}
	if matched {
		prior, err := scanJob(tx.QueryRow(jobSelect+` WHERE client_request_id = ?`, input.ClientRequestID))
		if err != nil {
			return Job{}, err
		}
		return attachJobDependenciesTx(tx, prior)
	}
	if err := requireTaskWorkstreamTx(tx, spec.TaskID, input.WorkstreamID); err != nil {
		return Job{}, err
	}
	if spec.ID == "" {
		spec.ID, err = prefixedUUID("job_")
		if err != nil {
			return Job{}, err
		}
	}
	for _, dependency := range dependencies {
		var dependencyWorkstream string
		if err := tx.QueryRow(`SELECT workstream_id FROM jobs WHERE id = ?`, dependency).Scan(&dependencyWorkstream); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return Job{}, fmt.Errorf("job dependency %q not found", dependency)
			}
			return Job{}, err
		}
		if dependencyWorkstream != input.WorkstreamID {
			return Job{}, errors.New("job dependency belongs to another workstream")
		}
	}
	deterministicState := "pending"
	if spec.Inference.Policy == "required" {
		deterministicState = "not_applicable"
	}
	if _, err := tx.Exec(`INSERT INTO jobs(id, client_request_id, request_sha256, workstream_id, task_id, kind, state, inputs_json,
		requirements_json, inference_policy, local_preferred, minimum_capability, effect_class, budget_json,
		retry_policy, attempts_max, deterministic_state, completion_condition_json, origin_proposal_id,
		created_by, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		spec.ID, input.ClientRequestID, requestDigest, input.WorkstreamID, spec.TaskID, spec.Kind, string(inputsJSON),
		string(requirementsJSON), spec.Inference.Policy, spec.Inference.LocalPreferred,
		spec.Inference.MinimumCapability, spec.Effects.Class, string(budgetJSON), spec.Retry.Policy,
		spec.Retry.AttemptsMax, deterministicState, string(completionJSON), proposalID, input.CreatedBy, nowMs, nowMs); err != nil {
		return Job{}, err
	}
	for _, dependency := range dependencies {
		if _, err := tx.Exec(`INSERT INTO job_dependencies(job_id, dependency_job_id, created_at) VALUES(?, ?, ?)`,
			spec.ID, dependency, nowMs); err != nil {
			return Job{}, err
		}
	}
	job := Job{ID: spec.ID, ClientRequestID: input.ClientRequestID, WorkstreamID: input.WorkstreamID,
		TaskID: spec.TaskID, Kind: spec.Kind, DependsOn: dependencies, State: "queued", Inputs: spec.Inputs, Requirements: spec.Requirements,
		Inference: spec.Inference, Effects: spec.Effects, Budget: spec.Budget, Retry: spec.Retry,
		DeterministicState: deterministicState, CompletionCondition: spec.CompletionCondition,
		OriginProposalID: proposalID, CreatedBy: input.CreatedBy, CreatedAt: formatMillis(nowMs),
		UpdatedAt: formatMillis(nowMs), Version: 1}
	if _, err := appendEvent(tx, Event{Type: "job.queued", WorkstreamID: input.WorkstreamID}, nowMs,
		map[string]any{"job_id": job.ID, "task_id": job.TaskID, "kind": job.Kind,
			"inference_policy": job.Inference.Policy, "effect_class": job.Effects.Class,
			"origin_proposal_id": proposalID}); err != nil {
		return Job{}, err
	}
	return job, nil
}

func (s *Store) GetJob(id string) (Job, error) {
	job, err := scanJob(s.db.QueryRow(jobSelect+` WHERE id = ?`, strings.TrimSpace(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, fmt.Errorf("job %q not found", id)
	}
	if err != nil {
		return Job{}, err
	}
	return s.attachJobDependencies(job)
}

func (s *Store) ListJobs(filter JobFilter) ([]Job, error) {
	limit := filter.Limit
	if limit < 1 || limit > 1000 {
		limit = 200
	}
	query, args := jobSelect+` WHERE 1 = 1`, []any{}
	if value := strings.TrimSpace(filter.WorkstreamID); value != "" {
		query += ` AND workstream_id = ?`
		args = append(args, value)
	}
	if value := strings.TrimSpace(filter.TaskID); value != "" {
		query += ` AND task_id = ?`
		args = append(args, value)
	}
	if value := strings.TrimSpace(filter.State); value != "" {
		if !jobStates[value] {
			return nil, errors.New("job state is invalid")
		}
		query += ` AND state = ?`
		args = append(args, value)
	}
	query += ` ORDER BY created_at, id LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	jobs := []Job{}
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for index := range jobs {
		jobs[index], err = s.attachJobDependencies(jobs[index])
		if err != nil {
			return nil, err
		}
	}
	return jobs, nil
}

// Invocation freezes one concrete attempt. Its specification row is never
// updated; terminal observations live in invocation_results.
type Invocation struct {
	ID                  string            `json:"id"`
	ClaimRequestID      string            `json:"claimRequestId"`
	JobID               string            `json:"jobId"`
	Attempt             int               `json:"attempt"`
	WorkerID            string            `json:"workerId"`
	WorkerSnapshot      map[string]any    `json:"workerSnapshot"`
	ExecutionMode       string            `json:"executionMode"`
	Runtime             map[string]any    `json:"runtime"`
	ResolvedResources   []any             `json:"resolvedResources"`
	ContextSnapshot     string            `json:"contextSnapshot,omitempty"`
	DisclosureView      string            `json:"disclosureView,omitempty"`
	ProblemModelVersion int64             `json:"problemModelVersion,omitempty"`
	Budget              BudgetSpec        `json:"budget"`
	PolicyHash          string            `json:"policyHash"`
	IdempotencyKey      string            `json:"idempotencyKey"`
	Spec                map[string]any    `json:"spec"`
	SpecSHA256          string            `json:"specSha256"`
	CreatedAt           string            `json:"createdAt"`
	Result              *InvocationResult `json:"result,omitempty"`
}

type InvocationResult struct {
	InvocationID   string         `json:"invocationId"`
	Status         string         `json:"status"`
	Result         map[string]any `json:"result"`
	FailureReason  string         `json:"failureReason,omitempty"`
	InputTokens    int64          `json:"inputTokens"`
	OutputTokens   int64          `json:"outputTokens"`
	CostMicrousd   int64          `json:"costMicrousd"`
	InferenceCalls int64          `json:"inferenceCalls"`
	ObservedWallMS int64          `json:"observedWallMs"`
	FinishedAt     string         `json:"finishedAt"`
}

type JobLease struct {
	JobID        string `json:"jobId"`
	InvocationID string `json:"invocationId"`
	WorkerID     string `json:"workerId"`
	Token        string `json:"token"`
	Epoch        int64  `json:"epoch"`
	AcquiredAt   string `json:"acquiredAt"`
	ExpiresAt    string `json:"expiresAt"`
}

type ClaimJobInput struct {
	JobID               string         `json:"jobId"`
	WorkerID            string         `json:"workerId"`
	ClaimRequestID      string         `json:"claimRequestId"`
	ExecutionMode       string         `json:"executionMode"`
	TTLMillis           int64          `json:"ttlMillis"`
	Runtime             map[string]any `json:"runtime"`
	ResolvedResources   []any          `json:"resolvedResources"`
	ContextSnapshot     string         `json:"contextSnapshot"`
	DisclosureView      string         `json:"disclosureView"`
	ProblemModelVersion int64          `json:"problemModelVersion"`
	Policy              map[string]any `json:"policy"`
}

type ClaimJobResult struct {
	Job        Job        `json:"job"`
	Invocation Invocation `json:"invocation"`
	Lease      JobLease   `json:"lease"`
}

type JobLeaseInput struct {
	JobID        string `json:"jobId"`
	InvocationID string `json:"invocationId"`
	WorkerID     string `json:"workerId"`
	Token        string `json:"token"`
	Epoch        int64  `json:"epoch"`
	TTLMillis    int64  `json:"ttlMillis"`
}

type JobUsage struct {
	InputTokens    int64 `json:"inputTokens"`
	OutputTokens   int64 `json:"outputTokens"`
	CostMicrousd   int64 `json:"costMicrousd"`
	InferenceCalls int64 `json:"inferenceCalls"`
	ObservedWallMS int64 `json:"observedWallMs"`
}

type FinishJobInput struct {
	JobID        string         `json:"jobId"`
	InvocationID string         `json:"invocationId"`
	WorkerID     string         `json:"workerId"`
	Token        string         `json:"token"`
	Epoch        int64          `json:"epoch"`
	Result       map[string]any `json:"result"`
	ArtifactIDs  []string       `json:"artifactIds"`
	Usage        JobUsage       `json:"usage"`
	Reason       string         `json:"reason"`
}

type FinishJobResult struct {
	Job        Job        `json:"job"`
	Invocation Invocation `json:"invocation"`
	Requeued   bool       `json:"requeued"`
	Artifacts  []string   `json:"artifactIds"`
}

type RetryJobInput struct {
	JobID           string `json:"jobId"`
	ExpectedVersion int64  `json:"expectedVersion"`
	RequestedBy     string `json:"requestedBy"`
	Reason          string `json:"reason"`
}

const invocationSelect = `SELECT id, claim_request_id, job_id, attempt, worker_id, worker_snapshot_json,
	execution_mode, runtime_json, resolved_resources_json, context_snapshot, disclosure_view,
	problem_model_version, budget_json, policy_hash, idempotency_key, spec_json, spec_sha256, created_at FROM invocations`

const invocationResultSelect = `SELECT invocation_id, status, result_json, failure_reason, input_tokens,
	output_tokens, cost_microusd, inference_calls, observed_wall_ms, finished_at FROM invocation_results`

const jobLeaseSelect = `SELECT job_id, invocation_id, worker_id, lease_token, epoch, acquired_at, expires_at FROM worker_leases`

func (s *Store) ClaimJob(input ClaimJobInput) (ClaimJobResult, error) {
	input.JobID, input.WorkerID = strings.TrimSpace(input.JobID), strings.TrimSpace(input.WorkerID)
	input.ClaimRequestID, input.ExecutionMode = strings.TrimSpace(input.ClaimRequestID), strings.TrimSpace(input.ExecutionMode)
	input.ContextSnapshot, input.DisclosureView = strings.TrimSpace(input.ContextSnapshot), strings.TrimSpace(input.DisclosureView)
	if !strings.HasPrefix(input.JobID, "job_") || !strings.HasPrefix(input.WorkerID, "worker:") ||
		input.ClaimRequestID == "" || len(input.ClaimRequestID) > 200 ||
		(input.ExecutionMode != "deterministic" && input.ExecutionMode != "inference") || input.ProblemModelVersion < 0 {
		return ClaimJobResult{}, errors.New("job claim identity or execution mode is invalid")
	}
	if len(input.ContextSnapshot) > 200 || len(input.DisclosureView) > 200 ||
		(input.ContextSnapshot != "" && !strings.HasPrefix(input.ContextSnapshot, "art_")) ||
		(input.DisclosureView != "" && !strings.HasPrefix(input.DisclosureView, "art_")) {
		return ClaimJobResult{}, errors.New("job claim context references must be bounded Artifact ids")
	}
	if input.Runtime == nil {
		input.Runtime = map[string]any{}
	}
	if input.Policy == nil {
		input.Policy = map[string]any{}
	}
	if input.ResolvedResources == nil {
		input.ResolvedResources = []any{}
	}
	if len(input.ResolvedResources) > 256 {
		return ClaimJobResult{}, errors.New("job claim has too many resolved resources")
	}
	if encoded, _, err := canonicalJSON(map[string]any{"runtime": input.Runtime, "resources": input.ResolvedResources, "policy": input.Policy}); err != nil || len(encoded) > maxOrchestrationJSONBytes {
		return ClaimJobResult{}, errors.New("job claim snapshot is invalid or too large")
	}
	ttlMillis := leaseTTL(input.TTLMillis).Milliseconds()
	claimRequestDigest, err := orchestrationRequestDigest("job.claim", map[string]any{
		"jobId": input.JobID, "workerId": input.WorkerID, "executionMode": input.ExecutionMode,
		"ttlMillis": ttlMillis, "runtime": input.Runtime, "resolvedResources": input.ResolvedResources,
		"contextSnapshot": input.ContextSnapshot, "disclosureView": input.DisclosureView,
		"problemModelVersion": input.ProblemModelVersion, "policy": input.Policy,
	})
	if err != nil {
		return ClaimJobResult{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return ClaimJobResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	matched, err := matchingRequestDigestTx(tx, `SELECT claim_request_sha256 FROM invocations WHERE claim_request_id = ?`,
		input.ClaimRequestID, claimRequestDigest, "claim")
	if err != nil {
		return ClaimJobResult{}, err
	}
	if matched {
		prior, err := scanInvocation(tx.QueryRow(invocationSelect+` WHERE claim_request_id = ?`, input.ClaimRequestID))
		if err != nil {
			return ClaimJobResult{}, err
		}
		lease, err := scanJobLease(tx.QueryRow(jobLeaseSelect+` WHERE invocation_id = ? AND expires_at > ?`, prior.ID, nowMs))
		if err != nil {
			return ClaimJobResult{}, errors.New("idempotent claim no longer has a live lease")
		}
		job, err := scanJob(tx.QueryRow(jobSelect+` WHERE id = ?`, input.JobID))
		if err != nil {
			return ClaimJobResult{}, err
		}
		job, err = attachJobDependenciesTx(tx, job)
		if err != nil {
			return ClaimJobResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return ClaimJobResult{}, err
		}
		return ClaimJobResult{Job: job, Invocation: prior, Lease: lease}, nil
	}
	job, err := scanJob(tx.QueryRow(jobSelect+` WHERE id = ?`, input.JobID))
	if errors.Is(err, sql.ErrNoRows) {
		return ClaimJobResult{}, fmt.Errorf("job %q not found", input.JobID)
	}
	if err != nil {
		return ClaimJobResult{}, err
	}
	job, err = attachJobDependenciesTx(tx, job)
	if err != nil {
		return ClaimJobResult{}, err
	}
	worker, err := scanWorker(tx.QueryRow(workerSelect+` WHERE id = ?`, input.WorkerID))
	if errors.Is(err, sql.ErrNoRows) {
		return ClaimJobResult{}, fmt.Errorf("worker %q not found", input.WorkerID)
	}
	if err != nil {
		return ClaimJobResult{}, err
	}
	if job.State != "queued" || job.AttemptsStarted >= job.Retry.AttemptsMax {
		return ClaimJobResult{}, errors.New("job is not claimable or exhausted its attempts")
	}
	var incompleteDependencies int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM job_dependencies
		JOIN jobs AS dependency ON dependency.id = job_dependencies.dependency_job_id
		WHERE job_dependencies.job_id = ? AND dependency.state <> 'completed'`, job.ID).Scan(&incompleteDependencies); err != nil {
		return ClaimJobResult{}, err
	}
	if incompleteDependencies > 0 {
		return ClaimJobResult{}, errors.New("job dependencies are not completed")
	}
	if worker.State != "available" {
		return ClaimJobResult{}, errors.New("worker is not available")
	}
	if err := authorizeExecutionMode(job, worker, input.ExecutionMode); err != nil {
		return ClaimJobResult{}, err
	}
	if err := requireCapabilities(job, worker, input.ExecutionMode); err != nil {
		return ClaimJobResult{}, err
	}
	if input.ExecutionMode == "inference" && input.DisclosureView == "" {
		return ClaimJobResult{}, errors.New("inference execution requires a frozen DisclosureView artifact")
	}
	inputArtifactIDs := map[string]bool{}
	collectArtifactRefs(input.ResolvedResources, inputArtifactIDs)
	if input.ContextSnapshot != "" {
		inputArtifactIDs[input.ContextSnapshot] = true
	}
	if input.DisclosureView != "" {
		inputArtifactIDs[input.DisclosureView] = true
	}
	orderedInputArtifactIDs := make([]string, 0, len(inputArtifactIDs))
	for artifactID := range inputArtifactIDs {
		orderedInputArtifactIDs = append(orderedInputArtifactIDs, artifactID)
	}
	sort.Strings(orderedInputArtifactIDs)
	var disclosureArtifact Artifact
	for _, artifactID := range orderedInputArtifactIDs {
		artifact, _, err := s.readArtifactTx(tx, artifactID)
		if err != nil {
			return ClaimJobResult{}, fmt.Errorf("job claim input %w", err)
		}
		if artifactID == input.DisclosureView {
			disclosureArtifact = artifact
		}
	}
	if input.ExecutionMode == "inference" && disclosureArtifact.ByteCount > job.Budget.RemoteDisclosureBytesMax {
		return ClaimJobResult{}, fmt.Errorf("DisclosureView exceeds the Job remote-disclosure budget (%d > %d bytes)",
			disclosureArtifact.ByteCount, job.Budget.RemoteDisclosureBytesMax)
	}
	if input.ProblemModelVersion > 0 {
		var found int64
		if err := tx.QueryRow(`SELECT version FROM problem_model_versions WHERE workstream_id = ? AND version = ?`,
			job.WorkstreamID, input.ProblemModelVersion).Scan(&found); err != nil {
			return ClaimJobResult{}, errors.New("job claim Problem Model version does not exist in this workstream")
		}
	}
	attempt := job.AttemptsStarted + 1
	epoch := job.LeaseEpoch + 1
	invocationID, err := prefixedUUID("inv_")
	if err != nil {
		return ClaimJobResult{}, err
	}
	leaseToken, err := prefixedUUID("lease_")
	if err != nil {
		return ClaimJobResult{}, err
	}
	workerSnapshot := map[string]any{"workerId": worker.ID, "kind": worker.Kind, "profile": worker.Profile,
		"transport": worker.Transport, "capabilities": worker.Capabilities, "inferenceCapable": worker.InferenceCapable}
	_, policyDigest, err := canonicalJSON(input.Policy)
	if err != nil {
		return ClaimJobResult{}, err
	}
	runtimeJSON, _, _ := canonicalJSON(input.Runtime)
	resourcesJSON, _, _ := canonicalJSON(input.ResolvedResources)
	workerJSON, _, _ := canonicalJSON(workerSnapshot)
	budgetJSON, _, _ := canonicalJSON(job.Budget)
	idempotencyKey := fmt.Sprintf("%s_attempt_%d", job.ID, attempt)
	spec := map[string]any{
		"schema": "noema.invocation/1", "id": invocationID, "jobId": job.ID, "attempt": attempt,
		"worker": workerSnapshot, "executionMode": input.ExecutionMode, "runtime": input.Runtime,
		"resolvedResources": input.ResolvedResources, "contextSnapshot": input.ContextSnapshot,
		"disclosureView": input.DisclosureView, "problemModelVersion": input.ProblemModelVersion,
		"budget": job.Budget, "policyHash": "sha256:" + policyDigest, "idempotencyKey": idempotencyKey,
	}
	specJSON, specDigest, err := canonicalJSON(spec)
	if err != nil {
		return ClaimJobResult{}, err
	}
	if _, err := tx.Exec(`INSERT INTO invocations(id, claim_request_id, claim_request_sha256, job_id, attempt, worker_id,
		worker_snapshot_json, execution_mode, runtime_json, resolved_resources_json, context_snapshot,
		disclosure_view, problem_model_version, budget_json, policy_hash, idempotency_key, spec_json,
		spec_sha256, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		invocationID, input.ClaimRequestID, claimRequestDigest, job.ID, attempt, worker.ID, string(workerJSON), input.ExecutionMode,
		string(runtimeJSON), string(resourcesJSON), input.ContextSnapshot, input.DisclosureView,
		input.ProblemModelVersion, string(budgetJSON), policyDigest, idempotencyKey, string(specJSON), specDigest, nowMs); err != nil {
		return ClaimJobResult{}, err
	}
	expiresMs := nowMs + ttlMillis
	if _, err := tx.Exec(`INSERT INTO worker_leases(job_id, invocation_id, worker_id, lease_token, epoch,
		acquired_at, expires_at) VALUES(?, ?, ?, ?, ?, ?, ?)`, job.ID, invocationID, worker.ID, leaseToken,
		epoch, nowMs, expiresMs); err != nil {
		return ClaimJobResult{}, err
	}
	for _, artifactID := range orderedInputArtifactIDs {
		if _, err := tx.Exec(`INSERT INTO job_artifacts(job_id, invocation_id, artifact_id, role, created_at)
			VALUES(?, ?, ?, 'input', ?)`, job.ID, invocationID, artifactID, nowMs); err != nil {
			return ClaimJobResult{}, err
		}
	}
	updated, err := tx.Exec(`UPDATE jobs SET state = 'claimed', attempts_started = ?, lease_epoch = ?,
		updated_at = ?, failure_reason = '', finished_at = NULL, version = version + 1
		WHERE id = ? AND state = 'queued' AND version = ?`, attempt, epoch, nowMs, job.ID, job.Version)
	if err != nil {
		return ClaimJobResult{}, err
	}
	if count, _ := updated.RowsAffected(); count != 1 {
		return ClaimJobResult{}, errors.New("job claim lost optimistic concurrency")
	}
	if _, err := tx.Exec(`UPDATE workers SET last_seen_at = ?, version = version + 1 WHERE id = ?`, nowMs, worker.ID); err != nil {
		return ClaimJobResult{}, err
	}
	job.State, job.AttemptsStarted, job.LeaseEpoch = "claimed", attempt, epoch
	job.UpdatedAt, job.FailureReason, job.FinishedAt, job.Version = formatMillis(nowMs), "", "", job.Version+1
	invocation := Invocation{ID: invocationID, ClaimRequestID: input.ClaimRequestID, JobID: job.ID,
		Attempt: attempt, WorkerID: worker.ID, WorkerSnapshot: workerSnapshot, ExecutionMode: input.ExecutionMode,
		Runtime: input.Runtime, ResolvedResources: input.ResolvedResources, ContextSnapshot: input.ContextSnapshot,
		DisclosureView: input.DisclosureView, ProblemModelVersion: input.ProblemModelVersion, Budget: job.Budget,
		PolicyHash: "sha256:" + policyDigest, IdempotencyKey: idempotencyKey, Spec: spec,
		SpecSHA256: "sha256:" + specDigest, CreatedAt: formatMillis(nowMs)}
	lease := JobLease{JobID: job.ID, InvocationID: invocation.ID, WorkerID: worker.ID, Token: leaseToken,
		Epoch: epoch, AcquiredAt: formatMillis(nowMs), ExpiresAt: formatMillis(expiresMs)}
	if _, err := appendEvent(tx, Event{Type: "job.claimed", WorkstreamID: job.WorkstreamID}, nowMs,
		map[string]any{"job_id": job.ID, "task_id": job.TaskID, "invocation_id": invocation.ID,
			"worker_id": worker.ID, "attempt": attempt, "epoch": epoch, "execution_mode": input.ExecutionMode,
			"policy_hash": "sha256:" + policyDigest, "input_artifact_ids": orderedInputArtifactIDs,
			"context_snapshot": input.ContextSnapshot, "disclosure_view": input.DisclosureView}); err != nil {
		return ClaimJobResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return ClaimJobResult{}, err
	}
	return ClaimJobResult{Job: job, Invocation: invocation, Lease: lease}, nil
}

func (s *Store) StartJob(input JobLeaseInput) (Job, error) {
	return s.transitionLeasedJob(input, "claimed", "running", "job.started")
}

func (s *Store) RenewJobLease(input JobLeaseInput) (JobLease, error) {
	if err := validateJobLeaseInput(input); err != nil {
		return JobLease{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return JobLease{}, err
	}
	defer func() { _ = tx.Rollback() }()
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	lease, _, err := requireJobLeaseTx(tx, input, nowMs)
	if err != nil {
		return JobLease{}, err
	}
	expiresMs := nowMs + leaseTTL(input.TTLMillis).Milliseconds()
	if _, err := tx.Exec(`UPDATE worker_leases SET expires_at = ? WHERE job_id = ? AND invocation_id = ?
		AND worker_id = ? AND lease_token = ? AND epoch = ?`, expiresMs, input.JobID, input.InvocationID,
		input.WorkerID, input.Token, input.Epoch); err != nil {
		return JobLease{}, err
	}
	if _, err := tx.Exec(`UPDATE workers SET last_seen_at = ?, version = version + 1 WHERE id = ?`, nowMs, input.WorkerID); err != nil {
		return JobLease{}, err
	}
	lease.ExpiresAt = formatMillis(expiresMs)
	if err := tx.Commit(); err != nil {
		return JobLease{}, err
	}
	return lease, nil
}

func (s *Store) transitionLeasedJob(input JobLeaseInput, from, to, eventType string) (Job, error) {
	if err := validateJobLeaseInput(input); err != nil {
		return Job{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Job{}, err
	}
	defer func() { _ = tx.Rollback() }()
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	_, job, err := requireJobLeaseTx(tx, input, nowMs)
	if err != nil {
		return Job{}, err
	}
	if job.State != from {
		return Job{}, fmt.Errorf("job must be %s before transition to %s", from, to)
	}
	updated, err := tx.Exec(`UPDATE jobs SET state = ?, updated_at = ?, version = version + 1
		WHERE id = ? AND state = ? AND version = ?`, to, nowMs, job.ID, from, job.Version)
	if err != nil {
		return Job{}, err
	}
	if count, _ := updated.RowsAffected(); count != 1 {
		return Job{}, errors.New("job transition lost optimistic concurrency")
	}
	job.State, job.UpdatedAt, job.Version = to, formatMillis(nowMs), job.Version+1
	if _, err := appendEvent(tx, Event{Type: eventType, WorkstreamID: job.WorkstreamID}, nowMs,
		map[string]any{"job_id": job.ID, "invocation_id": input.InvocationID, "worker_id": input.WorkerID,
			"epoch": input.Epoch}); err != nil {
		return Job{}, err
	}
	if err := tx.Commit(); err != nil {
		return Job{}, err
	}
	return job, nil
}

func (s *Store) CompleteJob(input FinishJobInput) (FinishJobResult, error) {
	return s.finishJob(input, "completed")
}

func (s *Store) FailJob(input FinishJobInput) (FinishJobResult, error) {
	return s.finishJob(input, "failed")
}

// ReportJobUnresolved is the only bridge from the deterministic plane to the
// inference plane of an optional Job. A worker cannot skip this durable fact.
func (s *Store) ReportJobUnresolved(input FinishJobInput) (FinishJobResult, error) {
	return s.finishJob(input, "unresolved")
}

func (s *Store) finishJob(input FinishJobInput, outcome string) (FinishJobResult, error) {
	input.JobID, input.InvocationID = strings.TrimSpace(input.JobID), strings.TrimSpace(input.InvocationID)
	input.WorkerID, input.Token, input.Reason = strings.TrimSpace(input.WorkerID), strings.TrimSpace(input.Token), strings.TrimSpace(input.Reason)
	leaseInput := JobLeaseInput{JobID: input.JobID, InvocationID: input.InvocationID, WorkerID: input.WorkerID,
		Token: input.Token, Epoch: input.Epoch}
	if err := validateJobLeaseInput(leaseInput); err != nil {
		return FinishJobResult{}, err
	}
	if outcome != "completed" && input.Reason == "" {
		return FinishJobResult{}, errors.New("failed or unresolved job completion requires a reason")
	}
	if len(input.Reason) > 8000 || len(input.ArtifactIDs) > 256 {
		return FinishJobResult{}, errors.New("job completion reason or artifacts are too large")
	}
	if input.Result == nil {
		input.Result = map[string]any{}
	}
	resultJSON, _, err := canonicalJSON(input.Result)
	if err != nil || len(resultJSON) > maxOrchestrationJSONBytes {
		return FinishJobResult{}, errors.New("job result is invalid or too large")
	}
	if err := validateUsageNonnegative(input.Usage); err != nil {
		return FinishJobResult{}, err
	}
	for _, artifactID := range input.ArtifactIDs {
		artifactID = strings.TrimSpace(artifactID)
		if !strings.HasPrefix(artifactID, "art_") || len(artifactID) > 200 {
			return FinishJobResult{}, errors.New("job output artifact ids are invalid or too numerous")
		}
	}
	artifactIDs := uniqueBoundedStrings(input.ArtifactIDs, 256, 200)
	if len(artifactIDs) != len(uniqueStrings(input.ArtifactIDs)) {
		return FinishJobResult{}, errors.New("job output artifact ids are invalid or too numerous")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return FinishJobResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	_, job, err := requireJobLeaseTx(tx, leaseInput, nowMs)
	if err != nil {
		return FinishJobResult{}, err
	}
	if job.State != "running" {
		return FinishJobResult{}, errors.New("only a running leased job may report a terminal observation")
	}
	invocation, err := scanInvocation(tx.QueryRow(invocationSelect+` WHERE id = ? AND job_id = ?`, input.InvocationID, input.JobID))
	if err != nil {
		return FinishJobResult{}, err
	}
	if err := validateObservedUsage(job, invocation, input.Usage); err != nil {
		return FinishJobResult{}, err
	}
	if outcome == "completed" && !completionConditionSatisfied(job.CompletionCondition, input.Result) {
		return FinishJobResult{}, errors.New("job result does not satisfy its frozen completion condition")
	}
	if outcome == "unresolved" && (job.Inference.Policy != "optional" || invocation.ExecutionMode != "deterministic") {
		return FinishJobResult{}, errors.New("only the deterministic attempt of an optional job may report unresolved")
	}
	for _, artifactID := range artifactIDs {
		var found string
		if err := tx.QueryRow(`SELECT id FROM artifacts WHERE id = ?`, artifactID).Scan(&found); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return FinishJobResult{}, fmt.Errorf("output artifact %q not found", artifactID)
			}
			return FinishJobResult{}, err
		}
	}
	resultStatus := outcome
	if _, err := tx.Exec(`INSERT INTO invocation_results(invocation_id, status, result_json, failure_reason,
		input_tokens, output_tokens, cost_microusd, inference_calls, observed_wall_ms, finished_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, invocation.ID, resultStatus, string(resultJSON),
		input.Reason, input.Usage.InputTokens, input.Usage.OutputTokens, input.Usage.CostMicrousd,
		input.Usage.InferenceCalls, input.Usage.ObservedWallMS, nowMs); err != nil {
		return FinishJobResult{}, err
	}
	for _, artifactID := range artifactIDs {
		if _, err := tx.Exec(`INSERT INTO job_artifacts(job_id, invocation_id, artifact_id, role, created_at)
			VALUES(?, ?, ?, 'output', ?)`, job.ID, invocation.ID, artifactID, nowMs); err != nil {
			return FinishJobResult{}, err
		}
	}
	if _, err := tx.Exec(`DELETE FROM worker_leases WHERE job_id = ? AND invocation_id = ?`, job.ID, invocation.ID); err != nil {
		return FinishJobResult{}, err
	}
	requeued := false
	nextState, failureReason, deterministicState := outcome, input.Reason, job.DeterministicState
	finishedAt := nowMs
	switch outcome {
	case "completed":
		nextState, failureReason = "completed", ""
		if invocation.ExecutionMode == "deterministic" {
			deterministicState = "resolved"
		}
	case "unresolved":
		nextState, deterministicState, finishedAt, requeued = "queued", "unresolved", int64(0), true
	case "failed":
		if shouldAutomaticallyRetry(job) {
			nextState, finishedAt, requeued = "queued", int64(0), true
		} else {
			nextState = "failed"
		}
	}
	var finished any
	if finishedAt > 0 {
		finished = finishedAt
	}
	updated, err := tx.Exec(`UPDATE jobs SET state = ?, deterministic_state = ?, updated_at = ?, finished_at = ?,
		failure_reason = ?, version = version + 1 WHERE id = ? AND state = 'running' AND version = ?`,
		nextState, deterministicState, nowMs, finished, failureReason, job.ID, job.Version)
	if err != nil {
		return FinishJobResult{}, err
	}
	if count, _ := updated.RowsAffected(); count != 1 {
		return FinishJobResult{}, errors.New("job completion lost optimistic concurrency")
	}
	job.State, job.DeterministicState, job.UpdatedAt = nextState, deterministicState, formatMillis(nowMs)
	job.FailureReason, job.Version = failureReason, job.Version+1
	if finishedAt > 0 {
		job.FinishedAt = formatMillis(finishedAt)
	} else {
		job.FinishedAt = ""
	}
	invocation.Result = &InvocationResult{InvocationID: invocation.ID, Status: resultStatus, Result: input.Result,
		FailureReason: input.Reason, InputTokens: input.Usage.InputTokens, OutputTokens: input.Usage.OutputTokens,
		CostMicrousd: input.Usage.CostMicrousd, InferenceCalls: input.Usage.InferenceCalls,
		ObservedWallMS: input.Usage.ObservedWallMS, FinishedAt: formatMillis(nowMs)}
	eventType := map[string]string{"completed": "job.completed", "failed": "job.failed", "unresolved": "job.deterministic.unresolved"}[outcome]
	if _, err := appendEvent(tx, Event{Type: eventType, WorkstreamID: job.WorkstreamID}, nowMs,
		map[string]any{"job_id": job.ID, "task_id": job.TaskID, "invocation_id": invocation.ID,
			"worker_id": input.WorkerID, "attempt": invocation.Attempt, "epoch": input.Epoch,
			"execution_mode": invocation.ExecutionMode, "artifact_ids": artifactIDs, "requeued": requeued,
			"usage": input.Usage, "reason": input.Reason}); err != nil {
		return FinishJobResult{}, err
	}
	if requeued {
		if _, err := appendEvent(tx, Event{Type: "job.requeued", WorkstreamID: job.WorkstreamID}, nowMs,
			map[string]any{"job_id": job.ID, "after_invocation_id": invocation.ID,
				"reason": input.Reason, "automatic": outcome != "unresolved"}); err != nil {
			return FinishJobResult{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return FinishJobResult{}, err
	}
	return FinishJobResult{Job: job, Invocation: invocation, Requeued: requeued, Artifacts: artifactIDs}, nil
}

func (s *Store) RetryJob(input RetryJobInput) (Job, error) {
	input.JobID, input.RequestedBy, input.Reason = strings.TrimSpace(input.JobID), strings.TrimSpace(input.RequestedBy), strings.TrimSpace(input.Reason)
	if !strings.HasPrefix(input.JobID, "job_") || input.ExpectedVersion < 1 || input.RequestedBy == "" ||
		len(input.RequestedBy) > 200 || input.Reason == "" || len(input.Reason) > 4000 {
		return Job{}, errors.New("manual retry requires a job, version, actor, and bounded reason")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Job{}, err
	}
	defer func() { _ = tx.Rollback() }()
	job, err := scanJob(tx.QueryRow(jobSelect+` WHERE id = ?`, input.JobID))
	if err != nil {
		return Job{}, err
	}
	job, err = attachJobDependenciesTx(tx, job)
	if err != nil {
		return Job{}, err
	}
	if job.Version != input.ExpectedVersion || (job.State != "failed" && job.State != "orphaned") {
		return Job{}, errors.New("job retry lost optimistic concurrency or job is not inspectable")
	}
	if job.AttemptsStarted >= job.Retry.AttemptsMax {
		return Job{}, errors.New("job exhausted its configured attempts")
	}
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	updated, err := tx.Exec(`UPDATE jobs SET state = 'queued', updated_at = ?, finished_at = NULL,
		failure_reason = '', version = version + 1 WHERE id = ? AND version = ?`, nowMs, job.ID, job.Version)
	if err != nil {
		return Job{}, err
	}
	if count, _ := updated.RowsAffected(); count != 1 {
		return Job{}, errors.New("job retry lost optimistic concurrency")
	}
	job.State, job.UpdatedAt, job.FinishedAt, job.FailureReason, job.Version = "queued", formatMillis(nowMs), "", "", job.Version+1
	if _, err := appendEvent(tx, Event{Type: "job.requeued", WorkstreamID: job.WorkstreamID}, nowMs,
		map[string]any{"job_id": job.ID, "requested_by": input.RequestedBy, "reason": input.Reason, "automatic": false}); err != nil {
		return Job{}, err
	}
	if err := tx.Commit(); err != nil {
		return Job{}, err
	}
	return job, nil
}

// ExpireJobLeases fences dead workers. Pure/idempotent jobs may be put back
// on the queue; all other effects become orphaned and require human review.
func (s *Store) ExpireJobLeases(workstreamIDs ...string) ([]Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	workstreamID := ""
	if len(workstreamIDs) > 0 {
		workstreamID = strings.TrimSpace(workstreamIDs[0])
		if workstreamID != "" && !strings.HasPrefix(workstreamID, "ws_") {
			return nil, errors.New("lease expiry workstream is invalid")
		}
	}
	query, args := jobLeaseSelect+` WHERE expires_at <= ?`, []any{nowMs}
	if workstreamID != "" {
		query += ` AND job_id IN (SELECT id FROM jobs WHERE workstream_id = ?)`
		args = append(args, workstreamID)
	}
	query += ` ORDER BY expires_at, job_id`
	rows, err := tx.Query(query, args...)
	if err != nil {
		return nil, err
	}
	leasings := []JobLease{}
	for rows.Next() {
		lease, err := scanJobLease(rows)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		leasings = append(leasings, lease)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	changed := []Job{}
	for _, lease := range leasings {
		job, err := scanJob(tx.QueryRow(jobSelect+` WHERE id = ?`, lease.JobID))
		if err != nil {
			return nil, err
		}
		job, err = attachJobDependenciesTx(tx, job)
		if err != nil {
			return nil, err
		}
		invocation, err := scanInvocation(tx.QueryRow(invocationSelect+` WHERE id = ?`, lease.InvocationID))
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(`INSERT INTO invocation_results(invocation_id, status, failure_reason, finished_at)
			VALUES(?, 'orphaned', 'worker lease expired', ?)`, invocation.ID, nowMs); err != nil {
			return nil, err
		}
		requeued := shouldAutomaticallyRetry(job)
		nextState := "orphaned"
		var finished any = nowMs
		if requeued {
			nextState, finished = "queued", nil
		}
		if _, err := tx.Exec(`UPDATE jobs SET state = ?, updated_at = ?, finished_at = ?, failure_reason = ?,
			version = version + 1 WHERE id = ? AND state IN ('claimed', 'running', 'input_required', 'permission_required')`,
			nextState, nowMs, finished, "worker lease expired", job.ID); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(`DELETE FROM worker_leases WHERE job_id = ?`, job.ID); err != nil {
			return nil, err
		}
		job.State, job.UpdatedAt, job.FailureReason, job.Version = nextState, formatMillis(nowMs), "worker lease expired", job.Version+1
		if requeued {
			job.FinishedAt = ""
		} else {
			job.FinishedAt = formatMillis(nowMs)
		}
		changed = append(changed, job)
		if _, err := appendEvent(tx, Event{Type: "job.orphaned", WorkstreamID: job.WorkstreamID}, nowMs,
			map[string]any{"job_id": job.ID, "invocation_id": invocation.ID, "worker_id": lease.WorkerID,
				"epoch": lease.Epoch, "effect_class": job.Effects.Class, "requeued": requeued}); err != nil {
			return nil, err
		}
		if requeued {
			if _, err := appendEvent(tx, Event{Type: "job.requeued", WorkstreamID: job.WorkstreamID}, nowMs,
				map[string]any{"job_id": job.ID, "after_invocation_id": invocation.ID,
					"reason": "worker lease expired", "automatic": true}); err != nil {
				return nil, err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return changed, nil
}

func (s *Store) GetInvocation(id string) (Invocation, error) {
	invocation, err := scanInvocation(s.db.QueryRow(invocationSelect+` WHERE id = ?`, strings.TrimSpace(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return Invocation{}, fmt.Errorf("invocation %q not found", id)
	}
	if err != nil {
		return Invocation{}, err
	}
	result, err := scanInvocationResult(s.db.QueryRow(invocationResultSelect+` WHERE invocation_id = ?`, invocation.ID))
	if err == nil {
		invocation.Result = &result
	} else if !errors.Is(err, sql.ErrNoRows) {
		return Invocation{}, err
	}
	return invocation, nil
}

func (s *Store) ListInvocations(jobID string, limit int) ([]Invocation, error) {
	jobID = strings.TrimSpace(jobID)
	if !strings.HasPrefix(jobID, "job_") {
		return nil, errors.New("invocation list requires a job id")
	}
	if limit < 1 || limit > 1000 {
		limit = 100
	}
	rows, err := s.db.Query(invocationSelect+` WHERE job_id = ? ORDER BY attempt DESC LIMIT ?`, jobID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Invocation{}
	for rows.Next() {
		invocation, err := scanInvocation(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, invocation)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for index := range result {
		observation, err := scanInvocationResult(s.db.QueryRow(invocationResultSelect+` WHERE invocation_id = ?`, result[index].ID))
		if err == nil {
			result[index].Result = &observation
		} else if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
	}
	return result, nil
}

type DelegationActor struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type DelegationSpec struct {
	ID                 string          `json:"id"`
	ParentTaskID       string          `json:"parentTaskId"`
	ParentInvocationID string          `json:"parentInvocationId"`
	RequestedBy        DelegationActor `json:"requestedBy"`
	Reason             map[string]any  `json:"reason"`
	ChildTaskID        string          `json:"childTaskId"`
	ChildJobIDs        []string        `json:"childJobIds"`
	Target             map[string]any  `json:"target"`
	Constraints        map[string]any  `json:"constraints"`
}

type CreateDelegationInput struct {
	ClientRequestID string         `json:"clientRequestId"`
	WorkstreamID    string         `json:"workstreamId"`
	Delegation      DelegationSpec `json:"delegation"`
}

type Delegation struct {
	ID                 string          `json:"id"`
	ClientRequestID    string          `json:"clientRequestId"`
	WorkstreamID       string          `json:"workstreamId"`
	ParentTaskID       string          `json:"parentTaskId"`
	ParentInvocationID string          `json:"parentInvocationId,omitempty"`
	RequestedBy        DelegationActor `json:"requestedBy"`
	Reason             map[string]any  `json:"reason"`
	ChildTaskID        string          `json:"childTaskId"`
	ChildJobIDs        []string        `json:"childJobIds"`
	Target             map[string]any  `json:"target"`
	Constraints        map[string]any  `json:"constraints"`
	OriginProposalID   string          `json:"originProposalId,omitempty"`
	OutputArtifactIDs  []string        `json:"outputArtifactIds"`
	CreatedAt          string          `json:"createdAt"`
	Version            int64           `json:"version"`
}

type DelegationFilter struct {
	WorkstreamID string
	ParentTaskID string
	ChildTaskID  string
	Limit        int
}

const delegationSelect = `SELECT id, client_request_id, workstream_id, parent_task_id,
	COALESCE(parent_invocation_id, ''), requested_by_type, requested_by_id, reason_json,
	child_task_id, target_json, constraints_json, origin_proposal_id, created_at, version FROM delegations`

func (s *Store) CreateDelegation(input CreateDelegationInput) (Delegation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Delegation{}, err
	}
	defer func() { _ = tx.Rollback() }()
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	delegation, err := createDelegationTx(tx, input, "", nowMs)
	if err != nil {
		return Delegation{}, err
	}
	if err := tx.Commit(); err != nil {
		return Delegation{}, err
	}
	return delegation, nil
}

func createDelegationTx(tx *sql.Tx, input CreateDelegationInput, proposalID string, nowMs int64) (Delegation, error) {
	input.ClientRequestID, input.WorkstreamID = strings.TrimSpace(input.ClientRequestID), strings.TrimSpace(input.WorkstreamID)
	if input.ClientRequestID == "" || len(input.ClientRequestID) > 200 || !strings.HasPrefix(input.WorkstreamID, "ws_") {
		return Delegation{}, errors.New("delegation requires a bounded request id and workstream")
	}
	spec := input.Delegation
	spec.ID, spec.ParentTaskID = strings.TrimSpace(spec.ID), strings.TrimSpace(spec.ParentTaskID)
	spec.ParentInvocationID, spec.ChildTaskID = strings.TrimSpace(spec.ParentInvocationID), strings.TrimSpace(spec.ChildTaskID)
	spec.RequestedBy.Type, spec.RequestedBy.ID = strings.TrimSpace(spec.RequestedBy.Type), strings.TrimSpace(spec.RequestedBy.ID)
	requestedID := spec.ID
	if spec.ID == "" {
		var err error
		spec.ID, err = prefixedUUID("del_")
		if err != nil {
			return Delegation{}, err
		}
	}
	if !strings.HasPrefix(spec.ID, "del_") || !orchestrationNamePattern.MatchString(spec.ID) ||
		!strings.HasPrefix(spec.ParentTaskID, "task_") || !strings.HasPrefix(spec.ChildTaskID, "task_") ||
		spec.ParentTaskID == spec.ChildTaskID {
		return Delegation{}, errors.New("delegation identity or task relationship is invalid")
	}
	if spec.RequestedBy.Type != "human" && spec.RequestedBy.Type != "agent" &&
		spec.RequestedBy.Type != "worker" && spec.RequestedBy.Type != "system" {
		return Delegation{}, errors.New("delegation requester type is invalid")
	}
	if spec.RequestedBy.ID == "" || len(spec.RequestedBy.ID) > 200 {
		return Delegation{}, errors.New("delegation requester is required and bounded")
	}
	if err := requireTaskWorkstreamTx(tx, spec.ParentTaskID, input.WorkstreamID); err != nil {
		return Delegation{}, err
	}
	if err := requireTaskWorkstreamTx(tx, spec.ChildTaskID, input.WorkstreamID); err != nil {
		return Delegation{}, err
	}
	if spec.ParentInvocationID != "" {
		var invocationTask, invocationWorkstream string
		if err := tx.QueryRow(`SELECT jobs.task_id, jobs.workstream_id FROM invocations
			JOIN jobs ON jobs.id = invocations.job_id WHERE invocations.id = ?`, spec.ParentInvocationID).
			Scan(&invocationTask, &invocationWorkstream); err != nil {
			return Delegation{}, errors.New("delegation parent Invocation does not exist")
		}
		if invocationTask != spec.ParentTaskID || invocationWorkstream != input.WorkstreamID {
			return Delegation{}, errors.New("delegation parent Invocation does not belong to the parent Task")
		}
	}
	for _, jobID := range spec.ChildJobIDs {
		jobID = strings.TrimSpace(jobID)
		if !strings.HasPrefix(jobID, "job_") || len(jobID) > 200 {
			return Delegation{}, errors.New("delegation requires valid child jobs")
		}
	}
	childJobs := uniqueBoundedStrings(spec.ChildJobIDs, 256, 200)
	if len(childJobs) == 0 || len(childJobs) != len(uniqueStrings(spec.ChildJobIDs)) {
		return Delegation{}, errors.New("delegation requires valid child jobs")
	}
	for _, jobID := range childJobs {
		var taskID, workstreamID string
		if err := tx.QueryRow(`SELECT task_id, workstream_id FROM jobs WHERE id = ?`, jobID).Scan(&taskID, &workstreamID); err != nil {
			return Delegation{}, fmt.Errorf("delegation child job %q does not exist", jobID)
		}
		if taskID != spec.ChildTaskID || workstreamID != input.WorkstreamID {
			return Delegation{}, errors.New("delegation child job does not belong to the child Task")
		}
	}
	if spec.Reason == nil {
		spec.Reason = map[string]any{}
	}
	if strings.TrimSpace(stringValue(spec.Reason["summary"])) == "" {
		return Delegation{}, errors.New("delegation reason requires a summary")
	}
	if spec.Target == nil {
		spec.Target = map[string]any{}
	}
	if spec.Constraints == nil {
		spec.Constraints = map[string]any{}
	}
	reasonJSON, _, reasonErr := canonicalJSON(spec.Reason)
	targetJSON, _, targetErr := canonicalJSON(spec.Target)
	constraintsJSON, _, constraintsErr := canonicalJSON(spec.Constraints)
	if reasonErr != nil || targetErr != nil || constraintsErr != nil ||
		len(reasonJSON)+len(targetJSON)+len(constraintsJSON) > maxOrchestrationJSONBytes {
		return Delegation{}, errors.New("delegation document is invalid or too large")
	}
	requestDigest, err := orchestrationRequestDigest("delegation.create", map[string]any{
		"workstreamId": input.WorkstreamID, "originProposalId": proposalID,
		"delegation": map[string]any{"id": requestedID, "parentTaskId": spec.ParentTaskID,
			"parentInvocationId": spec.ParentInvocationID, "requestedBy": spec.RequestedBy,
			"reason": spec.Reason, "childTaskId": spec.ChildTaskID, "childJobIds": childJobs,
			"target": spec.Target, "constraints": spec.Constraints},
	})
	if err != nil {
		return Delegation{}, err
	}
	matched, err := matchingRequestDigestTx(tx, `SELECT request_sha256 FROM delegations WHERE client_request_id = ?`,
		input.ClientRequestID, requestDigest, "delegation")
	if err != nil {
		return Delegation{}, err
	}
	if matched {
		prior, err := scanDelegation(tx.QueryRow(delegationSelect+` WHERE client_request_id = ?`, input.ClientRequestID))
		if err != nil {
			return Delegation{}, err
		}
		return attachDelegationTx(tx, prior)
	}
	if _, err := tx.Exec(`INSERT INTO delegations(id, client_request_id, request_sha256, workstream_id, parent_task_id,
		parent_invocation_id, requested_by_type, requested_by_id, reason_json, child_task_id, target_json,
		constraints_json, origin_proposal_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		spec.ID, input.ClientRequestID, requestDigest, input.WorkstreamID, spec.ParentTaskID, nullable(spec.ParentInvocationID),
		spec.RequestedBy.Type, spec.RequestedBy.ID, string(reasonJSON), spec.ChildTaskID, string(targetJSON),
		string(constraintsJSON), proposalID, nowMs); err != nil {
		return Delegation{}, err
	}
	for _, jobID := range childJobs {
		if _, err := tx.Exec(`INSERT INTO delegation_jobs(delegation_id, job_id) VALUES(?, ?)`, spec.ID, jobID); err != nil {
			return Delegation{}, err
		}
	}
	if _, err := tx.Exec(`INSERT OR IGNORE INTO task_edges(parent_task_id, child_task_id, type, created_at)
		VALUES(?, ?, 'decomposes', ?)`, spec.ParentTaskID, spec.ChildTaskID, nowMs); err != nil {
		return Delegation{}, err
	}
	delegation := Delegation{ID: spec.ID, ClientRequestID: input.ClientRequestID, WorkstreamID: input.WorkstreamID,
		ParentTaskID: spec.ParentTaskID, ParentInvocationID: spec.ParentInvocationID, RequestedBy: spec.RequestedBy,
		Reason: spec.Reason, ChildTaskID: spec.ChildTaskID, ChildJobIDs: []string{}, Target: spec.Target,
		Constraints: spec.Constraints, OriginProposalID: proposalID, OutputArtifactIDs: []string{},
		CreatedAt: formatMillis(nowMs), Version: 1}
	if _, err := appendEvent(tx, Event{Type: "delegation.created", WorkstreamID: input.WorkstreamID}, nowMs,
		map[string]any{"delegation_id": delegation.ID, "parent_task_id": delegation.ParentTaskID,
			"parent_invocation_id": delegation.ParentInvocationID, "child_task_id": delegation.ChildTaskID,
			"child_job_ids": childJobs, "requested_by": delegation.RequestedBy,
			"origin_proposal_id": proposalID}); err != nil {
		return Delegation{}, err
	}
	return attachDelegationTx(tx, delegation)
}

func (s *Store) GetDelegation(id string) (Delegation, error) {
	delegation, err := scanDelegation(s.db.QueryRow(delegationSelect+` WHERE id = ?`, strings.TrimSpace(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return Delegation{}, fmt.Errorf("delegation %q not found", id)
	}
	if err != nil {
		return Delegation{}, err
	}
	return s.attachDelegation(delegation)
}

func (s *Store) ListDelegations(filter DelegationFilter) ([]Delegation, error) {
	limit := filter.Limit
	if limit < 1 || limit > 1000 {
		limit = 200
	}
	query, args := delegationSelect+` WHERE 1 = 1`, []any{}
	if value := strings.TrimSpace(filter.WorkstreamID); value != "" {
		query += ` AND workstream_id = ?`
		args = append(args, value)
	}
	if value := strings.TrimSpace(filter.ParentTaskID); value != "" {
		query += ` AND parent_task_id = ?`
		args = append(args, value)
	}
	if value := strings.TrimSpace(filter.ChildTaskID); value != "" {
		query += ` AND child_task_id = ?`
		args = append(args, value)
	}
	query += ` ORDER BY created_at DESC, id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Delegation{}
	for rows.Next() {
		item, err := scanDelegation(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for index := range items {
		items[index], err = s.attachDelegation(items[index])
		if err != nil {
			return nil, err
		}
	}
	return items, nil
}

func createTaskFromProposalTx(tx *sql.Tx, proposal Proposal, payload map[string]any, nowMs int64) (Task, error) {
	document := proposalDocument(payload, "task")
	encoded, _, err := canonicalJSON(document)
	if err != nil {
		return Task{}, err
	}
	var spec TaskSpec
	if err := json.Unmarshal(encoded, &spec); err != nil {
		return Task{}, errors.New("task Proposal payload is invalid")
	}
	return createTaskTx(tx, CreateTaskInput{ClientRequestID: "proposal:" + proposal.ID,
		WorkstreamID: proposal.WorkstreamID, Task: spec, CreatedBy: proposal.ProposedBy}, proposal.ID, nowMs)
}

func createJobFromProposalTx(tx *sql.Tx, proposal Proposal, payload map[string]any, nowMs int64) (Job, error) {
	document := proposalDocument(payload, "job")
	encoded, _, err := canonicalJSON(document)
	if err != nil {
		return Job{}, err
	}
	var spec JobSpec
	if err := json.Unmarshal(encoded, &spec); err != nil {
		return Job{}, errors.New("job Proposal payload is invalid")
	}
	return createJobTx(tx, CreateJobInput{ClientRequestID: "proposal:" + proposal.ID,
		WorkstreamID: proposal.WorkstreamID, Job: spec, CreatedBy: proposal.ProposedBy}, proposal.ID, nowMs)
}

func createDelegationFromProposalTx(tx *sql.Tx, proposal Proposal, payload map[string]any, nowMs int64) (Delegation, error) {
	document := proposalDocument(payload, "delegation")
	encoded, _, err := canonicalJSON(document)
	if err != nil {
		return Delegation{}, err
	}
	var spec DelegationSpec
	if err := json.Unmarshal(encoded, &spec); err != nil {
		return Delegation{}, errors.New("delegation Proposal payload is invalid")
	}
	return createDelegationTx(tx, CreateDelegationInput{ClientRequestID: "proposal:" + proposal.ID,
		WorkstreamID: proposal.WorkstreamID, Delegation: spec}, proposal.ID, nowMs)
}

func requireTaskWorkstreamTx(tx *sql.Tx, taskID, workstreamID string) error {
	var found string
	if err := tx.QueryRow(`SELECT workstream_id FROM tasks WHERE id = ?`, taskID).Scan(&found); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("task %q not found", taskID)
		}
		return err
	}
	if found != workstreamID {
		return fmt.Errorf("task %q belongs to a different workstream", taskID)
	}
	return nil
}

func validateBudget(budget BudgetSpec) error {
	if budget.InputTokensMax < 0 || budget.OutputTokensMax < 0 || budget.CostUSDMax < 0 ||
		budget.WallTimeSecondsMax < 0 || budget.RemoteDisclosureBytesMax < 0 ||
		budget.InputTokensMax > 1_000_000_000 || budget.OutputTokensMax > 1_000_000_000 ||
		budget.CostUSDMax > 1_000_000 || budget.WallTimeSecondsMax > 31_536_000 ||
		budget.RemoteDisclosureBytesMax > 1_000_000_000_000 {
		return errors.New("job budget is invalid")
	}
	return nil
}

func validateUsageNonnegative(usage JobUsage) error {
	if usage.InputTokens < 0 || usage.OutputTokens < 0 || usage.CostMicrousd < 0 ||
		usage.InferenceCalls < 0 || usage.ObservedWallMS < 0 {
		return errors.New("job usage cannot be negative")
	}
	return nil
}

func validateObservedUsage(job Job, invocation Invocation, usage JobUsage) error {
	if invocation.ExecutionMode == "deterministic" || job.Inference.Policy == "forbidden" {
		if usage.InputTokens != 0 || usage.OutputTokens != 0 || usage.CostMicrousd != 0 || usage.InferenceCalls != 0 {
			return errors.New("deterministic or inference-forbidden execution must report exactly zero inference usage")
		}
	}
	if invocation.ExecutionMode == "inference" && usage.InferenceCalls < 1 {
		return errors.New("inference execution must report at least one inference call")
	}
	if job.Budget.InputTokensMax > 0 && usage.InputTokens > job.Budget.InputTokensMax {
		return errors.New("job exceeded its input-token budget")
	}
	if job.Budget.OutputTokensMax > 0 && usage.OutputTokens > job.Budget.OutputTokensMax {
		return errors.New("job exceeded its output-token budget")
	}
	if job.Budget.CostUSDMax > 0 && usage.CostMicrousd > int64(job.Budget.CostUSDMax*1_000_000+0.5) {
		return errors.New("job exceeded its cost budget")
	}
	if job.Budget.WallTimeSecondsMax > 0 && usage.ObservedWallMS > job.Budget.WallTimeSecondsMax*1000 {
		return errors.New("job exceeded its wall-time budget")
	}
	return nil
}

func completionConditionSatisfied(condition, result map[string]any) bool {
	for key, expected := range condition {
		actual, ok := result[key]
		if !ok {
			return false
		}
		_, expectedDigest, expectedErr := canonicalJSON(expected)
		_, actualDigest, actualErr := canonicalJSON(actual)
		if expectedErr != nil || actualErr != nil || expectedDigest != actualDigest {
			return false
		}
	}
	return true
}

func authorizeExecutionMode(job Job, worker Worker, mode string) error {
	switch job.Inference.Policy {
	case "forbidden":
		if mode != "deterministic" {
			return errors.New("inference is forbidden for this job")
		}
	case "required":
		if mode != "inference" || !worker.InferenceCapable {
			return errors.New("this job requires an inference-capable execution")
		}
	case "optional":
		if job.DeterministicState == "pending" && mode != "deterministic" {
			return errors.New("optional inference requires a deterministic attempt first")
		}
		if job.DeterministicState == "unresolved" && (mode != "inference" || !worker.InferenceCapable) {
			return errors.New("optional job may escalate only to an inference-capable execution after unresolved")
		}
		if job.DeterministicState != "pending" && job.DeterministicState != "unresolved" {
			return errors.New("optional job deterministic stage is not claimable")
		}
	}
	return nil
}

func requireCapabilities(job Job, worker Worker, executionMode string) error {
	wanted := jsonStringArray(job.Requirements["capabilities"])
	has := map[string]bool{}
	for _, value := range worker.Capabilities {
		has[value] = true
	}
	for _, value := range wanted {
		if !has[value] {
			return fmt.Errorf("worker lacks required capability %q", value)
		}
	}
	if capability := strings.TrimSpace(job.Inference.MinimumCapability); capability != "" &&
		executionMode == "inference" && !has[capability] {
		return fmt.Errorf("worker lacks minimum inference capability %q", capability)
	}
	return nil
}

func shouldAutomaticallyRetry(job Job) bool {
	return job.Retry.Policy == "safe_only" && job.AttemptsStarted < job.Retry.AttemptsMax &&
		(job.Effects.Class == "pure" || job.Effects.Class == "idempotent")
}

func validateJobLeaseInput(input JobLeaseInput) error {
	if !strings.HasPrefix(strings.TrimSpace(input.JobID), "job_") ||
		!strings.HasPrefix(strings.TrimSpace(input.InvocationID), "inv_") ||
		!strings.HasPrefix(strings.TrimSpace(input.WorkerID), "worker:") ||
		!strings.HasPrefix(strings.TrimSpace(input.Token), "lease_") || input.Epoch < 1 {
		return errors.New("current job lease credentials are required")
	}
	return nil
}

func requireJobLeaseTx(tx *sql.Tx, input JobLeaseInput, nowMs int64) (JobLease, Job, error) {
	var lease JobLease
	var acquiredAt, expiresAt int64
	err := tx.QueryRow(jobLeaseSelect+` WHERE job_id = ?`, input.JobID).Scan(&lease.JobID, &lease.InvocationID,
		&lease.WorkerID, &lease.Token, &lease.Epoch, &acquiredAt, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return JobLease{}, Job{}, errors.New("no current lease for job")
	}
	if err != nil {
		return JobLease{}, Job{}, err
	}
	if lease.InvocationID != input.InvocationID || lease.WorkerID != input.WorkerID ||
		lease.Token != input.Token || lease.Epoch != input.Epoch {
		return JobLease{}, Job{}, errors.New("stale job lease credentials")
	}
	if expiresAt <= nowMs {
		return JobLease{}, Job{}, errors.New("job lease has expired")
	}
	lease.AcquiredAt, lease.ExpiresAt = formatMillis(acquiredAt), formatMillis(expiresAt)
	job, err := scanJob(tx.QueryRow(jobSelect+` WHERE id = ?`, input.JobID))
	if err != nil {
		return JobLease{}, Job{}, err
	}
	job, err = attachJobDependenciesTx(tx, job)
	return lease, job, err
}

func uniqueBoundedStrings(values []string, maximum, maxLength int) []string {
	if len(values) > maximum {
		return nil
	}
	seen := map[string]bool{}
	result := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || len(value) > maxLength {
			return nil
		}
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	sort.Strings(result)
	return result
}

func scanTask(row scanner) (Task, error) {
	var task Task
	var criteriaJSON string
	var createdAt, updatedAt int64
	if err := row.Scan(&task.ID, &task.ClientRequestID, &task.WorkstreamID, &task.ParentTaskID,
		&task.Title, &task.Objective, &criteriaJSON, &task.State, &task.Priority, &task.Disclosure,
		&task.CreatedBy, &task.OriginProposalID, &createdAt, &updatedAt, &task.Version); err != nil {
		return Task{}, err
	}
	if err := json.Unmarshal([]byte(criteriaJSON), &task.AcceptanceCriteria); err != nil {
		return Task{}, err
	}
	if task.AcceptanceCriteria == nil {
		task.AcceptanceCriteria = []any{}
	}
	task.CreatedAt, task.UpdatedAt, task.DependsOn = formatMillis(createdAt), formatMillis(updatedAt), []string{}
	return task, nil
}

func scanWorker(row scanner) (Worker, error) {
	var worker Worker
	var capabilitiesJSON string
	var inference int
	var registeredAt, lastSeenAt int64
	if err := row.Scan(&worker.ID, &worker.Kind, &worker.Profile, &worker.Transport, &capabilitiesJSON,
		&inference, &worker.State, &registeredAt, &lastSeenAt, &worker.Version); err != nil {
		return Worker{}, err
	}
	if err := json.Unmarshal([]byte(capabilitiesJSON), &worker.Capabilities); err != nil {
		return Worker{}, err
	}
	worker.InferenceCapable = inference != 0
	worker.RegisteredAt, worker.LastSeenAt = formatMillis(registeredAt), formatMillis(lastSeenAt)
	return worker, nil
}

func scanJob(row scanner) (Job, error) {
	var job Job
	var inputsJSON, requirementsJSON, budgetJSON, completionJSON string
	var localPreferred int
	var createdAt, updatedAt, finishedAt int64
	if err := row.Scan(&job.ID, &job.ClientRequestID, &job.WorkstreamID, &job.TaskID, &job.Kind, &job.State,
		&inputsJSON, &requirementsJSON, &job.Inference.Policy, &localPreferred, &job.Inference.MinimumCapability,
		&job.Effects.Class, &budgetJSON, &job.Retry.Policy, &job.Retry.AttemptsMax, &job.AttemptsStarted,
		&job.DeterministicState, &completionJSON, &job.OriginProposalID, &job.CreatedBy, &createdAt,
		&updatedAt, &finishedAt, &job.FailureReason, &job.LeaseEpoch, &job.Version); err != nil {
		return Job{}, err
	}
	if err := json.Unmarshal([]byte(inputsJSON), &job.Inputs); err != nil {
		return Job{}, err
	}
	if err := json.Unmarshal([]byte(requirementsJSON), &job.Requirements); err != nil {
		return Job{}, err
	}
	if err := json.Unmarshal([]byte(budgetJSON), &job.Budget); err != nil {
		return Job{}, err
	}
	if err := json.Unmarshal([]byte(completionJSON), &job.CompletionCondition); err != nil {
		return Job{}, err
	}
	job.Inference.LocalPreferred = localPreferred != 0
	job.DependsOn = []string{}
	job.CreatedAt, job.UpdatedAt = formatMillis(createdAt), formatMillis(updatedAt)
	if finishedAt > 0 {
		job.FinishedAt = formatMillis(finishedAt)
	}
	return job, nil
}

func (s *Store) attachJobDependencies(job Job) (Job, error) {
	rows, err := s.db.Query(`SELECT dependency_job_id FROM job_dependencies WHERE job_id = ? ORDER BY dependency_job_id`, job.ID)
	if err != nil {
		return Job{}, err
	}
	defer rows.Close()
	job.DependsOn = []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return Job{}, err
		}
		job.DependsOn = append(job.DependsOn, id)
	}
	return job, rows.Err()
}

func attachJobDependenciesTx(tx *sql.Tx, job Job) (Job, error) {
	rows, err := tx.Query(`SELECT dependency_job_id FROM job_dependencies WHERE job_id = ? ORDER BY dependency_job_id`, job.ID)
	if err != nil {
		return Job{}, err
	}
	defer rows.Close()
	job.DependsOn = []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return Job{}, err
		}
		job.DependsOn = append(job.DependsOn, id)
	}
	return job, rows.Err()
}

func scanInvocation(row scanner) (Invocation, error) {
	var invocation Invocation
	var workerJSON, runtimeJSON, resourcesJSON, budgetJSON, specJSON string
	var policyDigest, specDigest string
	var createdAt int64
	if err := row.Scan(&invocation.ID, &invocation.ClaimRequestID, &invocation.JobID, &invocation.Attempt,
		&invocation.WorkerID, &workerJSON, &invocation.ExecutionMode, &runtimeJSON, &resourcesJSON,
		&invocation.ContextSnapshot, &invocation.DisclosureView, &invocation.ProblemModelVersion, &budgetJSON,
		&policyDigest, &invocation.IdempotencyKey, &specJSON, &specDigest, &createdAt); err != nil {
		return Invocation{}, err
	}
	if err := json.Unmarshal([]byte(workerJSON), &invocation.WorkerSnapshot); err != nil {
		return Invocation{}, err
	}
	if err := json.Unmarshal([]byte(runtimeJSON), &invocation.Runtime); err != nil {
		return Invocation{}, err
	}
	if err := json.Unmarshal([]byte(resourcesJSON), &invocation.ResolvedResources); err != nil {
		return Invocation{}, err
	}
	if err := json.Unmarshal([]byte(budgetJSON), &invocation.Budget); err != nil {
		return Invocation{}, err
	}
	if err := json.Unmarshal([]byte(specJSON), &invocation.Spec); err != nil {
		return Invocation{}, err
	}
	invocation.PolicyHash, invocation.SpecSHA256 = "sha256:"+policyDigest, "sha256:"+specDigest
	invocation.CreatedAt = formatMillis(createdAt)
	return invocation, nil
}

func scanInvocationResult(row scanner) (InvocationResult, error) {
	var result InvocationResult
	var resultJSON string
	var finishedAt int64
	if err := row.Scan(&result.InvocationID, &result.Status, &resultJSON, &result.FailureReason,
		&result.InputTokens, &result.OutputTokens, &result.CostMicrousd, &result.InferenceCalls,
		&result.ObservedWallMS, &finishedAt); err != nil {
		return InvocationResult{}, err
	}
	if err := json.Unmarshal([]byte(resultJSON), &result.Result); err != nil {
		return InvocationResult{}, err
	}
	result.FinishedAt = formatMillis(finishedAt)
	return result, nil
}

func scanJobLease(row scanner) (JobLease, error) {
	var lease JobLease
	var acquiredAt, expiresAt int64
	if err := row.Scan(&lease.JobID, &lease.InvocationID, &lease.WorkerID, &lease.Token,
		&lease.Epoch, &acquiredAt, &expiresAt); err != nil {
		return JobLease{}, err
	}
	lease.AcquiredAt, lease.ExpiresAt = formatMillis(acquiredAt), formatMillis(expiresAt)
	return lease, nil
}

func scanDelegation(row scanner) (Delegation, error) {
	var delegation Delegation
	var reasonJSON, targetJSON, constraintsJSON string
	var createdAt int64
	if err := row.Scan(&delegation.ID, &delegation.ClientRequestID, &delegation.WorkstreamID,
		&delegation.ParentTaskID, &delegation.ParentInvocationID, &delegation.RequestedBy.Type,
		&delegation.RequestedBy.ID, &reasonJSON, &delegation.ChildTaskID, &targetJSON,
		&constraintsJSON, &delegation.OriginProposalID, &createdAt, &delegation.Version); err != nil {
		return Delegation{}, err
	}
	if err := json.Unmarshal([]byte(reasonJSON), &delegation.Reason); err != nil {
		return Delegation{}, err
	}
	if err := json.Unmarshal([]byte(targetJSON), &delegation.Target); err != nil {
		return Delegation{}, err
	}
	if err := json.Unmarshal([]byte(constraintsJSON), &delegation.Constraints); err != nil {
		return Delegation{}, err
	}
	delegation.ChildJobIDs, delegation.OutputArtifactIDs = []string{}, []string{}
	delegation.CreatedAt = formatMillis(createdAt)
	return delegation, nil
}

func (s *Store) attachTaskEdges(task Task) (Task, error) {
	rows, err := s.db.Query(`SELECT parent_task_id FROM task_edges WHERE child_task_id = ? AND type = 'depends' ORDER BY parent_task_id`, task.ID)
	if err != nil {
		return Task{}, err
	}
	defer rows.Close()
	task.DependsOn = []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return Task{}, err
		}
		task.DependsOn = append(task.DependsOn, id)
	}
	return task, rows.Err()
}

func attachTaskEdgesTx(tx *sql.Tx, task Task) (Task, error) {
	rows, err := tx.Query(`SELECT parent_task_id FROM task_edges WHERE child_task_id = ? AND type = 'depends' ORDER BY parent_task_id`, task.ID)
	if err != nil {
		return Task{}, err
	}
	defer rows.Close()
	task.DependsOn = []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return Task{}, err
		}
		task.DependsOn = append(task.DependsOn, id)
	}
	return task, rows.Err()
}

func (s *Store) attachDelegation(delegation Delegation) (Delegation, error) {
	rows, err := s.db.Query(`SELECT delegation_jobs.job_id FROM delegation_jobs WHERE delegation_id = ? ORDER BY job_id`, delegation.ID)
	if err != nil {
		return Delegation{}, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return Delegation{}, err
		}
		delegation.ChildJobIDs = append(delegation.ChildJobIDs, id)
	}
	if err := rows.Close(); err != nil {
		return Delegation{}, err
	}
	artifactRows, err := s.db.Query(`SELECT DISTINCT job_artifacts.artifact_id FROM delegation_jobs
		JOIN job_artifacts ON job_artifacts.job_id = delegation_jobs.job_id
		WHERE delegation_jobs.delegation_id = ? AND job_artifacts.role = 'output' ORDER BY job_artifacts.artifact_id`, delegation.ID)
	if err != nil {
		return Delegation{}, err
	}
	defer artifactRows.Close()
	for artifactRows.Next() {
		var id string
		if err := artifactRows.Scan(&id); err != nil {
			return Delegation{}, err
		}
		delegation.OutputArtifactIDs = append(delegation.OutputArtifactIDs, id)
	}
	return delegation, artifactRows.Err()
}

func attachDelegationTx(tx *sql.Tx, delegation Delegation) (Delegation, error) {
	rows, err := tx.Query(`SELECT job_id FROM delegation_jobs WHERE delegation_id = ? ORDER BY job_id`, delegation.ID)
	if err != nil {
		return Delegation{}, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return Delegation{}, err
		}
		delegation.ChildJobIDs = append(delegation.ChildJobIDs, id)
	}
	if err := rows.Close(); err != nil {
		return Delegation{}, err
	}
	if err := rows.Err(); err != nil {
		return Delegation{}, err
	}
	artifactRows, err := tx.Query(`SELECT DISTINCT job_artifacts.artifact_id FROM delegation_jobs
		JOIN job_artifacts ON job_artifacts.job_id = delegation_jobs.job_id
		WHERE delegation_jobs.delegation_id = ? AND job_artifacts.role = 'output' ORDER BY job_artifacts.artifact_id`, delegation.ID)
	if err != nil {
		return Delegation{}, err
	}
	defer artifactRows.Close()
	for artifactRows.Next() {
		var id string
		if err := artifactRows.Scan(&id); err != nil {
			return Delegation{}, err
		}
		delegation.OutputArtifactIDs = append(delegation.OutputArtifactIDs, id)
	}
	return delegation, artifactRows.Err()
}
