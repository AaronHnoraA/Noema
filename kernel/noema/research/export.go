// Noema Workstream export is Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package research

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const maxWorkstreamExportBytes = 128 * 1024 * 1024

type CreateWorkstreamExportInput struct {
	WorkstreamID     string `json:"workstreamId"`
	ExportedBy       string `json:"exportedBy"`
	IncludeLocalOnly bool   `json:"includeLocalOnly"`
}

type WorkstreamExportResult struct {
	Artifact              Artifact `json:"artifact"`
	WorkstreamID          string   `json:"workstreamId"`
	AsOfSeq               int64    `json:"asOfSeq"`
	IncludeLocalOnly      bool     `json:"includeLocalOnly"`
	ExcludedCellIDs       []string `json:"excludedCellIds"`
	ExcludedFindingIDs    []string `json:"excludedFindingIds"`
	ExcludedProposalIDs   []string `json:"excludedProposalIds"`
	ExcludedTaskIDs       []string `json:"excludedTaskIds"`
	ExcludedJobIDs        []string `json:"excludedJobIds"`
	ExcludedDelegationIDs []string `json:"excludedDelegationIds"`
	ExcludedVersions      []string `json:"excludedVersions"`
}

type exportNotebook struct {
	ID             string   `json:"id"`
	Path           string   `json:"path"`
	Title          string   `json:"title"`
	SourceRevision string   `json:"sourceRevision"`
	ExportRevision string   `json:"exportRevision"`
	DataBase64     string   `json:"dataBase64"`
	ExcludedCells  []string `json:"excludedCells,omitempty"`
}

type exportArtifact struct {
	Artifact
	DataBase64 string `json:"dataBase64"`
}

type exportJobLease struct {
	JobID        string `json:"jobId"`
	InvocationID string `json:"invocationId"`
	WorkerID     string `json:"workerId"`
	Epoch        int64  `json:"epoch"`
	AcquiredAt   string `json:"acquiredAt"`
	ExpiresAt    string `json:"expiresAt"`
}

type workstreamExportPackage struct {
	Schema        string                `json:"schema"`
	Workstream    map[string]any        `json:"workstream"`
	AsOfSeq       int64                 `json:"asOfSeq"`
	Disclosure    map[string]any        `json:"disclosure"`
	Notebooks     []exportNotebook      `json:"notebooks"`
	Sessions      []Session             `json:"sessions"`
	Runs          []Run                 `json:"runs"`
	Captures      []Capture             `json:"captures"`
	Proposals     []Proposal            `json:"proposals"`
	Findings      []Finding             `json:"findings"`
	ResearchIR    []ResearchIRVersion   `json:"researchIr"`
	ProblemModels []ProblemModelVersion `json:"problemModels"`
	Tasks         []Task                `json:"tasks"`
	Jobs          []Job                 `json:"jobs"`
	Invocations   []Invocation          `json:"invocations"`
	Workers       []Worker              `json:"workers"`
	Delegations   []Delegation          `json:"delegations"`
	WorkerLeases  []exportJobLease      `json:"workerLeases"`
	Events        []Event               `json:"events"`
	Artifacts     []exportArtifact      `json:"artifacts"`
}

