package research

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMaintainCacheDeletesOnlyOldUnregisteredObjects(t *testing.T) {
	store, root := openTestStore(t)
	registered, err := store.ImportArtifact(ImportArtifactInput{
		Kind: "test-output", MediaType: "text/plain",
		ContentBase64: base64.StdEncoding.EncodeToString([]byte("registered")),
	})
	if err != nil {
		t.Fatal(err)
	}
	registeredPath := filepath.Join(root, StateDirName, "objects", "sha256", registered.SHA256[:2], registered.SHA256[2:])
	oldDigest := strings.Repeat("a", 64)
	oldPath := filepath.Join(root, StateDirName, "objects", "sha256", oldDigest[:2], oldDigest[2:])
	recentDigest := strings.Repeat("b", 64)
	recentPath := filepath.Join(root, StateDirName, "objects", "sha256", recentDigest[:2], recentDigest[2:])
	for _, path := range []string{oldPath, recentPath} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("orphan"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(oldPath, old, old); err != nil {
		t.Fatal(err)
	}
	status, err := store.MaintainCache(CachePolicy{HighWaterBytes: 1, TargetBytes: 1,
		OrphanAgeMS: time.Hour.Milliseconds(), WALBytes: 1 << 60})
	if err != nil {
		t.Fatal(err)
	}
	if status.RemovedCount != 1 {
		t.Fatalf("expected one eligible orphan removal, got %+v", status)
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("old unregistered object survived: %v", err)
	}
	for _, path := range []string{registeredPath, recentPath} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("protected cache object %s was removed: %v", path, err)
		}
	}
}

func TestMaintainCachePrunesStreamedSegmentsOnlyOfOldFinishedRuns(t *testing.T) {
	store, root := openTestStore(t)
	session := promoteRuntimeSession(t, store, root)
	run := prepareRuntimeRun(t, store, session, root)
	lease, err := store.AcquireLease(AcquireLeaseInput{SessionID: session.ID, Owner: "emacs:test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartRun(StartRunInput{SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportWorkerEvents(ReportWorkerEventsInput{SessionID: session.ID, Owner: lease.Owner,
		Epoch: lease.Epoch, RunID: run.ID, Events: []WorkerEvent{
			{Type: "run.content.segment", Payload: map[string]any{"stream": "assistant", "text": "part one "}},
			{Type: "run.content.segment", Payload: map[string]any{"stream": "assistant", "text": "part two"}},
		}}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportWorkerEvents(ReportWorkerEventsInput{SessionID: session.ID, Owner: lease.Owner,
		Epoch: lease.Epoch, RunID: run.ID, Events: []WorkerEvent{{Type: "run.status.changed",
			Payload: map[string]any{"status": "completed", "result_text": "done", "transcript_text": "part one part two"}}}}); err != nil {
		t.Fatal(err)
	}
	count := func(kind string) int {
		t.Helper()
		var total int
		if err := store.db.QueryRow(`SELECT COUNT(*) FROM events WHERE run_id = ? AND type = ?`, run.ID, kind).Scan(&total); err != nil {
			t.Fatal(err)
		}
		return total
	}
	policy := CachePolicy{HighWaterBytes: 1 << 60, TargetBytes: 1 << 59, WALBytes: 1 << 60, SegmentRetentionMS: time.Hour.Milliseconds()}
	// A Run that just finished keeps its stream for a live or reopened OutputArea.
	if status, err := store.MaintainCache(policy); err != nil || status.PrunedSegments != 0 || count("run.content.segment") != 2 {
		t.Fatalf("recent segments must survive: %+v (%v)", status, err)
	}
	if _, err := store.db.Exec(`UPDATE runs SET finished_at = ? WHERE id = ?`, time.Now().Add(-2*time.Hour).UnixMilli(), run.ID); err != nil {
		t.Fatal(err)
	}
	status, err := store.MaintainCache(policy)
	if err != nil || status.PrunedSegments != 2 || count("run.content.segment") != 0 || count("run.status.changed") == 0 {
		t.Fatalf("old finished segments must go and status events stay: %+v (%v)", status, err)
	}
	if output, err := store.ReadRunOutput(run.ID, true); err != nil || output.TranscriptText != "part one part two" {
		t.Fatalf("the Transcript must still hold the full text: %+v (%v)", output, err)
	}
}

func TestNotebookWritebackOutboxRecoversAWriterLease(t *testing.T) {
	store, root := openTestStore(t)
	session := promoteRuntimeSession(t, store, root)
	run := prepareRuntimeRun(t, store, session, root)
	lease, err := store.AcquireLease(AcquireLeaseInput{SessionID: session.ID, Owner: "emacs:test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartRun(StartRunInput{SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportWorkerEvents(ReportWorkerEventsInput{SessionID: session.ID, Owner: lease.Owner,
		Epoch: lease.Epoch, RunID: run.ID, Events: []WorkerEvent{{Type: "run.status.changed",
			Payload: map[string]any{"status": "completed"}}}}); err != nil {
		t.Fatal(err)
	}
	queued, err := store.QueueNotebookWriteback(QueueNotebookWritebackInput{RunID: run.ID,
		NotebookPath: "notes/research.noema", CellID: "c-work", Output: map[string]any{"content": "answer"}})
	if err != nil || queued.State != "pending" {
		t.Fatalf("queue writeback: %+v (%v)", queued, err)
	}
	claimed, err := store.ClaimNotebookWritebacks(20)
	if err != nil || len(claimed) != 1 || claimed[0].Attempts != 1 || claimed[0].State != "writing" {
		t.Fatalf("claim writeback: %+v (%v)", claimed, err)
	}
	failed, err := store.CompleteNotebookWriteback(CompleteNotebookWritebackInput{RunID: run.ID,
		State: "failed", LastError: "temporary", RetryAfterMS: 1})
	if err != nil || failed.State != "failed" {
		t.Fatalf("fail writeback: %+v (%v)", failed, err)
	}
	time.Sleep(2 * time.Millisecond)
	retried, err := store.ClaimNotebookWritebacks(20)
	if err != nil || len(retried) != 1 || retried[0].Attempts != 2 {
		t.Fatalf("retry writeback: %+v (%v)", retried, err)
	}
	done, err := store.CompleteNotebookWriteback(CompleteNotebookWritebackInput{RunID: run.ID, State: "done"})
	if err != nil || done.State != "done" {
		t.Fatalf("complete writeback: %+v (%v)", done, err)
	}
}
