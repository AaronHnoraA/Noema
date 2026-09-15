package research

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoordinatorRequestsAreClaimedExactlyOnce(t *testing.T) {
	store, _ := openTestStore(t)
	if _, err := store.CreateCoordinatorRequest("dag.edit", nil, "pi"); err == nil {
		t.Fatal("only run.start and session control requests are allowed")
	}
	created, err := store.CreateCoordinatorRequest("run.start", map[string]any{"cellId": "c-1"}, "pi")
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"session.cancel", "session.close"} {
		if _, err := store.CreateCoordinatorRequest(kind, map[string]any{"name": "baseline"}, "pi"); err != nil {
			t.Fatalf("%s should be accepted: %v", kind, err)
		}
	}
	claimed, err := store.ClaimCoordinatorRequests("emacs:1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != 3 || claimed[0].ID != created.ID || claimed[0].State != "claimed" || claimed[0].Payload["cellId"] != "c-1" {
		t.Fatalf("unexpected claim: %+v", claimed)
	}
	again, err := store.ClaimCoordinatorRequests("emacs:2", 10)
	if err != nil || len(again) != 0 {
		t.Fatalf("a claimed request must not be delivered twice: %+v %v", again, err)
	}
}

func TestCoordinatorRequestKindsMigrateFromV18(t *testing.T) {
	db, err := sql.Open("sqlite3", filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	v18 := strings.Replace(coordinatorRequestsTable, "'run.start', 'session.cancel', 'session.close'", "'run.start'", 1)
	if v18 == coordinatorRequestsTable {
		t.Fatal("test must build the v18 table")
	}
	if _, err := db.Exec(v18); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO coordinator_requests(id, kind, payload_json, actor, state, created_at)
		VALUES('creq_old', 'run.start', '{}', 'pi', 'pending', 1)`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := migrateCoordinatorRequestKinds(db); err != nil {
			t.Fatalf("migration must be idempotent: %v", err)
		}
	}
	if _, err := db.Exec(`INSERT INTO coordinator_requests(id, kind, payload_json, actor, state, created_at)
		VALUES('creq_new', 'session.close', '{}', 'pi', 'pending', 2)`); err != nil {
		t.Fatalf("v19 must accept session.close: %v", err)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM coordinator_requests`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("migration must keep existing requests: %d %v", count, err)
	}
}

func TestRunProjectionCarriesItsSessionName(t *testing.T) {
	store, root := openTestStore(t)
	session := promoteNamedTestSession(t, store, root, "native-projection", "")
	run, err := preparePromptRun(t, store, root, session.WorkstreamID, session.ID,
		&SessionNameIntent{Name: "baseline", Agent: "codex", Origin: "derived"})
	if err != nil {
		t.Fatal(err)
	}
	runs, err := store.ListRuns(RunFilter{SessionID: session.ID})
	if err != nil || len(runs) != 1 || runs[0].ID != run.ID || runs[0].SessionName != "baseline" {
		t.Fatalf("run projection should carry its session name: %+v %v", runs, err)
	}
	pi := promoteNamedTestSession(t, store, root, "native-pi", "")
	if _, err := store.BindSessionName(SessionNameIntent{Name: "helper", Agent: "codex", Origin: "system"}, pi.ID); err == nil {
		t.Fatal("system origin is reserved for the pi name")
	}
	bound, err := store.BindSessionName(SessionNameIntent{Name: PiSessionName, Origin: "system"}, pi.ID)
	if err != nil || bound.SessionID != pi.ID || bound.Agent != "codex" || bound.Origin != "system" {
		t.Fatalf("pi coordinator name should bind to its promoted session: %+v %v", bound, err)
	}
}