// CreateWorkstreamExport snapshots one internally consistent Workstream into
// a content-addressed JSON package. Default exports remove local_only cells,
// Findings, Proposals and any IR/ProblemModel version that could retain a
// reference to excluded content. Including local_only data requires an
// explicit request and is recorded in the package and audit event.
func (s *Store) CreateWorkstreamExport(input CreateWorkstreamExportInput) (WorkstreamExportResult, error) {
	input.WorkstreamID, input.ExportedBy = strings.TrimSpace(input.WorkstreamID), strings.TrimSpace(input.ExportedBy)
	if !strings.HasPrefix(input.WorkstreamID, "ws_") || input.ExportedBy == "" || len(input.ExportedBy) > 200 {
		return WorkstreamExportResult{}, errors.New("Workstream export requires a valid workstream and bounded actor")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return WorkstreamExportResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	pkg, result, err := s.buildWorkstreamExportTx(tx, input)
	if err != nil {
		return WorkstreamExportResult{}, err
	}
	encoded, err := json.Marshal(pkg)
	if err != nil {
		return WorkstreamExportResult{}, err
	}
	if len(encoded) > maxWorkstreamExportBytes {
		return WorkstreamExportResult{}, fmt.Errorf("Workstream export exceeds %d bytes", maxWorkstreamExportBytes)
	}
	if err := tx.Commit(); err != nil {
		return WorkstreamExportResult{}, err
	}
	artifact, err := s.putArtifactBytes("workstream-export", "application/vnd.noema.workstream+json", encoded)
	if err != nil {
		return WorkstreamExportResult{}, err
	}
	audit, err := s.db.Begin()
	if err != nil {
		return WorkstreamExportResult{}, err
	}
	defer func() { _ = audit.Rollback() }()
	artifact, err = ensureArtifactTx(audit, artifact)
	if err != nil {
		return WorkstreamExportResult{}, err
	}
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	if _, err := appendEvent(audit, Event{Type: "workstream.export.created", WorkstreamID: input.WorkstreamID}, nowMs,
		map[string]any{"artifact_id": artifact.ID, "sha256": artifact.SHA256, "byte_count": artifact.ByteCount,
			"include_local_only": input.IncludeLocalOnly, "exported_by": input.ExportedBy, "as_of_seq": result.AsOfSeq}); err != nil {
		return WorkstreamExportResult{}, err
	}
	if err := audit.Commit(); err != nil {
		return WorkstreamExportResult{}, err
	}
	result.Artifact = artifact
	return result, nil
}

func (s *Store) buildWorkstreamExportTx(tx *sql.Tx, input CreateWorkstreamExportInput) (workstreamExportPackage, WorkstreamExportResult, error) {
	var id, title, notebookID, status string
	var createdAt, updatedAt, version int64
	if err := tx.QueryRow(`SELECT id, title, COALESCE(notebook_id, ''), status, created_at, updated_at, version
		FROM workstreams WHERE id = ?`, input.WorkstreamID).Scan(&id, &title, &notebookID, &status, &createdAt, &updatedAt, &version); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workstreamExportPackage{}, WorkstreamExportResult{}, fmt.Errorf("workstream %q not found", input.WorkstreamID)
		}
		return workstreamExportPackage{}, WorkstreamExportResult{}, err
	}
	workstream := map[string]any{"id": id, "title": title, "notebookId": notebookID, "status": status,
		"createdAt": formatMillis(createdAt), "updatedAt": formatMillis(updatedAt), "version": version}

	notebooks, excludedCells, err := s.exportNotebooksTx(tx, id, input.IncludeLocalOnly)
	if err != nil {
		return workstreamExportPackage{}, WorkstreamExportResult{}, err
	}
	sessions, err := exportSessionsTx(tx, id)
	if err != nil {
		return workstreamExportPackage{}, WorkstreamExportResult{}, err
	}
	runs, err := exportRunsTx(tx, id)
	if err != nil {
		return workstreamExportPackage{}, WorkstreamExportResult{}, err
	}
	captures, err := exportCapturesTx(tx, id)
	if err != nil {
		return workstreamExportPackage{}, WorkstreamExportResult{}, err
	}
	proposals, excludedProposals, err := exportProposalsTx(tx, id, input.IncludeLocalOnly)
	if err != nil {
		return workstreamExportPackage{}, WorkstreamExportResult{}, err
	}
	findings, excludedFindings, err := exportFindingsTx(tx, id, input.IncludeLocalOnly)
	if err != nil {
		return workstreamExportPackage{}, WorkstreamExportResult{}, err
	}
	excludedSet := make(map[string]bool, len(excludedFindings))
	for _, findingID := range excludedFindings {
		excludedSet[findingID] = true
	}
	researchIR, excludedIR, err := exportResearchIRTx(tx, id, input.IncludeLocalOnly, excludedSet)
	if err != nil {
		return workstreamExportPackage{}, WorkstreamExportResult{}, err
	}
	problemModels, excludedModels, err := exportProblemModelsTx(tx, id, input.IncludeLocalOnly, excludedSet)
	if err != nil {
		return workstreamExportPackage{}, WorkstreamExportResult{}, err
	}
	tasks, excludedTasks, err := exportTasksTx(tx, id, input.IncludeLocalOnly)
	if err != nil {
		return workstreamExportPackage{}, WorkstreamExportResult{}, err
	}
	excludedTaskSet := stringSet(excludedTasks)
	jobs, excludedJobs, err := exportJobsTx(tx, id, excludedTaskSet)
	if err != nil {
		return workstreamExportPackage{}, WorkstreamExportResult{}, err
	}
	excludedJobSet := stringSet(excludedJobs)
	invocations, workers, jobLeases, err := exportInvocationsTx(tx, id, excludedJobSet)
	if err != nil {
		return workstreamExportPackage{}, WorkstreamExportResult{}, err
	}
	delegations, excludedDelegations, err := exportDelegationsTx(tx, id, excludedTaskSet, excludedJobSet)
	if err != nil {
		return workstreamExportPackage{}, WorkstreamExportResult{}, err
	}
	events, asOfSeq, err := exportEventsTx(tx, id)
	if err != nil {
		return workstreamExportPackage{}, WorkstreamExportResult{}, err
	}

	artifactIDs := map[string]bool{}
	collectArtifactRefs(runs, artifactIDs)
	collectArtifactRefs(captures, artifactIDs)
	collectArtifactRefs(findings, artifactIDs)
	collectArtifactRefs(events, artifactIDs)
	collectArtifactRefs(invocations, artifactIDs)
	collectArtifactRefs(delegations, artifactIDs)
	artifacts, err := s.exportArtifactsTx(tx, artifactIDs)
	if err != nil {
		return workstreamExportPackage{}, WorkstreamExportResult{}, err
	}
	excludedVersions := append(excludedIR, excludedModels...)
	sort.Strings(excludedVersions)
	result := WorkstreamExportResult{WorkstreamID: id, AsOfSeq: asOfSeq, IncludeLocalOnly: input.IncludeLocalOnly,
		ExcludedCellIDs: excludedCells, ExcludedFindingIDs: excludedFindings,
		ExcludedProposalIDs: excludedProposals, ExcludedTaskIDs: excludedTasks, ExcludedJobIDs: excludedJobs,
		ExcludedDelegationIDs: excludedDelegations, ExcludedVersions: excludedVersions}
	disclosure := map[string]any{
		"includeLocalOnly": input.IncludeLocalOnly, "excludedCellIds": excludedCells,
		"excludedFindingIds": excludedFindings, "excludedProposalIds": excludedProposals,
		"excludedTaskIds": excludedTasks, "excludedJobIds": excludedJobs,
		"excludedDelegationIds": excludedDelegations, "excludedVersions": excludedVersions,
	}
	pkg := workstreamExportPackage{Schema: "noema.workstream-export/1", Workstream: workstream, AsOfSeq: asOfSeq,
		Disclosure: disclosure, Notebooks: notebooks, Sessions: sessions, Runs: runs, Captures: captures,
		Proposals: proposals, Findings: findings, ResearchIR: researchIR, ProblemModels: problemModels,
		Tasks: tasks, Jobs: jobs, Invocations: invocations, Workers: workers, Delegations: delegations,
		WorkerLeases: jobLeases, Events: events, Artifacts: artifacts}
	return pkg, result, nil
}

