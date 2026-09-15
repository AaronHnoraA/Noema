// Noema research session-name routes are Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package api

import (
	"net/http"

	"github.com/88250/gulu"
	"github.com/aaronhe/noema/kernel/noema/research"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/gin-gonic/gin"
)

// D-031 logical session names.  Node owns routing; these routes only expose
// the durable registry to it.

func noemaResearchSessionNames(c *gin.Context) {
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
	includeArchived, _ := arg["includeArchived"].(bool)
	names, err := store.ListSessionNames(includeArchived)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"names": names}
}

func noemaResearchSessionNameGet(c *gin.Context) {
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
	var name string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("name", &name, true, true)) {
		return
	}
	found, err := store.GetSessionName(name)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = found
}

func noemaResearchSessionNameDeclare(c *gin.Context) {
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
	input := research.SessionNameIntent{}
	if !decodeResearchInput(arg, "intent", &input, ret) {
		return
	}
	declared, err := store.DeclareSessionName(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = declared
}

func noemaResearchSessionNameRename(c *gin.Context) {
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
	input := research.RenameSessionNameInput{}
	if !decodeResearchInput(arg, "rename", &input, ret) {
		return
	}
	renamed, err := store.RenameSessionName(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = renamed
}

func noemaResearchSessionNameBind(c *gin.Context) {
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
	input := research.SessionNameIntent{}
	if !decodeResearchInput(arg, "intent", &input, ret) {
		return
	}
	var sessionID string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("sessionId", &sessionID, true, true)) {
		return
	}
	bound, err := store.BindSessionName(input, sessionID)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = bound
}

// noemaResearchCoordinatorClaim hands pending Pi coordinator requests to the
// Emacs worker exactly once (D-032).
func noemaResearchCoordinatorClaim(c *gin.Context) {
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
	var owner string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("owner", &owner, true, true)) {
		return
	}
	requests, err := store.ClaimCoordinatorRequests(owner, 50)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"requests": requests}
}

func noemaResearchSessionNameArchive(c *gin.Context) {
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
	input := research.ArchiveSessionNameInput{}
	if !decodeResearchInput(arg, "archive", &input, ret) {
		return
	}
	archived, err := store.ArchiveSessionName(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = archived
}
