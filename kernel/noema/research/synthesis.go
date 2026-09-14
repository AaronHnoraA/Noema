// Noema research synthesis state is Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package research

// This file is the authority boundary for Phase F.  Model and supervisor
// adapters can only create Proposal rows.  Findings and immutable ResearchIR /
// ProblemModel versions are materialized here only after a versioned human
// review.  Evidence spans are checked against immutable CAS bytes before the
// transaction can commit.

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const maxProposalBytes = 1024 * 1024

var synthesisKindPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)

var proposalKinds = map[string]bool{
	"cell.create": true, "finding.create": true, "research_ir.create": true,
	"problem_model.create": true, "task.create": true, "job.create": true,
	"delegation.create": true,
}

var findingStatuses = map[string]bool{
	"proposed": true, "supported": true, "disputed": true,
	"refuted": true, "accepted": true, "superseded": true,
}

var verificationLevels = map[string]bool{
	"unreviewed": true, "agent_checked": true, "reproduced": true,
	"human_reviewed": true, "formally_verified": true,
}

var evidenceRelations = map[string]bool{
	"supports": true, "refutes": true, "qualifies": true,
	"context": true, "insufficient": true,
}

var semanticRelations = map[string]bool{
	"supports": true, "refutes": true, "qualifies": true, "depends_on": true,
	"equivalent_to": true, "generalizes": true, "specializes": true,
	"blocks": true, "motivates": true, "answers": true, "raises": true,
	"corroborates": true,
}

var provenanceRelations = map[string]bool{
	"derived_from": true, "used": true, "generated_by": true,
	"attributed_to": true, "associated_with": true,
}

// Proposal is an untrusted candidate until a human review changes Status.
// Payload remains the exact original candidate; ReviewedPayload records any
// human edit without rewriting that history.
type Proposal struct {
	ID              string         `json:"id"`
	ClientRequestID string         `json:"clientRequestId"`
	WorkstreamID    string         `json:"workstreamId"`
	Kind            string         `json:"kind"`
	Payload         map[string]any `json:"payload"`
	PayloadSHA256   string         `json:"payloadSha256"`
	Status          string         `json:"status"`
	ProposedBy      string         `json:"proposedBy"`
	SourceAdapter   string         `json:"sourceAdapter"`
	CreatedAt       string         `json:"createdAt"`
	ReviewedBy      string         `json:"reviewedBy,omitempty"`
	ReviewedAt      string         `json:"reviewedAt,omitempty"`
	RejectionReason string         `json:"rejectionReason,omitempty"`
	AcceptedRef     string         `json:"acceptedRef,omitempty"`
	ReviewedPayload map[string]any `json:"reviewedPayload,omitempty"`
	Version         int64          `json:"version"`
}

type CreateProposalInput struct {
	ClientRequestID string         `json:"clientRequestId"`
	WorkstreamID    string         `json:"workstreamId"`
	Kind            string         `json:"kind"`
	Payload         map[string]any `json:"payload"`
	ProposedBy      string         `json:"proposedBy"`
	SourceAdapter   string         `json:"sourceAdapter"`
}

type ProposalFilter struct {
	WorkstreamID string
	Status       string
	Limit        int
}

type ReviewProposalInput struct {
	ProposalID      string         `json:"proposalId"`
	Decision        string         `json:"decision"`
	ExpectedVersion int64          `json:"expectedVersion"`
	ReviewedBy      string         `json:"reviewedBy"`
	Reason          string         `json:"reason"`
	EditedPayload   map[string]any `json:"editedPayload"`
	AcceptedRef     string         `json:"acceptedRef"`
}

// BeginProposalAcceptanceInput reserves a cell Proposal before the Node
// notebook authority performs its compare-and-swap write. The reviewed
// payload is frozen by this transition and must be used by finalization.
type BeginProposalAcceptanceInput struct {
	ProposalID      string         `json:"proposalId"`
	ExpectedVersion int64          `json:"expectedVersion"`
	ReviewedBy      string         `json:"reviewedBy"`
	EditedPayload   map[string]any `json:"editedPayload"`
}

type ReviewProposalResult struct {
	Proposal     Proposal             `json:"proposal"`
	Finding      *Finding             `json:"finding,omitempty"`
	ResearchIR   *ResearchIRVersion   `json:"researchIr,omitempty"`
	ProblemModel *ProblemModelVersion `json:"problemModel,omitempty"`
	Task         *Task                `json:"task,omitempty"`
	Job          *Job                 `json:"job,omitempty"`
	Delegation   *Delegation          `json:"delegation,omitempty"`
	Deduplicated bool                 `json:"deduplicated,omitempty"`
}

type EvidenceSpanInput struct {
	Relation    string `json:"relation"`
	ArtifactID  string `json:"artifactId"`
	ByteStart   int64  `json:"byteStart"`
	ByteEnd     int64  `json:"byteEnd"`
	BlockSHA256 string `json:"blockSha256"`
	ASTPath     string `json:"astPath"`
}

type FindingRelationInput struct {
	TargetID      string `json:"targetId"`
	Type          string `json:"type"`
	RelationClass string `json:"relationClass"`
}

type FindingSpec struct {
	Kind         string                 `json:"kind"`
	Statement    string                 `json:"statement"`
	Status       string                 `json:"status"`
	Verification map[string]any         `json:"verification"`
	Scope        map[string]any         `json:"scope"`
	Origin       map[string]any         `json:"origin"`
	Disclosure   string                 `json:"disclosure"`
	Evidence     []EvidenceSpanInput    `json:"evidence"`
	Relations    []FindingRelationInput `json:"relations"`
}

type FindingEvidence struct {
	ID          string `json:"id"`
	FindingID   string `json:"findingId"`
	ArtifactID  string `json:"artifactId"`
	Relation    string `json:"relation"`
	ByteStart   int64  `json:"byteStart"`
	ByteEnd     int64  `json:"byteEnd"`
	BlockSHA256 string `json:"blockSha256"`
	ASTPath     string `json:"astPath,omitempty"`
	CreatedAt   string `json:"createdAt"`
}

type FindingRelation struct {
	SourceID      string `json:"sourceId"`
	TargetID      string `json:"targetId"`
	Type          string `json:"type"`
	RelationClass string `json:"relationClass"`
	CreatedAt     string `json:"createdAt"`
}

type Finding struct {
	ID                string            `json:"id"`
	WorkstreamID      string            `json:"workstreamId"`
	Kind              string            `json:"kind"`
	Statement         string            `json:"statement"`
	Status            string            `json:"status"`
	VerificationLevel string            `json:"verificationLevel"`
	Verification      map[string]any    `json:"verification"`
	Scope             map[string]any    `json:"scope"`
	Origin            map[string]any    `json:"origin"`
	Disclosure        string            `json:"disclosure"`
	SemanticSHA256    string            `json:"semanticSha256"`
	Evidence          []FindingEvidence `json:"evidence"`
	Relations         []FindingRelation `json:"relations"`
	CreatedAt         string            `json:"createdAt"`
	Version           int64             `json:"version"`
}

type FindingFilter struct {
	WorkstreamID string
	Status       string
	Query        string
	Limit        int
	IncludeLocal bool
}

type ResearchIRVersion struct {
	WorkstreamID string         `json:"workstreamId"`
	Version      int64          `json:"version"`
	Document     map[string]any `json:"document"`
	SHA256       string         `json:"sha256"`
	CreatedBy    string         `json:"createdBy"`
	CreatedAt    string         `json:"createdAt"`
	ReviewStatus string         `json:"reviewStatus"`
}

