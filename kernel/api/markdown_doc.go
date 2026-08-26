// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package api

import (
	"encoding/base64"
	"net/http"
	"sync"

	"github.com/88250/gulu"
	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/logging"
)

var registerExternalMarkdownBoxLock sync.Mutex

func storeMarkdownAsset(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	var notebook, p, name, mediaType, encoded string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("notebook", &notebook, true, true),
		util.BindJsonArg("path", &p, true, true),
		util.BindJsonArg("name", &name, false, false),
		util.BindJsonArg("type", &mediaType, false, false),
		util.BindJsonArg("data", &encoded, true, true),
	) {
		return
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		ret.Code = -1
		ret.Msg = "invalid base64 asset data"
		return
	}
	asset, err := model.StoreMarkdownAssetBytes(notebook, p, name, mediaType, data)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = asset
}

func storeMarkdownAssetFromPath(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	var notebook, p, sourcePath, name, mediaType string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("notebook", &notebook, true, true),
		util.BindJsonArg("path", &p, true, true),
		util.BindJsonArg("sourcePath", &sourcePath, true, true),
		util.BindJsonArg("name", &name, false, false),
		util.BindJsonArg("type", &mediaType, false, false),
	) {
		return
	}
	asset, err := model.StoreMarkdownAssetFromPath(notebook, p, sourcePath, name, mediaType)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = asset
}

func listUnusedMarkdownAssets(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	var notebook string
	var includePublic bool
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("notebook", &notebook, true, true),
		util.BindJsonArg("includePublic", &includePublic, false, false),
	) {
		return
	}
	assets, err := model.ListUnusedMarkdownAssets(notebook, includePublic)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{"assets": assets, "source": "kernel-assets"}
}

func inspectMarkdownAssets(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	var notebook string
	var includePublic bool
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("notebook", &notebook, true, true),
		util.BindJsonArg("includePublic", &includePublic, false, false)) {
		return
	}
	health, err := model.InspectMarkdownAssets(notebook, includePublic)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = health
}

func renameMarkdownAsset(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	var notebook, oldPath, newName string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("notebook", &notebook, true, true),
		util.BindJsonArg("oldPath", &oldPath, true, true),
		util.BindJsonArg("newName", &newName, true, true)) {
		return
	}
	result, err := model.RenameMarkdownAsset(notebook, oldPath, newName)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = result
}

func searchMarkdownAssetContent(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	var notebook, query string
	var limit int
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("notebook", &notebook, true, true),
		util.BindJsonArg("query", &query, true, true),
		util.BindJsonArg("limit", &limit, false, false)) {
		return
	}
	assets, total, indexed, err := model.SearchMarkdownAssetContent(notebook, query, limit)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"assets": assets, "total": total, "indexed": indexed, "source": "kernel-asset-content-fts5",
	}
}

func loadMarkdownBibliography(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	var notebook, p, metadata string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("notebook", &notebook, true, true),
		util.BindJsonArg("path", &p, true, true),
		util.BindJsonArg("metadata", &metadata, true, false),
	) {
		return
	}
	library, err := model.LoadMarkdownBibliography(notebook, p, metadata)
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = library
}

// loadMarkdownDoc 是 CM6 文本协议的加载端点（计划文档 Phase 2）：给一个
// markdown box 内的文档路径，返回当前 markdown 全文和已持久化 ID 的块列表
// （不含源偏移 from/to——CM6 用自己的 Lezer 解析同一份文本顺带算出，见计划
// 文档 Phase 2 关于这一点的澄清）。非 markdown box 的路径会报错，不是
// 这个协议要处理的对象（.sy box 走现有的 /api/filetree/getDoc）。
func loadMarkdownDoc(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var notebook, p string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("notebook", &notebook, true, true),
		util.BindJsonArg("path", &p, true, true),
	) {
		return
	}

	markdown, blocks, err := model.LoadMarkdownDoc(notebook, p)
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	ret.Data = map[string]any{
		"markdown": markdown,
		"blocks":   blocks,
	}
}

// saveMarkdownDoc 是 CM6 文本协议的保存端点：CM6 防抖全文保存后把最新
// markdown 文本整篇送过来，内核按原字节落盘、重新解析、增量更新索引，并
// 返回真正落盘的字节和最新块列表。Noema 的 portable identity 只做内存投影，
// 此端点不得为了内部 ID 或格式化需要改写源文本。
func saveMarkdownDoc(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var notebook, p, markdown, expectedVersion string
	var force bool
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("notebook", &notebook, true, true),
		util.BindJsonArg("path", &p, true, true),
		util.BindJsonArg("markdown", &markdown, true, false), // 允许保存空文档
		util.BindJsonArg("expectedVersion", &expectedVersion, false, false),
		util.BindJsonArg("force", &force, false, false),
	) {
		return
	}

	result, err := model.SaveMarkdownDocCAS(notebook, p, markdown, expectedVersion, force)
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	ret.Data = result
}

func mutateMarkdownMeta(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	var request model.MarkdownMetaMutationRequest
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if request.Notebook == "" || request.Path == "" || request.Action == "" {
		ret.Code = -1
		ret.Msg = "notebook, path, and action are required"
		return
	}
	result, err := model.MutateMarkdownMeta(request)
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = result
}

