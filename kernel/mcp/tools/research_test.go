package tools

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/noema/research"
)

func researchToolFixture(t *testing.T) (string, *research.Store) {
	t.Helper()
	root := t.TempDir()
	t.Cleanup(research.CloseAll)
	notebook := `{"nbformat":4,"nbformat_minor":5,"metadata":{"noema_research":{"schema":"noema.research-notebook/1","notebook_id":"nb_tools","workstream_id":"ws_tools","title":"Tools"}},"cells":[` +
		`{"id":"q","cell_type":"markdown","source":"Public question","metadata":{"noema_research":{"kind":"question","title":"Question"}}},` +
		`{"id":"secret","cell_type":"markdown","source":"private canary","metadata":{"noema_research":{"kind":"work","title":"Secret","disclosure":"local_only"}}},` +
		`{"id":"work","cell_type":"markdown","source":"Public work","metadata":{"noema_research":{"kind":"work","title":"Work","lineage":["q","secret"],"depends":["q","secret"]}}}]}`
	if err := os.WriteFile(filepath.Join(root, "tools.noema"), []byte(notebook), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := research.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.IndexNotebook("tools.noema", research.IndexOptions{Actor: "test"}); err != nil {
		t.Fatal(err)
	}
	return root, store
}

func decodeToolJSON(t *testing.T, result CallToolResult, target any) {
	t.Helper()
	if result.IsError || len(result.Content) != 1 {
		t.Fatalf("unexpected tool error: %+v", result)
	}
	if err := json.Unmarshal([]byte(result.Content[0].Text), target); err != nil {
		t.Fatalf("decode tool result: %v: %s", err, result.Content[0].Text)
	}
}

func TestResearchCellToolReadsNeighborsButNeverLocalOnly(t *testing.T) {
	root, _ := researchToolFixture(t)
	outlined, err := researchCellHandler(map[string]any{"action": "outline", "root": root, "notebookId": "nb_tools", "cellId": "work"})
	if err != nil {
		t.Fatal(err)
	}
	var outline struct {
		Cell    researchCellOutline   `json:"cell"`
		Parents []researchCellOutline `json:"parents"`
	}
	decodeToolJSON(t, outlined, &outline)
	if outline.Cell.SourceBytes != len("Public work") || len(outline.Parents) != 1 || outline.Parents[0].ID != "q" ||
		outline.Cell.SourceSHA256 == "" || strings.Contains(outlined.Content[0].Text, "Public question") ||
		strings.Contains(outlined.Content[0].Text, "private canary") || strings.Contains(outlined.Content[0].Text, `"secret"`) {
		t.Fatalf("outline disclosed source text or private graph neighbors: %+v", outlined)
	}
	result, err := researchCellHandler(map[string]any{"action": "neighbors", "root": root, "notebookId": "nb_tools", "cellId": "work"})
	if err != nil {
		t.Fatal(err)
	}
	var view research.ResearchCellView
	decodeToolJSON(t, result, &view)
	if view.Cell.Source != "Public work" || len(view.Parents) != 1 || view.Parents[0].ID != "q" || len(view.Dependencies) != 1 {
		t.Fatalf("unexpected filtered research neighbors: %+v", view)
	}
	blocked, err := researchCellHandler(map[string]any{"action": "read", "root": root, "notebookId": "nb_tools", "cellId": "secret"})
	if err != nil || !blocked.IsError || !strings.Contains(blocked.Content[0].Text, "local_only") {
		t.Fatalf("local_only cell escaped pull boundary: %+v (%v)", blocked, err)
	}
}

func TestArtifactToolImportsSearchesAndReadsCAS(t *testing.T) {
	root, _ := researchToolFixture(t)
	content := base64.StdEncoding.EncodeToString([]byte("bounded evidence"))
	imported, err := artifactHandler(map[string]any{"action": "import", "root": root, "kind": "evidence",
		"mediaType": "text/plain; charset=utf-8", "contentBase64": content, "sourceUri": "https://example.test"})
	if err != nil {
		t.Fatal(err)
	}
	var artifact research.Artifact
	decodeToolJSON(t, imported, &artifact)
	searched, _ := artifactHandler(map[string]any{"action": "search", "root": root, "query": artifact.ID})
	var search struct {
		Artifacts []research.Artifact `json:"artifacts"`
	}
	decodeToolJSON(t, searched, &search)
	if len(search.Artifacts) != 1 || search.Artifacts[0].ID != artifact.ID {
		t.Fatalf("imported artifact was not searchable: %+v", search)
	}
	read, _ := artifactHandler(map[string]any{"action": "read", "root": root, "id": artifact.ID})
	var payload struct {
		Text string `json:"text"`
	}
	decodeToolJSON(t, read, &payload)
	if payload.Text != "bounded evidence" {
		t.Fatalf("artifact bytes changed: %+v", payload)
	}
	reserved, _ := artifactHandler(map[string]any{"action": "import", "root": root, "kind": "run-spec",
		"mediaType": "application/json", "contentBase64": content})
	if !reserved.IsError || !strings.Contains(reserved.Content[0].Text, "reserved") {
		t.Fatalf("runtime-owned artifact kind was importable: %+v", reserved)
	}
}

func TestResearchRunToolReturnsDurableOutput(t *testing.T) {
	root, store := researchToolFixture(t)
	session, err := store.PromoteSession(research.PromoteSessionInput{WorkstreamID: "ws_tools", Adapter: "codex", Transport: "acp",
		NativeSessionID: "native-tools", ExecutionTarget: root})
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.PrepareRun(research.PrepareRunInput{WorkstreamID: "ws_tools", SessionID: session.ID,
		NotebookID: "nb_tools", CellID: "work", WorkNodeID: "wn_tools_work", SourceKind: "work-cell", ExecutionTarget: root,
		Spec: map[string]any{"schema": "noema.run-spec/1", "prompt": "private run prompt canary",
			"context":         []map[string]any{{"ref": "cell:q", "bytes": 15, "automatic": false}},
			"context_omitted": []map[string]any{{"ref": "result:older", "reason": "context budget"}}}})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := store.AcquireLease(research.AcquireLeaseInput{SessionID: session.ID, Owner: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartRun(research.StartRunInput{SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportWorkerEvents(research.ReportWorkerEventsInput{SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID,
		Events: []research.WorkerEvent{{Type: "run.status.changed", Payload: map[string]any{
			"status": "completed", "result_text": "Handoff", "transcript_text": "Full transcript",
		}}}}); err != nil {
		t.Fatal(err)
	}
	result, err := researchRunHandler(map[string]any{"action": "output", "root": root, "id": run.ID, "includeTranscript": true})
	if err != nil {
		t.Fatal(err)
	}
	var output research.RunOutput
	decodeToolJSON(t, result, &output)
	if output.Run.Status != "completed" || output.HandoffText != "Handoff" || output.TranscriptText != "Full transcript" {
		t.Fatalf("unexpected Run output: %+v", output)
	}
	context, err := researchRunHandler(map[string]any{"action": "context", "root": root, "id": run.ID})
	if err != nil {
		t.Fatal(err)
	}
	var receipt research.RunContextReceipt
	decodeToolJSON(t, context, &receipt)
	if receipt.Run.ID != run.ID || receipt.PromptBytes != len("private run prompt canary") ||
		len(receipt.Context) != 1 || receipt.Context[0]["ref"] != "cell:q" || len(receipt.Omitted) != 1 ||
		strings.Contains(context.Content[0].Text, "private run prompt canary") {
		t.Fatalf("Run context receipt did not stay compact and frozen: %+v", context)
	}
}

func TestProposalCreateToolSubmitsPendingCandidateFromActiveRun(t *testing.T) {
	root, store := researchToolFixture(t)
	before, err := os.ReadFile(filepath.Join(root, "tools.noema"))
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.PromoteSession(research.PromoteSessionInput{WorkstreamID: "ws_tools", Adapter: "codex", Transport: "acp",
		NativeSessionID: "native-proposal", ExecutionTarget: root})
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.PrepareRun(research.PrepareRunInput{WorkstreamID: "ws_tools", SessionID: session.ID,
		NotebookID: "nb_tools", CellID: "work", WorkNodeID: "wn_tools_work", SourceKind: "work-cell", ExecutionTarget: root,
		Spec: map[string]any{"schema": "noema.run-spec/1", "prompt": "Propose the next branch"}})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := store.AcquireLease(research.AcquireLeaseInput{SessionID: session.ID, Owner: "mcp-test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartRun(research.StartRunInput{SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID}); err != nil {
		t.Fatal(err)
	}
	result, err := proposalCreateHandler(map[string]any{
		"root": root, "runId": run.ID, "workNodeId": run.WorkNodeID,
		"clientRequestId": "agent-proposal-1", "kind": "cell.create",
		"payload": map[string]any{"cell": map[string]any{"title": "Coupling branch", "source": "@@agent(codex)\nTry coupling."},
			"provenance": map[string]any{"run_id": "run_forged", "work_node_id": "wn_forged"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var proposal research.Proposal
	decodeToolJSON(t, result, &proposal)
	provenance, _ := proposal.Payload["provenance"].(map[string]any)
	if proposal.Status != "pending" || proposal.WorkstreamID != run.WorkstreamID || proposal.ProposedBy != "agent:run/"+run.ID ||
		provenance["run_id"] != run.ID || provenance["work_node_id"] != run.WorkNodeID {
		t.Fatalf("MCP Proposal lost authority or provenance: %+v", proposal)
	}
	after, err := os.ReadFile(filepath.Join(root, "tools.noema"))
	if err != nil || string(after) != string(before) {
		t.Fatalf("proposal.create mutated the authoritative notebook (%v)", err)
	}
	wrong, err := proposalCreateHandler(map[string]any{
		"root": root, "runId": run.ID, "workNodeId": "wn_other", "clientRequestId": "agent-proposal-2",
		"kind": "finding.create", "payload": map[string]any{"claim": "forged"},
	})
	if err != nil || !wrong.IsError || !strings.Contains(wrong.Content[0].Text, "provenance") {
		t.Fatalf("forged WorkNode provenance was accepted: %+v (%v)", wrong, err)
	}
	if tool := GetTool("proposal.create"); tool == nil || !tool.ActionEffects[""].LocalWrite {
		t.Fatalf("proposal.create is not exposed with a local-write effect: %+v", tool)
	}
}

func TestResearchStateToolRecordsARequestAndNeverEditsTheDocument(t *testing.T) {
	root, store := researchToolFixture(t)
	before, err := os.ReadFile(filepath.Join(root, "tools.noema"))
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.PromoteSession(research.PromoteSessionInput{WorkstreamID: "ws_tools", Adapter: "codex", Transport: "acp",
		NativeSessionID: "native-state", ExecutionTarget: root})
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.PrepareRun(research.PrepareRunInput{WorkstreamID: "ws_tools", SessionID: session.ID,
		NotebookID: "nb_tools", CellID: "work", WorkNodeID: "wn_tools_work", SourceKind: "work-cell", ExecutionTarget: root,
		Spec: map[string]any{"schema": "noema.run-spec/1", "prompt": "Report progress"}})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := store.AcquireLease(research.AcquireLeaseInput{SessionID: session.ID, Owner: "mcp-test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartRun(research.StartRunInput{SessionID: session.ID, Owner: lease.Owner, Epoch: lease.Epoch, RunID: run.ID}); err != nil {
		t.Fatal(err)
	}

	result, err := researchStateHandler(map[string]any{
		"root": root, "runId": run.ID, "workNodeId": run.WorkNodeID,
		"state": "done", "reason": "go test ./noema/research: ok",
	})
	if err != nil || result.IsError {
		t.Fatalf("reporting work state failed: %+v (%v)", result, err)
	}
	// The kernel records the report; it does not apply it.  Emacs owns the
	// document, so the file on disk must be untouched.
	after, err := os.ReadFile(filepath.Join(root, "tools.noema"))
	if err != nil || string(after) != string(before) {
		t.Fatalf("research_state mutated the authoritative notebook (%v)", err)
	}
	requests, err := store.ClaimCoordinatorRequests("emacs-test", 10)
	if err != nil {
		t.Fatal(err)
	}
	var found *research.CoordinatorRequest
	for index := range requests {
		if requests[index].Kind == "worknode.state" {
			found = &requests[index]
		}
	}
	if found == nil {
		t.Fatalf("no worknode.state request was recorded: %+v", requests)
	}
	if found.Actor != "agent:run/"+run.ID ||
		found.Payload["workNodeId"] != run.WorkNodeID ||
		found.Payload["state"] != "done" ||
		found.Payload["reason"] != "go test ./noema/research: ok" ||
		found.Payload["file"] != "tools.noema" {
		t.Fatalf("worknode.state request lost its provenance or payload: %+v", found)
	}

	// A Run may report only on the node it owns, only while it is active,
	// and only with a state a WorkNode can actually hold.
	forged, err := researchStateHandler(map[string]any{
		"root": root, "runId": run.ID, "workNodeId": "wn_other", "state": "done",
	})
	if err != nil || !forged.IsError || !strings.Contains(forged.Content[0].Text, "owns") {
		t.Fatalf("a foreign WorkNode was accepted: %+v (%v)", forged, err)
	}
	bogus, err := researchStateHandler(map[string]any{
		"root": root, "runId": run.ID, "workNodeId": run.WorkNodeID, "state": "finished",
	})
	if err != nil || !bogus.IsError || !strings.Contains(bogus.Content[0].Text, "unsupported work state") {
		t.Fatalf("an unknown state was accepted: %+v (%v)", bogus, err)
	}
	if tool := GetTool("research_state"); tool == nil || !tool.ActionEffects["report"].LocalWrite {
		t.Fatalf("research_state is not exposed with a local-write effect: %+v", tool)
	}

	// Recorded is not applied, and the agent must be able to tell which it is
	// rather than assuming the document changed.
	var requestID string
	decodeToolJSON(t, result, &struct {
		RequestID *string `json:"requestId"`
	}{RequestID: &requestID})
	pending, err := researchStateHandler(map[string]any{
		"action": "status", "root": root, "requestId": requestID,
	})
	if err != nil || pending.IsError {
		t.Fatalf("status lookup failed: %+v (%v)", pending, err)
	}
	if !strings.Contains(pending.Content[0].Text, `"applied": false`) &&
		!strings.Contains(pending.Content[0].Text, `"applied":false`) {
		t.Fatalf("a request nobody has applied must not report applied: %s", pending.Content[0].Text)
	}
	// The request was claimed above but not carried out, and the status has to
	// distinguish those: "the editor is applying it" is not "applied".
	if !strings.Contains(pending.Content[0].Text, "claimed") {
		t.Fatalf("status must say where the report actually is: %s", pending.Content[0].Text)
	}

	// Once the editor carries it out, the same lookup says so.
	if _, err := store.CompleteCoordinatorRequest(requestID, "emacs-test", "done", ""); err != nil {
		t.Fatal(err)
	}
	applied, err := researchStateHandler(map[string]any{
		"action": "status", "root": root, "requestId": requestID,
	})
	if err != nil || applied.IsError {
		t.Fatalf("status lookup after completion failed: %+v (%v)", applied, err)
	}
	if !strings.Contains(applied.Content[0].Text, "applied") ||
		!strings.Contains(applied.Content[0].Text, "true") {
		t.Fatalf("a completed request must report applied: %s", applied.Content[0].Text)
	}
}
