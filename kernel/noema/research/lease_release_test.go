package research

import (
	"testing"
	"time"
)

// D-035: a Run that finishes normally hands its session back.  Nothing about
// that is a lost worker, so the lease sweep must stay silent afterwards.
func TestTerminalRunReleasesItsSessionQuietly(t *testing.T) {
	store, root := openTestStore(t)
	session := promoteRuntimeSession(t, store, root)
	run := prepareRuntimeRun(t, store, session, root)
	lease, err := store.AcquireLease(AcquireLeaseInput{SessionID: session.ID, Owner: "emacs:one"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartRun(StartRunInput{SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID}); err != nil {
		t.Fatal(err)
	}
	if loaded, err := store.GetSession(session.ID); err != nil || loaded.State != "active" {
		t.Fatalf("a leased session is active while its Run runs: %+v (%v)", loaded, err)
	}
	if _, err := store.ReportWorkerEvents(ReportWorkerEventsInput{SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID,
		Events: []WorkerEvent{{Type: "run.status.changed", Payload: map[string]any{"status": "completed"}}}}); err != nil {
		t.Fatal(err)
	}
	if loaded, err := store.GetSession(session.ID); err != nil || loaded.State != "warm" {
		t.Fatalf("a finished Run must leave its session resumable, not held: %+v (%v)", loaded, err)
	}
	var expiresAt, epoch int64
	if err := store.db.QueryRow(`SELECT expires_at, epoch FROM leases WHERE session_id = ?`, session.ID).Scan(&expiresAt, &epoch); err != nil {
		t.Fatal(err)
	}
	if epoch != lease.Epoch || expiresAt > time.Now().UnixMilli() {
		t.Fatalf("the released lease keeps its epoch and is already expired: epoch=%d expires=%d", epoch, expiresAt)
	}
	interrupted, err := store.ExpireLeases()
	if err != nil || len(interrupted) != 0 {
		t.Fatalf("a released lease interrupts nothing: %+v (%v)", interrupted, err)
	}
	var noise int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM events WHERE session_id = ? AND type = 'lease.expired'`, session.ID).Scan(&noise); err != nil || noise != 0 {
		t.Fatalf("a normal finish must not be recorded as lease expiry: %d (%v)", noise, err)
	}
	next, err := store.AcquireLease(AcquireLeaseInput{SessionID: session.ID, Owner: "emacs:two"})
	if err != nil || next.Epoch <= lease.Epoch {
		t.Fatalf("the next worker must acquire a newer epoch: %+v (%v)", next, err)
	}
}
