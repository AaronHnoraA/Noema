package research

import (
	"path/filepath"
	"strings"
	"testing"
)

func startEditingRun(t *testing.T, store *Store, root, native string) (Run, Lease) {
	t.Helper()
	session := promoteNamedTestSession(t, store, root, native, "")
	run := prepareRuntimeRun(t, store, session, root)
	lease, err := store.AcquireLease(AcquireLeaseInput{SessionID: session.ID, Owner: "emacs:" + native})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartRun(StartRunInput{SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID}); err != nil {
		t.Fatal(err)
	}
	return run, lease
}

func requestEdit(t *testing.T, store *Store, run Run, lease Lease, native string, path string) Permission {
	t.Helper()
	permission, err := store.RequestPermission(RequestPermissionInput{
		SessionID: run.SessionID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID, NativeRequestID: native,
		Action:  map[string]any{"kind": "edit", "paths": []any{path}},
		Options: []map[string]any{{"optionId": "allow_once"}, {"optionId": "reject_once"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return permission
}

func TestConcurrentEditOfOnePathWaitsForAPerson(t *testing.T) {
	store, root := openTestStore(t)
	first, firstLease := startEditingRun(t, store, root, "native-first")
	second, secondLease := startEditingRun(t, store, root, "native-second")

	granted := requestEdit(t, store, first, firstLease, "edit-1", "src/model.py")
	if granted.State != "resolved" || granted.OptionID != "allow_once" {
		t.Fatalf("an uncontested edit inside the project is auto-approved: %+v", granted)
	}
	// The same file through an absolute path is the same file.
	contested := requestEdit(t, store, second, secondLease, "edit-2", filepath.Join(root, "src", "model.py"))
	if contested.State != "pending" || !strings.Contains(contested.PolicyReason, first.ID) {
		t.Fatalf("a path an open Run is editing must wait for a person: %+v", contested)
	}
	// The person declines; the Run goes on.
	if _, err := store.db.Exec(`UPDATE permissions SET state = 'resolved', option_id = 'reject_once' WHERE id = ?`, contested.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE runs SET status = 'running' WHERE id = ?`, second.ID); err != nil {
		t.Fatal(err)
	}
	other := requestEdit(t, store, second, secondLease, "edit-3", "src/other.py")
	if other.State != "resolved" {
		t.Fatalf("other paths are unaffected: %+v", other)
	}
	// Once the first Run is no longer open, the path is free again.
	if _, err := store.db.Exec(`UPDATE runs SET status = 'completed' WHERE id = ?`, first.ID); err != nil {
		t.Fatal(err)
	}
	again := requestEdit(t, store, second, secondLease, "edit-4", "src/model.py")
	if again.State != "resolved" || again.PolicyReason == "" {
		t.Fatalf("a finished Run no longer holds its paths: %+v", again)
	}
}