func moveMarkdownDoc(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	var notebook, fromPath, toPath string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("notebook", &notebook, true, true),
		util.BindJsonArg("fromPath", &fromPath, true, false),
		util.BindJsonArg("toPath", &toPath, true, false),
	) {
		return
	}
	if util.InvalidIDPattern(notebook, ret) {
		return
	}
	result, err := model.MoveMarkdownDoc(notebook, fromPath, toPath)
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = result
}

func moveMarkdownPath(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	var notebook, fromPath, toPath string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("notebook", &notebook, true, true),
		util.BindJsonArg("fromPath", &fromPath, true, false),
		util.BindJsonArg("toPath", &toPath, true, false),
	) {
		return
	}
	if util.InvalidIDPattern(notebook, ret) {
		return
	}
	result, err := model.MoveMarkdownPath(notebook, fromPath, toPath)
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = result
}

// listMarkdownDocs 列出一个 markdown box 里的所有 .md 文档，供客户端渲染
// 文档浏览器/打开列表——不用手敲路径才能打开已有笔记。
func listMarkdownDocs(c *gin.Context) {
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

	docs, err := model.ListMarkdownDocs(notebook)
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	ret.Data = map[string]any{
		"docs": docs,
	}
}

// registerExternalMarkdownBox creates or updates a workspace-local shadow
// registration for an existing Wiki/Git repository, then mounts it in place.
// The external root is never copied and never receives .siyuan metadata.
func registerExternalMarkdownBox(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var name, root, repositoryID string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("name", &name, false, false),
		util.BindJsonArg("root", &root, true, false),
		util.BindJsonArg("repositoryId", &repositoryID, false, false),
	) {
		return
	}

	// A first mount now waits for its source scan and SQL/FTS commit. Serialize
	// registrations so concurrent App/Emacs attach attempts for the same
	// portable root wait for that operation instead of observing the shadow as
	// already mounted and returning before its index is ready.
	registerExternalMarkdownBoxLock.Lock()
	defer registerExternalMarkdownBoxLock.Unlock()

	registration, err := model.RegisterExternalMarkdownBox(name, root, repositoryID)
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	// A kernel workspace is reused across App/Emacs launches. Reconcile
	// registrations only after the active portable repository has had a chance
	// to rebind its existing identity at a new path, then remove shadows whose
	// roots are provably gone. Transient permission/I/O failures are retained.
	pruned, pruneErr := model.PruneMissingExternalMarkdownBoxes(registration.ID)
	if nil != pruneErr {
		logging.LogWarnf("prune stale external Markdown boxes failed: %s", pruneErr)
	}
	alreadyMounted, err := model.MountExternalMarkdownBoxAndWait(registration.ID)
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{
		"box":            registration,
		"alreadyMounted": alreadyMounted,
		"pruned":         pruned,
	}
}

func listExternalMarkdownBoxes(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	boxes, err := model.ListExternalMarkdownBoxes()
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{"boxes": boxes}
}

func listMarkdownRelationships(c *gin.Context) {
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
	relationships, err := model.ListMarkdownRelationships(notebook)
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{"relationships": relationships}
}

// listMarkdownPlanning exposes the span-aware planning scanner for one
// Markdown document or the whole external box. It is deliberately read-only;
// patch/clock mutations remain on their serialized host path until the write
// protocol migrates as a separate milestone.
func listMarkdownPlanning(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	var notebook, path string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("notebook", &notebook, true, true),
		util.BindJsonArg("path", &path, false, false),
	) {
		return
	}
	documents, err := model.ListMarkdownPlanning(notebook, path)
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{"documents": documents}
}

// listMarkdownPropertyBlocks exposes the narrow portable UUIDv7 property
// scanner in bulk so an attribute view never needs one request per block.
func listMarkdownPropertyBlocks(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	var notebook, path string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("notebook", &notebook, true, true),
		util.BindJsonArg("path", &path, false, false),
	) {
		return
	}
	documents, err := model.ListMarkdownPropertyBlocks(notebook, path)
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = map[string]any{"documents": documents}
}

func mutateMarkdownPropertyBlock(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	var request model.MarkdownPropertyMutationRequest
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if request.Notebook == "" || request.Path == "" || request.ID == "" || request.Key == "" {
		ret.Code = -1
		ret.Msg = "notebook, path, id, and key are required"
		return
	}
	result, err := model.MutateMarkdownProperty(request)
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = result
}

func mutateMarkdownPlanning(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	var request model.MarkdownPlanningMutationRequest
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if request.Notebook == "" || request.Path == "" || request.Mutation.Type == "" {
		ret.Code = -1
		ret.Msg = "notebook, path, and mutation.type are required"
		return
	}
	result, err := model.MutateMarkdownPlanning(request)
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = result
}

func resolveMarkdownBlock(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}
	var id string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("id", &id, true, true)) {
		return
	}
	location, err := model.ResolveMarkdownBlock(id)
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	ret.Data = location
}
