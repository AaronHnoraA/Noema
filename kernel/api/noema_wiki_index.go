// Noema Wiki index API: Copyright (c) 2026 Aaron He, distributed under the
// same AGPL-3.0-or-later terms as the kernel.

package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/88250/gulu"
	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/noema/wikiindex"
	"github.com/gin-gonic/gin"
)

// noemaWikiRefresh rebuilds the vault's wiki.db from its files: the kernel
// owns the Wiki index (docs/noema/design/wiki-workspace.md "Index
// ownership"). With includeIndex the built index comes back too, for a host
// that keeps it in memory.
func noemaWikiRefresh(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	request := struct {
		Notebook     string `json:"notebook"`
		Full         bool   `json:"full"`
		IncludeIndex bool   `json:"includeIndex"`
	}{}
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	notebook := strings.TrimSpace(request.Notebook)
	if "" == notebook || nil == model.Conf.Box(notebook) {
		ret.Code, ret.Msg = -1, model.ErrBoxNotFound.Error()
		return
	}
	if conf.BoxKindMarkdown != model.GetBoxKind(notebook) {
		ret.Code, ret.Msg = -1, errors.New("not a Markdown notebook").Error()
		return
	}
	result, err := wikiindex.Refresh(filesys.BoxRootPath(notebook), request.Full)
	if nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	if !request.IncludeIndex {
		result.Index = nil
	}
	ret.Data = result
}
