package api

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/noema/research"
	"github.com/gin-gonic/gin"
)

func TestNoemaResearchRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	root := t.TempDir()
	t.Cleanup(research.CloseAll)
	notebook := `{"nbformat":4,"nbformat_minor":5,"metadata":{"noema_research":{"schema":"noema.research-notebook/1","notebook_id":"nb_api","workstream_id":"ws_api","title":"API"}},"cells":[{"id":"c-q","cell_type":"markdown","source":"Q","metadata":{"noema_research":{"kind":"question"}}}]}`
	if err := os.WriteFile(filepath.Join(root, "a.noema"), []byte(notebook), 0o644); err != nil {
		t.Fatal(err)
	}
	engine := gin.New()
	engine.POST("/api/noema/research/index", noemaResearchIndex)
	engine.POST("/api/noema/research/status", noemaResearchStatus)
	engine.POST("/api/noema/research/events", noemaResearchEvents)
	engine.POST("/api/noema/research/cell/resolve", noemaResearchCellResolve)
	engine.POST("/api/noema/research/session/promote", noemaResearchSessionPromote)
	engine.POST("/api/noema/research/session/list", noemaResearchSessions)
	engine.POST("/api/noema/research/session/get", noemaResearchSessionGet)
	engine.POST("/api/noema/research/session/manual/begin", noemaResearchSessionManualBegin)
	engine.POST("/api/noema/research/session/manual/end", noemaResearchSessionManualEnd)
	engine.POST("/api/noema/research/session/manual/get", noemaResearchSessionManualGet)
	engine.POST("/api/noema/research/run/prepare", noemaResearchRunPrepare)
	engine.POST("/api/noema/research/run/list", noemaResearchRuns)
	engine.POST("/api/noema/research/run/get", noemaResearchRunGet)
	engine.POST("/api/noema/research/run/fail-preparing", noemaResearchRunFailPreparing)
	engine.POST("/api/noema/research/artifact/get", noemaResearchArtifactGet)
	engine.POST("/api/noema/research/artifact/read", noemaResearchArtifactRead)
	engine.POST("/api/noema/research/artifact/import", noemaResearchArtifactImport)
	engine.POST("/api/noema/research/artifact/link/list", noemaResearchArtifactLinks)
	engine.POST("/api/noema/research/corpus/index", noemaResearchCorpusIndex)
	engine.POST("/api/noema/research/corpus/index-files", noemaResearchCorpusIndexFiles)
	engine.POST("/api/noema/research/corpus/search", noemaResearchCorpusSearch)
	engine.POST("/api/noema/research/corpus/block/read", noemaResearchCorpusBlockRead)
	engine.POST("/api/noema/research/capture/create", noemaResearchCaptureCreate)
	engine.POST("/api/noema/research/capture/list", noemaResearchCaptures)
	engine.POST("/api/noema/research/worker/lease/acquire", noemaResearchWorkerLeaseAcquire)
	engine.POST("/api/noema/research/worker/lease/renew", noemaResearchWorkerLeaseRenew)
	engine.POST("/api/noema/research/worker/lease/expire", noemaResearchWorkerLeaseExpire)
	engine.POST("/api/noema/research/worker/start", noemaResearchWorkerStart)
	engine.POST("/api/noema/research/worker/events", noemaResearchWorkerEvents)
	engine.POST("/api/noema/research/worker/permission", noemaResearchWorkerPermission)
	engine.POST("/api/noema/research/worker/input", noemaResearchWorkerInput)
	engine.POST("/api/noema/research/permission/get", noemaResearchPermissionGet)
	engine.POST("/api/noema/research/permission/decide", noemaResearchPermissionDecide)
	engine.POST("/api/noema/research/input/get", noemaResearchInputGet)
	engine.POST("/api/noema/research/input/respond", noemaResearchInputRespond)
	engine.POST("/api/noema/research/attention/list", noemaResearchAttentionList)
	engine.POST("/api/noema/research/proposal/create", noemaResearchProposalCreate)
	engine.POST("/api/noema/research/proposal/get", noemaResearchProposalGet)
	engine.POST("/api/noema/research/proposal/list", noemaResearchProposals)
	engine.POST("/api/noema/research/proposal/begin-accept", noemaResearchProposalBeginAccept)
	engine.POST("/api/noema/research/proposal/review", noemaResearchProposalReview)
	engine.POST("/api/noema/research/finding/get", noemaResearchFindingGet)
	engine.POST("/api/noema/research/finding/list", noemaResearchFindings)
	engine.POST("/api/noema/research/research-ir/list", noemaResearchIRList)
	engine.POST("/api/noema/research/problem-model/list", noemaResearchProblemModels)
	engine.POST("/api/noema/research/export/create", noemaResearchExportCreate)
	engine.POST("/api/noema/research/task/create", noemaResearchTaskCreate)
	engine.POST("/api/noema/research/task/get", noemaResearchTaskGet)
	engine.POST("/api/noema/research/task/list", noemaResearchTasks)
	engine.POST("/api/noema/research/task/transition", noemaResearchTaskTransition)
	engine.POST("/api/noema/research/job/create", noemaResearchJobCreate)
	engine.POST("/api/noema/research/job/get", noemaResearchJobGet)
	engine.POST("/api/noema/research/job/list", noemaResearchJobs)
	engine.POST("/api/noema/research/job/claim", noemaResearchJobClaim)
	engine.POST("/api/noema/research/job/start", noemaResearchJobStart)
	engine.POST("/api/noema/research/job/lease/renew", noemaResearchJobLeaseRenew)
	engine.POST("/api/noema/research/job/lease/expire", noemaResearchJobLeaseExpire)
	engine.POST("/api/noema/research/job/complete", noemaResearchJobComplete)
	engine.POST("/api/noema/research/job/fail", noemaResearchJobFail)
	engine.POST("/api/noema/research/job/unresolved", noemaResearchJobUnresolved)
	engine.POST("/api/noema/research/job/retry", noemaResearchJobRetry)
	engine.POST("/api/noema/research/invocation/get", noemaResearchInvocationGet)
	engine.POST("/api/noema/research/invocation/list", noemaResearchInvocations)
	engine.POST("/api/noema/research/scheduler/worker/register", noemaResearchSchedulerWorkerRegister)
	engine.POST("/api/noema/research/scheduler/worker/get", noemaResearchSchedulerWorkerGet)
	engine.POST("/api/noema/research/scheduler/worker/list", noemaResearchSchedulerWorkers)
	engine.POST("/api/noema/research/delegation/create", noemaResearchDelegationCreate)
	engine.POST("/api/noema/research/delegation/get", noemaResearchDelegationGet)
	engine.POST("/api/noema/research/delegation/list", noemaResearchDelegations)
	call := func(path string, body map[string]any) map[string]any {
		t.Helper()
		payload, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(payload)))
		req.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, req)
		var decoded map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
			t.Fatalf("%s: %v %s", path, err, recorder.Body.String())
		}
		return decoded
	}

	indexed := call("/api/noema/research/index", map[string]any{"root": root, "path": "a.noema", "actor": "test"})
	if code, _ := indexed["code"].(float64); code != 0 {
		t.Fatalf("index failed: %v", indexed)
	}
	data := indexed["data"].(map[string]any)
	if data["notebookId"] != "nb_api" || data["cells"].(float64) != 1 {
		t.Fatalf("unexpected index data %v", data)
	}

	status := call("/api/noema/research/status", map[string]any{"root": root, "path": "a.noema"})
	if statusData, _ := status["data"].(map[string]any); statusData == nil || statusData["stale"] != false {
		t.Fatalf("unexpected status %v", status)
	}

	events := call("/api/noema/research/events", map[string]any{"root": root, "notebookId": "nb_api"})
	eventData, _ := events["data"].(map[string]any)
	if list, _ := eventData["events"].([]any); len(list) != 1 {
		t.Fatalf("unexpected events %v", events)
	}
	location := call("/api/noema/research/cell/resolve", map[string]any{
		"root": root, "notebookId": "nb_api", "cellId": "c-q",
	})
	if locationData, _ := location["data"].(map[string]any); locationData == nil || locationData["path"] != "a.noema" {
		t.Fatalf("unexpected cell location %v", location)
	}

	escaped := call("/api/noema/research/index", map[string]any{"root": root, "path": "../outside.noema"})
	if code, _ := escaped["code"].(float64); code == 0 {
		t.Fatal("paths escaping the repository must be rejected")
	}

	promoted := call("/api/noema/research/session/promote", map[string]any{
		"root": root,
		"session": map[string]any{
			"workstreamId": "ws_api", "adapter": "magent", "transport": "acp",
			"nativeSessionId": "native-api", "executionTarget": root,
			"startedAt": "2026-09-12T01:02:03Z",
		},
	})
	promotedData, _ := promoted["data"].(map[string]any)
	sessionID, _ := promotedData["id"].(string)
	if sessionID == "" || promotedData["startedAt"] != "2026-09-12T01:02:03.000Z" {
		t.Fatalf("unexpected promotion %v", promoted)
	}
	listed := call("/api/noema/research/session/list", map[string]any{"root": root, "workstreamId": "ws_api"})
	listedData, _ := listed["data"].(map[string]any)
	if sessions, _ := listedData["sessions"].([]any); len(sessions) != 1 {
		t.Fatalf("unexpected session list %v", listed)
	}
	loaded := call("/api/noema/research/session/get", map[string]any{"root": root, "id": sessionID})
	loadedData, _ := loaded["data"].(map[string]any)
	if loadedData["nativeSessionId"] != "native-api" {
		t.Fatalf("unexpected session get %v", loaded)
	}
	manual := call("/api/noema/research/session/manual/begin", map[string]any{
		"root": root, "intervention": map[string]any{
			"sessionId": sessionID, "command": []any{"codex", "resume", "native-api"},
			"startedBy": "emacs", "expectedVersion": 1,
		},
	})
	manualData, _ := manual["data"].(map[string]any)
	manualID, _ := manualData["id"].(string)
	if manualID == "" || manualData["state"] != "active" {
		t.Fatalf("unexpected manual intervention %v", manual)
	}
	loadedManual := call("/api/noema/research/session/manual/get", map[string]any{"root": root, "id": manualID})
	if data, _ := loadedManual["data"].(map[string]any); data["state"] != "active" {
		t.Fatalf("unexpected loaded manual intervention %v", loadedManual)
	}
	endedManual := call("/api/noema/research/session/manual/end", map[string]any{
		"root": root, "intervention": map[string]any{
			"interventionId": manualID, "endedBy": "emacs", "reason": "handback", "expectedVersion": 1,
		},
	})
	if data, _ := endedManual["data"].(map[string]any); data["state"] != "ended" {
		t.Fatalf("unexpected ended manual intervention %v", endedManual)
	}

	prepared := call("/api/noema/research/run/prepare", map[string]any{
		"root": root,
		"run": map[string]any{
			"workstreamId": "ws_api", "sessionId": sessionID, "notebookId": "nb_api", "cellId": "c-q",
			"workNodeId": "wn_api_question",
			"sourceKind": "work-cell", "executionTarget": root,
			"spec":            map[string]any{"schema": "noema.run-spec/1", "prompt": "Investigate"},
			"contextManifest": map[string]any{"items": []any{}},
		},
	})
	preparedData, _ := prepared["data"].(map[string]any)
	preparedRun, _ := preparedData["run"].(map[string]any)
	frozenSpec, _ := preparedData["spec"].(map[string]any)
	runID, _ := preparedRun["id"].(string)
	if runID == "" || preparedRun["status"] != "preparing" || preparedRun["specArtifactId"] == "" || frozenSpec["run_id"] != runID {
		t.Fatalf("unexpected prepared run %v", prepared)
	}
	linkedArtifact := call("/api/noema/research/artifact/import", map[string]any{
		"root": root, "artifact": map[string]any{
			"kind": "run-file", "mediaType": "text/plain; charset=utf-8",
			"contentBase64": base64.StdEncoding.EncodeToString([]byte("ordinary output")),
			"runId":         runID, "sourceUri": "noema://file/notes/output.md",
			"metadata": map[string]any{"change": "created"},
		},
	})
	if linkedArtifact["code"].(float64) != 0 {
		t.Fatalf("unexpected linked artifact import %v", linkedArtifact)
	}
	links := call("/api/noema/research/artifact/link/list", map[string]any{
		"root": root, "workNodeId": "wn_api_question", "limit": 100,
	})
	linksData, _ := links["data"].(map[string]any)
	linkValues, _ := linksData["links"].([]any)
	if len(linkValues) != 1 || linkValues[0].(map[string]any)["sourceUri"] != "noema://file/notes/output.md" {
		t.Fatalf("WorkNode artifact provenance was not queryable %v", links)
	}
	artifact := call("/api/noema/research/artifact/read", map[string]any{"root": root, "id": preparedRun["specArtifactId"]})
	artifactData, _ := artifact["data"].(map[string]any)
	encoded, _ := artifactData["dataBase64"].(string)
	bytes, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(bytes) == 0 {
		t.Fatalf("runspec artifact must be readable %v (%v)", artifact, err)
	}
	storedSpec := map[string]any{}
	if err := json.Unmarshal(bytes, &storedSpec); err != nil || !reflect.DeepEqual(storedSpec, frozenSpec) {
		t.Fatalf("returned RunSpec must equal exact CAS bytes: stored=%v returned=%v (%v)", storedSpec, frozenSpec, err)
	}
	runs := call("/api/noema/research/run/list", map[string]any{"root": root, "sessionId": sessionID})
	runsData, _ := runs["data"].(map[string]any)
	if values, _ := runsData["runs"].([]any); len(values) != 1 {
		t.Fatalf("unexpected run list %v", runs)
	}

	acquired := call("/api/noema/research/worker/lease/acquire", map[string]any{
		"root": root, "lease": map[string]any{"sessionId": sessionID, "owner": "emacs:api", "ttlMillis": 30000},
	})
	leaseData, _ := acquired["data"].(map[string]any)
	epoch, _ := leaseData["epoch"].(float64)
	if epoch != 1 {
		t.Fatalf("unexpected lease %v", acquired)
	}
	started := call("/api/noema/research/worker/start", map[string]any{
		"root": root, "start": map[string]any{"sessionId": sessionID, "owner": "emacs:api", "epoch": epoch, "runId": runID},
	})
	startedData, _ := started["data"].(map[string]any)
	if startedData["status"] != "running" {
		t.Fatalf("unexpected started run %v", started)
	}
	requested := call("/api/noema/research/worker/permission", map[string]any{
		"root": root,
		"permission": map[string]any{
			"sessionId": sessionID, "owner": "emacs:api", "epoch": epoch, "runId": runID, "nativeRequestId": "request-api-1",
			"action":  map[string]any{"kind": "edit", "paths": []any{"notes/a.md"}},
			"options": []any{map[string]any{"optionId": "allow_once"}, map[string]any{"optionId": "reject_once"}},
		},
	})
	permissionData, _ := requested["data"].(map[string]any)
	permissionID, _ := permissionData["id"].(string)
	if permissionID == "" || permissionData["state"] != "pending" {
		t.Fatalf("unexpected permission %v", requested)
	}
	resolved := call("/api/noema/research/permission/decide", map[string]any{
		"root": root, "decision": map[string]any{"permissionId": permissionID, "optionId": "allow_once", "expectedVersion": 1, "decidedBy": "test"},
	})
	resolvedData, _ := resolved["data"].(map[string]any)
	if resolvedData["state"] != "resolved" || resolvedData["version"].(float64) != 2 {
		t.Fatalf("unexpected permission resolution %v", resolved)
	}
	requestedInput := call("/api/noema/research/worker/input", map[string]any{
		"root": root,
		"input": map[string]any{
			"sessionId": sessionID, "owner": "emacs:api", "epoch": epoch, "runId": runID,
			"nativeRequestId": "input-api-1", "prompt": "Choose", "inputKind": "select",
			"options": []any{map[string]any{"id": "a", "label": "A"}},
		},
	})
	inputData, _ := requestedInput["data"].(map[string]any)
	inputID, _ := inputData["id"].(string)
	if inputID == "" || inputData["state"] != "pending" || inputData["epoch"] != epoch {
		t.Fatalf("unexpected input request %v", requestedInput)
	}
	loadedInput := call("/api/noema/research/input/get", map[string]any{"root": root, "id": inputID})
	if data, _ := loadedInput["data"].(map[string]any); data["prompt"] != "Choose" {
		t.Fatalf("unexpected loaded input %v", loadedInput)
	}
	answeredInput := call("/api/noema/research/input/respond", map[string]any{
		"root": root, "response": map[string]any{
			"runId": runID, "requestId": inputID, "answer": map[string]any{"choice": "a"}, "answeredBy": "mobile",
		},
	})
	if data, _ := answeredInput["data"].(map[string]any); data["state"] != "resolved" || data["answeredBy"] != "mobile" {
		t.Fatalf("unexpected input answer %v", answeredInput)
	}
	reported := call("/api/noema/research/worker/events", map[string]any{
		"root": root,
		"events": map[string]any{
			"sessionId": sessionID, "owner": "emacs:api", "epoch": epoch, "runId": runID,
			"events": []any{map[string]any{"type": "run.status.changed", "payload": map[string]any{"status": "completed"}}},
		},
	})
	if data, _ := reported["data"].(map[string]any); len(data["events"].([]any)) != 1 {
		t.Fatalf("unexpected worker report %v", reported)
	}
	loadedRun := call("/api/noema/research/run/get", map[string]any{"root": root, "id": runID})
	loadedRunData, _ := loadedRun["data"].(map[string]any)
	if loadedRunData["status"] != "completed" {
		t.Fatalf("run completion was not persisted %v", loadedRun)
	}
	preparedFailure := call("/api/noema/research/run/prepare", map[string]any{
		"root": root,
		"run": map[string]any{
			"workstreamId": "ws_api", "sessionId": sessionID, "notebookId": "nb_api", "cellId": "c-q",
			"workNodeId": "wn_api_question",
			"sourceKind": "work-cell", "executionTarget": root,
			"spec": map[string]any{"schema": "noema.run-spec/1", "prompt": "Bootstrap failure"},
		},
	})
	preparedFailureData, _ := preparedFailure["data"].(map[string]any)
	preparedFailureRun, _ := preparedFailureData["run"].(map[string]any)
	failed := call("/api/noema/research/run/fail-preparing", map[string]any{
		"root": root, "failure": map[string]any{
			"runId": preparedFailureRun["id"], "failureReason": "adapter unavailable",
		},
	})
	failedData, _ := failed["data"].(map[string]any)
	if failedData["status"] != "failed" || failedData["startedAt"] != nil || failedData["failureReason"] != "adapter unavailable" {
		t.Fatalf("unexpected pre-dispatch failure %v", failed)
	}
	captured := call("/api/noema/research/capture/create", map[string]any{
		"root": root, "capture": map[string]any{
			"clientRequestId": "api-capture-1", "url": "https://example.test/proof", "title": "Proof",
			"adapter": "generic-selection", "completeness": "selection", "capturedAt": "2026-09-13T08:00:00Z",
			"markdown": "Selected proof", "sanitizedHtml": "<p>Selected proof</p>",
		},
	})
	capturedData, _ := captured["data"].(map[string]any)
	if capturedData["id"] == "" || capturedData["artifactId"] == "" || capturedData["completeness"] != "selection" {
		t.Fatalf("unexpected capture %v", captured)
	}
	captureList := call("/api/noema/research/capture/list", map[string]any{"root": root, "limit": 10})
	captureListData, _ := captureList["data"].(map[string]any)
	if values, _ := captureListData["captures"].([]any); len(values) != 1 {
		t.Fatalf("unexpected capture list %v", captureList)
	}
	proposal := call("/api/noema/research/proposal/create", map[string]any{
		"root": root, "proposal": map[string]any{
			"clientRequestId": "api-proposal-1", "workstreamId": "ws_api", "kind": "finding.create",
			"proposedBy": "agent:magent", "sourceAdapter": "magent/gptel",
			"payload": map[string]any{"finding": map[string]any{
				"kind": "observation", "statement": "Selected proof", "status": "proposed",
				"verification": map[string]any{"level": "unreviewed"}, "disclosure": "project",
				"evidence": []any{map[string]any{"relation": "supports", "artifactId": capturedData["artifactId"],
					"byteStart": 0, "byteEnd": len("Selected proof")}},
			}},
		},
	})
	proposalData, _ := proposal["data"].(map[string]any)
	if proposalData["status"] != "pending" || proposalData["version"].(float64) != 1 {
		t.Fatalf("unexpected Proposal %v", proposal)
	}
	attention := call("/api/noema/research/attention/list", map[string]any{"root": root})
	attentionData, _ := attention["data"].(map[string]any)
	if values, _ := attentionData["proposals"].([]any); len(values) != 1 {
		t.Fatalf("pending Proposal missing from Attention %v", attention)
	}
	reviewed := call("/api/noema/research/proposal/review", map[string]any{
		"root": root, "review": map[string]any{"proposalId": proposalData["id"], "decision": "accept",
			"expectedVersion": 1, "reviewedBy": "human:api-test"},
	})
	reviewedData, _ := reviewed["data"].(map[string]any)
	findingData, _ := reviewedData["finding"].(map[string]any)
	if findingData["statement"] != "Selected proof" || findingData["verificationLevel"] != "unreviewed" {
		t.Fatalf("unexpected accepted Finding %v", reviewed)
	}
	findingList := call("/api/noema/research/finding/list", map[string]any{"root": root, "workstreamId": "ws_api"})
	findingListData, _ := findingList["data"].(map[string]any)
	if values, _ := findingListData["findings"].([]any); len(values) != 1 {
		t.Fatalf("unexpected Finding list %v", findingList)
	}
	cellProposal := call("/api/noema/research/proposal/create", map[string]any{
		"root": root, "proposal": map[string]any{
			"clientRequestId": "api-cell-proposal-1", "workstreamId": "ws_api", "kind": "cell.create",
			"proposedBy": "agent:magent", "sourceAdapter": "magent/gptel",
			"payload": map[string]any{"cell": map[string]any{
				"notebookId": "nb_api", "cellId": "c-q", "kind": "question", "title": "", "source": "Q"}},
		},
	})
	cellProposalData, _ := cellProposal["data"].(map[string]any)
	reserved := call("/api/noema/research/proposal/begin-accept", map[string]any{
		"root": root, "review": map[string]any{"proposalId": cellProposalData["id"],
			"expectedVersion": 1, "reviewedBy": "human:api-test"},
	})
	reservedData, _ := reserved["data"].(map[string]any)
	reservedProposal, _ := reservedData["proposal"].(map[string]any)
	if reservedProposal["status"] != "accepting" || reservedProposal["version"].(float64) != 2 {
		t.Fatalf("unexpected cell Proposal reservation %v", reserved)
	}
	cellReviewed := call("/api/noema/research/proposal/review", map[string]any{
		"root": root, "review": map[string]any{"proposalId": cellProposalData["id"], "decision": "accept",
			"expectedVersion": 2, "reviewedBy": "human:api-test", "acceptedRef": "noema://cell/nb_api/c-q"},
	})
	cellReviewedData, _ := cellReviewed["data"].(map[string]any)
	cellReviewedProposal, _ := cellReviewedData["proposal"].(map[string]any)
	if cellReviewedProposal["status"] != "accepted" || cellReviewedProposal["version"].(float64) != 3 {
		t.Fatalf("unexpected cell Proposal finalization %v", cellReviewed)
	}
	parentTask := call("/api/noema/research/task/create", map[string]any{"root": root, "task": map[string]any{
		"clientRequestId": "api-task-parent", "workstreamId": "ws_api", "createdBy": "human:api-test",
		"task": map[string]any{"title": "Parent synthesis", "objective": "Coordinate the proof", "disclosure": "project"},
	}})
	parentTaskData, _ := parentTask["data"].(map[string]any)
	childTask := call("/api/noema/research/task/create", map[string]any{"root": root, "task": map[string]any{
		"clientRequestId": "api-task-child", "workstreamId": "ws_api", "createdBy": "human:api-test",
		"task": map[string]any{"parentTaskId": parentTaskData["id"], "title": "Deterministic check",
			"objective": "Run the focused checks", "acceptanceCriteria": []any{"exit code is zero"}, "disclosure": "project"},
	}})
	childTaskData, _ := childTask["data"].(map[string]any)
	if parentTaskData["state"] != "open" || childTaskData["parentTaskId"] != parentTaskData["id"] {
		t.Fatalf("unexpected task materialization parent=%v child=%v", parentTask, childTask)
	}
	jobResponse := call("/api/noema/research/job/create", map[string]any{"root": root, "job": map[string]any{
		"clientRequestId": "api-job-1", "workstreamId": "ws_api", "createdBy": "human:api-test",
		"job": map[string]any{"taskId": childTaskData["id"], "kind": "tests.run",
			"requirements": map[string]any{"capabilities": []any{"tests.run"}},
			"inference":    map[string]any{"policy": "forbidden"}, "effects": map[string]any{"class": "pure"},
			"budget":              map[string]any{"wallTimeSecondsMax": 60},
			"retry":               map[string]any{"policy": "safe_only", "attemptsMax": 2},
			"completionCondition": map[string]any{"exitCode": 0}},
	}})
	jobData, _ := jobResponse["data"].(map[string]any)
	jobID, _ := jobData["id"].(string)
	if jobData["state"] != "queued" || jobID == "" {
		t.Fatalf("unexpected Job %v", jobResponse)
	}
	workerResponse := call("/api/noema/research/scheduler/worker/register", map[string]any{"root": root,
		"worker": map[string]any{"id": "worker:api:deterministic", "kind": "deterministic",
			"transport": "in-process", "capabilities": []any{"tests.run"}}})
	workerData, _ := workerResponse["data"].(map[string]any)
	claimResponse := call("/api/noema/research/job/claim", map[string]any{"root": root,
		"claim": map[string]any{"jobId": jobID, "workerId": workerData["id"],
			"claimRequestId": "api-claim-1", "executionMode": "deterministic", "ttlMillis": 30000}})
	claimData, _ := claimResponse["data"].(map[string]any)
	invocationData, _ := claimData["invocation"].(map[string]any)
	jobLeaseData, _ := claimData["lease"].(map[string]any)
	credentials := map[string]any{"jobId": jobID, "invocationId": invocationData["id"], "workerId": workerData["id"],
		"token": jobLeaseData["token"], "epoch": jobLeaseData["epoch"]}
	startedJob := call("/api/noema/research/job/start", map[string]any{"root": root, "lease": credentials})
	if data, _ := startedJob["data"].(map[string]any); data["state"] != "running" {
		t.Fatalf("unexpected started Job %v", startedJob)
	}
	completedJob := call("/api/noema/research/job/complete", map[string]any{"root": root,
		"completion": map[string]any{"jobId": credentials["jobId"], "invocationId": credentials["invocationId"],
			"workerId": credentials["workerId"], "token": credentials["token"], "epoch": credentials["epoch"],
			"result": map[string]any{"exitCode": 0}, "artifactIds": []any{capturedData["artifactId"]},
			"usage": map[string]any{"inputTokens": 0, "outputTokens": 0, "costMicrousd": 0, "inferenceCalls": 0}},
	})
	completedData, _ := completedJob["data"].(map[string]any)
	completedJobData, _ := completedData["job"].(map[string]any)
	if completedJobData["state"] != "completed" {
		t.Fatalf("unexpected completed Job %v", completedJob)
	}
	delegationResponse := call("/api/noema/research/delegation/create", map[string]any{"root": root,
		"delegation": map[string]any{"clientRequestId": "api-delegation-1", "workstreamId": "ws_api",
			"delegation": map[string]any{"parentTaskId": parentTaskData["id"],
				"requestedBy": map[string]any{"type": "human", "id": "human:api-test"},
				"reason":      map[string]any{"summary": "Delegate the deterministic verification."},
				"childTaskId": childTaskData["id"], "childJobIds": []any{jobID}}}})
	delegationData, _ := delegationResponse["data"].(map[string]any)
	if outputs, _ := delegationData["outputArtifactIds"].([]any); len(outputs) != 1 || outputs[0] != capturedData["artifactId"] {
		t.Fatalf("delegation provenance did not reach output artifact %v", delegationResponse)
	}
	invocationList := call("/api/noema/research/invocation/list", map[string]any{"root": root, "jobId": jobID})
	if data, _ := invocationList["data"].(map[string]any); len(data["invocations"].([]any)) != 1 {
		t.Fatalf("unexpected Invocation list %v", invocationList)
	}
	exported := call("/api/noema/research/export/create", map[string]any{"root": root,
		"export": map[string]any{"workstreamId": "ws_api", "exportedBy": "human:api-test"}})
	exportedData, _ := exported["data"].(map[string]any)
	exportArtifact, _ := exportedData["artifact"].(map[string]any)
	if exportArtifact["kind"] != "workstream-export" || exportArtifact["sha256"] == "" {
		t.Fatalf("unexpected Workstream export %v", exported)
	}
}
