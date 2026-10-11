// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema Knowledge search API additions are Copyright (c) 2026 Aaron He and
// distributed under the same AGPL-3.0-or-later terms.

package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/88250/gulu"
	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/noema/wikisearch"
	"github.com/gin-gonic/gin"
)

// noemaKnowledgeSearch is the one search behind the editor, the Wiki pages
// and Emacs.  It reads the notebook's wiki.db and changes nothing.
func noemaKnowledgeSearch(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	request := struct {
		Notebook             string   `json:"notebook"`
		Query                string   `json:"query"`
		Mode                 string   `json:"mode"`
		Limit                int      `json:"limit"`
		Cursor               int      `json:"cursor"`
		RepositoryID         string   `json:"repositoryId"`
		Partition            string   `json:"partition"`
		Namespace            string   `json:"namespace"`
		Sort                 string   `json:"sort"`
		AllowedRepositoryIDs []string `json:"allowedRepositoryIds"`
		// A reference lookup (mode "references") is made from a note: its
		// absolute path and, when it has unsaved edits, its text.
		File    string  `json:"file"`
		Content *string `json:"content"`
	}{}
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	notebook := strings.TrimSpace(request.Notebook)
	if "" == notebook {
		ret.Code, ret.Msg = -1, "notebook is required"
		return
	}
	if nil == model.Conf.Box(notebook) {
		ret.Code, ret.Msg = -1, model.ErrBoxNotFound.Error()
		return
	}
	if conf.BoxKindMarkdown != model.GetBoxKind(notebook) {
		ret.Code, ret.Msg = -1, errors.New("not a Markdown notebook").Error()
		return
	}
	options := wikisearch.Options{
		Query: request.Query, Mode: request.Mode, Limit: request.Limit, Cursor: request.Cursor,
		RepositoryID: strings.TrimSpace(request.RepositoryID), Partition: strings.TrimSpace(request.Partition),
		Namespace: strings.TrimSpace(request.Namespace), Sort: strings.TrimSpace(request.Sort),
		AllowedRepositoryIDs: request.AllowedRepositoryIDs, File: strings.TrimSpace(request.File),
	}
	if nil != request.Content {
		options.Content, options.HasContent = *request.Content, true
	}
	root := filesys.BoxRootPath(notebook)
	if "references" == request.Mode {
		references, err := wikisearch.References(root, options)
		if nil != err {
			ret.Code, ret.Msg = -1, err.Error()
			return
		}
		ret.Data = references
		return
	}
	response, err := wikisearch.Search(root, options)
	if nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = response
}
