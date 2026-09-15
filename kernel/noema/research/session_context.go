// Noema session context accounting is Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package research

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

type SessionUsage struct {
	SessionID     string `json:"sessionId,omitempty"`
	TotalTokens   int64  `json:"totalTokens"`
	InputTokens   int64  `json:"inputTokens"`
	OutputTokens  int64  `json:"outputTokens"`
	ThoughtTokens int64  `json:"thoughtTokens"`
	CachedTokens  int64  `json:"cachedTokens"`
	ContextUsed   int64  `json:"contextUsed"`
	ContextSize   int64  `json:"contextSize"`
	UpdatedAt     string `json:"updatedAt,omitempty"`
}

type SessionCompaction struct {
	ID                 string `json:"id"`
	SessionID          string `json:"sessionId"`
	Generation         int64  `json:"generation"`
	Mode               string `json:"mode"`
	Status             string `json:"status"`
	OldNativeSessionID string `json:"oldNativeSessionId,omitempty"`
	NewNativeSessionID string `json:"newNativeSessionId,omitempty"`
	FailureReason      string `json:"failureReason,omitempty"`
	CreatedAt          string `json:"createdAt"`
	FinishedAt         string `json:"finishedAt,omitempty"`
}

type SessionContext struct {
	Usage      SessionUsage       `json:"usage"`
	Compaction *SessionCompaction `json:"compaction,omitempty"`
}

func validateSessionUsage(usage SessionUsage) error {
	values := []int64{usage.TotalTokens, usage.InputTokens, usage.OutputTokens, usage.ThoughtTokens,
		usage.CachedTokens, usage.ContextUsed, usage.ContextSize}
	for _, value := range values {
		if value < 0 {
			return errors.New("session usage cannot be negative")
		}
	}
	return nil
}

func recordSessionUsageTx(tx *sql.Tx, sessionID string, usage SessionUsage, nowMs int64) error {
	if err := validateSessionUsage(usage); err != nil {
		return err
	}
	_, err := tx.Exec(`INSERT INTO session_usage(session_id, total_tokens, input_tokens, output_tokens,
		thought_tokens, cached_tokens, context_used, context_size, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET total_tokens = excluded.total_tokens,
		input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
		thought_tokens = excluded.thought_tokens, cached_tokens = excluded.cached_tokens,
		context_used = excluded.context_used, context_size = excluded.context_size, updated_at = excluded.updated_at`,
		sessionID, usage.TotalTokens, usage.InputTokens, usage.OutputTokens, usage.ThoughtTokens,
		usage.CachedTokens, usage.ContextUsed, usage.ContextSize, nowMs)
	return err
}

func scanSessionCompaction(row *sql.Row) (*SessionCompaction, error) {
	var item SessionCompaction
	var createdAt int64
	var finishedAt sql.NullInt64
	err := row.Scan(&item.ID, &item.SessionID, &item.Generation, &item.Mode, &item.Status,
		&item.OldNativeSessionID, &item.NewNativeSessionID, &item.FailureReason, &createdAt, &finishedAt)
	if err != nil {
		return nil, err
	}
	item.CreatedAt = formatMillis(createdAt)
	if finishedAt.Valid {
		item.FinishedAt = formatMillis(finishedAt.Int64)
	}
	return &item, nil
}

func (s *Store) GetSessionContext(sessionID string) (SessionContext, error) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return SessionContext{}, errors.New("session context requires a session id")
	}
	result := SessionContext{Usage: SessionUsage{SessionID: sessionID}}
	var updatedAt int64
	err := s.db.QueryRow(`SELECT total_tokens, input_tokens, output_tokens, thought_tokens,
		cached_tokens, context_used, context_size, updated_at FROM session_usage WHERE session_id = ?`, sessionID).
		Scan(&result.Usage.TotalTokens, &result.Usage.InputTokens, &result.Usage.OutputTokens,
			&result.Usage.ThoughtTokens, &result.Usage.CachedTokens, &result.Usage.ContextUsed,
			&result.Usage.ContextSize, &updatedAt)
	if err == nil {
		result.Usage.UpdatedAt = formatMillis(updatedAt)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return SessionContext{}, err
	} else {
		var exists int
		if err := s.db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE id = ?`, sessionID).Scan(&exists); err != nil || exists == 0 {
			return SessionContext{}, fmt.Errorf("session %q not found", sessionID)
		}
	}
	result.Compaction, err = scanSessionCompaction(s.db.QueryRow(`SELECT id, session_id, generation, mode, status,
		old_native_session_id, new_native_session_id, failure_reason, created_at, finished_at
		FROM session_compactions WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, sessionID))
	if errors.Is(err, sql.ErrNoRows) {
		result.Compaction, err = nil, nil
	}
	return result, err
}

func (s *Store) RequestSessionCompaction(sessionID string) (SessionCompaction, error) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return SessionCompaction{}, errors.New("session compaction requires a session id")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, err := scanSessionCompaction(s.db.QueryRow(`SELECT id, session_id, generation, mode, status,
		old_native_session_id, new_native_session_id, failure_reason, created_at, finished_at
		FROM session_compactions WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, sessionID)); err == nil {
		return *existing, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return SessionCompaction{}, err
	}
	var nativeID string
	if err := s.db.QueryRow(`SELECT native_session_id FROM sessions WHERE id = ?`, sessionID).Scan(&nativeID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return SessionCompaction{}, fmt.Errorf("session %q not found", sessionID)
		}
		return SessionCompaction{}, err
	}
	var generation int64
	_ = s.db.QueryRow(`SELECT COALESCE(MAX(generation), 1) FROM session_names WHERE session_id = ?`, sessionID).Scan(&generation)
	id, err := prefixedUUID("compact_")
	if err != nil {
		return SessionCompaction{}, err
	}
	nowMs := time.Now().UTC().UnixMilli()
	if _, err := s.db.Exec(`INSERT INTO session_compactions(id, session_id, generation, mode, status,
		old_native_session_id, created_at) VALUES(?, ?, ?, 'checkpoint', 'pending', ?, ?)`,
		id, sessionID, generation, nativeID, nowMs); err != nil {
		return SessionCompaction{}, err
	}
	item, err := scanSessionCompaction(s.db.QueryRow(`SELECT id, session_id, generation, mode, status,
		old_native_session_id, new_native_session_id, failure_reason, created_at, finished_at
		FROM session_compactions WHERE id = ?`, id))
	if err != nil {
		return SessionCompaction{}, err
	}
	return *item, nil
}
