// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema configuration additions are Copyright (c) 2026 Aaron He and
// distributed under the same AGPL-3.0-or-later terms.

package api

import (
	"net/http"
	"path/filepath"
	"strings"

	"github.com/88250/gulu"
	"github.com/aaronhe/noema/kernel/noema/katexmacros"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/gin-gonic/gin"
)

func loadNoemaKatexMacros(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	request := struct {
		Dir string `json:"dir"`
	}{}
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	dir := strings.TrimSpace(request.Dir)
	if dir == "" {
		dir = filepath.Join(filepath.Dir(util.WorkingDir), "resources", "katex-macros")
	}
	ret.Data = katexmacros.Load(dir)
}