func (s *Store) exportNotebooksTx(tx *sql.Tx, workstreamID string, includeLocal bool) ([]exportNotebook, []string, error) {
	rows, err := tx.Query(`SELECT id, path, title, revision_sha256 FROM notebooks WHERE workstream_id = ? ORDER BY path, id`, workstreamID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	result, excludedAll := []exportNotebook{}, []string{}
	for rows.Next() {
		var notebook exportNotebook
		if err := rows.Scan(&notebook.ID, &notebook.Path, &notebook.Title, &notebook.SourceRevision); err != nil {
			return nil, nil, err
		}
		path, err := safeExportPath(s.root, notebook.Path)
		if err != nil {
			return nil, nil, err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, nil, err
		}
		if Revision(data) != notebook.SourceRevision {
			return nil, nil, fmt.Errorf("research notebook %q changed after its last index; reindex before export", notebook.Path)
		}
		exported, excluded, err := disclosureNotebook(data, includeLocal)
		if err != nil {
			return nil, nil, fmt.Errorf("project research notebook %q: %w", notebook.Path, err)
		}
		notebook.ExportRevision = Revision(exported)
		notebook.DataBase64 = base64.StdEncoding.EncodeToString(exported)
		notebook.ExcludedCells = excluded
		excludedAll = append(excludedAll, excluded...)
		result = append(result, notebook)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	sort.Strings(excludedAll)
	return result, excludedAll, nil
}

func safeExportPath(root, rel string) (string, error) {
	candidate := filepath.Join(root, filepath.FromSlash(rel))
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", err
	}
	inside, err := filepath.Rel(resolvedRoot, resolved)
	if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) || filepath.IsAbs(inside) {
		return "", errors.New("indexed notebook path escapes the repository")
	}
	return resolved, nil
}

