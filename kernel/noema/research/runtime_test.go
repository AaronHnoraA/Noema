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

func TestListRunsLatestPerWorkNodeKeepsOldConversationsReachable(t *testing.T) {
	store, root := openTestStore(t)
	prepare := func(native, workNode string, withSession bool) Run {
		t.Helper()
		session, err := store.PromoteSession(PromoteSessionInput{Title: native, Adapter: "magent", Transport: "acp",
			NativeSessionID: native, ExecutionTarget: root})
		if err != nil {
			t.Fatal(err)
		}
		input := PrepareRunInput{WorkstreamID: session.WorkstreamID, NotebookID: "nb_latest", CellID: "c-" + workNode,
			WorkNodeID: workNode, SourceKind: "work-cell", ExecutionTarget: root,
			Spec: map[string]any{"schema": "noema.run-spec/1"}}
		if withSession {
			input.SessionID = session.ID
		}
		run, err := store.PrepareRun(input)
		if err != nil {
			t.Fatal(err)
		}
		return run
	}
	older := prepare("native-a-old", "wn_a", true)
	newer := prepare("native-a-new", "wn_a", true)
	branch := prepare("native-b", "wn_b", true)
	// A Run that never reached a conversation must not hide the one before it.
	prepare("native-a-fresh", "wn_a", false)
	runs, err := store.ListRuns(RunFilter{LatestPerWorkNode: true})
	if err != nil {
		t.Fatal(err)
	}
	byNode := map[string]string{}
	for _, run := range runs {
		if _, duplicate := byNode[run.WorkNodeID]; duplicate {
			t.Fatalf("one Run per WorkNode expected: %+v", runs)
		}
		byNode[run.WorkNodeID] = run.ID
	}
	if len(byNode) != 2 || byNode["wn_a"] != newer.ID || byNode["wn_b"] != branch.ID || byNode["wn_a"] == older.ID {
		t.Fatalf("latest conversation Run per WorkNode expected: %+v", byNode)
	}
}

func TestLatestWorkNodeActivityReportsTheNewestEventPerWorkNode(t *testing.T) {
	store, _ := openTestStore(t)
	insert := func(id, notebook, workNode string, ts int64) {
		t.Helper()
		if _, err := store.db.Exec(`INSERT INTO events(id, type, ts, notebook_id, work_node_id, payload_json)
			VALUES(?, 'test.event', ?, ?, ?, '{}')`, id, ts, notebook, workNode); err != nil {
			t.Fatal(err)
		}
	}
	insert("evt_a_old", "nb_one", "wn_a", 1000)
	insert("evt_b", "nb_one", "wn_b", 2000)
	insert("evt_a_new", "nb_one", "wn_a", 3000)
	insert("evt_other_notebook", "nb_two", "wn_c", 4000)
	insert("evt_no_node", "nb_one", "", 5000)
	events, err := store.LatestWorkNodeActivity("nb_one")
	if err != nil || len(events) != 2 {
		t.Fatalf("one activity row per WorkNode of the notebook expected: %+v (%v)", events, err)
	}
	times := map[string]string{}
	for _, event := range events {
		times[event.WorkNodeID] = event.TS
	}
	if times["wn_a"] != formatMillis(3000) || times["wn_b"] != formatMillis(2000) {
		t.Fatalf("newest event time per WorkNode expected: %+v", times)
	}
}

