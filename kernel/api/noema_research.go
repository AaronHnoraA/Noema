// Noema research index routes are Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package api

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"github.com/88250/gulu"
	"github.com/aaronhe/noema/kernel/noema/research"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/gin-gonic/gin"
)

func noemaResearchStore(arg map[string]any, ret *gulu.Result) (*research.Store, bool) {
	var root string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("root", &root, true, true)) {
		return nil, false
	}
	store, err := research.Open(root)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return nil, false
	}
	return store, true
}

func noemaResearchIndex(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	var path, actor, reason string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("path", &path, true, true),
		util.BindJsonArg("actor", &actor, false, false),
		util.BindJsonArg("reason", &reason, false, false)) {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	result, err := store.IndexNotebook(path, research.IndexOptions{Actor: actor, Reason: reason})
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = result
}

func noemaResearchStatus(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	var path string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("path", &path, true, true)) {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	status, err := store.Status(path)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = status
}

func noemaResearchEvents(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	var notebookID string
	var after, limit float64
	var latestPerWorkNode bool
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("notebookId", &notebookID, false, false),
		util.BindJsonArg("after", &after, false, false),
		util.BindJsonArg("limit", &limit, false, false),
		util.BindJsonArg("latestPerWorkNode", &latestPerWorkNode, false, false)) {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var events []research.Event
	var err error
	if latestPerWorkNode {
		events, err = store.LatestWorkNodeActivity(notebookID)
	} else {
		events, err = store.Events(notebookID, int64(after), int(limit))
	}
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{"events": events}
}

func noemaResearchCellResolve(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	var notebookID, cellID string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("notebookId", &notebookID, true, true),
		util.BindJsonArg("cellId", &cellID, true, true)) {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	location, err := store.ResolveResearchCell(notebookID, cellID)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = location
}

func noemaResearchSessionPromote(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.PromoteSessionInput{}
	if !decodeResearchInput(arg, "session", &input, ret) {
		return
	}
	session, err := store.PromoteSession(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = session
}

func noemaResearchSessions(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var workstreamID, adapter string
	var limit float64
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("workstreamId", &workstreamID, false, false),
		util.BindJsonArg("adapter", &adapter, false, false),
		util.BindJsonArg("limit", &limit, false, false)) {
		return
	}
	sessions, err := store.ListSessions(research.SessionFilter{WorkstreamID: workstreamID, Adapter: adapter, Limit: int(limit)})
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"sessions": sessions}
}

func noemaResearchSessionGet(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var id string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("id", &id, true, true)) {
		return
	}
	session, err := store.GetSession(id)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = session
}

func noemaResearchSessionManualBegin(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.BeginManualInterventionInput{}
	if !decodeResearchInput(arg, "intervention", &input, ret) {
		return
	}
	intervention, err := store.BeginManualIntervention(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = intervention
}

func noemaResearchSessionManualEnd(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.EndManualInterventionInput{}
	if !decodeResearchInput(arg, "intervention", &input, ret) {
		return
	}
	intervention, err := store.EndManualIntervention(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = intervention
}

func noemaResearchSessionManualGet(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var id string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("id", &id, true, true)) {
		return
	}
	intervention, err := store.GetManualIntervention(id)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = intervention
}

func noemaResearchRunPrepare(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.PrepareRunInput{}
	if !decodeResearchInput(arg, "run", &input, ret) {
		return
	}
	run, err := store.PrepareRun(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"run": run, "spec": input.Spec}
}

func noemaResearchRuns(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var workstreamID, sessionID string
	var limit float64
	var latestPerWorkNode bool
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("workstreamId", &workstreamID, false, false),
		util.BindJsonArg("sessionId", &sessionID, false, false),
		util.BindJsonArg("limit", &limit, false, false),
		util.BindJsonArg("latestPerWorkNode", &latestPerWorkNode, false, false)) {
		return
	}
	runs, err := store.ListRuns(research.RunFilter{WorkstreamID: workstreamID, SessionID: sessionID, Limit: int(limit),
		LatestPerWorkNode: latestPerWorkNode})
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"runs": runs}
}

func noemaResearchRunHandoff(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var id string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("id", &id, true, true)) {
		return
	}
	handoffID, transcriptID, err := store.RunTerminalArtifactIDs(id)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"handoffArtifactId": handoffID, "transcriptArtifactId": transcriptID}
}