type ProblemModelVersion struct {
	ID                string         `json:"id"`
	WorkstreamID      string         `json:"workstreamId"`
	Version           int64          `json:"version"`
	Document          map[string]any `json:"document"`
	SHA256            string         `json:"sha256"`
	ResearchIRVersion int64          `json:"researchIrVersion"`
	ArtifactSetHash   string         `json:"artifactSetHash"`
	PolicyHash        string         `json:"policyHash"`
	CreatedBy         string         `json:"createdBy"`
	CreatedAt         string         `json:"createdAt"`
	ReviewStatus      string         `json:"reviewStatus"`
}

const proposalSelect = `SELECT id, client_request_id, workstream_id, kind, payload_json, payload_sha256,
	status, proposed_by, source_adapter, created_at, reviewed_by, COALESCE(reviewed_at, 0),
	rejection_reason, accepted_ref, COALESCE(reviewed_payload_json, ''), version FROM proposals`

func (s *Store) CreateProposal(input CreateProposalInput) (Proposal, error) {
	input.ClientRequestID = strings.TrimSpace(input.ClientRequestID)
	input.WorkstreamID, input.Kind = strings.TrimSpace(input.WorkstreamID), strings.TrimSpace(input.Kind)
	input.ProposedBy, input.SourceAdapter = strings.TrimSpace(input.ProposedBy), strings.TrimSpace(input.SourceAdapter)
	if input.ClientRequestID == "" || len(input.ClientRequestID) > 200 {
		return Proposal{}, errors.New("proposal requires a bounded client request id")
	}
	if !strings.HasPrefix(input.WorkstreamID, "ws_") || !proposalKinds[input.Kind] {
		return Proposal{}, errors.New("proposal workstream or kind is invalid")
	}
	if input.ProposedBy == "" || len(input.ProposedBy) > 200 || input.SourceAdapter == "" || len(input.SourceAdapter) > 100 {
		return Proposal{}, errors.New("proposal actor and source adapter are required and bounded")
	}
	if input.Payload == nil {
		return Proposal{}, errors.New("proposal payload is required")
	}
	payloadJSON, digest, err := canonicalJSON(input.Payload)
	if err != nil || len(payloadJSON) == 0 || len(payloadJSON) > maxProposalBytes {
		return Proposal{}, fmt.Errorf("proposal payload must be valid JSON no larger than %d bytes", maxProposalBytes)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Proposal{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if prior, err := getProposalTx(tx, "client_request_id", input.ClientRequestID); err == nil {
		if prior.WorkstreamID != input.WorkstreamID || prior.Kind != input.Kind || prior.PayloadSHA256 != "sha256:"+digest ||
			prior.ProposedBy != input.ProposedBy || prior.SourceAdapter != input.SourceAdapter {
			return Proposal{}, errors.New("proposal client request id was reused with different content")
		}
		return prior, tx.Commit()
	} else if !errors.Is(err, sql.ErrNoRows) {
		return Proposal{}, err
	}
	if err := requireWorkstreamTx(tx, input.WorkstreamID); err != nil {
		return Proposal{}, err
	}
	id, err := prefixedUUID("prop_")
	if err != nil {
		return Proposal{}, err
	}
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	if _, err := tx.Exec(`INSERT INTO proposals(id, client_request_id, workstream_id, kind, payload_json,
		payload_sha256, status, proposed_by, source_adapter, created_at) VALUES(?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
		id, input.ClientRequestID, input.WorkstreamID, input.Kind, string(payloadJSON), digest,
		input.ProposedBy, input.SourceAdapter, nowMs); err != nil {
		return Proposal{}, err
	}
	proposal := Proposal{ID: id, ClientRequestID: input.ClientRequestID, WorkstreamID: input.WorkstreamID,
		Kind: input.Kind, Payload: input.Payload, PayloadSHA256: "sha256:" + digest, Status: "pending",
		ProposedBy: input.ProposedBy, SourceAdapter: input.SourceAdapter, CreatedAt: formatMillis(nowMs), Version: 1}
	if _, err := appendEvent(tx, Event{Type: "proposal.created", WorkstreamID: input.WorkstreamID}, nowMs,
		map[string]any{"proposal_id": id, "kind": input.Kind, "proposed_by": input.ProposedBy,
			"source_adapter": input.SourceAdapter, "payload_sha256": "sha256:" + digest}); err != nil {
		return Proposal{}, err
	}
	if err := tx.Commit(); err != nil {
		return Proposal{}, err
	}
	return proposal, nil
}

func (s *Store) GetProposal(id string) (Proposal, error) {
	proposal, err := scanProposal(s.db.QueryRow(proposalSelect+` WHERE id = ?`, strings.TrimSpace(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return Proposal{}, fmt.Errorf("proposal %q not found", id)
	}
	return proposal, err
}

func (s *Store) ListProposals(filter ProposalFilter) ([]Proposal, error) {
	limit := filter.Limit
	if limit < 1 || limit > 1000 {
		limit = 200
	}
	query, args := proposalSelect+` WHERE 1 = 1`, []any{}
	if workstreamID := strings.TrimSpace(filter.WorkstreamID); workstreamID != "" {
		query += ` AND workstream_id = ?`
		args = append(args, workstreamID)
	}
	if status := strings.TrimSpace(filter.Status); status != "" {
		if status != "pending" && status != "accepting" && status != "accepted" && status != "rejected" {
			return nil, errors.New("proposal status is invalid")
		}
		query += ` AND status = ?`
		args = append(args, status)
	}
	query += ` ORDER BY created_at DESC, id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	proposals := []Proposal{}
	for rows.Next() {
		proposal, err := scanProposal(rows)
		if err != nil {
			return nil, err
		}
		proposals = append(proposals, proposal)
	}
	return proposals, rows.Err()
}

// BeginProposalAcceptance atomically fences a cell Proposal before any
// notebook bytes are changed. Replaying the same reservation after a lost
// response is idempotent; a different reviewer or payload is rejected.
func (s *Store) BeginProposalAcceptance(input BeginProposalAcceptanceInput) (Proposal, error) {
	input.ProposalID = strings.TrimSpace(input.ProposalID)
	input.ReviewedBy = strings.TrimSpace(input.ReviewedBy)
	if !strings.HasPrefix(input.ProposalID, "prop_") || input.ExpectedVersion < 1 ||
		input.ReviewedBy == "" || len(input.ReviewedBy) > 200 {
		return Proposal{}, errors.New("proposal acceptance reservation requires an id, version and bounded reviewer")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Proposal{}, err
	}
	defer func() { _ = tx.Rollback() }()
	proposal, err := getProposalTx(tx, "id", input.ProposalID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Proposal{}, fmt.Errorf("proposal %q not found", input.ProposalID)
		}
		return Proposal{}, err
	}
	if proposal.Kind != "cell.create" {
		return Proposal{}, errors.New("only cell Proposals require an acceptance reservation")
	}
	reviewedPayload := proposal.Payload
	if input.EditedPayload != nil {
		reviewedPayload = input.EditedPayload
	}
	reviewedJSON, reviewedDigest, err := canonicalJSON(reviewedPayload)
	if err != nil || len(reviewedJSON) == 0 || len(reviewedJSON) > maxProposalBytes {
		return Proposal{}, errors.New("reviewed proposal payload is invalid or too large")
	}
	if proposal.Status == "accepting" {
		_, storedDigest, storedErr := canonicalJSON(proposal.ReviewedPayload)
		if storedErr != nil || storedDigest != reviewedDigest ||
			(input.ExpectedVersion != proposal.Version && input.ExpectedVersion != proposal.Version-1) {
			return Proposal{}, errors.New("proposal acceptance reservation has a different frozen review")
		}
		if err := tx.Commit(); err != nil {
			return Proposal{}, err
		}
		return proposal, nil
	}
	if proposal.Status != "pending" || proposal.Version != input.ExpectedVersion {
		return Proposal{}, errors.New("proposal acceptance reservation lost optimistic concurrency or was already decided")
	}
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	updated, err := tx.Exec(`UPDATE proposals SET status = 'accepting', reviewed_by = ?, reviewed_at = ?,
		reviewed_payload_json = ?, version = version + 1 WHERE id = ? AND status = 'pending' AND version = ?`,
		input.ReviewedBy, nowMs, string(reviewedJSON), proposal.ID, input.ExpectedVersion)
	if err != nil {
		return Proposal{}, err
	}
	if count, _ := updated.RowsAffected(); count != 1 {
		return Proposal{}, errors.New("proposal acceptance reservation lost optimistic concurrency")
	}
	proposal.Status, proposal.ReviewedBy, proposal.ReviewedAt = "accepting", input.ReviewedBy, formatMillis(nowMs)
	proposal.ReviewedPayload = reviewedPayload
	proposal.Version++
	if _, err := appendEvent(tx, Event{Type: "proposal.acceptance.started", WorkstreamID: proposal.WorkstreamID}, nowMs,
		map[string]any{"proposal_id": proposal.ID, "kind": proposal.Kind, "reviewed_by": input.ReviewedBy,
			"reviewed_payload_sha256": "sha256:" + reviewedDigest}); err != nil {
		return Proposal{}, err
	}
	if err := tx.Commit(); err != nil {
		return Proposal{}, err
	}
	return proposal, nil
}

func (s *Store) ReviewProposal(input ReviewProposalInput) (ReviewProposalResult, error) {
	input.ProposalID, input.Decision = strings.TrimSpace(input.ProposalID), strings.TrimSpace(input.Decision)
	input.ReviewedBy, input.Reason, input.AcceptedRef = strings.TrimSpace(input.ReviewedBy), strings.TrimSpace(input.Reason), strings.TrimSpace(input.AcceptedRef)
	if !strings.HasPrefix(input.ProposalID, "prop_") || (input.Decision != "accept" && input.Decision != "reject") {
		return ReviewProposalResult{}, errors.New("proposal review id or decision is invalid")
	}
	if input.ExpectedVersion < 1 || input.ReviewedBy == "" || len(input.ReviewedBy) > 200 || len(input.Reason) > 4000 {
		return ReviewProposalResult{}, errors.New("proposal review requires a version and bounded reviewer")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return ReviewProposalResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	proposal, err := getProposalTx(tx, "id", input.ProposalID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ReviewProposalResult{}, fmt.Errorf("proposal %q not found", input.ProposalID)
		}
		return ReviewProposalResult{}, err
	}
	if proposal.Version != input.ExpectedVersion {
		return ReviewProposalResult{}, errors.New("proposal review lost optimistic concurrency or was already decided")
	}
	if input.Decision == "accept" && proposal.Kind == "cell.create" {
		if proposal.Status != "accepting" {
			return ReviewProposalResult{}, errors.New("cell Proposal must be reserved before materialization")
		}
	} else if proposal.Status != "pending" {
		return ReviewProposalResult{}, errors.New("proposal review lost optimistic concurrency or was already decided")
	}
	reviewedPayload := proposal.Payload
	if proposal.Status == "accepting" {
		reviewedPayload = proposal.ReviewedPayload
		if input.EditedPayload != nil {
			_, frozenDigest, frozenErr := canonicalJSON(reviewedPayload)
			_, submittedDigest, submittedErr := canonicalJSON(input.EditedPayload)
			if frozenErr != nil || submittedErr != nil || frozenDigest != submittedDigest {
				return ReviewProposalResult{}, errors.New("cell Proposal reviewed payload changed after acceptance reservation")
			}
		}
	} else if input.EditedPayload != nil {
		reviewedPayload = input.EditedPayload
	}
	reviewedJSON, _, err := canonicalJSON(reviewedPayload)
	if err != nil || len(reviewedJSON) == 0 || len(reviewedJSON) > maxProposalBytes {
		return ReviewProposalResult{}, errors.New("reviewed proposal payload is invalid or too large")
	}
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	result := ReviewProposalResult{}
	acceptedRef := ""
	if input.Decision == "accept" {
		switch proposal.Kind {
		case "finding.create":
			finding, deduplicated, err := s.createFindingFromProposalTx(tx, proposal, reviewedPayload, nowMs)
			if err != nil {
				return ReviewProposalResult{}, err
			}
			result.Finding, result.Deduplicated = &finding, deduplicated
			acceptedRef = "finding:" + finding.ID
		case "research_ir.create":
			version, deduplicated, err := createResearchIRFromProposalTx(tx, proposal, reviewedPayload, nowMs)
			if err != nil {
				return ReviewProposalResult{}, err
			}
			result.ResearchIR, result.Deduplicated = &version, deduplicated
			acceptedRef = fmt.Sprintf("research-ir:%s:%d", version.WorkstreamID, version.Version)
		case "problem_model.create":
			version, deduplicated, err := createProblemModelFromProposalTx(tx, proposal, reviewedPayload, nowMs)
			if err != nil {
				return ReviewProposalResult{}, err
			}
			result.ProblemModel, result.Deduplicated = &version, deduplicated
			acceptedRef = fmt.Sprintf("problem-model:%s:%d", version.ID, version.Version)
		case "task.create":
			task, err := createTaskFromProposalTx(tx, proposal, reviewedPayload, nowMs)
			if err != nil {
				return ReviewProposalResult{}, err
			}
			result.Task = &task
			acceptedRef = "task:" + task.ID
		case "job.create":
			job, err := createJobFromProposalTx(tx, proposal, reviewedPayload, nowMs)
			if err != nil {
				return ReviewProposalResult{}, err
			}
			result.Job = &job
			acceptedRef = "job:" + job.ID
		case "delegation.create":
			delegation, err := createDelegationFromProposalTx(tx, proposal, reviewedPayload, nowMs)
			if err != nil {
				return ReviewProposalResult{}, err
			}
			result.Delegation = &delegation
			acceptedRef = "delegation:" + delegation.ID
		case "cell.create":
			if err := verifyAcceptedCellTx(tx, proposal.WorkstreamID, reviewedPayload, input.AcceptedRef); err != nil {
				return ReviewProposalResult{}, err
			}
			acceptedRef = input.AcceptedRef
		default:
			return ReviewProposalResult{}, fmt.Errorf("proposal kind %q has no authoritative acceptance materializer", proposal.Kind)
		}
	}
	status := "accepted"
	if input.Decision == "reject" {
		status = "rejected"
		if input.Reason == "" {
			return ReviewProposalResult{}, errors.New("rejecting a proposal requires a reason")
		}
	}
	expectedStatus := "pending"
	if proposal.Kind == "cell.create" && input.Decision == "accept" {
		expectedStatus = "accepting"
	}
	updated, err := tx.Exec(`UPDATE proposals SET status = ?, reviewed_by = ?, reviewed_at = ?, rejection_reason = ?,
		accepted_ref = ?, reviewed_payload_json = ?, version = version + 1 WHERE id = ? AND status = ? AND version = ?`,
		status, input.ReviewedBy, nowMs, input.Reason, acceptedRef, string(reviewedJSON), proposal.ID, expectedStatus, input.ExpectedVersion)
	if err != nil {
		return ReviewProposalResult{}, err
	}
	if count, _ := updated.RowsAffected(); count != 1 {
		return ReviewProposalResult{}, errors.New("proposal review lost optimistic concurrency")
	}
	proposal.Status, proposal.ReviewedBy, proposal.ReviewedAt = status, input.ReviewedBy, formatMillis(nowMs)
	proposal.RejectionReason, proposal.AcceptedRef, proposal.ReviewedPayload = input.Reason, acceptedRef, reviewedPayload
	proposal.Version++
	result.Proposal = proposal
	if input.Decision == "accept" {
		materializedEvent := map[string]string{
			"cell.create":          "cell.proposal.materialized",
			"finding.create":       "finding.accepted",
			"research_ir.create":   "research_ir.version.created",
			"problem_model.create": "problem_model.version.created",
			"task.create":          "task.proposal.materialized",
			"job.create":           "job.proposal.materialized",
			"delegation.create":    "delegation.proposal.materialized",
		}[proposal.Kind]
		if materializedEvent != "" {
			if _, err := appendEvent(tx, Event{Type: materializedEvent, WorkstreamID: proposal.WorkstreamID}, nowMs,
				map[string]any{"proposal_id": proposal.ID, "accepted_ref": acceptedRef,
					"reviewed_by": input.ReviewedBy, "source_adapter": proposal.SourceAdapter}); err != nil {
				return ReviewProposalResult{}, err
			}
		}
	}
	if _, err := appendEvent(tx, Event{Type: "proposal.reviewed", WorkstreamID: proposal.WorkstreamID}, nowMs,
		map[string]any{"proposal_id": proposal.ID, "kind": proposal.Kind, "decision": input.Decision,
			"reviewed_by": input.ReviewedBy, "accepted_ref": acceptedRef, "deduplicated": result.Deduplicated}); err != nil {
		return ReviewProposalResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return ReviewProposalResult{}, err
	}
	return result, nil
}

func (s *Store) GetFinding(id string) (Finding, error) {
	finding, err := scanFinding(s.db.QueryRow(findingSelect+` WHERE id = ?`, strings.TrimSpace(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return Finding{}, fmt.Errorf("finding %q not found", id)
	}
	if err != nil {
		return Finding{}, err
	}
	return s.attachFindingDetails(finding)
}

func (s *Store) ListFindings(filter FindingFilter) ([]Finding, error) {
	limit := filter.Limit
	if limit < 1 || limit > 1000 {
		limit = 200
	}
	query, args := findingSelect+` WHERE 1 = 1`, []any{}
	if workstreamID := strings.TrimSpace(filter.WorkstreamID); workstreamID != "" {
		query += ` AND workstream_id = ?`
		args = append(args, workstreamID)
	}
	if status := strings.TrimSpace(filter.Status); status != "" {
		if !findingStatuses[status] {
			return nil, errors.New("finding status is invalid")
		}
		query += ` AND status = ?`
		args = append(args, status)
	}
	if !filter.IncludeLocal {
		query += ` AND disclosure <> 'local_only'`
	}
	if search := strings.TrimSpace(filter.Query); search != "" {
		query += ` AND (statement LIKE ? OR kind LIKE ?)`
		pattern := "%" + search + "%"
		args = append(args, pattern, pattern)
	}
	query += ` ORDER BY created_at DESC, id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	findings := []Finding{}
	for rows.Next() {
		finding, err := scanFinding(rows)
		if err != nil {
			return nil, err
		}
		findings = append(findings, finding)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for index := range findings {
		findings[index], err = s.attachFindingDetails(findings[index])
		if err != nil {
			return nil, err
		}
	}
	return findings, nil
}

func (s *Store) ListResearchIR(workstreamID string, limit int) ([]ResearchIRVersion, error) {
	workstreamID = strings.TrimSpace(workstreamID)
	if limit < 1 || limit > 1000 {
		limit = 100
	}
	rows, err := s.db.Query(researchIRSelect+` WHERE workstream_id = ? ORDER BY version DESC LIMIT ?`, workstreamID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	versions := []ResearchIRVersion{}
	for rows.Next() {
		version, err := scanResearchIR(rows)
		if err != nil {
			return nil, err
		}
		versions = append(versions, version)
	}
	return versions, rows.Err()
}

func (s *Store) ListProblemModels(workstreamID string, limit int) ([]ProblemModelVersion, error) {
	workstreamID = strings.TrimSpace(workstreamID)
	if limit < 1 || limit > 1000 {
		limit = 100
	}
	rows, err := s.db.Query(problemModelSelect+` WHERE workstream_id = ? ORDER BY version DESC LIMIT ?`, workstreamID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	versions := []ProblemModelVersion{}
	for rows.Next() {
		version, err := scanProblemModel(rows)
		if err != nil {
			return nil, err
		}
		versions = append(versions, version)
	}
	return versions, rows.Err()
}

func (s *Store) createFindingFromProposalTx(tx *sql.Tx, proposal Proposal, payload map[string]any, nowMs int64) (Finding, bool, error) {
	raw := proposalDocument(payload, "finding")
	if _, exists := raw["truth"]; exists {
		return Finding{}, false, errors.New("Findings must not store a scalar truth field")
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return Finding{}, false, err
	}
	spec := FindingSpec{}
	if err := json.Unmarshal(encoded, &spec); err != nil {
		return Finding{}, false, err
	}
	spec.Kind, spec.Statement = strings.TrimSpace(spec.Kind), strings.TrimSpace(spec.Statement)
	spec.Status, spec.Disclosure = strings.TrimSpace(spec.Status), strings.TrimSpace(spec.Disclosure)
	if !synthesisKindPattern.MatchString(spec.Kind) || spec.Statement == "" || len([]byte(spec.Statement)) > 64*1024 {
		return Finding{}, false, errors.New("finding kind or statement is invalid")
	}
	if spec.Status == "" {
		spec.Status = "proposed"
	}
	if !findingStatuses[spec.Status] {
		return Finding{}, false, errors.New("finding epistemic status is invalid")
	}
	if spec.Disclosure == "" {
		spec.Disclosure = "project"
	}
	if spec.Disclosure != "project" && spec.Disclosure != "local_only" {
		return Finding{}, false, errors.New("finding disclosure is invalid")
	}
	if spec.Verification == nil {
		spec.Verification = map[string]any{}
	}
	level := strings.TrimSpace(stringValue(spec.Verification["level"]))
	if level == "" {
		level = "unreviewed"
		spec.Verification["level"] = level
	}
	if !verificationLevels[level] {
		return Finding{}, false, errors.New("finding verification level is invalid")
	}
	if spec.Scope == nil {
		spec.Scope = map[string]any{}
	}
	if spec.Origin == nil {
		spec.Origin = map[string]any{}
	}
	if len(spec.Evidence) == 0 || len(spec.Evidence) > 128 {
		return Finding{}, false, errors.New("every Finding requires 1-128 immutable evidence spans")
	}
	validatedEvidence, err := s.validateEvidenceTx(tx, spec.Evidence)
	if err != nil {
		return Finding{}, false, err
	}
	semanticJSON, semanticDigest, err := canonicalJSON(map[string]any{
		"kind": spec.Kind, "statement": spec.Statement, "scope": spec.Scope,
	})
	if err != nil || len(semanticJSON) == 0 {
		return Finding{}, false, errors.New("finding identity could not be encoded")
	}
	verificationJSON, _, err := canonicalJSON(spec.Verification)
	if err != nil {
		return Finding{}, false, err
	}
	scopeJSON, _, err := canonicalJSON(spec.Scope)
	if err != nil {
		return Finding{}, false, err
	}
	originJSON, _, err := canonicalJSON(spec.Origin)
	if err != nil {
		return Finding{}, false, err
	}
	finding, deduplicated, aggregateChanged := Finding{}, false, false
	finding, err = scanFinding(tx.QueryRow(findingSelect+` WHERE workstream_id = ? AND semantic_sha256 = ?`, proposal.WorkstreamID, semanticDigest))
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Finding{}, false, err
	}
	if errors.Is(err, sql.ErrNoRows) {
		id, err := prefixedUUID("finding_")
		if err != nil {
			return Finding{}, false, err
		}
		if _, err := tx.Exec(`INSERT INTO findings(id, workstream_id, kind, statement, status, verification_level,
			verification_json, scope_json, origin_json, disclosure, semantic_sha256, created_at)
			VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, proposal.WorkstreamID, spec.Kind, spec.Statement,
			spec.Status, level, string(verificationJSON), string(scopeJSON), string(originJSON), spec.Disclosure,
			semanticDigest, nowMs); err != nil {
			return Finding{}, false, err
		}
		finding = Finding{ID: id, WorkstreamID: proposal.WorkstreamID, Kind: spec.Kind, Statement: spec.Statement,
			Status: spec.Status, VerificationLevel: level, Verification: spec.Verification, Scope: spec.Scope,
			Origin: spec.Origin, Disclosure: spec.Disclosure, SemanticSHA256: "sha256:" + semanticDigest,
			CreatedAt: formatMillis(nowMs), Version: 1, Evidence: []FindingEvidence{}, Relations: []FindingRelation{}}
	} else {
		deduplicated = true
		if finding.Disclosure != "local_only" && spec.Disclosure == "local_only" {
			if _, err := tx.Exec(`UPDATE findings SET disclosure = 'local_only' WHERE id = ?`, finding.ID); err != nil {
				return Finding{}, false, err
			}
			finding.Disclosure, aggregateChanged = "local_only", true
		}
	}
	for _, evidence := range validatedEvidence {
		evidenceID, err := prefixedUUID("evidence_")
		if err != nil {
			return Finding{}, false, err
		}
		inserted, err := tx.Exec(`INSERT OR IGNORE INTO finding_evidence(id, finding_id, artifact_id, relation,
			byte_start, byte_end, block_sha256, ast_path, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			evidenceID, finding.ID, evidence.ArtifactID, evidence.Relation, evidence.ByteStart, evidence.ByteEnd,
			evidence.BlockSHA256, evidence.ASTPath, nowMs)
		if err != nil {
			return Finding{}, false, err
		}
		if count, _ := inserted.RowsAffected(); deduplicated && count > 0 {
			aggregateChanged = true
		}
	}
	for _, relation := range spec.Relations {
		relation.TargetID, relation.Type, relation.RelationClass = strings.TrimSpace(relation.TargetID), strings.TrimSpace(relation.Type), strings.TrimSpace(relation.RelationClass)
		if relation.TargetID == finding.ID || !validFindingRelation(relation.RelationClass, relation.Type) {
			return Finding{}, false, errors.New("finding relation is invalid or self-referential")
		}
		var target string
		if err := tx.QueryRow(`SELECT id FROM findings WHERE id = ? AND workstream_id = ?`, relation.TargetID, proposal.WorkstreamID).Scan(&target); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return Finding{}, false, fmt.Errorf("related finding %q not found in this workstream", relation.TargetID)
			}
			return Finding{}, false, err
		}
		inserted, err := tx.Exec(`INSERT OR IGNORE INTO finding_relations(source_finding_id, target_finding_id, type,
			relation_class, created_at) VALUES(?, ?, ?, ?, ?)`, finding.ID, target, relation.Type, relation.RelationClass, nowMs)
		if err != nil {
			return Finding{}, false, err
		}
		if count, _ := inserted.RowsAffected(); deduplicated && count > 0 {
			aggregateChanged = true
		}
	}
	if deduplicated && aggregateChanged {
		if _, err := tx.Exec(`UPDATE findings SET version = version + 1 WHERE id = ?`, finding.ID); err != nil {
			return Finding{}, false, err
		}
		finding.Version++
	}
	finding.Evidence, err = findingEvidenceTx(tx, finding.ID)
	if err != nil {
		return Finding{}, false, err
	}
	finding.Relations, err = findingRelationsTx(tx, finding.ID)
	if err != nil {
		return Finding{}, false, err
	}
	return finding, deduplicated, nil
}

func createResearchIRFromProposalTx(tx *sql.Tx, proposal Proposal, payload map[string]any, nowMs int64) (ResearchIRVersion, bool, error) {
	document := proposalDocument(payload, "researchIr")
	if err := validateResearchIRDocumentTx(tx, proposal.WorkstreamID, document); err != nil {
		return ResearchIRVersion{}, false, err
	}
	delete(document, "version")
	delete(document, "workstream_id")
	delete(document, "workstreamId")
	encoded, digest, err := canonicalJSON(document)
	if err != nil {
		return ResearchIRVersion{}, false, err
	}
	if prior, err := researchIRByDigestTx(tx, proposal.WorkstreamID, digest); err == nil {
		return prior, true, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return ResearchIRVersion{}, false, err
	}
	var next int64
	if err := tx.QueryRow(`SELECT COALESCE(MAX(version), 0) + 1 FROM research_ir_versions WHERE workstream_id = ?`, proposal.WorkstreamID).Scan(&next); err != nil {
		return ResearchIRVersion{}, false, err
	}
	if _, err := tx.Exec(`INSERT INTO research_ir_versions(workstream_id, version, document_json, sha256,
		created_by, created_at, review_status) VALUES(?, ?, ?, ?, ?, ?, 'human_reviewed')`,
		proposal.WorkstreamID, next, string(encoded), digest, proposal.ProposedBy, nowMs); err != nil {
		return ResearchIRVersion{}, false, err
	}
	return ResearchIRVersion{WorkstreamID: proposal.WorkstreamID, Version: next, Document: document,
		SHA256: "sha256:" + digest, CreatedBy: proposal.ProposedBy, CreatedAt: formatMillis(nowMs), ReviewStatus: "human_reviewed"}, false, nil
}

func createProblemModelFromProposalTx(tx *sql.Tx, proposal Proposal, payload map[string]any, nowMs int64) (ProblemModelVersion, bool, error) {
	document := proposalDocument(payload, "problemModel")
	if stringValue(document["schema"]) != "noema.problem-model/1" {
		return ProblemModelVersion{}, false, errors.New("Problem Model schema must be noema.problem-model/1")
	}
	snapshot := mapValue(document["source_snapshot"])
	if len(snapshot) == 0 {
		snapshot = mapValue(document["sourceSnapshot"])
	}
	irVersion := int64Value(snapshot["research_ir_version"])
	if irVersion == 0 {
		irVersion = int64Value(snapshot["researchIrVersion"])
	}
	artifactSetHash, err := normalizedSHA256(stringValue(snapshot["artifact_set_hash"]), false)
	if err != nil {
		artifactSetHash, err = normalizedSHA256(stringValue(snapshot["artifactSetHash"]), false)
	}
	if err != nil {
		return ProblemModelVersion{}, false, errors.New("Problem Model requires a valid artifact set hash")
	}
	policyHash, err := normalizedSHA256(stringValue(snapshot["policy_hash"]), false)
	if err != nil {
		policyHash, err = normalizedSHA256(stringValue(snapshot["policyHash"]), false)
	}
	if err != nil {
		return ProblemModelVersion{}, false, errors.New("Problem Model requires a valid policy hash")
	}
	var foundVersion int64
	if err := tx.QueryRow(`SELECT version FROM research_ir_versions WHERE workstream_id = ? AND version = ?`, proposal.WorkstreamID, irVersion).Scan(&foundVersion); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ProblemModelVersion{}, false, errors.New("Problem Model source ResearchIR version does not exist")
		}
		return ProblemModelVersion{}, false, err
	}
	delete(document, "version")
	delete(document, "workstream_id")
	delete(document, "workstreamId")
	var modelID string
	requestedID := strings.TrimSpace(stringValue(document["id"]))
	err = tx.QueryRow(`SELECT id FROM problem_model_versions WHERE workstream_id = ? ORDER BY version DESC LIMIT 1`, proposal.WorkstreamID).Scan(&modelID)
	if errors.Is(err, sql.ErrNoRows) {
		if strings.HasPrefix(requestedID, "pm_") && cellIDPattern.MatchString(requestedID) {
			modelID, err = requestedID, nil
		} else {
			modelID, err = prefixedUUID("pm_")
		}
	}
	if err != nil {
		return ProblemModelVersion{}, false, err
	}
	if requestedID != "" && requestedID != modelID {
		return ProblemModelVersion{}, false, errors.New("Problem Model id cannot change between immutable versions")
	}
	// The immutable document carries the same authoritative identity as its
	// outer version row, even when the first Proposal omitted an id.
	document["id"] = modelID
	encoded, digest, err := canonicalJSON(document)
	if err != nil {
		return ProblemModelVersion{}, false, err
	}
	if prior, err := problemModelByDigestTx(tx, proposal.WorkstreamID, digest); err == nil {
		return prior, true, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return ProblemModelVersion{}, false, err
	}
	var next int64
	if err := tx.QueryRow(`SELECT COALESCE(MAX(version), 0) + 1 FROM problem_model_versions WHERE workstream_id = ?`, proposal.WorkstreamID).Scan(&next); err != nil {
		return ProblemModelVersion{}, false, err
	}
	if _, err := tx.Exec(`INSERT INTO problem_model_versions(id, workstream_id, version, document_json, sha256,
		research_ir_version, artifact_set_hash, policy_hash, created_by, created_at, review_status)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human_reviewed')`, modelID, proposal.WorkstreamID, next,
		string(encoded), digest, irVersion, artifactSetHash, policyHash, proposal.ProposedBy, nowMs); err != nil {
		return ProblemModelVersion{}, false, err
	}
	return ProblemModelVersion{ID: modelID, WorkstreamID: proposal.WorkstreamID, Version: next, Document: document,
		SHA256: "sha256:" + digest, ResearchIRVersion: irVersion, ArtifactSetHash: "sha256:" + artifactSetHash,
		PolicyHash: "sha256:" + policyHash, CreatedBy: proposal.ProposedBy, CreatedAt: formatMillis(nowMs),
		ReviewStatus: "human_reviewed"}, false, nil
}

func validateResearchIRDocumentTx(tx *sql.Tx, workstreamID string, document map[string]any) error {
	if stringValue(document["schema"]) != "noema.research-ir/1" {
		return errors.New("ResearchIR schema must be noema.research-ir/1")
	}
	nodes, ok := document["nodes"].([]any)
	if !ok {
		return errors.New("ResearchIR nodes must be an array")
	}
	edges, ok := document["edges"].([]any)
	if !ok {
		return errors.New("ResearchIR edges must be an array")
	}
	ids := map[string]bool{}
	for _, rawNode := range nodes {
		node := mapValue(rawNode)
		id := strings.TrimSpace(stringValue(node["id"]))
		if id == "" || ids[id] {
			return errors.New("ResearchIR node ids must be present and unique")
		}
		ids[id] = true
		findingID := id
		if strings.HasPrefix(findingID, "finding:") {
			findingID = strings.TrimPrefix(findingID, "finding:")
		}
		if strings.HasPrefix(findingID, "finding_") {
			var found string
			if err := tx.QueryRow(`SELECT id FROM findings WHERE id = ? AND workstream_id = ?`, findingID, workstreamID).Scan(&found); err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					return fmt.Errorf("ResearchIR Finding node %q does not exist in this workstream", findingID)
				}
				return err
			}
		}
	}
	for _, rawEdge := range edges {
		edge := mapValue(rawEdge)
		from, to := stringValue(edge["from"]), stringValue(edge["to"])
		class := stringValue(edge["relationClass"])
		if class == "" {
			class = stringValue(edge["relation_class"])
		}
		typ := stringValue(edge["type"])
		if !ids[from] || !ids[to] || from == to || !validFindingRelation(class, typ) {
			return errors.New("ResearchIR edges require existing distinct nodes and an explicit semantic/provenance relation class")
		}
	}
	return nil
}

func (s *Store) validateEvidenceTx(tx *sql.Tx, inputs []EvidenceSpanInput) ([]EvidenceSpanInput, error) {
	validated := make([]EvidenceSpanInput, 0, len(inputs))
	for _, input := range inputs {
		input.ArtifactID, input.Relation, input.ASTPath = strings.TrimSpace(input.ArtifactID), strings.TrimSpace(input.Relation), strings.TrimSpace(input.ASTPath)
		if !strings.HasPrefix(input.ArtifactID, "art_") || !evidenceRelations[input.Relation] ||
			input.ByteStart < 0 || input.ByteEnd <= input.ByteStart || len(input.ASTPath) > 2000 {
			return nil, errors.New("finding evidence relation or span is invalid")
		}
		artifact, data, err := s.readArtifactTx(tx, input.ArtifactID)
		if err != nil {
			return nil, err
		}
		if input.ByteEnd > int64(len(data)) || artifact.ByteCount != int64(len(data)) {
			return nil, fmt.Errorf("finding evidence span exceeds artifact %q", input.ArtifactID)
		}
		digest := sha256.Sum256(data[input.ByteStart:input.ByteEnd])
		actual := hex.EncodeToString(digest[:])
		if input.BlockSHA256 != "" {
			expected, err := normalizedSHA256(input.BlockSHA256, false)
			if err != nil || expected != actual {
				return nil, fmt.Errorf("finding evidence span hash does not match artifact %q", input.ArtifactID)
			}
		}
		input.BlockSHA256 = "sha256:" + actual
		validated = append(validated, input)
	}
	return validated, nil
}

func (s *Store) readArtifactTx(tx *sql.Tx, id string) (Artifact, []byte, error) {
	artifact, err := scanArtifact(tx.QueryRow(artifactSelect+` WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Artifact{}, nil, fmt.Errorf("artifact %q not found", id)
	}
	if err != nil {
		return Artifact{}, nil, err
	}
	data, err := verifyArtifactBytes(s.root, artifact)
	return artifact, data, err
}

func verifyAcceptedCellTx(tx *sql.Tx, workstreamID string, payload map[string]any, ref string) error {
	parts := strings.Split(strings.TrimSpace(ref), "/")
	if len(parts) != 5 || parts[0] != "noema:" || parts[1] != "" || parts[2] != "cell" ||
		!strings.HasPrefix(parts[3], "nb_") || parts[4] == "" {
		return errors.New("cell proposal acceptance requires a materialized noema://cell reference")
	}
	document := proposalDocument(payload, "cell")
	wantedNotebook := stringValue(document["notebookId"])
	if wantedNotebook == "" {
		wantedNotebook = stringValue(document["notebook_id"])
	}
	wantedCell := stringValue(document["cellId"])
	if wantedCell == "" {
		wantedCell = stringValue(document["cell_id"])
	}
	if wantedNotebook != parts[3] || wantedCell != parts[4] {
		return errors.New("materialized cell identity does not match the reviewed Proposal payload")
	}
	var found, actualKind, actualTitle, actualSourceSHA string
	if err := tx.QueryRow(`SELECT cells.cell_id, cells.kind, cells.title, cells.source_sha256
		FROM cells JOIN notebooks ON notebooks.id = cells.notebook_id
		WHERE notebooks.id = ? AND cells.cell_id = ? AND notebooks.workstream_id = ?`,
		parts[3], parts[4], workstreamID).Scan(&found, &actualKind, &actualTitle, &actualSourceSHA); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("accepted cell is not present in the authoritative notebook index")
		}
		return err
	}
	expectedKind := strings.TrimSpace(stringValue(document["kind"]))
	if expectedKind == "" {
		expectedKind = "work"
	}
	expectedTitle := strings.TrimSpace(stringValue(document["title"]))
	sourceJSON, err := json.Marshal(document["source"])
	if err != nil {
		return errors.New("reviewed cell source is invalid")
	}
	expectedSource, err := notebookSource(sourceJSON)
	if err != nil {
		return errors.New("reviewed cell source is invalid")
	}
	expectedSource = strings.ReplaceAll(strings.ReplaceAll(expectedSource, "\r\n", "\n"), "\r", "\n")
	if actualKind != expectedKind || actualTitle != expectedTitle || actualSourceSHA != sha256Hex([]byte(expectedSource)) {
		return errors.New("materialized cell content does not match the reviewed Proposal payload")
	}
	var targetWorkNode string
	if err := tx.QueryRow(`SELECT work_node_id FROM cell_work_nodes WHERE notebook_id = ? AND cell_id = ?`,
		parts[3], parts[4]).Scan(&targetWorkNode); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("accepted work cell has no WorkNode binding")
		}
		return err
	}
	resolveWorkNode := func(value string) (string, error) {
		value = strings.TrimSpace(value)
		if value == "" {
			return "", nil
		}
		if strings.HasPrefix(value, "wn_") {
			return value, nil
		}
		var resolved string
		if err := tx.QueryRow(`SELECT work_node_id FROM cell_work_nodes WHERE notebook_id = ? AND cell_id = ?`,
			parts[3], value).Scan(&resolved); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return "", errors.New("reviewed Proposal relation references an unbound cell")
			}
			return "", err
		}
		return resolved, nil
	}
	expectedRelations := map[string]map[string]bool{"lineage": {}, "depends": {}}
	if parent := strings.TrimSpace(stringValue(document["lineageParent"])); parent != "" {
		resolved, err := resolveWorkNode(parent)
		if err != nil {
			return err
		}
		expectedRelations["lineage"][resolved] = true
	} else if parent := strings.TrimSpace(stringValue(document["lineage_parent"])); parent != "" {
		resolved, err := resolveWorkNode(parent)
		if err != nil {
			return err
		}
		expectedRelations["lineage"][resolved] = true
	}
	for _, dependency := range uniqueStrings(jsonStringArray(document["depends"])) {
		resolved, err := resolveWorkNode(dependency)
		if err != nil {
			return err
		}
		expectedRelations["depends"][resolved] = true
	}
	actualRelations := map[string]map[string]bool{"lineage": {}, "depends": {}}
	rows, err := tx.Query(`SELECT src_work_node_id, type FROM work_dependencies WHERE notebook_id = ? AND dst_work_node_id = ?`, parts[3], targetWorkNode)
	if err != nil {
		return err
	}
	for rows.Next() {
		var source, relationType string
		if err := rows.Scan(&source, &relationType); err != nil {
			_ = rows.Close()
			return err
		}
		if actualRelations[relationType] != nil {
			actualRelations[relationType][source] = true
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, relationType := range []string{"lineage", "depends"} {
		if len(actualRelations[relationType]) != len(expectedRelations[relationType]) {
			return errors.New("materialized cell relations do not match the reviewed Proposal payload")
		}
		for source := range expectedRelations[relationType] {
			if !actualRelations[relationType][source] {
				return errors.New("materialized cell relations do not match the reviewed Proposal payload")
			}
		}
	}
	return nil
}

func jsonStringArray(value any) []string {
	switch values := value.(type) {
	case []string:
		return append([]string(nil), values...)
	case []any:
		result := make([]string, 0, len(values))
		for _, value := range values {
			if text, ok := value.(string); ok {
				result = append(result, text)
			}
		}
		return result
	default:
		return nil
	}
}

func (s *Store) attachFindingDetails(finding Finding) (Finding, error) {
	var err error
	finding.Evidence, err = findingEvidenceDB(s.db, finding.ID)
	if err != nil {
		return Finding{}, err
	}
	finding.Relations, err = findingRelationsDB(s.db, finding.ID)
	return finding, err
}

const findingSelect = `SELECT id, workstream_id, kind, statement, status, verification_level,
	verification_json, scope_json, origin_json, disclosure, semantic_sha256, created_at, version FROM findings`

// scanFinding is intentionally explicit. database/sql calls Scan only once,
// so JSON and time conversion happens after raw values have been collected.
func scanFinding(scanner interface{ Scan(...any) error }) (Finding, error) {
	var finding Finding
	var verificationJSON, scopeJSON, originJSON, digest string
	var createdAt int64
	err := scanner.Scan(&finding.ID, &finding.WorkstreamID, &finding.Kind, &finding.Statement, &finding.Status,
		&finding.VerificationLevel, &verificationJSON, &scopeJSON, &originJSON, &finding.Disclosure, &digest, &createdAt, &finding.Version)
	if err != nil {
		return Finding{}, err
	}
	if err := json.Unmarshal([]byte(verificationJSON), &finding.Verification); err != nil {
		return Finding{}, err
	}
	if err := json.Unmarshal([]byte(scopeJSON), &finding.Scope); err != nil {
		return Finding{}, err
	}
	if err := json.Unmarshal([]byte(originJSON), &finding.Origin); err != nil {
		return Finding{}, err
	}
	finding.SemanticSHA256, finding.CreatedAt = "sha256:"+digest, formatMillis(createdAt)
	finding.Evidence, finding.Relations = []FindingEvidence{}, []FindingRelation{}
	return finding, nil
}

type scanner interface{ Scan(...any) error }

func getProposalTx(tx *sql.Tx, column, value string) (Proposal, error) {
	if column != "id" && column != "client_request_id" {
		return Proposal{}, errors.New("invalid proposal lookup")
	}
	return scanProposal(tx.QueryRow(proposalSelect+` WHERE `+column+` = ?`, value))
}

func scanProposal(row scanner) (Proposal, error) {
	var proposal Proposal
	var payloadJSON, reviewedJSON, digest string
	var createdAt, reviewedAt int64
	if err := row.Scan(&proposal.ID, &proposal.ClientRequestID, &proposal.WorkstreamID, &proposal.Kind,
		&payloadJSON, &digest, &proposal.Status, &proposal.ProposedBy, &proposal.SourceAdapter, &createdAt,
		&proposal.ReviewedBy, &reviewedAt, &proposal.RejectionReason, &proposal.AcceptedRef, &reviewedJSON, &proposal.Version); err != nil {
		return Proposal{}, err
	}
	if err := json.Unmarshal([]byte(payloadJSON), &proposal.Payload); err != nil {
		return Proposal{}, err
	}
	if reviewedJSON != "" {
		if err := json.Unmarshal([]byte(reviewedJSON), &proposal.ReviewedPayload); err != nil {
			return Proposal{}, err
		}
	}
	proposal.PayloadSHA256, proposal.CreatedAt = "sha256:"+digest, formatMillis(createdAt)
	if reviewedAt > 0 {
		proposal.ReviewedAt = formatMillis(reviewedAt)
	}
	return proposal, nil
}

func findingEvidenceDB(db *sql.DB, findingID string) ([]FindingEvidence, error) {
	rows, err := db.Query(`SELECT id, finding_id, artifact_id, relation, byte_start, byte_end, block_sha256,
		ast_path, created_at FROM finding_evidence WHERE finding_id = ? ORDER BY artifact_id, byte_start, id`, findingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanFindingEvidenceRows(rows)
}

func findingEvidenceTx(tx *sql.Tx, findingID string) ([]FindingEvidence, error) {
	rows, err := tx.Query(`SELECT id, finding_id, artifact_id, relation, byte_start, byte_end, block_sha256,
		ast_path, created_at FROM finding_evidence WHERE finding_id = ? ORDER BY artifact_id, byte_start, id`, findingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanFindingEvidenceRows(rows)
}

func scanFindingEvidenceRows(rows *sql.Rows) ([]FindingEvidence, error) {
	result := []FindingEvidence{}
	for rows.Next() {
		var evidence FindingEvidence
		var createdAt int64
		if err := rows.Scan(&evidence.ID, &evidence.FindingID, &evidence.ArtifactID, &evidence.Relation,
			&evidence.ByteStart, &evidence.ByteEnd, &evidence.BlockSHA256, &evidence.ASTPath, &createdAt); err != nil {
			return nil, err
		}
		evidence.CreatedAt = formatMillis(createdAt)
		result = append(result, evidence)
	}
	return result, rows.Err()
}

func findingRelationsDB(db *sql.DB, findingID string) ([]FindingRelation, error) {
	rows, err := db.Query(`SELECT source_finding_id, target_finding_id, type, relation_class, created_at
		FROM finding_relations WHERE source_finding_id = ? ORDER BY relation_class, type, target_finding_id`, findingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanFindingRelationRows(rows)
}

func findingRelationsTx(tx *sql.Tx, findingID string) ([]FindingRelation, error) {
	rows, err := tx.Query(`SELECT source_finding_id, target_finding_id, type, relation_class, created_at
		FROM finding_relations WHERE source_finding_id = ? ORDER BY relation_class, type, target_finding_id`, findingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanFindingRelationRows(rows)
}

func scanFindingRelationRows(rows *sql.Rows) ([]FindingRelation, error) {
	result := []FindingRelation{}
	for rows.Next() {
		var relation FindingRelation
		var createdAt int64
		if err := rows.Scan(&relation.SourceID, &relation.TargetID, &relation.Type, &relation.RelationClass, &createdAt); err != nil {
			return nil, err
		}
		relation.CreatedAt = formatMillis(createdAt)
		result = append(result, relation)
	}
	return result, rows.Err()
}

const researchIRSelect = `SELECT workstream_id, version, document_json, sha256, created_by, created_at, review_status FROM research_ir_versions`

func scanResearchIR(row scanner) (ResearchIRVersion, error) {
	var version ResearchIRVersion
	var documentJSON, digest string
	var createdAt int64
	if err := row.Scan(&version.WorkstreamID, &version.Version, &documentJSON, &digest, &version.CreatedBy, &createdAt, &version.ReviewStatus); err != nil {
		return ResearchIRVersion{}, err
	}
	if err := json.Unmarshal([]byte(documentJSON), &version.Document); err != nil {
		return ResearchIRVersion{}, err
	}
	version.SHA256, version.CreatedAt = "sha256:"+digest, formatMillis(createdAt)
	return version, nil
}

func researchIRByDigestTx(tx *sql.Tx, workstreamID, digest string) (ResearchIRVersion, error) {
	return scanResearchIR(tx.QueryRow(researchIRSelect+` WHERE workstream_id = ? AND sha256 = ?`, workstreamID, digest))
}

const problemModelSelect = `SELECT id, workstream_id, version, document_json, sha256, research_ir_version,
	artifact_set_hash, policy_hash, created_by, created_at, review_status FROM problem_model_versions`

func scanProblemModel(row scanner) (ProblemModelVersion, error) {
	var version ProblemModelVersion
	var documentJSON, digest, artifactSetHash, policyHash string
	var createdAt int64
	if err := row.Scan(&version.ID, &version.WorkstreamID, &version.Version, &documentJSON, &digest,
		&version.ResearchIRVersion, &artifactSetHash, &policyHash, &version.CreatedBy, &createdAt, &version.ReviewStatus); err != nil {
		return ProblemModelVersion{}, err
	}
	if err := json.Unmarshal([]byte(documentJSON), &version.Document); err != nil {
		return ProblemModelVersion{}, err
	}
	version.SHA256, version.ArtifactSetHash, version.PolicyHash = "sha256:"+digest, "sha256:"+artifactSetHash, "sha256:"+policyHash
	version.CreatedAt = formatMillis(createdAt)
	return version, nil
}

func problemModelByDigestTx(tx *sql.Tx, workstreamID, digest string) (ProblemModelVersion, error) {
	return scanProblemModel(tx.QueryRow(problemModelSelect+` WHERE workstream_id = ? AND sha256 = ?`, workstreamID, digest))
}

func proposalDocument(payload map[string]any, key string) map[string]any {
	if nested := mapValue(payload[key]); len(nested) > 0 {
		return cloneMap(nested)
	}
	return cloneMap(payload)
}

func cloneMap(value map[string]any) map[string]any {
	encoded, _ := json.Marshal(value)
	copy := map[string]any{}
	_ = json.Unmarshal(encoded, &copy)
	return copy
}

func canonicalJSON(value any) ([]byte, string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, "", err
	}
	digest := sha256.Sum256(encoded)
	return encoded, hex.EncodeToString(digest[:]), nil
}

func normalizedSHA256(value string, allowEmpty bool) (string, error) {
	value = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(value), "sha256:"))
	if value == "" && allowEmpty {
		return "", nil
	}
	if len(value) != 64 {
		return "", errors.New("invalid sha256")
	}
	if _, err := hex.DecodeString(value); err != nil {
		return "", errors.New("invalid sha256")
	}
	return strings.ToLower(value), nil
}

func validFindingRelation(class, typ string) bool {
	if class == "semantic" {
		return semanticRelations[typ]
	}
	if class == "provenance" {
		return provenanceRelations[typ]
	}
	return false
}

func mapValue(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func int64Value(value any) int64 {
	switch current := value.(type) {
	case float64:
		return int64(current)
	case int64:
		return current
	case int:
		return int64(current)
	default:
		return 0
	}
}

func artifactPath(root string, artifact Artifact) string {
	return filepath.Join(root, StateDirName, "objects", "sha256", artifact.SHA256[:2], artifact.SHA256[2:])
}

func verifyArtifactBytes(root string, artifact Artifact) ([]byte, error) {
	data, err := os.ReadFile(artifactPath(root, artifact))
	if err != nil {
		return nil, fmt.Errorf("read artifact %q: %w", artifact.ID, err)
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != artifact.SHA256 || int64(len(data)) != artifact.ByteCount {
		return nil, fmt.Errorf("artifact %q digest verification failed", artifact.ID)
	}
	return data, nil
}