func TestProjectFileRunUsesTrustedLocalLifecycle(t *testing.T) {
	store, root := openTestStore(t)
	session := promoteRuntimeSession(t, store, root)
	run, err := store.PrepareRun(PrepareRunInput{
		WorkstreamID: session.WorkstreamID, NotebookID: "nb_project", CellID: "c-project",
		WorkNodeID: "wn_project", SourceKind: "project-file", ExecutionTarget: root,
		Spec:            map[string]any{"schema": "noema.run-spec/1", "source": map[string]any{"kind": "project-file", "file": "job.py"}},
		ContextManifest: map[string]any{"schema": "noema.context-manifest/1", "items": []any{}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if run.SessionID != "" || run.Status != "preparing" || run.SourceKind != "project-file" {
		t.Fatalf("unexpected prepared local run: %+v", run)
	}
	if _, err := store.StartRun(StartRunInput{RunID: run.ID}); err == nil {
		t.Fatal("project-file Run bypassed the dedicated local lifecycle")
	}
	started, err := store.StartLocalRun(StartLocalRunInput{RunID: run.ID})
	if err != nil || started.Status != "running" {
		t.Fatalf("start local run: %+v (%v)", started, err)
	}
	events, err := store.ReportLocalRunEvents(ReportLocalRunEventsInput{RunID: run.ID, Events: []WorkerEvent{
		{Type: "run.content.segment", Payload: map[string]any{"stream": "stdout", "text": "answer=42\n"}},
		{Type: "run.status.changed", Payload: map[string]any{"status": "completed", "transcript_text": "answer=42\n"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 || events[len(events)-1].WorkNodeID != "wn_project" {
		t.Fatalf("local events lost output/provenance: %+v", events)
	}
	stored, err := store.GetRun(run.ID)
	if err != nil || stored.Status != "completed" || stored.FinishedAt == "" {
		t.Fatalf("terminal local run was not durable: %+v (%v)", stored, err)
	}
	if _, err := store.ReportLocalRunEvents(ReportLocalRunEventsInput{RunID: run.ID,
		Events: []WorkerEvent{{Type: "run.content.segment", Payload: map[string]any{"text": "late"}}}}); err == nil {
		t.Fatal("terminal local Run accepted a late event")
	}
}

func TestEquivalentContextManifestHasStableArtifactIdentity(t *testing.T) {
	store, root := openTestStore(t)
	session := promoteRuntimeSession(t, store, root)
	prepare := func() Run {
		run, err := store.PrepareRun(PrepareRunInput{
			WorkstreamID: session.WorkstreamID, SourceKind: "promoted-session", ExecutionTarget: root,
			Spec:            map[string]any{"schema": "noema.run-spec/1"},
			ContextManifest: map[string]any{"schema": "noema.context-manifest/1"},
			ContextItems: []ContextItemInput{{Ref: "file:fact.md", ResolvedURI: "noema://file/fact.md",
				MediaType: "text/markdown", ContentBase64: base64.StdEncoding.EncodeToString([]byte("same source\n"))}},
		})
		if err != nil {
			t.Fatal(err)
		}
		return run
	}
	first, second := prepare(), prepare()
	if first.ContextArtifactID == "" || first.ContextArtifactID != second.ContextArtifactID {
		t.Fatalf("equivalent parsing changed manifest identity: %q != %q", first.ContextArtifactID, second.ContextArtifactID)
	}
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
		Action:  map[string]any{"kind": "edit", "paths": []any{"../result.md"}},
		Options: []map[string]any{{"optionId": "allow_once", "label": "Allow once"}, {"optionId": "reject_once", "label": "Reject"}},
	})
	if err != nil || permission.State != "pending" || permission.Version != 1 {
		t.Fatalf("permission request failed: %+v (%v)", permission, err)
	}
	if _, err := store.RequestPermission(RequestPermissionInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID, NativeRequestID: "acp-request-1",
		Action: map[string]any{"kind": "edit", "paths": []any{"../changed-after-approval.md"}}, Options: permission.Options,
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
	changed, err := store.RequestPermission(RequestPermissionInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID,
		NativeRequestID: "acp-request-1-changed",
		Action:          map[string]any{"kind": "edit", "paths": []any{"../changed-after-approval.md"}},
		Options:         permission.Options,
	})
	if err != nil || changed.State != "pending" || changed.ID == permission.ID || changed.ActionSHA256 == permission.ActionSHA256 {
		t.Fatalf("a changed post-approval toolCall must become a fresh permission request: %+v (%v)", changed, err)
	}
	events, err := store.ReportWorkerEvents(ReportWorkerEventsInput{
		SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID,
		Events: []WorkerEvent{
			{Type: "run.output", Payload: map[string]any{"stream": "assistant", "text": "Found a counterexample."}},
			{Type: "run.status.changed", Payload: map[string]any{"status": "completed"}},
		},
	})
	if err != nil || len(events) != 3 || events[0].Type != "run.output" || events[1].Type != "permission.expired" || events[2].Type != "run.status.changed" {
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
		Action:  map[string]any{"kind": "fetch", "network": true},
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
		SessionUsage: &SessionUsage{TotalTokens: 800, InputTokens: 700, OutputTokens: 100,
			ContextUsed: 850, ContextSize: 1000},
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
	if gotHandoff, gotTranscript, err := store.RunTerminalArtifactIDs(run.ID); err != nil ||
		gotHandoff != handoffID || gotTranscript != transcriptID {
		t.Fatalf("terminal artifact lookup must not page Run content: %q %q (%v)", gotHandoff, gotTranscript, err)
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
	context, err := store.GetSessionContext(session.ID)
	if err != nil || context.Usage.ContextUsed != 850 || context.Usage.ContextSize != 1000 {
		t.Fatalf("session context usage was not retained: %+v (%v)", context, err)
	}
	compaction, err := store.RequestSessionCompaction(session.ID)
	if err != nil || compaction.Status != "pending" || compaction.OldNativeSessionID != session.NativeSessionID {
		t.Fatalf("checkpoint rollover was not queued: %+v (%v)", compaction, err)
	}
	again, err := store.RequestSessionCompaction(session.ID)
	if err != nil || again.ID != compaction.ID {
		t.Fatalf("compaction request must be idempotent: %+v (%v)", again, err)
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
		Action: map[string]any{"kind": "fetch", "network": true}, Options: []map[string]any{{"optionId": "allow_once"}},
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
	var runCount int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM runs WHERE session_id = ?`, session.ID).Scan(&runCount); err != nil || runCount != 1 {
		t.Fatalf("lease recovery must not replay a Run automatically: %d (%v)", runCount, err)
	}
	continued := prepareRuntimeRun(t, store, session, root)
	resumedLease, err := store.AcquireLease(AcquireLeaseInput{SessionID: session.ID, Owner: "emacs:reopened"})
	if err != nil {
		t.Fatal(err)
	}
	if started, err := store.StartRun(StartRunInput{SessionID: session.ID, Owner: resumedLease.Owner, Epoch: resumedLease.Epoch, RunID: continued.ID}); err != nil || started.Status != "running" {
		t.Fatalf("an explicit continue after reopening must start a new Run: %+v (%v)", started, err)
	}
	if loaded, err := store.GetRun(run.ID); err != nil || loaded.Status != "interrupted" {
		t.Fatalf("continuing must not rewrite or replay the interrupted Run: %+v (%v)", loaded, err)
	}
}

func TestPermissionPolicyApprovesProjectWorkAndAsksBeyondIt(t *testing.T) {
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
	options := []map[string]any{{"optionId": "allow_always"}, {"optionId": "allow_once"}, {"optionId": "reject_once"}}
	request := func(id string, action map[string]any) Permission {
		t.Helper()
		permission, err := store.RequestPermission(RequestPermissionInput{
			SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID, NativeRequestID: id,
			Action: action, Options: options,
		})
		if err != nil {
			t.Fatalf("%s: %v", id, err)
		}
		return permission
	}
	type probe struct {
		id     string
		action map[string]any
	}
	for _, denied := range []probe{
		{"push", map[string]any{"kind": "execute", "argv": []any{"git", "push", "origin", "main"}}},
		{"sudo", map[string]any{"kind": "execute", "argv": []any{"sudo", "rm", "-rf", "build"}}},
		{"credential", map[string]any{"kind": "credential"}},
	} {
		if got := request(denied.id, denied.action); got.State != "resolved" || got.OptionID != "reject_once" || got.DecidedBy != "policy" {
			t.Fatalf("%s must always be denied without Attention: %+v", denied.id, got)
		}
	}
	for _, inside := range []probe{
		{"read", map[string]any{"kind": "read", "paths": []any{"notes/result.md"}}},
		{"edit", map[string]any{"kind": "edit", "paths": []any{"notes/result.md", filepath.Join(root, "src", "main.go")}}},
		{"test", map[string]any{"kind": "execute", "argv": []any{"bash", "-lc", "go test ./... 2>/dev/null"}}},
	} {
		if got := request(inside.id, inside.action); got.State != "resolved" || got.OptionID != "allow_once" || got.DecidedBy != "policy" {
			t.Fatalf("%s inside the project must be approved automatically: %+v", inside.id, got)
		}
	}
	for _, beyond := range []probe{
		{"network", map[string]any{"kind": "fetch", "network": true}},
		{"curl", map[string]any{"kind": "execute", "argv": []any{"curl", "https://example.com"}}},
		{"outside-read", map[string]any{"kind": "read", "paths": []any{"/etc/hosts"}}},
		{"home", map[string]any{"kind": "execute", "argv": []any{"cat", "~/.ssh/config"}}},
	} {
		got := request(beyond.id, beyond.action)
		if got.State != "pending" {
			t.Fatalf("%s beyond the project must ask a person: %+v", beyond.id, got)
		}
		if _, err := store.DecidePermission(DecidePermissionInput{PermissionID: got.ID, OptionID: "reject_once", ExpectedVersion: got.Version, DecidedBy: "user"}); err != nil {
			t.Fatal(err)
		}
	}
	outsideEdit := map[string]any{"kind": "edit", "paths": []any{"../outside.md"}}
	first := request("outside-1", outsideEdit)
	if first.State != "pending" {
		t.Fatalf("outside-project edit must ask first: %+v", first)
	}
	if _, err := store.DecidePermission(DecidePermissionInput{PermissionID: first.ID, OptionID: "allow_always", ExpectedVersion: first.Version, DecidedBy: "user"}); err != nil {
		t.Fatal(err)
	}
	var rules int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM permission_rules WHERE scope = 'session' AND scope_id = ? AND effect = 'allow'`, session.ID).Scan(&rules); err != nil || rules != 1 {
		t.Fatalf("allow_always must create a narrow session rule: %d (%v)", rules, err)
	}
	if remembered := request("outside-2", outsideEdit); remembered.State != "resolved" || remembered.OptionID != "allow_once" || !strings.HasPrefix(remembered.DecidedBy, "policy-rule:") {
		t.Fatalf("matching remembered decision must be automatic and one-time: %+v", remembered)
	}
	if other := request("outside-3", map[string]any{"kind": "edit", "paths": []any{"../elsewhere.md"}}); other.State != "pending" {
		t.Fatalf("a remembered rule must not widen to other outside paths: %+v", other)
	}
}

func TestCancellingAPreparingRunStopsItBeforeDispatch(t *testing.T) {
	store, root := openTestStore(t)
	session := promoteRuntimeSession(t, store, root)
	run := prepareRuntimeRun(t, store, session, root)
	cancelled, err := store.RequestRunCancellation(CancelRunInput{RunID: run.ID, RequestedBy: "web"})
	if err != nil || cancelled.Status != "cancelled" {
		t.Fatalf("a preparing Run has no worker to observe cancellation and must end now: %+v (%v)", cancelled, err)
	}
	lease, err := store.AcquireLease(AcquireLeaseInput{SessionID: session.ID, Owner: "emacs:late"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartRun(StartRunInput{SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID}); err == nil ||
		!strings.Contains(err.Error(), "cancelled before it started") {
		t.Fatalf("a late worker must not start a cancelled Run: %v", err)
	}
	if failed, err := store.FailPreparedRun(FailPreparedRunInput{RunID: run.ID, FailureReason: "worker start failed"}); err != nil || failed.Status != "cancelled" {
		t.Fatalf("a worker reporting the refused start must keep the cancellation: %+v (%v)", failed, err)
	}
	if _, err := store.RequestRunCancellation(CancelRunInput{RunID: run.ID, RequestedBy: "web"}); err == nil {
		t.Fatal("cancelling a finished Run again must report that it already ended")
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
		Action:  map[string]any{"kind": "edit", "paths": []any{"../result.md"}},
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
		Action:  map[string]any{"kind": "edit", "paths": []any{"../proof.md"}},
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