func noemaResearchRunGet(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var id string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("id", &id, true, true)) {
		return
	}
	run, err := store.GetRun(id)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = run
}

func noemaResearchRunLive(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var id string
	var after, limit float64
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("id", &id, true, true),
		util.BindJsonArg("after", &after, false, false),
		util.BindJsonArg("limit", &limit, false, false)) {
		return
	}
	live, err := store.LiveRun(id, int64(after), int(limit))
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = live
}

func noemaResearchRunCancel(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.CancelRunInput{}
	if !decodeResearchInput(arg, "cancellation", &input, ret) {
		return
	}
	run, err := store.RequestRunCancellation(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = run
}

func noemaResearchRunFailPreparing(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.FailPreparedRunInput{}
	if !decodeResearchInput(arg, "failure", &input, ret) {
		return
	}
	run, err := store.FailPreparedRun(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = run
}

func noemaResearchArtifactGet(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var id string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("id", &id, true, true)) {
		return
	}
	artifact, err := store.GetArtifact(id)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = artifact
}

func noemaResearchArtifactRead(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var id string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("id", &id, true, true)) {
		return
	}
	artifact, data, err := store.ReadArtifact(id)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"artifact": artifact, "dataBase64": base64.StdEncoding.EncodeToString(data)}
}

func noemaResearchArtifactImport(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.ImportArtifactInput{}
	if !decodeResearchInput(arg, "artifact", &input, ret) {
		return
	}
	artifact, err := store.ImportArtifact(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = artifact
}

func noemaResearchArtifactLinks(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var workstreamID, notebookID, workNodeID, runID string
	// `util.JsonArg' decodes JSON numbers as float64 before binding.  Convert at
	// the API boundary; binding directly to int rejects ordinary browser calls.
	var limit float64
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("workstreamId", &workstreamID, false, false),
		util.BindJsonArg("notebookId", &notebookID, false, false),
		util.BindJsonArg("workNodeId", &workNodeID, false, false),
		util.BindJsonArg("runId", &runID, false, false),
		util.BindJsonArg("limit", &limit, false, false)) {
		return
	}
	links, err := store.ListArtifactLinks(research.ArtifactLinkFilter{
		WorkstreamID: workstreamID, NotebookID: notebookID, WorkNodeID: workNodeID, RunID: runID, Limit: int(limit),
	})
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"links": links}
}

func noemaResearchCorpusIndex(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.IndexArtifactCorpusInput{}
	if !decodeResearchInput(arg, "index", &input, ret) {
		return
	}
	result, err := store.IndexMarkdownCorpus(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = result
}

func noemaResearchCorpusIndexFiles(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.IndexArtifactCorpusInput{}
	if !decodeResearchInput(arg, "index", &input, ret) {
		return
	}
	result, err := store.IndexMarkdownFiles(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = result
}

func noemaResearchCorpusSearch(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.SearchArtifactBlocksInput{}
	if !decodeResearchInput(arg, "search", &input, ret) {
		return
	}
	hits, err := store.SearchArtifactBlocks(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"hits": hits}
}

func noemaResearchCorpusBlockRead(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var id string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("id", &id, true, true)) {
		return
	}
	block, err := store.ReadArtifactBlock(id)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = block
}

func noemaResearchCaptureCreate(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.CaptureInput{}
	if !decodeResearchInput(arg, "capture", &input, ret) {
		return
	}
	capture, err := store.CreateCapture(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = capture
}

func noemaResearchCaptures(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var limit float64
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("limit", &limit, false, false)) {
		return
	}
	captures, err := store.ListCaptures(int(limit))
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"captures": captures}
}

