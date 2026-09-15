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