func disclosureNotebook(data []byte, includeLocal bool) ([]byte, []string, error) {
	if includeLocal {
		return data, []string{}, nil
	}
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, nil, err
	}
	cells, _ := document["cells"].([]any)
	excluded := map[string]bool{}
	kept := make([]any, 0, len(cells))
	for _, raw := range cells {
		cell, _ := raw.(map[string]any)
		meta, _ := cell["metadata"].(map[string]any)
		researchMeta, _ := meta[Namespace].(map[string]any)
		id, _ := cell["id"].(string)
		if stringValue(researchMeta["disclosure"]) == "local_only" {
			excluded[id] = true
			continue
		}
		kept = append(kept, cell)
	}
	for _, raw := range kept {
		cell := raw.(map[string]any)
		meta, _ := cell["metadata"].(map[string]any)
		researchMeta, _ := meta[Namespace].(map[string]any)
		for _, key := range []string{"lineage", "depends"} {
			refs, _ := researchMeta[key].([]any)
			filtered := make([]any, 0, len(refs))
			for _, ref := range refs {
				if id, ok := ref.(string); ok && !excluded[id] {
					filtered = append(filtered, id)
				}
			}
			if len(refs) > 0 {
				researchMeta[key] = filtered
			}
		}
	}
	document["cells"] = kept
	encoded, err := json.Marshal(document)
	ids := make([]string, 0, len(excluded))
	for id := range excluded {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return encoded, ids, err
}

func exportSessionsTx(tx *sql.Tx, workstreamID string) ([]Session, error) {
	rows, err := tx.Query(sessionSelect+` WHERE workstream_id = ? ORDER BY attached_at, id`, workstreamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Session{}
	for rows.Next() {
		value, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, value)
	}
	return result, rows.Err()
}

func exportRunsTx(tx *sql.Tx, workstreamID string) ([]Run, error) {
	rows, err := tx.Query(runSelect+` WHERE workstream_id = ? ORDER BY created_at, id`, workstreamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Run{}
	for rows.Next() {
		value, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, value)
	}
	return result, rows.Err()
}