func noemaResearchWorkerLeaseAcquire(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.AcquireLeaseInput{}
	if !decodeResearchInput(arg, "lease", &input, ret) {
		return
	}
	lease, err := store.AcquireLease(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = lease
}

func noemaResearchWorkerLeaseRenew(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.RenewLeaseInput{}
	if !decodeResearchInput(arg, "lease", &input, ret) {
		return
	}
	lease, err := store.RenewLease(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = lease
}

func noemaResearchWorkerLeaseExpire(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	runs, err := store.ExpireLeases()
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"interrupted": runs}
}

func noemaResearchWorkerStart(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.StartRunInput{}
	if !decodeResearchInput(arg, "start", &input, ret) {
		return
	}
	run, err := store.StartRun(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = run
}

func noemaResearchLocalRunStart(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.StartLocalRunInput{}
	if !decodeResearchInput(arg, "start", &input, ret) {
		return
	}
	run, err := store.StartLocalRun(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = run
}

func noemaResearchWorkerAttach(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.AttachRunInput{}
	if !decodeResearchInput(arg, "attachment", &input, ret) {
		return
	}
	run, err := store.AttachRunToSession(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = run
}

func noemaResearchWorkerEvents(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.ReportWorkerEventsInput{}
	if !decodeResearchInput(arg, "events", &input, ret) {
		return
	}
	events, err := store.ReportWorkerEvents(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"events": events}
}

func noemaResearchLocalRunEvents(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.ReportLocalRunEventsInput{}
	if !decodeResearchInput(arg, "events", &input, ret) {
		return
	}
	events, err := store.ReportLocalRunEvents(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"events": events}
}

func noemaResearchWorkerPermission(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.RequestPermissionInput{}
	if !decodeResearchInput(arg, "permission", &input, ret) {
		return
	}
	permission, err := store.RequestPermission(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = permission
}

func noemaResearchWorkerInput(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.RequestInputInput{}
	if !decodeResearchInput(arg, "input", &input, ret) {
		return
	}
	request, err := store.RequestInput(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = request
}

func noemaResearchPermissionGet(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var id string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("id", &id, true, true)) {
		return
	}
	permission, err := store.GetPermission(id)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = permission
}

func noemaResearchPermissionDecide(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.DecidePermissionInput{}
	if !decodeResearchInput(arg, "decision", &input, ret) {
		return
	}
	permission, err := store.DecidePermission(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = permission
}

func noemaResearchInputGet(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var id string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("id", &id, true, true)) {
		return
	}
	request, err := store.GetInputRequest(id)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = request
}

func noemaResearchInputRespond(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.RespondInputInput{}
	if !decodeResearchInput(arg, "response", &input, ret) {
		return
	}
	request, err := store.RespondInput(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = request
}

func noemaResearchAttentionList(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	attention, err := store.ListAttention()
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = attention
}

func noemaResearchProposalCreate(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.CreateProposalInput{}
	if !decodeResearchInput(arg, "proposal", &input, ret) {
		return
	}
	proposal, err := store.CreateProposal(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = proposal
}

func noemaResearchProposalGet(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var id string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("id", &id, true, true)) {
		return
	}
	proposal, err := store.GetProposal(id)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = proposal
}

func noemaResearchProposals(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var workstreamID, status string
	var limit float64
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("workstreamId", &workstreamID, false, false),
		util.BindJsonArg("status", &status, false, false),
		util.BindJsonArg("limit", &limit, false, false)) {
		return
	}
	proposals, err := store.ListProposals(research.ProposalFilter{WorkstreamID: workstreamID, Status: status, Limit: int(limit)})
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"proposals": proposals}
}

func noemaResearchProposalReview(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.ReviewProposalInput{}
	if !decodeResearchInput(arg, "review", &input, ret) {
		return
	}
	result, err := store.ReviewProposal(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = result
}

func noemaResearchProposalBeginAccept(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.BeginProposalAcceptanceInput{}
	if !decodeResearchInput(arg, "review", &input, ret) {
		return
	}
	proposal, err := store.BeginProposalAcceptance(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"proposal": proposal}
}

func noemaResearchFindingGet(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var id string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("id", &id, true, true)) {
		return
	}
	finding, err := store.GetFinding(id)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = finding
}

func noemaResearchFindings(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var workstreamID, status, query string
	var limit float64
	var includeLocal bool
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("workstreamId", &workstreamID, false, false),
		util.BindJsonArg("status", &status, false, false),
		util.BindJsonArg("query", &query, false, false),
		util.BindJsonArg("limit", &limit, false, false),
		util.BindJsonArg("includeLocal", &includeLocal, false, false)) {
		return
	}
	findings, err := store.ListFindings(research.FindingFilter{WorkstreamID: workstreamID, Status: status,
		Query: query, Limit: int(limit), IncludeLocal: includeLocal})
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"findings": findings}
}

func noemaResearchIRList(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var workstreamID string
	var limit float64
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("workstreamId", &workstreamID, true, true),
		util.BindJsonArg("limit", &limit, false, false)) {
		return
	}
	versions, err := store.ListResearchIR(workstreamID, int(limit))
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"versions": versions}
}

