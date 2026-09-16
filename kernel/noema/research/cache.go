// Noema research cache maintenance is Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package research

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	defaultCacheHighWaterBytes = int64(5 * 1024 * 1024 * 1024)
	defaultCacheTargetBytes    = int64(4 * 1024 * 1024 * 1024)
	defaultCacheOrphanAge      = 24 * time.Hour
	defaultCacheWALBytes       = int64(64 * 1024 * 1024)
	// Streamed content segments only serve a live OutputArea.  A finished
	// Run keeps its text in the Transcript artifact and the notebook output.
	defaultSegmentRetention = 7 * 24 * time.Hour
)

// CachePolicy is deliberately conservative.  Only CAS blobs which have no
// row at all in the artifact registry are eligible for removal.
type CachePolicy struct {
	HighWaterBytes int64 `json:"highWaterBytes"`
	TargetBytes    int64 `json:"targetBytes"`
	OrphanAgeMS    int64 `json:"orphanAgeMillis"`
	WALBytes       int64 `json:"walBytes"`
	// SegmentRetentionMS is how long streamed content events of a finished
	// Run are kept once its Transcript and notebook writeback are durable.
	SegmentRetentionMS int64 `json:"segmentRetentionMillis"`
}

// CacheStatus describes repository-local derived/runtime storage.
type CacheStatus struct {
	TotalBytes      int64  `json:"totalBytes"`
	ObjectBytes     int64  `json:"objectBytes"`
	ObjectCount     int64  `json:"objectCount"`
	OrphanBytes     int64  `json:"orphanBytes"`
	OrphanCount     int64  `json:"orphanCount"`
	DatabaseBytes   int64  `json:"databaseBytes"`
	WALBytes        int64  `json:"walBytes"`
	RemovedBytes    int64  `json:"removedBytes"`
	RemovedCount    int64  `json:"removedCount"`
	Pressure        bool   `json:"pressure"`
	CheckpointedWAL bool   `json:"checkpointedWal"`
	LimitedReason   string `json:"limitedReason,omitempty"`
	// PrunedSegments counts streamed content events removed this pass.
	PrunedSegments int64 `json:"prunedSegments"`
}

// DefaultCachePolicy returns the bounded automatic maintenance policy.
func DefaultCachePolicy() CachePolicy {
	return CachePolicy{HighWaterBytes: defaultCacheHighWaterBytes, TargetBytes: defaultCacheTargetBytes,
		OrphanAgeMS: defaultCacheOrphanAge.Milliseconds(), WALBytes: defaultCacheWALBytes,
		SegmentRetentionMS: defaultSegmentRetention.Milliseconds()}
}

func normalizedCachePolicy(policy CachePolicy) CachePolicy {
	defaults := DefaultCachePolicy()
	if policy.HighWaterBytes <= 0 {
		policy.HighWaterBytes = defaults.HighWaterBytes
	}
	if policy.TargetBytes <= 0 || policy.TargetBytes > policy.HighWaterBytes {
		policy.TargetBytes = defaults.TargetBytes
		if policy.TargetBytes > policy.HighWaterBytes {
			policy.TargetBytes = policy.HighWaterBytes
		}
	}
	if policy.OrphanAgeMS <= 0 {
		policy.OrphanAgeMS = defaults.OrphanAgeMS
	}
	if policy.WALBytes <= 0 {
		policy.WALBytes = defaults.WALBytes
	}
	if policy.SegmentRetentionMS <= 0 {
		policy.SegmentRetentionMS = defaults.SegmentRetentionMS
	}
	return policy
}

type cacheObject struct {
	path, digest string
	size         int64
	modified     time.Time
}

func regularFileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return 0
	}
	return info.Size()
}

func scanCacheObjects(root string, registered map[string]bool, cutoff time.Time) ([]cacheObject, CacheStatus, error) {
	objectsRoot := filepath.Join(root, StateDirName, "objects", "sha256")
	orphans := []cacheObject{}
	status := CacheStatus{}
	err := filepath.WalkDir(objectsRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if errors.Is(walkErr, os.ErrNotExist) {
			return nil
		}
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return err
		}
		status.ObjectBytes += info.Size()
		status.ObjectCount++
		relative, err := filepath.Rel(objectsRoot, path)
		if err != nil {
			return err
		}
		digest := strings.ToLower(strings.ReplaceAll(relative, string(filepath.Separator), ""))
		if len(digest) != 64 || strings.IndexFunc(digest, func(r rune) bool {
			return !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f'))
		}) >= 0 || registered[digest] {
			return nil
		}
		status.OrphanBytes += info.Size()
		status.OrphanCount++
		if !info.ModTime().After(cutoff) {
			orphans = append(orphans, cacheObject{path: path, digest: digest, size: info.Size(), modified: info.ModTime()})
		}
		return nil
	})
	if errors.Is(err, os.ErrNotExist) {
		err = nil
	}
	return orphans, status, err
}

func (s *Store) registeredArtifactDigests() (map[string]bool, error) {
	rows, err := s.db.Query(`SELECT DISTINCT lower(sha256) FROM artifacts`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]bool{}
	for rows.Next() {
		var digest string
		if err := rows.Scan(&digest); err != nil {
			return nil, err
		}
		result[digest] = true
	}
	return result, rows.Err()
}

