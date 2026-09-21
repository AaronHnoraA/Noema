// Noema research MCP pull tools are Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package tools

import (
	"encoding/base64"
	"errors"
	"strings"

	"github.com/aaronhe/noema/kernel/noema/research"
)

var ResearchCellTool = &Tool{
	Name: "research_cell", Description: "Read a Noema research cell, its explicit lineage/dependency neighbors, or whether the files its Runs touched have changed since. local_only cells are never returned.",
	InputSchema: ToolSchema{Type: "object", Properties: map[string]Property{
		"action":     {Type: "string", Description: "Operation", Enum: []string{"read", "neighbors", "changes"}},
		"root":       {Type: "string", Description: "Absolute Noema repository root"},
		"notebookId": {Type: "string", Description: "Research notebook id"},
		"cellId":     {Type: "string", Description: "Research cell id"},
		"workNodeId": {Type: "string", Description: "WorkNode id for changes; defaults to the one bound to cellId"},
	}, Required: []string{"action", "root", "notebookId"}},
	Surface:       SurfaceResearch,
	Handler:       researchCellHandler,
	ActionEffects: map[string]ToolEffects{"read": {LocalRead: true}, "neighbors": {LocalRead: true}, "changes": {LocalRead: true}},
}

var ResearchRunTool = &Tool{
	Name: "research_run", Description: "List or read durable Noema Runs and their immutable output artifacts.",
	InputSchema: ToolSchema{Type: "object", Properties: map[string]Property{
		"action":            {Type: "string", Description: "Operation", Enum: []string{"list", "get", "output"}},
		"root":              {Type: "string", Description: "Absolute Noema repository root"},
		"id":                {Type: "string", Description: "Run id for get/output"},
		"workstreamId":      {Type: "string", Description: "Optional Workstream filter for list"},
		"sessionId":         {Type: "string", Description: "Optional Session filter for list"},
		"limit":             {Type: "number", Description: "Maximum Runs for list (1-1000)"},
		"includeTranscript": {Type: "boolean", Description: "Include transcript text for output"},
	}, Required: []string{"action", "root"}},
	Surface:       SurfaceResearch,
	Handler:       researchRunHandler,
	ActionEffects: map[string]ToolEffects{"list": {LocalRead: true}, "get": {LocalRead: true}, "output": {LocalRead: true}},
}

var ArtifactTool = &Tool{
	Name: "artifact", Description: "Search/read immutable Noema artifacts or import bounded evidence bytes into CAS. Runtime-owned artifact kinds are reserved.",
	InputSchema: ToolSchema{Type: "object", Properties: map[string]Property{
		"action":        {Type: "string", Description: "Operation", Enum: []string{"search", "read", "import"}},
		"root":          {Type: "string", Description: "Absolute Noema repository root"},
		"id":            {Type: "string", Description: "Artifact id for read"},
		"query":         {Type: "string", Description: "ID, kind, or digest fragment for search"},
		"kind":          {Type: "string", Description: "Kind filter for search or kind for import"},
		"limit":         {Type: "number", Description: "Maximum search results (1-1000)"},
		"mediaType":     {Type: "string", Description: "MIME type for import"},
		"contentBase64": {Type: "string", Description: "Base64 bytes for import"},
		"workstreamId":  {Type: "string", Description: "Optional Workstream attachment for import"},
		"sourceUri":     {Type: "string", Description: "Optional provenance URI for import"},
	}, Required: []string{"action", "root"}},
	Surface:       SurfaceResearch,
	Handler:       artifactHandler,
	ActionEffects: map[string]ToolEffects{"search": {LocalRead: true}, "read": {LocalRead: true}, "import": {LocalWrite: true}},
}

// ProposalCreateTool is the only agent-facing write into the research model.
// It creates an untrusted pending candidate; accepting or materializing that
// candidate remains a separate human-authority operation outside MCP.
var ProposalCreateTool = &Tool{
	Name: "proposal.create", Description: "Submit an untrusted pending Noema Proposal from the current agent Run. This never edits a .noema document or accepts the Proposal.",
	InputSchema: ToolSchema{Type: "object", Properties: map[string]Property{
		"root":            {Type: "string", Description: "Absolute Noema repository root"},
		"runId":           {Type: "string", Description: "Current durable agent Run id"},
		"workNodeId":      {Type: "string", Description: "WorkNode owned by that Run"},
		"clientRequestId": {Type: "string", Description: "Stable idempotency key for this candidate"},
		"kind":            {Type: "string", Description: "Proposal kind", Enum: []string{"cell.create", "graph.declare", "finding.create", "research_ir.create", "problem_model.create", "task.create", "job.create", "delegation.create"}},
		"payload":         {Type: "object", Description: "Untrusted candidate payload; @@ directives remain data until human acceptance"},
	}, Required: []string{"root", "runId", "workNodeId", "clientRequestId", "kind", "payload"}},
	Surface:       SurfaceResearch,
	Handler:       proposalCreateHandler,
	ActionEffects: map[string]ToolEffects{"": {LocalWrite: true}},
}

