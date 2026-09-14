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
		Spec: map[string]any{"schema": "noema.run-spec/1", "prompt": "Work"}})
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
}
