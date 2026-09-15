// Noema Pi coordinator MCP endpoint is Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package mcp

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/aaronhe/noema/kernel/mcp/tools"
	"github.com/aaronhe/noema/kernel/noema/research"
	"github.com/aaronhe/noema/kernel/util"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// D-032/D-035: Pi is the project's session manager and reaches Noema only
// through this endpoint.  Its tools are the same deterministic session
// operations Emacs uses, executed with actor "pi", so Pi can never override
// what the user pinned.  Anything that touches a live agent (start, cancel,
// close) is a durable request Emacs carries out over ACP.  pi-acp appends the
// server instructions to Pi's system prompt.

//go:embed coordinator.md
var coordinatorInstructions string

const coordinatorActor = "pi"

var (
	coordinatorHandlerOnce sync.Once
	coordinatorHandler     http.Handler
)

func getCoordinatorHandler() http.Handler {
	coordinatorHandlerOnce.Do(func() {
		server := mcpsdk.NewServer(&mcpsdk.Implementation{Name: "Noema Coordinator", Version: util.Ver},
			&mcpsdk.ServerOptions{Instructions: coordinatorInstructions, Capabilities: &mcpsdk.ServerCapabilities{}})
		server.AddReceivingMiddleware(privateCacheMiddleware())
		for _, tool := range CoordinatorTools() {
			syncTool(server, tool.Name, tool)
		}
		coordinatorHandler = newHTTPHandler(server)
	})
	return coordinatorHandler
}

func coordinatorRootProperty() tools.Property {
	return tools.Property{Type: "string", Description: "Absolute Noema project root"}
}

// CoordinatorTools returns the Pi coordinator tool set.  They are not added
// to the shared registry, so ordinary agent Runs never see them.
func CoordinatorTools() []*tools.Tool {
	return []*tools.Tool{
		{
			Name: "session.list", Description: "List the project's named agent sessions with agent, origin, state and last Run.",
			InputSchema: tools.ToolSchema{Type: "object", Properties: map[string]tools.Property{
				"root":            coordinatorRootProperty(),
				"includeArchived": {Type: "boolean", Description: "Include archived names"},
			}, Required: []string{"root"}},
			Handler: coordinatorSessionList, ReadOnlyHint: true,
			ActionEffects: map[string]tools.ToolEffects{"": {LocalRead: true}},
		},
		{
			Name: "session.declare", Description: "Create a session name, optionally as a child of a parent name. The conversation starts on its first Run.",
			InputSchema: tools.ToolSchema{Type: "object", Properties: map[string]tools.Property{
				"root":   coordinatorRootProperty(),
				"name":   {Type: "string", Description: "New session name"},
				"agent":  {Type: "string", Description: "Agent id, e.g. codex, claude, opencode, pi"},
				"parent": {Type: "string", Description: "Optional parent session name to hand over from"},
			}, Required: []string{"root", "name", "agent"}},
			Handler:       coordinatorSessionDeclare,
			ActionEffects: map[string]tools.ToolEffects{"": {LocalWrite: true}},
		},
		{
			Name: "session.rename", Description: "Rename a session name created by Pi or derived by Noema. The old name keeps working as an alias.",
			InputSchema: tools.ToolSchema{Type: "object", Properties: map[string]tools.Property{
				"root":    coordinatorRootProperty(),
				"name":    {Type: "string", Description: "Current session name"},
				"newName": {Type: "string", Description: "New session name"},
			}, Required: []string{"root", "name", "newName"}},
			Handler:       coordinatorSessionRename,
			ActionEffects: map[string]tools.ToolEffects{"": {LocalWrite: true}},
		},
		{
			Name: "session.archive", Description: "Archive or restore a session name created by Pi or derived by Noema.",
			InputSchema: tools.ToolSchema{Type: "object", Properties: map[string]tools.Property{
				"root":     coordinatorRootProperty(),
				"name":     {Type: "string", Description: "Session name"},
				"archived": {Type: "boolean", Description: "true to archive (default), false to restore"},
			}, Required: []string{"root", "name"}},
			Handler:       coordinatorSessionArchive,
			ActionEffects: map[string]tools.ToolEffects{"": {LocalWrite: true}},
		},
		{
			Name: "run.start", Description: "Ask Emacs to run one .noema work block through the Noema worker. A @@session in the block overrides sessionName.",
			InputSchema: tools.ToolSchema{Type: "object", Properties: map[string]tools.Property{
				"root":        coordinatorRootProperty(),
				"file":        {Type: "string", Description: ".noema file, relative to the project root"},
				"cellId":      {Type: "string", Description: "Work block cell id"},
				"sessionName": {Type: "string", Description: "Optional session name the human asked for"},
			}, Required: []string{"root", "file", "cellId"}},
			Handler:       coordinatorRunStart,
			ActionEffects: map[string]tools.ToolEffects{"": {LocalWrite: true}},
		},
		{
			Name: "session.cancel", Description: "Ask Emacs to cancel the Run currently open in a session.",
			InputSchema: tools.ToolSchema{Type: "object", Properties: map[string]tools.Property{
				"root": coordinatorRootProperty(),
				"name": {Type: "string", Description: "Session name"},
			}, Required: []string{"root", "name"}},
			Handler:       coordinatorSessionCancel,
			ActionEffects: map[string]tools.ToolEffects{"": {LocalWrite: true}},
		},
		{
			Name: "session.close", Description: "Ask Emacs to stop an idle session's agent process. The name and history stay; the next Run resumes it.",
			InputSchema: tools.ToolSchema{Type: "object", Properties: map[string]tools.Property{
				"root": coordinatorRootProperty(),
				"name": {Type: "string", Description: "Session name"},
			}, Required: []string{"root", "name"}},
			Handler:       coordinatorSessionClose,
			ActionEffects: map[string]tools.ToolEffects{"": {LocalWrite: true}},
		},
	}
}