func exportCapturesTx(tx *sql.Tx, workstreamID string) ([]Capture, error) {
	rows, err := tx.Query(`SELECT id, client_request_id, artifact_id, COALESCE(html_artifact_id, ''),
		COALESCE(workstream_id, ''), url, title, adapter, completeness, captured_at, created_at, metadata_json
		FROM captures WHERE workstream_id = ? ORDER BY created_at, id`, workstreamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Capture{}
	for rows.Next() {
		value, err := scanCapture(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, value)
	}
	return result, rows.Err()
}

func exportTasksTx(tx *sql.Tx, workstreamID string, includeLocal bool) ([]Task, []string, error) {
	rows, err := tx.Query(taskSelect+` WHERE workstream_id = ? ORDER BY created_at, id`, workstreamID)
	if err != nil {
		return nil, nil, err
	}
	all := []Task{}
	for rows.Next() {
		task, err := scanTask(rows)
		if err != nil {
			_ = rows.Close()
			return nil, nil, err
		}
		all = append(all, task)
	}
	if err := rows.Close(); err != nil {
		return nil, nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	for index := range all {
		all[index], err = attachTaskEdgesTx(tx, all[index])
		if err != nil {
			return nil, nil, err
		}
	}
	excluded := map[string]bool{}
	if !includeLocal {
		for _, task := range all {
			if task.Disclosure == "local_only" {
				excluded[task.ID] = true
			}
		}
		// A disclosed child would otherwise reveal structure derived from a
		// withheld parent or dependency. Exclusion therefore follows the Task
		// dependency closure, just as IR versions follow excluded Findings.
		changed := true
		for changed {
			changed = false
			for _, task := range all {
				if excluded[task.ID] {
					continue
				}
				if excluded[task.ParentTaskID] {
					excluded[task.ID], changed = true, true
					continue
				}
				for _, dependency := range task.DependsOn {
					if excluded[dependency] {
						excluded[task.ID], changed = true, true
						break
					}
				}
			}
		}
	}
	result, excludedIDs := []Task{}, []string{}
	for _, task := range all {
		if excluded[task.ID] {
			excludedIDs = append(excludedIDs, task.ID)
		} else {
			result = append(result, task)
		}
	}
	sort.Strings(excludedIDs)
	return result, excludedIDs, nil
}

func exportJobsTx(tx *sql.Tx, workstreamID string, excludedTasks map[string]bool) ([]Job, []string, error) {
	rows, err := tx.Query(jobSelect+` WHERE workstream_id = ? ORDER BY created_at, id`, workstreamID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	result, excluded := []Job{}, []string{}
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return nil, nil, err
		}
		if excludedTasks[job.TaskID] {
			excluded = append(excluded, job.ID)
		} else {
			result = append(result, job)
		}
	}
	sort.Strings(excluded)
	return result, excluded, rows.Err()
}

func exportInvocationsTx(tx *sql.Tx, workstreamID string, excludedJobs map[string]bool) ([]Invocation, []Worker, []exportJobLease, error) {
	rows, err := tx.Query(invocationSelect+` WHERE job_id IN (
		SELECT id FROM jobs WHERE workstream_id = ?) ORDER BY created_at, id`, workstreamID)
	if err != nil {
		return nil, nil, nil, err
	}
	invocations := []Invocation{}
	workerIDs := map[string]bool{}
	for rows.Next() {
		invocation, err := scanInvocation(rows)
		if err != nil {
			_ = rows.Close()
			return nil, nil, nil, err
		}
		if !excludedJobs[invocation.JobID] {
			invocations = append(invocations, invocation)
			workerIDs[invocation.WorkerID] = true
		}
	}
	if err := rows.Close(); err != nil {
		return nil, nil, nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, nil, nil, err
	}
	for index := range invocations {
		result, err := scanInvocationResult(tx.QueryRow(invocationResultSelect+` WHERE invocation_id = ?`, invocations[index].ID))
		if err == nil {
			invocations[index].Result = &result
		} else if !errors.Is(err, sql.ErrNoRows) {
			return nil, nil, nil, err
		}
	}
	workers := []Worker{}
	ids := make([]string, 0, len(workerIDs))
	for id := range workerIDs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		worker, err := scanWorker(tx.QueryRow(workerSelect+` WHERE id = ?`, id))
		if err != nil {
			return nil, nil, nil, err
		}
		workers = append(workers, worker)
	}
	leaseRows, err := tx.Query(`SELECT worker_leases.job_id, worker_leases.invocation_id,
		worker_leases.worker_id, worker_leases.epoch, worker_leases.acquired_at, worker_leases.expires_at
		FROM worker_leases JOIN jobs ON jobs.id = worker_leases.job_id
		WHERE jobs.workstream_id = ? ORDER BY worker_leases.job_id`, workstreamID)
	if err != nil {
		return nil, nil, nil, err
	}
	leasings := []exportJobLease{}
	for leaseRows.Next() {
		var lease exportJobLease
		var acquiredAt, expiresAt int64
		if err := leaseRows.Scan(&lease.JobID, &lease.InvocationID, &lease.WorkerID, &lease.Epoch,
			&acquiredAt, &expiresAt); err != nil {
			_ = leaseRows.Close()
			return nil, nil, nil, err
		}
		if !excludedJobs[lease.JobID] {
			lease.AcquiredAt, lease.ExpiresAt = formatMillis(acquiredAt), formatMillis(expiresAt)
			leasings = append(leasings, lease)
		}
	}
	if err := leaseRows.Close(); err != nil {
		return nil, nil, nil, err
	}
	return invocations, workers, leasings, leaseRows.Err()
}

