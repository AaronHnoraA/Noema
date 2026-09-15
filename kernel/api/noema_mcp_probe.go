// Copyright (c) 2026 Aaron He. AGPL-3.0-or-later.
package api

import (
	"github.com/88250/gulu"
	mcpclient "github.com/aaronhe/noema/kernel/mcp/client"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/gin-gonic/gin"
	"net/http"
	"os"
	"path/filepath"
)

func noemaMCPProbe(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	root, _ := arg["root"].(string)
	scope, _ := arg["scope"].(string)
	if scope != "" && scope != "project" && scope != "global" {
		ret.Code, ret.Msg = -1, "Invalid capability scope"
		return
	}
	if !filepath.IsAbs(root) {
		ret.Code, ret.Msg = -1, "Absolute working directory required"
		return
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		ret.Code, ret.Msg = -1, "Working directory does not exist"
		return
	}
	if _, err := os.Stat(filepath.Join(root, "noema.toml")); scope != "global" && err != nil {
		ret.Code, ret.Msg = -1, "No Noema project at root"
		return
	}
	var config mcpclient.ProbeConfig
	if !decodeResearchInput(arg, "config", &config, ret) {
		return
	}
	ret.Data = mcpclient.ProbeMCP(c.Request.Context(), root, config)
}
