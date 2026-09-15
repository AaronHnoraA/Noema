// Noema research cache routes are Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package api

import (
	"net/http"

	"github.com/88250/gulu"
	"github.com/aaronhe/noema/kernel/noema/research"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/gin-gonic/gin"
)

func noemaResearchCacheStatus(c *gin.Context) {
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
	status, err := store.CacheStatusOnly()
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = status
}

func noemaResearchCacheMaintain(c *gin.Context) {
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
	policy := research.CachePolicy{}
	if raw, present := arg["policy"]; present && raw != nil {
		if !decodeResearchInput(arg, "policy", &policy, ret) {
			return
		}
	}
	status, err := store.MaintainCache(policy)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = status
}

func noemaResearchWritebackQueue(c *gin.Context) {
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
	input := research.QueueNotebookWritebackInput{}
	if !decodeResearchInput(arg, "writeback", &input, ret) {
		return
	}
	item, err := store.QueueNotebookWriteback(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = item
}

func noemaResearchWritebackClaim(c *gin.Context) {
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
	items, err := store.ClaimNotebookWritebacks(20)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = map[string]any{"writebacks": items}
}

func noemaResearchWritebackComplete(c *gin.Context) {
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
	input := research.CompleteNotebookWritebackInput{}
	if !decodeResearchInput(arg, "writeback", &input, ret) {
		return
	}
	item, err := store.CompleteNotebookWriteback(input)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = item
}