func exportDelegationsTx(tx *sql.Tx, workstreamID string, excludedTasks, excludedJobs map[string]bool) ([]Delegation, []string, error) {
	rows, err := tx.Query(delegationSelect+` WHERE workstream_id = ? ORDER BY created_at, id`, workstreamID)
	if err != nil {
		return nil, nil, err
	}
	all := []Delegation{}
	for rows.Next() {
		delegation, err := scanDelegation(rows)
		if err != nil {
			_ = rows.Close()
			return nil, nil, err
		}
		all = append(all, delegation)
	}
	if err := rows.Close(); err != nil {
		return nil, nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	result, excluded := []Delegation{}, []string{}
	for _, delegation := range all {
		jobRows, err := tx.Query(`SELECT job_id FROM delegation_jobs WHERE delegation_id = ? ORDER BY job_id`, delegation.ID)
		if err != nil {
			return nil, nil, err
		}
		hidden := excludedTasks[delegation.ParentTaskID] || excludedTasks[delegation.ChildTaskID]
		for jobRows.Next() {
			var jobID string
			if err := jobRows.Scan(&jobID); err != nil {
				_ = jobRows.Close()
				return nil, nil, err
			}
			delegation.ChildJobIDs = append(delegation.ChildJobIDs, jobID)
			if excludedJobs[jobID] {
				hidden = true
			}
		}
		if err := jobRows.Close(); err != nil {
			return nil, nil, err
		}
		if hidden {
			excluded = append(excluded, delegation.ID)
			continue
		}
		artifactRows, err := tx.Query(`SELECT DISTINCT job_artifacts.artifact_id FROM delegation_jobs
			JOIN job_artifacts ON job_artifacts.job_id = delegation_jobs.job_id
			WHERE delegation_jobs.delegation_id = ? AND job_artifacts.role = 'output'
			ORDER BY job_artifacts.artifact_id`, delegation.ID)
		if err != nil {
			return nil, nil, err
		}
		for artifactRows.Next() {
			var artifactID string
			if err := artifactRows.Scan(&artifactID); err != nil {
				_ = artifactRows.Close()
				return nil, nil, err
			}
			delegation.OutputArtifactIDs = append(delegation.OutputArtifactIDs, artifactID)
		}
		if err := artifactRows.Close(); err != nil {
			return nil, nil, err
		}
		result = append(result, delegation)
	}
	sort.Strings(excluded)
	return result, excluded, nil
}

func stringSet(values []string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[value] = true
	}
	return result
}

