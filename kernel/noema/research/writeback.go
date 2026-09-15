// Noema notebook writeback outbox is Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package research

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

type NotebookWriteback struct {
	RunID            string         `json:"runId"`
	NotebookPath     string         `json:"notebookPath"`
	CellID           string         `json:"cellId"`
	Output           map[string]any `json:"output"`
	ExpectedRevision string         `json:"expectedRevision,omitempty"`
	State            string         `json:"state"`
	Attempts         int64          `json:"attempts"`
	NextAttempt      string         `json:"nextAttempt"`
	LastError        string         `json:"lastError,omitempty"`
	UpdatedAt        string         `json:"updatedAt"`
}

type QueueNotebookWritebackInput struct {
	RunID            string         `json:"runId"`
	NotebookPath     string         `json:"notebookPath"`
	CellID           string         `json:"cellId"`
	Output           map[string]any `json:"output"`
	ExpectedRevision string         `json:"expectedRevision"`
}

type CompleteNotebookWritebackInput struct {
	RunID        string `json:"runId"`
	State        string `json:"state"`
	LastError    string `json:"lastError"`
	RetryAfterMS int64  `json:"retryAfterMillis"`
}

func validateNotebookWritebackPath(path string) (string, error) {
	path = filepath.Clean(strings.TrimSpace(path))
	if path == "." || filepath.IsAbs(path) || path == ".." || strings.HasPrefix(path, ".."+string(filepath.Separator)) {
		return "", errors.New("notebook writeback path must stay inside the project")
	}
	return filepath.ToSlash(path), nil
}

func (s *Store) QueueNotebookWriteback(input QueueNotebookWritebackInput) (NotebookWriteback, error) {
	input.RunID, input.CellID = strings.TrimSpace(input.RunID), strings.TrimSpace(input.CellID)
	path, err := validateNotebookWritebackPath(input.NotebookPath)
	if err != nil {
		return NotebookWriteback{}, err
	}
	if input.RunID == "" || input.CellID == "" || input.Output == nil {
		return NotebookWriteback{}, errors.New("notebook writeback requires run, cell and output")
	}
	encoded, err := json.Marshal(input.Output)
	if err != nil {
		return NotebookWriteback{}, fmt.Errorf("encode notebook writeback: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var terminal string
	if err := s.db.QueryRow(`SELECT status FROM runs WHERE id = ?`, input.RunID).Scan(&terminal); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return NotebookWriteback{}, fmt.Errorf("run %q not found", input.RunID)
		}
		return NotebookWriteback{}, err
	}
	if !terminalRunStatuses[terminal] {
		return NotebookWriteback{}, fmt.Errorf("run %q is not terminal", input.RunID)
	}
	nowMs := time.Now().UTC().UnixMilli()
	if _, err := s.db.Exec(`INSERT INTO notebook_writebacks(run_id, notebook_path, cell_id, output_json,
		expected_revision, state, attempts, next_attempt, updated_at) VALUES(?, ?, ?, ?, ?, 'pending', 0, ?, ?)
		ON CONFLICT(run_id) DO NOTHING`, input.RunID, path, input.CellID, string(encoded),
		strings.TrimSpace(input.ExpectedRevision), nowMs, nowMs); err != nil {
		return NotebookWriteback{}, err
	}
	return s.notebookWriteback(input.RunID)
}

func (s *Store) notebookWriteback(runID string) (NotebookWriteback, error) {
	var item NotebookWriteback
	var outputJSON string
	var nextAttempt, updatedAt int64
	err := s.db.QueryRow(`SELECT run_id, notebook_path, cell_id, output_json, expected_revision,
		state, attempts, next_attempt, last_error, updated_at FROM notebook_writebacks WHERE run_id = ?`, runID).
		Scan(&item.RunID, &item.NotebookPath, &item.CellID, &outputJSON, &item.ExpectedRevision,
			&item.State, &item.Attempts, &nextAttempt, &item.LastError, &updatedAt)
	if err != nil {
		return NotebookWriteback{}, err
	}
	if err := json.Unmarshal([]byte(outputJSON), &item.Output); err != nil {
		return NotebookWriteback{}, err
	}
	item.NextAttempt, item.UpdatedAt = formatMillis(nextAttempt), formatMillis(updatedAt)
	return item, nil
}

// ClaimNotebookWritebacks leases due rows to the Node file writer.  A host
// crash makes a writing row claimable again after five minutes.
func (s *Store) ClaimNotebookWritebacks(limit int) ([]NotebookWriteback, error) {
	if limit < 1 || limit > 100 {
		limit = 20
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	nowMs := time.Now().UTC().UnixMilli()
	if _, err := tx.Exec(`UPDATE notebook_writebacks SET state = 'failed', last_error = 'writer lease expired',
		next_attempt = ?, updated_at = ? WHERE state = 'writing' AND updated_at <= ?`, nowMs, nowMs, nowMs-5*60*1000); err != nil {
		return nil, err
	}
	rows, err := tx.Query(`SELECT run_id FROM notebook_writebacks
		WHERE state IN ('pending', 'failed') AND next_attempt <= ? ORDER BY next_attempt, updated_at LIMIT ?`, nowMs, limit)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for _, id := range ids {
		if _, err := tx.Exec(`UPDATE notebook_writebacks SET state = 'writing', attempts = attempts + 1,
			updated_at = ? WHERE run_id = ?`, nowMs, id); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := make([]NotebookWriteback, 0, len(ids))
	for _, id := range ids {
		item, err := s.notebookWriteback(id)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, nil
}

func (s *Store) CompleteNotebookWriteback(input CompleteNotebookWritebackInput) (NotebookWriteback, error) {
	input.RunID, input.State, input.LastError = strings.TrimSpace(input.RunID), strings.TrimSpace(input.State), strings.TrimSpace(input.LastError)
	if input.RunID == "" || (input.State != "done" && input.State != "failed" && input.State != "conflict") {
		return NotebookWriteback{}, errors.New("writeback completion requires a run and valid terminal state")
	}
	if input.RetryAfterMS < 0 {
		input.RetryAfterMS = 0
	}
	if input.RetryAfterMS > 5*60*1000 {
		input.RetryAfterMS = 5 * 60 * 1000
	}
	nowMs := time.Now().UTC().UnixMilli()
	s.mu.Lock()
	defer s.mu.Unlock()
	result, err := s.db.Exec(`UPDATE notebook_writebacks SET state = ?, next_attempt = ?, last_error = ?,
		updated_at = ? WHERE run_id = ? AND state = 'writing'`, input.State, nowMs+input.RetryAfterMS,
		input.LastError, nowMs, input.RunID)
	if err != nil {
		return NotebookWriteback{}, err
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return NotebookWriteback{}, fmt.Errorf("writeback %q is not owned by a writer", input.RunID)
	}
	return s.notebookWriteback(input.RunID)
}
