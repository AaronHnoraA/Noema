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
	"net/http"

	"github.com/88250/gulu"
	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/gin-gonic/gin"
)

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
// markdown 文本整篇送过来，内核落盘、重新解析、增量更新索引，返回规范化后
// 真正落盘的字节和最新块列表（可能因为 normalizeOrgEndBlankLines 之类的
// 规范化而与调用方传入的不完全一样，调用方应该用返回值刷新自己的状态，
// 不能假设"我传什么就是磁盘上的什么"）。
func saveMarkdownDoc(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var notebook, p, markdown string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("notebook", &notebook, true, true),
		util.BindJsonArg("path", &p, true, true),
		util.BindJsonArg("markdown", &markdown, true, false), // 允许保存空文档
	) {
		return
	}

	saved, blocks, err := model.SaveMarkdownDoc(notebook, p, markdown)
	if nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	ret.Data = map[string]any{
		"markdown": saved,
		"blocks":   blocks,
	}
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
