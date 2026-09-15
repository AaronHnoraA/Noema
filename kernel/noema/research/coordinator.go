// Noema research coordinator requests are Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package research

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// CoordinatorRequest is a durable ask from the Pi manager (D-032, D-035).  It
// never acts by itself: the Emacs worker claims it exactly once and carries it
// out through the same frozen-RunSpec, lease and ACP path as a human.
type CoordinatorRequest struct {
	ID             string         `json:"id"`
	Kind           string         `json:"kind"`
	Payload        map[string]any `json:"payload"`
	Actor          string         `json:"actor"`
	State          string         `json:"state"`
	ClaimedBy      string         `json:"claimedBy,omitempty"`
	CreatedAt      string         `json:"createdAt"`
	ClaimedAt      string         `json:"claimedAt,omitempty"`
	LeaseExpiresAt string         `json:"leaseExpiresAt,omitempty"`
	FinishedAt     string         `json:"finishedAt,omitempty"`
	FailureReason  string         `json:"failureReason,omitempty"`
	Version        int64          `json:"version"`
}

// coordinatorRequestKinds are the only asks Pi can make of Emacs.
var coordinatorRequestKinds = map[string]bool{"run.start": true, "session.cancel": true, "session.close": true}

// CreateCoordinatorRequest records one pending request.
func (s *Store) CreateCoordinatorRequest(kind string, payload map[string]any, actor string) (CoordinatorRequest, error) {
	kind, actor = strings.TrimSpace(kind), strings.TrimSpace(actor)
	if !coordinatorRequestKinds[kind] {
		return CoordinatorRequest{}, fmt.Errorf("unsupported coordinator request %q", kind)
	}
	if actor == "" {
		return CoordinatorRequest{}, errors.New("coordinator request needs an actor")
	}
	if payload == nil {
		payload = map[string]any{}
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return CoordinatorRequest{}, err
	}
	id, err := prefixedUUID("creq_")
	if err != nil {
		return CoordinatorRequest{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return CoordinatorRequest{}, err
	}
	defer func() { _ = tx.Rollback() }()
	nowMs := time.Now().UTC().UnixMilli()
	if _, err := tx.Exec(`INSERT INTO coordinator_requests(id, kind, payload_json, actor, state, created_at) VALUES(?, ?, ?, ?, 'pending', ?)`,
		id, kind, string(encoded), actor, nowMs); err != nil {
		return CoordinatorRequest{}, err
	}
	if _, err := appendEvent(tx, Event{Type: "coordinator.request.created"}, nowMs,
		map[string]any{"request_id": id, "kind": kind, "actor": actor, "payload": payload}); err != nil {
		return CoordinatorRequest{}, err
	}
	if err := tx.Commit(); err != nil {
		return CoordinatorRequest{}, err
	}
	return CoordinatorRequest{ID: id, Kind: kind, Payload: payload, Actor: actor, State: "pending",
		CreatedAt: formatMillis(nowMs), Version: 1}, nil
}

// ClaimCoordinatorRequests atomically hands every pending request to owner.
func (s *Store) ClaimCoordinatorRequests(owner string, limit int) ([]CoordinatorRequest, error) {
	owner = strings.TrimSpace(owner)
	if owner == "" {
		return nil, errors.New("claiming coordinator requests needs an owner")
	}
	if limit <= 0 || limit > 50 {
		limit = 50
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	nowMs := time.Now().UTC().UnixMilli()
	// A claimant may disappear after changing state but before dispatch.  Its
	// request becomes available again after the bounded claim lease.
	if _, err := tx.Exec(`UPDATE coordinator_requests
		SET state = 'pending', claimed_by = '', claimed_at = NULL,
		    lease_expires_at = NULL, version = version + 1
		WHERE state = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`, nowMs); err != nil {
		return nil, err
	}
	rows, err := tx.Query(`SELECT id, kind, payload_json, actor, created_at, version FROM coordinator_requests
		WHERE state = 'pending' ORDER BY created_at, id LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	claimed := []CoordinatorRequest{}
	for rows.Next() {
		var request CoordinatorRequest
		var payload string
		var createdAt int64
		if err := rows.Scan(&request.ID, &request.Kind, &payload, &request.Actor, &createdAt, &request.Version); err != nil {
			_ = rows.Close()
			return nil, err
		}
		request.Payload = map[string]any{}
		_ = json.Unmarshal([]byte(payload), &request.Payload)
		request.CreatedAt = formatMillis(createdAt)
		claimed = append(claimed, request)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	leaseExpiresAt := nowMs + 60_000
	for index := range claimed {
		if _, err := tx.Exec(`UPDATE coordinator_requests SET state = 'claimed', claimed_by = ?, claimed_at = ?,
			lease_expires_at = ?, version = version + 1 WHERE id = ? AND state = 'pending'`,
			owner, nowMs, leaseExpiresAt, claimed[index].ID); err != nil {
			return nil, err
		}
		claimed[index].State, claimed[index].ClaimedBy = "claimed", owner
		claimed[index].ClaimedAt, claimed[index].Version = formatMillis(nowMs), claimed[index].Version+1
		claimed[index].LeaseExpiresAt = formatMillis(leaseExpiresAt)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return claimed, nil
}

// CompleteCoordinatorRequest acknowledges a claimed request exactly once.
func (s *Store) CompleteCoordinatorRequest(id, owner, state, reason string) (CoordinatorRequest, error) {
	id, owner, state = strings.TrimSpace(id), strings.TrimSpace(owner), strings.TrimSpace(state)
	if id == "" || owner == "" || (state != "done" && state != "failed") {
		return CoordinatorRequest{}, errors.New("coordinator completion needs id, owner and done/failed state")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	nowMs := time.Now().UTC().UnixMilli()
	result, err := s.db.Exec(`UPDATE coordinator_requests SET state = ?, finished_at = ?,
		failure_reason = ?, lease_expires_at = NULL, version = version + 1
		WHERE id = ? AND state = 'claimed' AND claimed_by = ?`, state, nowMs, strings.TrimSpace(reason), id, owner)
	if err != nil {
		return CoordinatorRequest{}, err
	}
	changed, _ := result.RowsAffected()
	if changed != 1 {
		return CoordinatorRequest{}, errors.New("coordinator request is not claimed by this owner")
	}
	var request CoordinatorRequest
	var payload string
	var createdAt, claimedAt int64
	if err := s.db.QueryRow(`SELECT id, kind, payload_json, actor, state, claimed_by, created_at,
		COALESCE(claimed_at, 0), version FROM coordinator_requests WHERE id = ?`, id).Scan(
		&request.ID, &request.Kind, &payload, &request.Actor, &request.State, &request.ClaimedBy,
		&createdAt, &claimedAt, &request.Version); err != nil {
		return CoordinatorRequest{}, err
	}
	_ = json.Unmarshal([]byte(payload), &request.Payload)
	request.CreatedAt, request.ClaimedAt = formatMillis(createdAt), formatMillis(claimedAt)
	request.FinishedAt, request.FailureReason = formatMillis(nowMs), strings.TrimSpace(reason)
	return request, nil
}
