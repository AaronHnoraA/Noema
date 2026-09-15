package research

import (
	"strings"
	"testing"
)

func promoteNamedTestSession(t *testing.T, store *Store, root, native, workstreamID string) Session {
	t.Helper()
	session, err := store.PromoteSession(PromoteSessionInput{
		Title: "Named session test", WorkstreamID: workstreamID, Adapter: "codex", Transport: "acp",
		NativeSessionID: native, ExecutionTarget: root,
	})
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func preparePromptRun(t *testing.T, store *Store, root, workstreamID, sessionID string, intent *SessionNameIntent) (Run, error) {
	t.Helper()
	return store.PrepareRun(PrepareRunInput{
		WorkstreamID: workstreamID, SessionID: sessionID, SourceKind: "prompt-file", ExecutionTarget: root,
		Spec: map[string]any{"schema": "noema.run-spec/1", "prompt": "Explore"}, SessionName: intent,
	})
}

func TestFreshRunBindsItsSessionNameWhenAttached(t *testing.T) {
	store, root := openTestStore(t)
	origin := promoteNamedTestSession(t, store, root, "native-origin", "")
	intent := &SessionNameIntent{Name: "baseline", Agent: "codex", Origin: "derived"}
	run, err := preparePromptRun(t, store, root, origin.WorkstreamID, "", intent)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetSessionName("baseline"); err == nil {
		t.Fatal("a fresh Run must not bind its name before a session exists")
	}
	fresh := promoteNamedTestSession(t, store, root, "native-fresh", origin.WorkstreamID)
	lease, err := store.AcquireLease(AcquireLeaseInput{SessionID: fresh.ID, Owner: "emacs:test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AttachRunToSession(AttachRunInput{SessionID: fresh.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID}); err != nil {
		t.Fatal(err)
	}
	name, err := store.GetSessionName("baseline")
	if err != nil {
		t.Fatal(err)
	}
	if name.SessionID != fresh.ID || name.Generation != 1 || name.NativeSessionID != "native-fresh" || !name.OpenRun {
		t.Fatalf("unexpected bound name: %+v", name)
	}
}

func TestNamedSessionServesOtherWorkstreamsButAnonymousDoesNot(t *testing.T) {
	store, root := openTestStore(t)
	named := promoteNamedTestSession(t, store, root, "native-named", "")
	anonymous := promoteNamedTestSession(t, store, root, "native-anonymous", "")
	other := promoteNamedTestSession(t, store, root, "native-other", "")
	intent := &SessionNameIntent{Name: "shared", Agent: "codex", Origin: "user"}
	first, err := preparePromptRun(t, store, root, named.WorkstreamID, named.ID, intent)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.FailPreparedRun(FailPreparedRunInput{RunID: first.ID, FailureReason: "test"}); err != nil {
		t.Fatal(err)
	}
	if _, err := preparePromptRun(t, store, root, other.WorkstreamID, named.ID, intent); err != nil {
		t.Fatalf("named session should serve another workstream: %v", err)
	}
	if _, err := preparePromptRun(t, store, root, other.WorkstreamID, anonymous.ID, nil); err == nil {
		t.Fatal("anonymous session must stay inside its workstream")
	}
}

func TestSessionNameRulesProtectUserBindings(t *testing.T) {
	store, root := openTestStore(t)
	session := promoteNamedTestSession(t, store, root, "native-rules", "")
	if _, err := preparePromptRun(t, store, root, session.WorkstreamID, session.ID,
		&SessionNameIntent{Name: "主线", Agent: "codex", Origin: "user"}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"fresh", "a:b", "", "x y", "-lead"} {
		if _, err := store.DeclareSessionName(SessionNameIntent{Name: bad, Agent: "codex", Origin: "user"}); err == nil {
			t.Fatalf("name %q should be rejected", bad)
		}
	}
	if _, err := store.DeclareSessionName(SessionNameIntent{Name: "pi", Agent: "pi", Origin: "user"}); err == nil {
		t.Fatal("pi is reserved for the coordinator")
	}
	if _, err := store.DeclareSessionName(SessionNameIntent{Name: "主线", Agent: "claude", Origin: "user"}); err == nil ||
		!strings.Contains(err.Error(), "belongs to agent codex") {
		t.Fatalf("agent conflict should be explicit, got %v", err)
	}
	if _, err := store.RenameSessionName(RenameSessionNameInput{Name: "主线", NewName: "baseline", Actor: "pi"}); err == nil {
		t.Fatal("Pi must not rename a user-pinned name")
	}
	if _, err := store.ArchiveSessionName(ArchiveSessionNameInput{Name: "主线", Archived: true, Actor: "pi"}); err == nil {
		t.Fatal("Pi must not archive a user-pinned name")
	}
	renamed, err := store.RenameSessionName(RenameSessionNameInput{Name: "主线", NewName: "baseline", Actor: "emacs"})
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Name != "baseline" || len(renamed.Aliases) != 1 || renamed.Aliases[0] != "主线" {
		t.Fatalf("rename should keep the old spelling as alias: %+v", renamed)
	}
	viaAlias, err := store.GetSessionName("主线")
	if err != nil || viaAlias.Name != "baseline" || viaAlias.SessionID != session.ID {
		t.Fatalf("alias should resolve to the renamed session: %+v %v", viaAlias, err)
	}
	child, err := store.DeclareSessionName(SessionNameIntent{Name: "ablation", Agent: "codex", ParentName: "主线", ForkMode: "reconstructed", Origin: "pi"})
	if err != nil {
		t.Fatal(err)
	}
	if child.ParentName != "baseline" || child.SessionID != "" || child.Origin != "pi" {
		t.Fatalf("declared child should resolve its parent alias and stay unbound: %+v", child)
	}
	if _, err := store.ArchiveSessionName(ArchiveSessionNameInput{Name: "ablation", Archived: true, Actor: "pi"}); err != nil {
		t.Fatalf("Pi may archive a name it created: %v", err)
	}
	active, err := store.ListSessionNames(false)
	if err != nil || len(active) != 1 || active[0].Name != "baseline" {
		t.Fatalf("archived names should be hidden by default: %+v %v", active, err)
	}
	if _, err := store.DeclareSessionName(SessionNameIntent{Name: "baseline", Agent: "codex", Origin: "derived"}); err != nil {
		t.Fatal(err)
	}
	if kept, _ := store.GetSessionName("baseline"); kept.Origin != "user" {
		t.Fatalf("a lower-authority declaration must not downgrade origin: %+v", kept)
	}
}
