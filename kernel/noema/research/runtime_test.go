package research

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func promoteRuntimeSession(t *testing.T, store *Store, root string) Session {
	t.Helper()
	session, err := store.PromoteSession(PromoteSessionInput{
		Title:           "Runtime test",
		Adapter:         "magent",
		Transport:       "acp",
		NativeSessionID: "native-runtime-test",
		ExecutionTarget: root,
	})
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func prepareRuntimeRun(t *testing.T, store *Store, session Session, root string) Run {
	t.Helper()
	run, err := store.PrepareRun(PrepareRunInput{
		WorkstreamID: session.WorkstreamID, SessionID: session.ID,
		NotebookID: "nb_runtime", CellID: "c-work", WorkNodeID: "wn_runtime", SourceKind: "work-cell", ExecutionTarget: root,
		Spec: map[string]any{
			"schema": "noema.runspec/1", "prompt": "Investigate the invariant", "capabilities": map[string]any{"network": false},
		},
		ContextItems: []ContextItemInput{{
			Ref: "file:notes/context.md", ResolvedURI: "noema://context/file/notes/context.md",
			MediaType: "text/markdown", ContentBase64: base64.StdEncoding.EncodeToString([]byte("Known fact.")),
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return run
}

func TestRunLifecycleUsesCASLeaseAndVersionedPermissions(t *testing.T) {
	store, root := openTestStore(t)
	session := promoteRuntimeSession(t, store, root)
	run := prepareRuntimeRun(t, store, session, root)
	if run.Status != "preparing" || run.WorkNodeID != "wn_runtime" || run.SpecArtifactID == "" || run.ContextArtifactID == "" {
		t.Fatalf("prepared run is incomplete: %+v", run)
	}
	fileArtifact, err := store.ImportArtifact(ImportArtifactInput{
		Kind: "run-file", MediaType: "text/plain; charset=utf-8",
		ContentBase64: base64.StdEncoding.EncodeToString([]byte("ordinary project artifact")),
		RunID:         run.ID, SourceURI: "noema://file/notes/result.md", Metadata: map[string]any{"change": "created"},
	})
	if err != nil {
		t.Fatalf("associate ordinary artifact with Run: %v", err)
	}
	links, err := store.ListArtifactLinks(ArtifactLinkFilter{WorkNodeID: run.WorkNodeID})
	if err != nil || len(links) != 1 || links[0].Artifact.ID != fileArtifact.ID ||
		links[0].RunID != run.ID || links[0].CellID != run.CellID || links[0].Relation != "created" {
		t.Fatalf("artifact provenance was not queryable by WorkNode: %+v (%v)", links, err)
	}
	var digest string
	if err := store.db.QueryRow(`SELECT sha256 FROM artifacts WHERE id = ?`, run.SpecArtifactID).Scan(&digest); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, StateDirName, "objects", "sha256", digest[:2], digest[2:])); err != nil {
		t.Fatalf("runspec must be stored in CAS: %v", err)
	}
	_, specBytes, err := store.ReadArtifact(run.SpecArtifactID)
	if err != nil {
		t.Fatal(err)
	}
	var frozenSpec map[string]any
	if err := json.Unmarshal(specBytes, &frozenSpec); err != nil {
		t.Fatal(err)
	}
	if frozenSpec["run_id"] != run.ID || !strings.HasPrefix(frozenSpec["context_manifest"].(string), "cas:sha256:") {
		t.Fatalf("stored RunSpec must contain its identity and manifest CAS ref: %s", specBytes)
	}
	var manifestDigest string
	if err := store.db.QueryRow(`SELECT sha256 FROM artifacts WHERE id = ?`, run.ContextArtifactID).Scan(&manifestDigest); err != nil {
		t.Fatal(err)
	}
	manifestBytes, err := os.ReadFile(filepath.Join(root, StateDirName, "objects", "sha256", manifestDigest[:2], manifestDigest[2:]))
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatal(err)
	}
	items, _ := manifest["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["artifact_id"] == "" {
		t.Fatalf("context manifest must reference a frozen content object: %s", manifestBytes)
	}
	contextID, _ := items[0].(map[string]any)["artifact_id"].(string)
	contextArtifact, contextBytes, err := store.ReadArtifact(contextID)
	if err != nil || contextArtifact.Kind != "context-item" || string(contextBytes) != "Known fact." {
		t.Fatalf("frozen context must be retrievable with integrity: %+v %q (%v)", contextArtifact, contextBytes, err)
	}

	lease, err := store.AcquireLease(AcquireLeaseInput{SessionID: session.ID, Owner: "emacs:one"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AcquireLease(AcquireLeaseInput{SessionID: session.ID, Owner: "emacs:two"}); err == nil {
		t.Fatal("a live lease must exclude another worker")
	}
	started, err := store.StartRun(StartRunInput{SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID})
	if err != nil || started.Status != "running" || started.StartedAt == "" {
		t.Fatalf("start failed: %+v (%v)", started, err)
	}
	permission, err := store.RequestPermission(RequestPermissionInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID, NativeRequestID: "acp-request-1",
		Action:  map[string]any{"kind": "edit", "paths": []any{"notes/result.md"}},
		Options: []map[string]any{{"optionId": "allow_once", "label": "Allow once"}, {"optionId": "reject_once", "label": "Reject"}},
	})
	if err != nil || permission.State != "pending" || permission.Version != 1 {
		t.Fatalf("permission request failed: %+v (%v)", permission, err)
	}
	if _, err := store.RequestPermission(RequestPermissionInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID, NativeRequestID: "acp-request-1",
		Action: map[string]any{"kind": "edit", "paths": []any{"notes/changed-after-approval.md"}}, Options: permission.Options,
	}); err == nil || !stringsContains(err.Error(), "different action") {
		t.Fatalf("changed toolCall content must become a new native permission request, got %v", err)
	}
	if loaded, err := store.GetRun(run.ID); err != nil || loaded.Status != "waiting_permission" {
		t.Fatalf("request must pause run: %+v (%v)", loaded, err)
	}
	if _, err := store.DecidePermission(DecidePermissionInput{PermissionID: permission.ID, OptionID: "allow_once", ExpectedVersion: 2, DecidedBy: "user"}); err == nil {
		t.Fatal("stale permission decision must be rejected")
	}
	resolved, err := store.DecidePermission(DecidePermissionInput{PermissionID: permission.ID, OptionID: "allow_once", ExpectedVersion: 1, DecidedBy: "user"})
	if err != nil || resolved.State != "resolved" || resolved.Version != 2 {
		t.Fatalf("permission decision failed: %+v (%v)", resolved, err)
	}
	if _, err := store.DecidePermission(DecidePermissionInput{PermissionID: permission.ID, OptionID: "reject_once", ExpectedVersion: 1, DecidedBy: "attention"}); err == nil {
		t.Fatal("a concurrent second decision must lose after the first resolution")
	}
	events, err := store.ReportWorkerEvents(ReportWorkerEventsInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID,
		Events: []WorkerEvent{
			{Type: "run.output", Payload: map[string]any{"stream": "assistant", "text": "Found a counterexample."}},
			{Type: "run.status.changed", Payload: map[string]any{"status": "completed"}},
		},
	})
	if err != nil || len(events) != 2 {
		t.Fatalf("worker events failed: %+v (%v)", events, err)
	}
	finished, err := store.GetRun(run.ID)
	if err != nil || finished.Status != "completed" || finished.FinishedAt == "" {
		t.Fatalf("run completion not durable: %+v (%v)", finished, err)
	}
	all, err := store.Events("", 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) < 6 {
		t.Fatalf("expected lifecycle audit events, got %d", len(all))
	}
	for _, event := range all {
		if event.RunID == run.ID && event.WorkNodeID != run.WorkNodeID {
			t.Fatalf("Run event lost stable WorkNode identity: %+v", event)
		}
	}
}

func TestRunArtifactDeduplicatesAndOldWorkerCannotAdvance(t *testing.T) {
	store, root := openTestStore(t)
	session := promoteRuntimeSession(t, store, root)
	first := prepareRuntimeRun(t, store, session, root)
	second, err := store.PrepareRun(PrepareRunInput{
		WorkstreamID: session.WorkstreamID,
		NotebookID:   "nb_runtime", CellID: "c-work-2", WorkNodeID: "wn_runtime", SourceKind: "work-cell", ExecutionTarget: root,
		Spec: map[string]any{"schema": "noema.runspec/1", "prompt": "Investigate the invariant", "capabilities": map[string]any{"network": false}},
		ContextItems: []ContextItemInput{{
			Ref: "file:notes/context.md", ResolvedURI: "noema://context/file/notes/context.md",
			MediaType: "text/markdown", ContentBase64: base64.StdEncoding.EncodeToString([]byte("Known fact.")),
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.SpecArtifactID == second.SpecArtifactID || first.ContextArtifactID != second.ContextArtifactID {
		t.Fatalf("Run identity makes specs unique while identical manifests must deduplicate: %q %q / %q %q", first.SpecArtifactID, second.SpecArtifactID, first.ContextArtifactID, second.ContextArtifactID)
	}
	firstLease, err := store.AcquireLease(AcquireLeaseInput{SessionID: session.ID, Owner: "emacs:one"})
	if err != nil {
		t.Fatal(err)
	}
	secondLease, err := store.AcquireLease(AcquireLeaseInput{SessionID: session.ID, Owner: "emacs:one"})
	if err != nil || secondLease.Epoch <= firstLease.Epoch {
		t.Fatalf("reacquisition must fence the old worker: %+v (%v)", secondLease, err)
	}
	_, err = store.StartRun(StartRunInput{SessionID: session.ID, Owner: firstLease.Owner, Epoch: firstLease.Epoch, RunID: first.ID})
	if err == nil || !stringsContains(err.Error(), "stale lease") {
		t.Fatalf("old epoch must not start a run, got %v", err)
	}
	if _, err := store.StartRun(StartRunInput{SessionID: session.ID, Owner: secondLease.Owner, Epoch: secondLease.Epoch, RunID: first.ID}); err != nil {
		t.Fatal(err)
	}
}

func TestRunCancellationRecordsIntentButNeverFakesThePhysicalOutcome(t *testing.T) {
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
	permission, err := store.RequestPermission(RequestPermissionInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID, NativeRequestID: "cancel-pending",
		Action:  map[string]any{"kind": "execute", "argv": []any{"go", "test"}},
		Options: []map[string]any{{"optionId": "allow_once"}, {"optionId": "reject_once"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	requested, err := store.RequestRunCancellation(CancelRunInput{RunID: run.ID, RequestedBy: "web"})
	if err != nil || requested.Status != "waiting_permission" {
		t.Fatalf("cancellation must retain observed non-terminal state: %+v (%v)", requested, err)
	}
	if _, err := store.RequestRunCancellation(CancelRunInput{RunID: run.ID, RequestedBy: "web"}); err != nil {
		t.Fatalf("repeated cancellation must be idempotent: %v", err)
	}
	var count int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM events WHERE run_id = ? AND type = 'run.cancel.requested'`, run.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("cancellation intent must be recorded once: %d (%v)", count, err)
	}
	if _, err := store.ReportWorkerEvents(ReportWorkerEventsInput{SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID,
		Events: []WorkerEvent{{Type: "run.status.changed", Payload: map[string]any{"status": "cancelled"}}}}); err != nil {
		t.Fatal(err)
	}
	if loaded, err := store.GetRun(run.ID); err != nil || loaded.Status != "cancelled" || loaded.FinishedAt == "" {
		t.Fatalf("only worker observation can make cancellation terminal: %+v (%v)", loaded, err)
	}
	if loaded, err := store.GetPermission(permission.ID); err != nil || loaded.State != "expired" {
		t.Fatalf("terminal Run must remove pending permission from Attention: %+v (%v)", loaded, err)
	}
}

func TestTerminalOutputCreatesHandoffArtifactAndLiveSnapshot(t *testing.T) {
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
	events, err := store.ReportWorkerEvents(ReportWorkerEventsInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID,
		Events: []WorkerEvent{{Type: "run.status.changed", Payload: map[string]any{
			"status": "completed", "result_text": "A concise handoff.", "transcript_text": "Complete assistant stream.",
		}}},
	})
	if err != nil || len(events) != 3 || events[0].Type != "artifact.created" || events[1].Type != "artifact.created" || events[2].Type != "run.status.changed" {
		t.Fatalf("terminal report must create handoff plus status events: %+v (%v)", events, err)
	}
	handoffID, _ := events[2].Payload["handoff_artifact_id"].(string)
	artifact, data, err := store.ReadArtifact(handoffID)
	if err != nil || artifact.Kind != "handoff" || string(data) != "A concise handoff." {
		t.Fatalf("handoff must be immutable and readable: %+v %q (%v)", artifact, data, err)
	}
	transcriptID, _ := events[2].Payload["transcript_artifact_id"].(string)
	transcript, transcriptData, err := store.ReadArtifact(transcriptID)
	if err != nil || transcript.Kind != "transcript" || string(transcriptData) != "Complete assistant stream." {
		t.Fatalf("transcript must be immutable and readable: %+v %q (%v)", transcript, transcriptData, err)
	}
	if _, leaked := events[2].Payload["result_text"]; leaked {
		t.Fatal("large handoff bytes belong in CAS, not the event ledger")
	}
	if _, leaked := events[2].Payload["transcript_text"]; leaked {
		t.Fatal("transcript bytes belong in CAS, not the event ledger")
	}
	live, err := store.LiveRun(run.ID, 0, 100)
	if err != nil || live.Run.Status != "completed" || live.Seq == 0 || len(live.Events) < 4 {
		t.Fatalf("live snapshot is incomplete: %+v (%v)", live, err)
	}
	tail, err := store.LiveRun(run.ID, live.Seq, 100)
	if err != nil || len(tail.Events) != 0 || tail.Seq != live.Seq {
		t.Fatalf("live cursor must be stable at the tail: %+v (%v)", tail, err)
	}
}

func TestExpiredLeaseInterruptsRunAndExpiresPermission(t *testing.T) {
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
	permission, err := store.RequestPermission(RequestPermissionInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID, NativeRequestID: "acp-request-2",
		Action: map[string]any{"kind": "edit"}, Options: []map[string]any{{"optionId": "allow_once"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE leases SET expires_at = 0 WHERE session_id = ?`, session.ID); err != nil {
		t.Fatal(err)
	}
	interrupted, err := store.ExpireLeases()
	if err != nil || len(interrupted) != 1 || interrupted[0].ID != run.ID || interrupted[0].Status != "interrupted" {
		t.Fatalf("lease expiry recovery failed: %+v (%v)", interrupted, err)
	}
	if loaded, err := store.GetPermission(permission.ID); err != nil || loaded.State != "expired" {
		t.Fatalf("pending permission must expire with worker: %+v (%v)", loaded, err)
	}
	if _, err := store.RenewLease(RenewLeaseInput{SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch}); err == nil {
		t.Fatal("expired deleted lease must not renew")
	}
}

func TestPermissionPolicyHardDeniesAndRememberedRules(t *testing.T) {
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
	options := []map[string]any{{"optionId": "allow_once"}, {"optionId": "reject_once"}}
	hardDenied, err := store.RequestPermission(RequestPermissionInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID, NativeRequestID: "fetch-1",
		Action: map[string]any{"kind": "fetch", "network": true}, Options: options,
	})
	if err != nil || hardDenied.State != "resolved" || hardDenied.OptionID != "reject_once" || hardDenied.DecidedBy != "policy" {
		t.Fatalf("network must be immediately denied: %+v (%v)", hardDenied, err)
	}
	first, err := store.RequestPermission(RequestPermissionInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID, NativeRequestID: "edit-1",
		Action: map[string]any{"kind": "edit", "paths": []any{"notes/result.md"}}, Options: []map[string]any{{"optionId": "allow_always"}, {"optionId": "reject_once"}},
	})
	if err != nil || first.State != "pending" {
		t.Fatalf("ordinary project edit must ask first: %+v (%v)", first, err)
	}
	if _, err := store.DecidePermission(DecidePermissionInput{PermissionID: first.ID, OptionID: "allow_always", ExpectedVersion: first.Version, DecidedBy: "user"}); err != nil {
		t.Fatal(err)
	}
	var rules int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM permission_rules WHERE scope = 'session' AND scope_id = ? AND effect = 'allow'`, session.ID).Scan(&rules); err != nil || rules != 1 {
		t.Fatalf("allow_always must create a narrow session rule: %d (%v)", rules, err)
	}
	autoAllowed, err := store.RequestPermission(RequestPermissionInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID, NativeRequestID: "edit-2",
		Action: map[string]any{"kind": "edit", "paths": []any{"notes/result.md"}}, Options: options,
	})
	if err != nil || autoAllowed.State != "resolved" || autoAllowed.OptionID != "allow_once" || !strings.HasPrefix(autoAllowed.DecidedBy, "policy-rule:") {
		t.Fatalf("matching remembered decision must be automatic: %+v (%v)", autoAllowed, err)
	}
	outside, err := store.RequestPermission(RequestPermissionInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID, NativeRequestID: "outside-1",
		Action: map[string]any{"kind": "edit", "paths": []any{"../outside.md"}}, Options: options,
	})
	if err != nil || outside.OptionID != "reject_once" || outside.DecidedBy != "policy" {
		t.Fatalf("outside-project write must be denied even with allow rule: %+v (%v)", outside, err)
	}
}

func TestWorkerCanAttachPreDispatchRunAfterCreatingSession(t *testing.T) {
	store, root := openTestStore(t)
	session := promoteRuntimeSession(t, store, root)
	run, err := store.PrepareRun(PrepareRunInput{
		WorkstreamID: session.WorkstreamID, NotebookID: "nb_runtime", CellID: "c-fresh", WorkNodeID: "wn_fresh", SourceKind: "work-cell", ExecutionTarget: root,
		Spec: map[string]any{"schema": "noema.runspec/1", "prompt": "Fresh session"},
	})
	if err != nil || run.SessionID != "" {
		t.Fatalf("pre-dispatch run must exist before session attachment: %+v (%v)", run, err)
	}
	lease, err := store.AcquireLease(AcquireLeaseInput{SessionID: session.ID, Owner: "emacs:fresh"})
	if err != nil {
		t.Fatal(err)
	}
	attached, err := store.AttachRunToSession(AttachRunInput{SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID})
	if err != nil || attached.SessionID != session.ID || attached.Version != 2 {
		t.Fatalf("worker could not attach pre-dispatch run: %+v (%v)", attached, err)
	}
	if _, err := store.StartRun(StartRunInput{SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID}); err != nil {
		t.Fatal(err)
	}
}

func TestOneOpenRunPerSessionIsAStorageInvariant(t *testing.T) {
	store, root := openTestStore(t)
	session := promoteRuntimeSession(t, store, root)
	_ = prepareRuntimeRun(t, store, session, root)
	_, err := store.PrepareRun(PrepareRunInput{
		WorkstreamID: session.WorkstreamID, SessionID: session.ID,
		NotebookID: "nb_runtime", CellID: "c-second", WorkNodeID: "wn_second", SourceKind: "work-cell", ExecutionTarget: root,
		Spec: map[string]any{"schema": "noema.runspec/1", "prompt": "Second open run"},
	})
	if err == nil {
		t.Fatal("the database must reject a second unfinished Run for one Session")
	}
}

func TestFailPreparedRunReleasesOpenSlotWithoutInventingExecution(t *testing.T) {
	store, root := openTestStore(t)
	session := promoteRuntimeSession(t, store, root)
	run := prepareRuntimeRun(t, store, session, root)
	failed, err := store.FailPreparedRun(FailPreparedRunInput{
		RunID: run.ID, FailureReason: "ACP configuration unavailable",
	})
	if err != nil || failed.Status != "failed" || failed.StartedAt != "" || failed.FinishedAt == "" || failed.FailureReason == "" {
		t.Fatalf("prepared failure must be terminal without claiming execution: %+v (%v)", failed, err)
	}
	if again, err := store.FailPreparedRun(FailPreparedRunInput{RunID: run.ID, FailureReason: "retry after lost response"}); err != nil || again.ID != run.ID {
		t.Fatalf("prepared failure retry must be idempotent: %+v (%v)", again, err)
	}
	if _, err := store.PrepareRun(PrepareRunInput{
		WorkstreamID: session.WorkstreamID, SessionID: session.ID, NotebookID: "nb_runtime", CellID: "c-next", WorkNodeID: "wn_next",
		SourceKind: "work-cell", ExecutionTarget: root,
		Spec: map[string]any{"schema": "noema.run-spec/1", "prompt": "Next run"},
	}); err != nil {
		t.Fatalf("failed preparation must release the session slot: %v", err)
	}
	var events int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM events WHERE run_id = ? AND type = 'run.status.changed'`, run.ID).Scan(&events); err != nil || events != 1 {
		t.Fatalf("prepared failure must emit exactly one terminal event: %d (%v)", events, err)
	}
}

func TestAttentionIsDerivedFromPendingPermissionsAndInputRuns(t *testing.T) {
	store, root := openTestStore(t)
	session := promoteRuntimeSession(t, store, root)
	run := prepareRuntimeRun(t, store, session, root)
	lease, err := store.AcquireLease(AcquireLeaseInput{SessionID: session.ID, Owner: "emacs:attention"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartRun(StartRunInput{SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID}); err != nil {
		t.Fatal(err)
	}
	permission, err := store.RequestPermission(RequestPermissionInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID, NativeRequestID: "attention-1",
		Action:  map[string]any{"kind": "edit", "paths": []any{"notes/result.md"}},
		Options: []map[string]any{{"optionId": "allow_once"}, {"optionId": "reject_once"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	attention, err := store.ListAttention()
	if err != nil || len(attention.Permissions) != 1 || attention.Permissions[0].ID != permission.ID || len(attention.InputRuns) != 0 {
		t.Fatalf("pending permission missing from Attention: %+v (%v)", attention, err)
	}
	if _, err := store.DecidePermission(DecidePermissionInput{
		PermissionID: permission.ID, OptionID: "allow_once", ExpectedVersion: permission.Version, DecidedBy: "attention",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportWorkerEvents(ReportWorkerEventsInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID,
		Events: []WorkerEvent{{Type: "run.input_required", Payload: map[string]any{"status": "waiting_input", "request_id": "input-1"}}},
	}); err != nil {
		t.Fatal(err)
	}
	// An input request is an event plus an explicit status transition. Keep the
	// state fact separate so projections never infer lifecycle from wording.
	if _, err := store.ReportWorkerEvents(ReportWorkerEventsInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID,
		Events: []WorkerEvent{{Type: "run.status.changed", Payload: map[string]any{"status": "waiting_input"}}},
	}); err != nil {
		t.Fatal(err)
	}
	attention, err = store.ListAttention()
	if err != nil || len(attention.Permissions) != 0 || len(attention.InputRuns) != 1 || attention.InputRuns[0].ID != run.ID {
		t.Fatalf("Attention projection did not follow authoritative states: %+v (%v)", attention, err)
	}
}

func TestStructuredInputRoundTripAndTerminalExpiry(t *testing.T) {
	store, root := openTestStore(t)
	session := promoteRuntimeSession(t, store, root)
	run := prepareRuntimeRun(t, store, session, root)
	lease, err := store.AcquireLease(AcquireLeaseInput{SessionID: session.ID, Owner: "emacs:input"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartRun(StartRunInput{SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID}); err != nil {
		t.Fatal(err)
	}
	request, err := store.RequestInput(RequestInputInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID,
		NativeRequestID: "native-input-1", Prompt: "Choose a proof strategy", InputKind: "select",
		Options: []map[string]any{{"id": "spectral", "label": "Spectral"}, {"id": "direct", "label": "Direct"}},
	})
	if err != nil || request.State != "pending" || request.Epoch != lease.Epoch {
		t.Fatalf("unexpected input request: %+v (%v)", request, err)
	}
	if loaded, err := store.GetRun(run.ID); err != nil || loaded.Status != "waiting_input" {
		t.Fatalf("input request must pause the Run: %+v (%v)", loaded, err)
	}
	attention, err := store.ListAttention()
	if err != nil || len(attention.InputRequests) != 1 || attention.InputRequests[0].ID != request.ID || len(attention.InputRuns) != 1 {
		t.Fatalf("structured input missing from Attention: %+v (%v)", attention, err)
	}
	answer := map[string]any{"choice": "spectral", "note": "use the compact proof"}
	resolved, err := store.RespondInput(RespondInputInput{RunID: run.ID, RequestID: request.ID, Answer: answer, AnsweredBy: "mobile"})
	if err != nil || resolved.State != "resolved" || resolved.Version != 2 || resolved.Epoch != lease.Epoch {
		t.Fatalf("unexpected input response: %+v (%v)", resolved, err)
	}
	if loaded, err := store.GetRun(run.ID); err != nil || loaded.Status != "running" {
		t.Fatalf("input response must resume the Run: %+v (%v)", loaded, err)
	}
	if _, err := store.RespondInput(RespondInputInput{RunID: run.ID, RequestID: request.ID, Answer: "again", AnsweredBy: "web"}); err == nil {
		t.Fatal("a second input response must conflict")
	}

	pending, err := store.RequestInput(RequestInputInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID,
		NativeRequestID: "native-input-2", Prompt: "Add a final note?", InputKind: "confirm",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportWorkerEvents(ReportWorkerEventsInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID,
		Events: []WorkerEvent{{Type: "run.status.changed", Payload: map[string]any{"status": "completed"}}},
	}); err != nil {
		t.Fatal(err)
	}
	if loaded, err := store.GetInputRequest(pending.ID); err != nil || loaded.State != "expired" {
		t.Fatalf("terminal Run must expire pending input: %+v (%v)", loaded, err)
	}
}

func TestPermissionDecisionRejectsAChangedWorkerEpoch(t *testing.T) {
	store, root := openTestStore(t)
	session := promoteRuntimeSession(t, store, root)
	run := prepareRuntimeRun(t, store, session, root)
	first, err := store.AcquireLease(AcquireLeaseInput{SessionID: session.ID, Owner: "emacs:old"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartRun(StartRunInput{SessionID: session.ID, Owner: first.Owner, Epoch: first.Epoch, RunID: run.ID}); err != nil {
		t.Fatal(err)
	}
	permission, err := store.RequestPermission(RequestPermissionInput{
		SessionID: session.ID, Owner: first.Owner, Epoch: first.Epoch, RunID: run.ID, NativeRequestID: "epoch-permission",
		Action:  map[string]any{"kind": "edit", "paths": []any{"notes/proof.md"}},
		Options: []map[string]any{{"optionId": "allow_once"}, {"optionId": "reject_once"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE leases SET expires_at = 0 WHERE session_id = ?`, session.ID); err != nil {
		t.Fatal(err)
	}
	second, err := store.AcquireLease(AcquireLeaseInput{SessionID: session.ID, Owner: "emacs:new"})
	if err != nil || second.Epoch == first.Epoch {
		t.Fatalf("expected a new lease epoch: %+v (%v)", second, err)
	}
	if _, err := store.DecidePermission(DecidePermissionInput{
		PermissionID: permission.ID, OptionID: "allow_once", ExpectedVersion: permission.Version, DecidedBy: "mobile",
	}); err == nil || !strings.Contains(err.Error(), "stale lease epoch") {
		t.Fatalf("old epoch permission decision must be rejected, got %v", err)
	}
	if loaded, err := store.GetPermission(permission.ID); err != nil || loaded.State != "pending" {
		t.Fatalf("rejected decision must not mutate permission: %+v (%v)", loaded, err)
	}
}

func stringsContains(value, needle string) bool { return strings.Contains(value, needle) }
