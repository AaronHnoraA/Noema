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
	Name: "research_cell", Description: "Read a Noema research cell and its explicit lineage/dependency neighbors. local_only cells are never returned.",
	InputSchema: ToolSchema{Type: "object", Properties: map[string]Property{
		"action":     {Type: "string", Description: "Operation", Enum: []string{"read", "neighbors"}},
		"root":       {Type: "string", Description: "Absolute Noema repository root"},
		"notebookId": {Type: "string", Description: "Research notebook id"},
		"cellId":     {Type: "string", Description: "Research cell id"},
	}, Required: []string{"action", "root", "notebookId", "cellId"}},
	Handler:       researchCellHandler,
	ActionEffects: map[string]ToolEffects{"read": {LocalRead: true}, "neighbors": {LocalRead: true}},
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
		"kind":            {Type: "string", Description: "Proposal kind", Enum: []string{"cell.create", "finding.create", "research_ir.create", "problem_model.create", "task.create", "job.create", "delegation.create"}},
		"payload":         {Type: "object", Description: "Untrusted candidate payload; @@ directives remain data until human acceptance"},
	}, Required: []string{"root", "runId", "workNodeId", "clientRequestId", "kind", "payload"}},
	Handler:       proposalCreateHandler,
	ActionEffects: map[string]ToolEffects{"": {LocalWrite: true}},
}

func init() {
	register(ResearchCellTool)
	register(ResearchRunTool)
	register(ArtifactTool)
	register(ProposalCreateTool)
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

func researchCellHandler(args map[string]any) (CallToolResult, error) {
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
	return researchUnknownAction("research_cell", stringArg(args, "action"), "read, neighbors"), nil
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