// MaintainCache prunes expired stream rows and old, unregistered CAS blobs.
// It never deletes an artifact known to SQLite, even when the target size
// cannot otherwise be reached.
func (s *Store) MaintainCache(requested CachePolicy) (CacheStatus, error) {
	policy := normalizedCachePolicy(requested)
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.Exec(`DELETE FROM run_stream_cache WHERE expires_at <= ?`, time.Now().UTC().UnixMilli()); err != nil {
		return CacheStatus{}, fmt.Errorf("prune expired run stream cache: %w", err)
	}
	// Streamed segments are the largest unbounded table.  Remove them only for
	// Runs that finished long enough ago, whose notebook writeback is done and
	// whose terminal event names a Transcript artifact holding the full text.
	segmentCutoff := time.Now().UTC().Add(-time.Duration(policy.SegmentRetentionMS) * time.Millisecond).UnixMilli()
	pruned, err := s.db.Exec(`DELETE FROM events WHERE type = 'run.content.segment' AND run_id IN (
		SELECT r.id FROM runs r
		WHERE r.status IN ('completed', 'cancelled', 'failed', 'interrupted')
		AND COALESCE(r.finished_at, 0) > 0 AND r.finished_at <= ?
		AND NOT EXISTS (SELECT 1 FROM notebook_writebacks w WHERE w.run_id = r.id AND w.state != 'done')
		AND EXISTS (SELECT 1 FROM events terminal WHERE terminal.run_id = r.id
			AND terminal.type = 'run.status.changed'
			AND COALESCE(json_extract(terminal.payload_json, '$.transcript_artifact_id'), '') != ''))`, segmentCutoff)
	if err != nil {
		return CacheStatus{}, fmt.Errorf("prune finished run segments: %w", err)
	}
	prunedSegments, _ := pruned.RowsAffected()
	registered, err := s.registeredArtifactDigests()
	if err != nil {
		return CacheStatus{}, fmt.Errorf("read artifact registry: %w", err)
	}
	orphans, status, err := scanCacheObjects(s.root, registered,
		time.Now().Add(-time.Duration(policy.OrphanAgeMS)*time.Millisecond))
	if err != nil {
		return CacheStatus{}, fmt.Errorf("scan research cache: %w", err)
	}
	databasePath := filepath.Join(s.root, StateDirName, "state.sqlite")
	walPath := databasePath + "-wal"
	status.DatabaseBytes = regularFileSize(databasePath)
	status.WALBytes = regularFileSize(walPath)
	status.TotalBytes = status.DatabaseBytes + status.WALBytes + regularFileSize(databasePath+"-shm") + status.ObjectBytes
	if status.WALBytes >= policy.WALBytes {
		var busy, logFrames, checkpointed int
		if err := s.db.QueryRow(`PRAGMA wal_checkpoint(TRUNCATE)`).Scan(&busy, &logFrames, &checkpointed); err == nil && busy == 0 {
			status.CheckpointedWAL = true
			status.WALBytes = regularFileSize(walPath)
			status.TotalBytes = status.DatabaseBytes + status.WALBytes + regularFileSize(databasePath+"-shm") + status.ObjectBytes
		}
	}
	if status.TotalBytes > policy.HighWaterBytes {
		sort.Slice(orphans, func(i, j int) bool { return orphans[i].modified.Before(orphans[j].modified) })
		for _, orphan := range orphans {
			if status.TotalBytes <= policy.TargetBytes {
				break
			}
			if err := os.Remove(orphan.path); err != nil && !errors.Is(err, os.ErrNotExist) {
				continue
			}
			status.TotalBytes -= orphan.size
			status.ObjectBytes -= orphan.size
			status.OrphanBytes -= orphan.size
			status.OrphanCount--
			status.RemovedBytes += orphan.size
			status.RemovedCount++
			_ = os.Remove(filepath.Dir(orphan.path))
		}
	}
	status.PrunedSegments = prunedSegments
	status.Pressure = status.TotalBytes > policy.HighWaterBytes
	if status.Pressure {
		status.LimitedReason = "only old CAS objects absent from the artifact registry are safe to remove"
	}
	return status, nil
}

// CacheStatusOnly inspects the default policy without deleting anything.
func (s *Store) CacheStatusOnly() (CacheStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	registered, err := s.registeredArtifactDigests()
	if err != nil {
		return CacheStatus{}, err
	}
	_, status, err := scanCacheObjects(s.root, registered, time.Time{})
	if err != nil {
		return CacheStatus{}, err
	}
	databasePath := filepath.Join(s.root, StateDirName, "state.sqlite")
	status.DatabaseBytes = regularFileSize(databasePath)
	status.WALBytes = regularFileSize(databasePath + "-wal")
	status.TotalBytes = status.DatabaseBytes + status.WALBytes + regularFileSize(databasePath+"-shm") + status.ObjectBytes
	status.Pressure = status.TotalBytes > defaultCacheHighWaterBytes
	return status, nil
}
