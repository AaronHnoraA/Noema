// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema Markdown session-state additions are Copyright (c) 2026 Aaron He and
// distributed under the same AGPL-3.0-or-later terms.

package api

import (
	"net/http"

	"github.com/88250/gulu"
	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/gin-gonic/gin"
)

func readMarkdownSession(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	var notebook string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("notebook", &notebook, true, true)) {
		return
	}
	state, err := model.ReadMarkdownSession(notebook)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = state
}

func touchMarkdownRecentNote(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	var entry model.MarkdownRecentNote
	if err := c.ShouldBindJSON(&entry); err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if entry.Notebook == "" || entry.Path == "" {
		ret.Code = -1
		ret.Msg = "notebook and path are required"
		return
	}
	state, err := model.TouchMarkdownRecentNote(entry)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = state
}

func touchMarkdownCursorPosition(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	var entry model.MarkdownCursorPosition
	if err := c.ShouldBindJSON(&entry); err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if entry.Notebook == "" || entry.Path == "" {
		ret.Code = -1
		ret.Msg = "notebook and path are required"
		return
	}
	state, err := model.TouchMarkdownCursorPosition(entry)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = state
}