func exportProposalsTx(tx *sql.Tx, workstreamID string, includeLocal bool) ([]Proposal, []string, error) {
	rows, err := tx.Query(proposalSelect+` WHERE workstream_id = ? ORDER BY created_at, id`, workstreamID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	result, excluded := []Proposal{}, []string{}
	for rows.Next() {
		value, err := scanProposal(rows)
		if err != nil {
			return nil, nil, err
		}
		if !includeLocal && (containsLocalDisclosure(value.Payload) || containsLocalDisclosure(value.ReviewedPayload)) {
			excluded = append(excluded, value.ID)
			continue
		}
		result = append(result, value)
	}
	return result, excluded, rows.Err()
}

func exportFindingsTx(tx *sql.Tx, workstreamID string, includeLocal bool) ([]Finding, []string, error) {
	query := findingSelect + ` WHERE workstream_id = ?`
	if !includeLocal {
		query += ` AND disclosure <> 'local_only'`
	}
	query += ` ORDER BY created_at, id`
	rows, err := tx.Query(query, workstreamID)
	if err != nil {
		return nil, nil, err
	}
	result := []Finding{}
	for rows.Next() {
		finding, err := scanFinding(rows)
		if err != nil {
			_ = rows.Close()
			return nil, nil, err
		}
		result = append(result, finding)
	}
	if err := rows.Close(); err != nil {
		return nil, nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	// Finish the base scan before issuing detail queries on the same SQLite
	// transaction. Some drivers do not allow a second active statement on one
	// connection even when SQLite itself happens to tolerate it.
	for index := range result {
		var err error
		result[index].Evidence, err = findingEvidenceTx(tx, result[index].ID)
		if err != nil {
			return nil, nil, err
		}
		result[index].Relations, err = findingRelationsTx(tx, result[index].ID)
		if err != nil {
			return nil, nil, err
		}
	}
	excluded := []string{}
	if !includeLocal {
		excludedRows, err := tx.Query(`SELECT id FROM findings WHERE workstream_id = ? AND disclosure = 'local_only' ORDER BY id`, workstreamID)
		if err != nil {
			return nil, nil, err
		}
		for excludedRows.Next() {
			var id string
			if err := excludedRows.Scan(&id); err != nil {
				_ = excludedRows.Close()
				return nil, nil, err
			}
			excluded = append(excluded, id)
		}
		if err := excludedRows.Close(); err != nil {
			return nil, nil, err
		}
	}
	return result, excluded, nil
}

func exportResearchIRTx(tx *sql.Tx, workstreamID string, includeLocal bool, excluded map[string]bool) ([]ResearchIRVersion, []string, error) {
	rows, err := tx.Query(researchIRSelect+` WHERE workstream_id = ? ORDER BY version`, workstreamID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	result, omitted := []ResearchIRVersion{}, []string{}
	for rows.Next() {
		value, err := scanResearchIR(rows)
		if err != nil {
			return nil, nil, err
		}
		if !includeLocal && (containsLocalDisclosure(value.Document) || referencesExcluded(value.Document, excluded)) {
			omitted = append(omitted, fmt.Sprintf("research-ir:%s:%d", workstreamID, value.Version))
			continue
		}
		result = append(result, value)
	}
	return result, omitted, rows.Err()
}

func exportProblemModelsTx(tx *sql.Tx, workstreamID string, includeLocal bool, excluded map[string]bool) ([]ProblemModelVersion, []string, error) {
	rows, err := tx.Query(problemModelSelect+` WHERE workstream_id = ? ORDER BY version`, workstreamID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	result, omitted := []ProblemModelVersion{}, []string{}
	for rows.Next() {
		value, err := scanProblemModel(rows)
		if err != nil {
			return nil, nil, err
		}
		if !includeLocal && (containsLocalDisclosure(value.Document) || referencesExcluded(value.Document, excluded)) {
			omitted = append(omitted, fmt.Sprintf("problem-model:%s:%d", value.ID, value.Version))
			continue
		}
		result = append(result, value)
	}
	return result, omitted, rows.Err()
}

func exportEventsTx(tx *sql.Tx, workstreamID string) ([]Event, int64, error) {
	rows, err := tx.Query(`SELECT seq, id, type, ts, COALESCE(workstream_id, ''), COALESCE(notebook_id, ''),
		COALESCE(cell_id, ''), COALESCE(work_node_id, ''), COALESCE(run_id, ''), COALESCE(session_id, ''), COALESCE(causation_id, ''), payload_json
		FROM events WHERE workstream_id = ? AND type <> 'workstream.export.created' ORDER BY seq`, workstreamID)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	result := []Event{}
	var asOf int64
	for rows.Next() {
		var event Event
		var ts int64
		var payloadJSON string
		if err := rows.Scan(&event.Seq, &event.ID, &event.Type, &ts, &event.WorkstreamID, &event.NotebookID,
			&event.CellID, &event.WorkNodeID, &event.RunID, &event.SessionID, &event.CausationID, &payloadJSON); err != nil {
			return nil, 0, err
		}
		if err := json.Unmarshal([]byte(payloadJSON), &event.Payload); err != nil {
			return nil, 0, err
		}
		event.TS, asOf = formatMillis(ts), event.Seq
		result = append(result, event)
	}
	return result, asOf, rows.Err()
}

func (s *Store) exportArtifactsTx(tx *sql.Tx, ids map[string]bool) ([]exportArtifact, error) {
	// Manifests and event payloads can reference more CAS objects. Walk those
	// JSON values deterministically until the closure stops growing.
	seen := map[string]bool{}
	for {
		pending := []string{}
		for id := range ids {
			if !seen[id] {
				pending = append(pending, id)
			}
		}
		if len(pending) == 0 {
			break
		}
		sort.Strings(pending)
		for _, id := range pending {
			artifact, data, err := s.readArtifactTx(tx, id)
			if err != nil {
				return nil, err
			}
			seen[id] = true
			if strings.Contains(strings.ToLower(artifact.MediaType), "json") {
				var value any
				if json.Unmarshal(data, &value) == nil {
					collectArtifactRefs(value, ids)
				}
			}
		}
	}
	ordered := make([]string, 0, len(seen))
	for id := range seen {
		ordered = append(ordered, id)
	}
	sort.Strings(ordered)
	result := make([]exportArtifact, 0, len(ordered))
	var total int64
	for _, id := range ordered {
		artifact, data, err := s.readArtifactTx(tx, id)
		if err != nil {
			return nil, err
		}
		total += int64(len(data))
		if total > maxWorkstreamExportBytes {
			return nil, errors.New("Workstream artifact closure exceeds export size limit")
		}
		result = append(result, exportArtifact{Artifact: artifact, DataBase64: base64.StdEncoding.EncodeToString(data)})
	}
	return result, nil
}

func collectArtifactRefs(value any, ids map[string]bool) {
	switch current := value.(type) {
	case string:
		if strings.HasPrefix(current, "art_") && cellIDPattern.MatchString(current) {
			ids[current] = true
		}
	case map[string]any:
		for _, child := range current {
			collectArtifactRefs(child, ids)
		}
	case []any:
		for _, child := range current {
			collectArtifactRefs(child, ids)
		}
	default:
		encoded, err := json.Marshal(current)
		if err == nil && len(encoded) > 0 && (encoded[0] == '{' || encoded[0] == '[') {
			var generic any
			if json.Unmarshal(encoded, &generic) == nil {
				collectArtifactRefs(generic, ids)
			}
		}
	}
}

func containsLocalDisclosure(value any) bool {
	switch current := value.(type) {
	case map[string]any:
		for key, child := range current {
			if strings.EqualFold(strings.ReplaceAll(key, "_", ""), "disclosure") && stringValue(child) == "local_only" {
				return true
			}
			if containsLocalDisclosure(child) {
				return true
			}
		}
	case []any:
		for _, child := range current {
			if containsLocalDisclosure(child) {
				return true
			}
		}
	}
	return false
}

func referencesExcluded(value any, excluded map[string]bool) bool {
	switch current := value.(type) {
	case string:
		return excluded[current] || (strings.HasPrefix(current, "finding:") && excluded[strings.TrimPrefix(current, "finding:")])
	case map[string]any:
		for _, child := range current {
			if referencesExcluded(child, excluded) {
				return true
			}
		}
	case []any:
		for _, child := range current {
			if referencesExcluded(child, excluded) {
				return true
			}
		}
	}
	return false
}