// ResearchStateTool lets a Run keep the DAG honest about itself.  It is the
// one write that is not a Proposal, and it is narrow by construction: a Run
// may move the WorkNode it owns and nothing else, it cannot restructure the
// document, and it does not apply the change here.  The request is durable;
// Emacs claims it and applies it through the same validated, undoable
// transaction a person's edit uses, so the document keeps one authority.
var ResearchStateTool = &Tool{
	Name: "research_state", Description: "Report the state of the WorkNode this agent Run owns: active while working, done once verification passed, regressed when previously finished work broke. Records the reason and, for regressed, carries it to the finished work below. Cannot touch any other node. Use action \"status\" to confirm an earlier report was actually applied.",
	InputSchema: ToolSchema{Type: "object", Properties: map[string]Property{
		"action":     {Type: "string", Description: "Operation; defaults to report", Enum: []string{"report", "status"}},
		"root":       {Type: "string", Description: "Absolute Noema repository root"},
		"runId":      {Type: "string", Description: "Current durable agent Run id"},
		"workNodeId": {Type: "string", Description: "WorkNode owned by that Run"},
		"state":      {Type: "string", Description: "New state", Enum: research.WorkStates},
		"reason":     {Type: "string", Description: "Why: the evidence for done, or what broke for regressed"},
		"requestId":  {Type: "string", Description: "Request id from an earlier report, for action status"},
	}, Required: []string{"root"}},
	Surface:       SurfaceResearch,
	Handler:       researchStateHandler,
	ActionEffects: map[string]ToolEffects{"": {LocalWrite: true}, "report": {LocalWrite: true}, "status": {LocalRead: true}},
}

func init() {
	register(ResearchCellTool)
	register(ResearchRunTool)
	register(ArtifactTool)
	register(ProposalCreateTool)
	register(ResearchStateTool)
}

// researchStateStatusHandler answers whether an earlier report was carried
// out.  Reporting and applying are separate on purpose -- the kernel never
// writes a `.noema` document -- so "recorded" is not "applied", and an agent
// that cannot tell the difference will reason about a state the document does
// not have.
func researchStateStatusHandler(args map[string]any) (CallToolResult, error) {
	store, result := researchToolStore(args)
	if result != nil {
		return *result, nil
	}
	request, err := store.CoordinatorRequest(stringArg(args, "requestId"))
	if err != nil {
		return historyResearchError(err), nil
	}
	if request.Kind != "worknode.state" {
		return historyResearchError(errors.New("that request is not a work state report")), nil
	}
	applied := request.State == "done"
	summary := map[string]string{
		"pending": "recorded; the editor has not picked it up yet",
		"claimed": "the editor is applying it now",
		"done":    "applied to the document",
		"failed":  "the editor could not apply it",
	}[request.State]
	return historyResearchJSON(map[string]any{
		"requestId": request.ID, "state": request.State, "applied": applied,
		"workNodeId": request.Payload["workNodeId"], "reportedState": request.Payload["state"],
		"failureReason": request.FailureReason, "summary": summary,
	})
}