func noemaResearchProblemModels(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var workstreamID string
	var limit float64
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("workstreamId", &workstreamID, true, true),
		util.BindJsonArg("limit", &limit, false, false)) {
		return
	}
	versions, err := store.ListProblemModels(workstreamID, int(limit))
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"versions": versions}
}

func noemaResearchExportCreate(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.CreateWorkstreamExportInput{}
	if !decodeResearchInput(arg, "export", &input, ret) {
		return
	}
	result, err := store.CreateWorkstreamExport(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = result
}

func noemaResearchTaskCreate(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.CreateTaskInput{}
	if !decodeResearchInput(arg, "task", &input, ret) {
		return
	}
	value, err := store.CreateTask(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = value
}

func noemaResearchTaskGet(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var id string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("id", &id, true, true)) {
		return
	}
	value, err := store.GetTask(id)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = value
}

func noemaResearchTasks(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var workstreamID, state string
	var limit float64
	var includeLocal bool
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("workstreamId", &workstreamID, false, false),
		util.BindJsonArg("state", &state, false, false), util.BindJsonArg("limit", &limit, false, false),
		util.BindJsonArg("includeLocal", &includeLocal, false, false)) {
		return
	}
	values, err := store.ListTasks(research.TaskFilter{WorkstreamID: workstreamID, State: state,
		Limit: int(limit), IncludeLocal: includeLocal})
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"tasks": values}
}

func noemaResearchTaskTransition(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.TransitionTaskInput{}
	if !decodeResearchInput(arg, "transition", &input, ret) {
		return
	}
	value, err := store.TransitionTask(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = value
}

func noemaResearchJobCreate(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.CreateJobInput{}
	if !decodeResearchInput(arg, "job", &input, ret) {
		return
	}
	value, err := store.CreateJob(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = value
}

func noemaResearchJobGet(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var id string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("id", &id, true, true)) {
		return
	}
	value, err := store.GetJob(id)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = value
}

func noemaResearchJobs(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var workstreamID, taskID, state string
	var limit float64
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("workstreamId", &workstreamID, false, false),
		util.BindJsonArg("taskId", &taskID, false, false), util.BindJsonArg("state", &state, false, false),
		util.BindJsonArg("limit", &limit, false, false)) {
		return
	}
	values, err := store.ListJobs(research.JobFilter{WorkstreamID: workstreamID, TaskID: taskID,
		State: state, Limit: int(limit)})
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"jobs": values}
}

func noemaResearchJobClaim(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.ClaimJobInput{}
	if !decodeResearchInput(arg, "claim", &input, ret) {
		return
	}
	value, err := store.ClaimJob(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = value
}

func noemaResearchJobStart(c *gin.Context) {
	noemaResearchJobLeaseTransition(c, "start")
}

func noemaResearchJobLeaseRenew(c *gin.Context) {
	noemaResearchJobLeaseTransition(c, "renew")
}

func noemaResearchJobLeaseTransition(c *gin.Context, operation string) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.JobLeaseInput{}
	if !decodeResearchInput(arg, "lease", &input, ret) {
		return
	}
	if operation == "renew" {
		value, err := store.RenewJobLease(input)
		if err != nil {
			ret.Code, ret.Msg = -1, err.Error()
			return
		}
		ret.Data = value
		return
	}
	value, err := store.StartJob(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = value
}

func noemaResearchJobLeaseExpire(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var workstreamID string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("workstreamId", &workstreamID, false, false)) {
		return
	}
	values, err := store.ExpireJobLeases(workstreamID)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"jobs": values}
}

func noemaResearchJobComplete(c *gin.Context) {
	noemaResearchJobFinish(c, "complete")
}

func noemaResearchJobFail(c *gin.Context) {
	noemaResearchJobFinish(c, "fail")
}

func noemaResearchJobUnresolved(c *gin.Context) {
	noemaResearchJobFinish(c, "unresolved")
}

func noemaResearchJobFinish(c *gin.Context, operation string) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.FinishJobInput{}
	if !decodeResearchInput(arg, "completion", &input, ret) {
		return
	}
	var value research.FinishJobResult
	var err error
	switch operation {
	case "complete":
		value, err = store.CompleteJob(input)
	case "fail":
		value, err = store.FailJob(input)
	default:
		value, err = store.ReportJobUnresolved(input)
	}
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = value
}

