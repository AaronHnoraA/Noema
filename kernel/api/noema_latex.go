// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema LaTeX API additions are Copyright (c) 2026 Aaron He and distributed
// under the same AGPL-3.0-or-later terms.

package api

import (
	"net/http"

	"github.com/88250/gulu"
	noemalatex "github.com/aaronhe/noema/kernel/noema/latex"
	"github.com/gin-gonic/gin"
)

func prepareNoemaLatexPandoc(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	request := struct {
		Markdown       *string           `json:"markdown"`
		Rules          noemalatex.Rules  `json:"rules"`
		CitationKeyMap map[string]string `json:"citationKeyMap"`
	}{}
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if nil == request.Markdown {
		ret.Code = -1
		ret.Msg = "markdown is required"
		return
	}
	prepared, err := noemalatex.Prepare(*request.Markdown, noemalatex.Options{
		Rules: request.Rules, CitationKeyMap: request.CitationKeyMap,
	})
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = prepared
}

func extractNoemaLatexMetadata(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	request := struct {
		Markdown *string `json:"markdown"`
	}{}
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if nil == request.Markdown {
		ret.Code = -1
		ret.Msg = "markdown is required"
		return
	}
	ret.Data = map[string]any{"meta": noemalatex.ExtractMetadata(*request.Markdown)}
}

func postprocessNoemaLatexPandoc(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	request := struct {
		Latex *string `json:"latex"`
	}{}
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if nil == request.Latex {
		ret.Code = -1
		ret.Msg = "latex is required"
		return
	}
	ret.Data = map[string]any{"latex": noemalatex.PostprocessPandocLatex(*request.Latex)}
}

func planNoemaLatexTemplate(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	request := struct {
		Template    *string  `json:"template"`
		AllowedKeys []string `json:"allowedKeys"`
	}{}
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if nil == request.Template {
		ret.Code = -1
		ret.Msg = "template is required"
		return
	}
	plan, err := noemalatex.PlanTemplate(*request.Template, request.AllowedKeys)
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = plan
}