func researchStateHandler(args map[string]any) (CallToolResult, error) {
	if stringArg(args, "action") == "status" {
		return researchStateStatusHandler(args)
	}
	if action := stringArg(args, "action"); action != "" && action != "report" {
		return researchUnknownAction("research_state", action, "report, status"), nil
	}
	store, result := researchToolStore(args)
	if result != nil {
		return *result, nil
	}
	for _, required := range []string{"runId", "workNodeId", "state"} {
		if strings.TrimSpace(stringArg(args, required)) == "" {
			return historyResearchError(errors.New("reporting work state requires " + required)), nil
		}
	}
	state := strings.TrimSpace(stringArg(args, "state"))
	if !research.ValidWorkState(state) {
		return historyResearchError(errors.New("unsupported work state " + state)), nil
	}
	run, err := store.GetRun(stringArg(args, "runId"))
	if err != nil {
		return historyResearchError(err), nil
	}
	if run.WorkNodeID == "" || run.WorkNodeID != stringArg(args, "workNodeId") {
		return historyResearchError(errors.New("a Run may report only on the WorkNode it owns")), nil
	}
	if run.Status != "running" && run.Status != "waiting_permission" && run.Status != "waiting_input" {
		return historyResearchError(errors.New("work state can be reported only while the agent Run is active")), nil
	}
	if run.NotebookID == "" {
		return historyResearchError(errors.New("this Run does not come from a work document")), nil
	}
	notebook, err := store.NotebookPath(run.NotebookID)
	if err != nil {
		return historyResearchError(err), nil
	}
	request, err := store.CreateCoordinatorRequest("worknode.state", map[string]any{
		"file": notebook, "workNodeId": run.WorkNodeID, "state": state,
		"reason": strings.TrimSpace(stringArg(args, "reason")), "runId": run.ID,
	}, "agent:run/"+run.ID)
	if err != nil {
		return historyResearchError(err), nil
	}
	return historyResearchJSON(map[string]any{
		"requestId": request.ID, "state": state, "workNodeId": run.WorkNodeID,
		// Recorded is not applied. Say so plainly and give the agent the way
		// to find out, rather than letting it assume the document changed.
		"applied": false,
		"note":    "Recorded, not yet applied. The editor applies it as an ordinary document edit; confirm with research_state {action: \"status\", requestId}.",
	})
}

func proposalCreateHandler(args map[string]any) (CallToolResult, error) {
	store, result := researchToolStore(args)
	if result != nil {
		return *result, nil
	}
	runID, workNodeID := stringArg(args, "runId"), stringArg(args, "workNodeId")
	run, err := store.GetRun(runID)
	if err != nil {
		return historyResearchError(err), nil
	}
	if run.SessionID == "" || run.WorkNodeID == "" || run.WorkNodeID != workNodeID {
		return historyResearchError(errors.New("proposal provenance does not belong to this agent Run")), nil
	}
	if run.Status != "running" && run.Status != "waiting_permission" && run.Status != "waiting_input" {
		return historyResearchError(errors.New("Proposals can be submitted only while their agent Run is active")), nil
	}
	rawPayload, ok := args["payload"].(map[string]any)
	if !ok || rawPayload == nil {
		return historyResearchError(errors.New("proposal payload must be an object")), nil
	}
	payload := make(map[string]any, len(rawPayload)+1)
	for key, value := range rawPayload {
		payload[key] = value
	}
	// The tool owns this reserved provenance field.  Agent-supplied values
	// cannot forge another Run or WorkNode association.
	payload["provenance"] = map[string]any{"run_id": run.ID, "work_node_id": run.WorkNodeID}
	proposal, err := store.CreateProposal(research.CreateProposalInput{
		ClientRequestID: stringArg(args, "clientRequestId"), WorkstreamID: run.WorkstreamID,
		Kind: stringArg(args, "kind"), Payload: payload,
		ProposedBy: "agent:run/" + run.ID, SourceAdapter: "noema-mcp",
	})
	if err != nil {
		return historyResearchError(err), nil
	}
	if proposal.Status != "pending" {
		return historyResearchError(errors.New("MCP may create only pending Proposals")), nil
	}
	return historyResearchJSON(proposal)
}

// researchChangesHandler answers "is this still verified against the code that
// is there now?".  Every Run snapshots the files it created or modified into
// the content-addressed store and links them to its WorkNode, so the question
// is answerable from what was already recorded.
//
// It only reports.  A changed foundation does not move a WorkNode's state:
// deciding what the change means for the claim is the person's judgement, and
// a tool that silently re-opened finished work would be guessing.
func researchChangesHandler(args map[string]any) (CallToolResult, error) {
	store, result := researchToolStore(args)
	if result != nil {
		return *result, nil
	}
	notebookID := stringArg(args, "notebookId")
	workNodeID := strings.TrimSpace(stringArg(args, "workNodeId"))
	if workNodeID == "" {
		cellID := stringArg(args, "cellId")
		if strings.TrimSpace(cellID) == "" {
			return historyResearchError(errors.New("changes needs a workNodeId or a cellId")), nil
		}
		view, err := store.ReadResearchCell(notebookID, cellID)
		if err != nil {
			return historyResearchError(err), nil
		}
		workNodeID = view.Cell.WorkNodeID
		if strings.TrimSpace(workNodeID) == "" {
			return historyResearchError(errors.New("that cell is not bound to a WorkNode")), nil
		}
	}
	changes, err := store.SourceChanges(research.ArtifactLinkFilter{
		NotebookID: notebookID, WorkNodeID: workNodeID,
	})
	if err != nil {
		return historyResearchError(err), nil
	}
	stale := 0
	for _, change := range changes {
		if change.State != "unchanged" {
			stale++
		}
	}
	return historyResearchJSON(map[string]any{
		"notebookId": notebookID, "workNodeId": workNodeID,
		"sources": changes, "changed": stale,
		"note": "Reported only; no WorkNode state was altered.",
	})
}

