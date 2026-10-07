// Noema Run context receipts are Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package research

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// RunContextReceipt reports the immutable input selected for one Run. The
// optional ACP usage is a cumulative Session snapshot at this Run's terminal
// event, never a per-Run token count or a complete provider prompt trace.
type RunContextReceipt struct {
	Run                  Run              `json:"run"`
	SpecSHA256           string           `json:"specSha256"`
	PromptBytes          int              `json:"promptBytes"`
	ContextLimitBytes    int              `json:"contextLimitBytes,omitempty"`
	Context              []map[string]any `json:"context"`
	Omitted              []map[string]any `json:"omitted"`
	SessionUsageAtFinish *SessionUsage    `json:"sessionUsageAtFinish,omitempty"`
}

func (s *Store) RunContextReceipt(id string) (RunContextReceipt, error) {
	run, err := s.GetRun(id)
	if err != nil {
		return RunContextReceipt{}, err
	}
	artifact, data, err := s.ReadArtifact(run.SpecArtifactID)
	if err != nil {
		return RunContextReceipt{}, err
	}
	if artifact.Kind != "run-spec" {
		return RunContextReceipt{}, fmt.Errorf("run %q has no RunSpec artifact", run.ID)
	}
	var spec struct {
		RunID             string           `json:"run_id"`
		Prompt            string           `json:"prompt"`
		ContextLimitBytes int              `json:"context_limit_bytes"`
		Context           []map[string]any `json:"context"`
		Omitted           []map[string]any `json:"context_omitted"`
	}
	if err := json.Unmarshal(data, &spec); err != nil {
		return RunContextReceipt{}, fmt.Errorf("decode run %q RunSpec: %w", run.ID, err)
	}
	if spec.RunID != run.ID {
		return RunContextReceipt{}, fmt.Errorf("run %q RunSpec identity does not match", run.ID)
	}
	limit := spec.ContextLimitBytes
	if limit == 0 && run.SourceKind == "work-cell" {
		limit = 64 * 1024 // Legacy RunSpecs predate context_limit_bytes.
	}
	receipt := RunContextReceipt{Run: run, SpecSHA256: artifact.SHA256,
		PromptBytes: len([]byte(spec.Prompt)), ContextLimitBytes: limit,
		Context: spec.Context, Omitted: spec.Omitted}
	if receipt.Context == nil {
		receipt.Context = []map[string]any{}
	}
	if receipt.Omitted == nil {
		receipt.Omitted = []map[string]any{}
	}
	var payload string
	var eventAt int64
	err = s.db.QueryRow(`SELECT payload_json, ts FROM events
		WHERE run_id = ? AND type = 'run.status.changed' ORDER BY seq DESC LIMIT 1`, run.ID).
		Scan(&payload, &eventAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return RunContextReceipt{}, err
	}
	if err == nil {
		var terminal struct {
			Status string        `json:"status"`
			Usage  *SessionUsage `json:"session_usage_at_finish"`
		}
		if err := json.Unmarshal([]byte(payload), &terminal); err != nil {
			return RunContextReceipt{}, fmt.Errorf("decode run %q terminal event: %w", run.ID, err)
		}
		if terminalRunStatuses[strings.TrimSpace(terminal.Status)] && terminal.Usage != nil {
			terminal.Usage.SessionID = run.SessionID
			terminal.Usage.UpdatedAt = formatMillis(eventAt)
			receipt.SessionUsageAtFinish = terminal.Usage
		}
	}
	return receipt, nil
}