func noemaResearchJobRetry(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.RetryJobInput{}
	if !decodeResearchInput(arg, "retry", &input, ret) {
		return
	}
	value, err := store.RetryJob(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = value
}

func noemaResearchInvocationGet(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var id string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("id", &id, true, true)) {
		return
	}
	value, err := store.GetInvocation(id)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = value
}

func noemaResearchInvocations(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var jobID string
	var limit float64
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("jobId", &jobID, true, true),
		util.BindJsonArg("limit", &limit, false, false)) {
		return
	}
	values, err := store.ListInvocations(jobID, int(limit))
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"invocations": values}
}

func noemaResearchSchedulerWorkerRegister(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.RegisterWorkerInput{}
	if !decodeResearchInput(arg, "worker", &input, ret) {
		return
	}
	value, err := store.RegisterWorker(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = value
}

func noemaResearchSchedulerWorkerGet(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var id string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("id", &id, true, true)) {
		return
	}
	value, err := store.GetWorker(id)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = value
}

func noemaResearchSchedulerWorkers(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var state string
	var limit float64
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("state", &state, false, false),
		util.BindJsonArg("limit", &limit, false, false)) {
		return
	}
	values, err := store.ListWorkers(state, int(limit))
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"workers": values}
}

func noemaResearchDelegationCreate(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	input := research.CreateDelegationInput{}
	if !decodeResearchInput(arg, "delegation", &input, ret) {
		return
	}
	value, err := store.CreateDelegation(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = value
}

func noemaResearchDelegationGet(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var id string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("id", &id, true, true)) {
		return
	}
	value, err := store.GetDelegation(id)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = value
}

func noemaResearchDelegations(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var workstreamID, parentTaskID, childTaskID string
	var limit float64
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("workstreamId", &workstreamID, false, false),
		util.BindJsonArg("parentTaskId", &parentTaskID, false, false),
		util.BindJsonArg("childTaskId", &childTaskID, false, false), util.BindJsonArg("limit", &limit, false, false)) {
		return
	}
	values, err := store.ListDelegations(research.DelegationFilter{WorkstreamID: workstreamID,
		ParentTaskID: parentTaskID, ChildTaskID: childTaskID, Limit: int(limit)})
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"delegations": values}
}

func noemaResearchHistoryIndex(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var sources []research.HistorySource
	if !decodeResearchInput(arg, "sources", &sources, ret) || len(sources) == 0 {
		if ret.Msg == "" {
			ret.Code, ret.Msg = -1, "Field [sources] must not be empty"
		}
		return
	}
	result, err := store.IndexHistory(sources)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = result
}

func noemaResearchHistorySearch(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var query, projectRoot, source string
	var limit float64
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("query", &query, true, true),
		util.BindJsonArg("projectRoot", &projectRoot, false, false),
		util.BindJsonArg("source", &source, false, false),
		util.BindJsonArg("limit", &limit, false, false)) {
		return
	}
	hits, err := store.SearchHistory(research.HistorySearchOptions{
		Query: query, ProjectRoot: projectRoot, Source: source, Limit: int(limit),
	})
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"hits": hits}
}

func noemaResearchHistoryPeek(c *gin.Context) {
	noemaResearchHistoryRead(c, true)
}

func noemaResearchHistoryReadFull(c *gin.Context) {
	noemaResearchHistoryRead(c, false)
}

func noemaResearchHistoryRead(c *gin.Context, peek bool) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	store, ok := noemaResearchStore(arg, ret)
	if !ok {
		return
	}
	var id string
	var maxRunes float64
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("id", &id, true, true),
		util.BindJsonArg("maxRunes", &maxRunes, false, false)) {
		return
	}
	var record research.HistoryRecord
	var err error
	if peek {
		record, err = store.PeekHistory(id, int(maxRunes))
	} else {
		record, err = store.ReadHistory(id)
	}
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = record
}

func decodeResearchInput(arg map[string]any, key string, destination any, ret *gulu.Result) bool {
	raw, exists := arg[key]
	if !exists || raw == nil {
		ret.Code, ret.Msg = -1, "Field ["+key+"] is required"
		return false
	}
	data, err := json.Marshal(raw)
	if err == nil {
		err = json.Unmarshal(data, destination)
	}
	if err != nil {
		ret.Code, ret.Msg = -1, "Field ["+key+"] has an invalid shape: "+err.Error()
		return false
	}
	return true
}