func researchCellHandler(args map[string]any) (CallToolResult, error) {
	if stringArg(args, "action") == "changes" {
		return researchChangesHandler(args)
	}
	store, result := researchToolStore(args)
	if result != nil {
		return *result, nil
	}
	view, err := store.ReadResearchCell(stringArg(args, "notebookId"), stringArg(args, "cellId"))
	if err != nil {
		return historyResearchError(err), nil
	}
	if stringArg(args, "action") == "read" {
		return historyResearchJSON(map[string]any{"notebookId": view.NotebookID, "workstreamId": view.WorkstreamID, "cell": view.Cell})
	}
	if stringArg(args, "action") == "neighbors" {
		return historyResearchJSON(view)
	}
	return researchUnknownAction("research_cell", stringArg(args, "action"), "read, neighbors, changes"), nil
}

func researchRunHandler(args map[string]any) (CallToolResult, error) {
	store, result := researchToolStore(args)
	if result != nil {
		return *result, nil
	}
	switch stringArg(args, "action") {
	case "list":
		limit, _ := args["limit"].(float64)
		runs, err := store.ListRuns(research.RunFilter{WorkstreamID: stringArg(args, "workstreamId"),
			SessionID: stringArg(args, "sessionId"), Limit: int(limit)})
		if err != nil {
			return historyResearchError(err), nil
		}
		return historyResearchJSON(map[string]any{"runs": runs})
	case "get":
		run, err := store.GetRun(stringArg(args, "id"))
		if err != nil {
			return historyResearchError(err), nil
		}
		return historyResearchJSON(run)
	case "output":
		output, err := store.ReadRunOutput(stringArg(args, "id"), boolArg(args, "includeTranscript"))
		if err != nil {
			return historyResearchError(err), nil
		}
		return historyResearchJSON(output)
	default:
		return researchUnknownAction("research_run", stringArg(args, "action"), "list, get, output"), nil
	}
}

func artifactHandler(args map[string]any) (CallToolResult, error) {
	store, result := researchToolStore(args)
	if result != nil {
		return *result, nil
	}
	switch stringArg(args, "action") {
	case "search":
		limit, _ := args["limit"].(float64)
		artifacts, err := store.ListArtifacts(research.ArtifactFilter{Query: stringArg(args, "query"), Kind: stringArg(args, "kind"), Limit: int(limit)})
		if err != nil {
			return historyResearchError(err), nil
		}
		return historyResearchJSON(map[string]any{"artifacts": artifacts})
	case "read":
		artifact, data, err := store.ReadArtifact(stringArg(args, "id"))
		if err != nil {
			return historyResearchError(err), nil
		}
		payload := map[string]any{"artifact": artifact}
		if strings.HasPrefix(artifact.MediaType, "text/") || strings.Contains(artifact.MediaType, "json") || strings.Contains(artifact.MediaType, "xml") {
			payload["text"] = string(data)
		} else {
			payload["dataBase64"] = base64.StdEncoding.EncodeToString(data)
		}
		return historyResearchJSON(payload)
	case "import":
		artifact, err := store.ImportArtifact(research.ImportArtifactInput{Kind: stringArg(args, "kind"),
			MediaType: stringArg(args, "mediaType"), ContentBase64: stringArg(args, "contentBase64"),
			WorkstreamID: stringArg(args, "workstreamId"), SourceURI: stringArg(args, "sourceUri")})
		if err != nil {
			return historyResearchError(err), nil
		}
		return historyResearchJSON(artifact)
	default:
		return researchUnknownAction("artifact", stringArg(args, "action"), "search, read, import"), nil
	}
}

func researchToolStore(args map[string]any) (*research.Store, *CallToolResult) {
	root := stringArg(args, "root")
	store, err := research.Open(root)
	if err != nil {
		result := historyResearchError(err)
		return nil, &result
	}
	return store, nil
}

func stringArg(args map[string]any, key string) string {
	value, _ := args[key].(string)
	return strings.TrimSpace(value)
}

func boolArg(args map[string]any, key string) bool {
	value, _ := args[key].(bool)
	return value
}

func researchUnknownAction(tool, action, expected string) CallToolResult {
	return CallToolResult{Content: []ContentItem{{Type: "text", Text: tool + " unknown action '" + action + "', expected one of: [" + expected + "]"}}, IsError: true}
}
