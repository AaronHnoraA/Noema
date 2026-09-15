package mcp

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/mcp/tools"
	"github.com/aaronhe/noema/kernel/noema/research"
)

func coordinatorText(result tools.CallToolResult) string {
	if len(result.Content) == 0 {
		return ""
	}
	return result.Content[0].Text
}

func TestCoordinatorToolsStayOffTheSharedRegistry(t *testing.T) {
	if !strings.Contains(coordinatorInstructions, "Never decide on your own") {
		t.Fatal("coordinator instructions must be embedded")
	}
	shared := map[string]bool{}
	for _, tool := range tools.GetAllTools() {
		shared[tool.Name] = true
	}
	for _, tool := range CoordinatorTools() {
		if shared[tool.Name] {
			t.Fatalf("coordinator tool %s must not be exposed to ordinary agent Runs", tool.Name)
		}
		if _, err := tools.CompileToolValidator(tool); err != nil {
			t.Fatalf("coordinator tool %s has an invalid schema: %v", tool.Name, err)
		}
	}
}

func TestCoordinatorRunStartQueuesOnlyProjectWorkDocuments(t *testing.T) {
	root := t.TempDir()
	t.Cleanup(research.CloseAll)
	if err := os.WriteFile(filepath.Join(root, "work.noema"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "other.noema")
	if err := os.WriteFile(outside, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{outside, "../escape.noema", "notes.md", "missing.noema"} {
		result, _ := coordinatorRunStart(map[string]any{"root": root, "file": file, "cellId": "c-1"})
		if !result.IsError {
			t.Fatalf("run.start should reject %s", file)
		}
	}
	result, _ := coordinatorRunStart(map[string]any{"root": root, "file": "work.noema", "cellId": "c-1", "sessionName": "bad name"})
	if !result.IsError {
		t.Fatal("run.start should validate sessionName")
	}
	result, _ = coordinatorRunStart(map[string]any{"root": root, "file": "work.noema", "cellId": "c-1", "sessionName": "baseline"})
	if result.IsError || !strings.Contains(coordinatorText(result), "creq_") {
		t.Fatalf("run.start should queue a request: %s", coordinatorText(result))
	}
	store, err := research.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := store.ClaimCoordinatorRequests("emacs:test", 10)
	if err != nil || len(claimed) != 1 || claimed[0].Actor != "pi" || claimed[0].Payload["sessionName"] != "baseline" {
		t.Fatalf("unexpected queued request: %+v %v", claimed, err)
	}
}

func TestCoordinatorSessionControlQueuesOnlyWhatCanApply(t *testing.T) {
	root := t.TempDir()
	t.Cleanup(research.CloseAll)
	store, err := research.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.DeclareSessionName(research.SessionNameIntent{Name: "baseline", Agent: "codex", Origin: "user"}); err != nil {
		t.Fatal(err)
	}
	if result, _ := coordinatorSessionCancel(map[string]any{"root": root, "name": "baseline"}); !result.IsError {
		t.Fatal("cancel needs an open Run")
	}
	if result, _ := coordinatorSessionClose(map[string]any{"root": root, "name": "missing"}); !result.IsError {
		t.Fatal("close needs an existing name")
	}
	result, _ := coordinatorSessionClose(map[string]any{"root": root, "name": "baseline"})
	if result.IsError || !strings.Contains(coordinatorText(result), "creq_") {
		t.Fatalf("close of an idle session should queue: %s", coordinatorText(result))
	}
	claimed, err := store.ClaimCoordinatorRequests("emacs:test", 10)
	if err != nil || len(claimed) != 1 || claimed[0].Kind != "session.close" || claimed[0].Payload["name"] != "baseline" {
		t.Fatalf("unexpected queued control request: %+v %v", claimed, err)
	}
}

func TestCoordinatorCannotChangeUserPinnedNames(t *testing.T) {
	root := t.TempDir()
	t.Cleanup(research.CloseAll)
	store, err := research.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.DeclareSessionName(research.SessionNameIntent{Name: "baseline", Agent: "codex", Origin: "user"}); err != nil {
		t.Fatal(err)
	}
	if result, _ := coordinatorSessionRename(map[string]any{"root": root, "name": "baseline", "newName": "main"}); !result.IsError {
		t.Fatal("Pi must not rename a user-pinned name")
	}
	if result, _ := coordinatorSessionArchive(map[string]any{"root": root, "name": "baseline"}); !result.IsError {
		t.Fatal("Pi must not archive a user-pinned name")
	}
	declared, _ := coordinatorSessionDeclare(map[string]any{"root": root, "name": "ablation", "agent": "codex", "parent": "baseline"})
	if declared.IsError || !strings.Contains(coordinatorText(declared), `"origin":"pi"`) {
		t.Fatalf("Pi may declare its own child names: %s", coordinatorText(declared))
	}
	if result, _ := coordinatorSessionRename(map[string]any{"root": root, "name": "ablation", "newName": "ablation-2"}); result.IsError {
		t.Fatalf("Pi may rename names it created: %s", coordinatorText(result))
	}
	listed, _ := coordinatorSessionList(map[string]any{"root": root})
	if listed.IsError || !strings.Contains(coordinatorText(listed), "ablation-2") {
		t.Fatalf("session.list should show names: %s", coordinatorText(listed))
	}
}