func coordinatorSessionCancel(args map[string]any) (tools.CallToolResult, error) {
	return coordinatorSessionControl("session.cancel", args)
}

func coordinatorSessionClose(args map[string]any) (tools.CallToolResult, error) {
	return coordinatorSessionControl("session.close", args)
}

// coordinatorSessionControl queues a live-agent action only when it can
// apply: cancel needs an open Run, close needs an idle session, and Pi never
// acts on its own `pi' session.
func coordinatorSessionControl(kind string, args map[string]any) (tools.CallToolResult, error) {
	store, err := coordinatorStore(args)
	if err != nil {
		return coordinatorFailure(err), nil
	}
	name, err := store.GetSessionName(coordinatorString(args, "name"))
	if err != nil {
		return coordinatorFailure(err), nil
	}
	switch {
	case name.Name == research.PiSessionName:
		return coordinatorFailure(errors.New("the pi session is managed by Emacs, not by Pi")), nil
	case kind == "session.cancel" && !name.OpenRun:
		return coordinatorFailure(fmt.Errorf("session %s has no open Run", name.Name)), nil
	case kind == "session.close" && name.OpenRun:
		return coordinatorFailure(fmt.Errorf("session %s is running a Run; cancel it first", name.Name)), nil
	}
	payload := map[string]any{"name": name.Name, "sessionId": name.SessionID}
	if kind == "session.cancel" && name.LastRun != nil {
		payload["runId"] = name.LastRun.ID
	}
	request, err := store.CreateCoordinatorRequest(kind, payload, coordinatorActor)
	if err != nil {
		return coordinatorFailure(err), nil
	}
	return coordinatorResult(map[string]any{"request": request, "note": "Queued for Emacs."}), nil
}

func coordinatorString(args map[string]any, key string) string {
	value, _ := args[key].(string)
	return strings.TrimSpace(value)
}

func coordinatorStore(args map[string]any) (*research.Store, error) {
	return research.Open(coordinatorString(args, "root"))
}

func coordinatorResult(value any) tools.CallToolResult {
	data, err := json.Marshal(value)
	if err != nil {
		return coordinatorFailure(err)
	}
	return tools.CallToolResult{Content: []tools.ContentItem{{Type: "text", Text: string(data)}}}
}

func coordinatorFailure(err error) tools.CallToolResult {
	return tools.CallToolResult{Content: []tools.ContentItem{{Type: "text", Text: err.Error()}}, IsError: true}
}

func coordinatorSessionList(args map[string]any) (tools.CallToolResult, error) {
	store, err := coordinatorStore(args)
	if err != nil {
		return coordinatorFailure(err), nil
	}
	archived, _ := args["includeArchived"].(bool)
	names, err := store.ListSessionNames(archived)
	if err != nil {
		return coordinatorFailure(err), nil
	}
	return coordinatorResult(map[string]any{"names": names}), nil
}

func coordinatorSessionDeclare(args map[string]any) (tools.CallToolResult, error) {
	store, err := coordinatorStore(args)
	if err != nil {
		return coordinatorFailure(err), nil
	}
	intent := research.SessionNameIntent{
		Name: coordinatorString(args, "name"), Agent: coordinatorString(args, "agent"),
		ParentName: coordinatorString(args, "parent"), Origin: coordinatorActor,
	}
	if intent.ParentName != "" {
		intent.ForkMode = "reconstructed"
	}
	declared, err := store.DeclareSessionName(intent)
	if err != nil {
		return coordinatorFailure(err), nil
	}
	return coordinatorResult(declared), nil
}

func coordinatorSessionRename(args map[string]any) (tools.CallToolResult, error) {
	store, err := coordinatorStore(args)
	if err != nil {
		return coordinatorFailure(err), nil
	}
	renamed, err := store.RenameSessionName(research.RenameSessionNameInput{
		Name: coordinatorString(args, "name"), NewName: coordinatorString(args, "newName"), Actor: coordinatorActor,
	})
	if err != nil {
		return coordinatorFailure(err), nil
	}
	return coordinatorResult(renamed), nil
}

func coordinatorSessionArchive(args map[string]any) (tools.CallToolResult, error) {
	store, err := coordinatorStore(args)
	if err != nil {
		return coordinatorFailure(err), nil
	}
	archived := true
	if value, ok := args["archived"].(bool); ok {
		archived = value
	}
	name, err := store.ArchiveSessionName(research.ArchiveSessionNameInput{
		Name: coordinatorString(args, "name"), Archived: archived, Actor: coordinatorActor,
	})
	if err != nil {
		return coordinatorFailure(err), nil
	}
	return coordinatorResult(name), nil
}

// coordinatorWorkFile resolves FILE inside ROOT and requires an existing
// `.noema' document.
func coordinatorWorkFile(root, file string) (string, error) {
	if file == "" {
		return "", errors.New("run.start needs a .noema file")
	}
	path := file
	if !filepath.IsAbs(path) {
		path = filepath.Join(root, path)
	}
	path = filepath.Clean(path)
	relative, err := filepath.Rel(filepath.Clean(root), path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("%s is outside the project", file)
	}
	if !strings.EqualFold(filepath.Ext(path), ".noema") {
		return "", fmt.Errorf("%s is not a .noema work document", file)
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("%s does not exist", file)
	}
	return path, nil
}

func coordinatorRunStart(args map[string]any) (tools.CallToolResult, error) {
	store, err := coordinatorStore(args)
	if err != nil {
		return coordinatorFailure(err), nil
	}
	path, err := coordinatorWorkFile(coordinatorString(args, "root"), coordinatorString(args, "file"))
	if err != nil {
		return coordinatorFailure(err), nil
	}
	cellID := coordinatorString(args, "cellId")
	if cellID == "" || strings.ContainsAny(cellID, " \t\n") {
		return coordinatorFailure(errors.New("run.start needs the work block cellId")), nil
	}
	sessionName := coordinatorString(args, "sessionName")
	if sessionName != "" {
		if err := research.ValidateSessionName(sessionName); err != nil {
			return coordinatorFailure(err), nil
		}
	}
	request, err := store.CreateCoordinatorRequest("run.start",
		map[string]any{"file": path, "cellId": cellID, "sessionName": sessionName}, coordinatorActor)
	if err != nil {
		return coordinatorFailure(err), nil
	}
	return coordinatorResult(map[string]any{
		"request": request,
		"note":    "Queued for Emacs; the Run starts through the Noema worker. A @@session line in the block overrides sessionName.",
	}), nil
}
