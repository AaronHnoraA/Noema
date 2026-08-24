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

package model

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/88250/lute/ast"
	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/siyuan-note/filelock"
)

// MarkdownBlockRef 是 markdown box 文档里一个已分配 ID 的块的最小摘要。
//
// 刻意不含源偏移（from/to）：lute 的 ast.Node 完全不追踪源字节位置
// （不像 CM6 用的 Lezer 那样偏移原生），在这里算 from/to 等于把 CM6 的
// markdown 语法层在服务端重新实现一遍，既重复劳动又违背"内核只识别块边界，
// CM6/Lezer 独占语义层"的分工——见计划文档 Phase 2 的澄清。CM6 拿到
// markdown 全文后，用自己的 Lezer 解析顺带算出每个 ID 在源文本里的位置，
// 这部分对 Lezer 而言是免费的。
type MarkdownBlockRef struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Level int    `json:"level,omitempty"` // 标题层级 1-6；非标题块为 0
}

// LoadMarkdownDoc 读取一个 markdown box 文档，返回保证与磁盘一致的当前
// markdown 字节，以及文档里已经分配了 ID 的块列表。
//
// 若这次解析给文档分配了新 ID，或者 normalizeOrgEndBlankLines 之类的规范化
// 改动了字节（见 filesys.loadMarkdownTree），会先落盘一次再读回——
// writeMarkdownTree 内容不变时直接跳过落盘，这个保证的代价可以忽略，
// 换来的是调用方看到的 markdown 字节、磁盘上的字节、后续 UpsertIndexes
// 索引的字节三者永远一致，不会出现"读到的内容里有 ID 但磁盘上还没有"的窗口。
func LoadMarkdownDoc(boxID, path string) (markdown string, blocks []MarkdownBlockRef, err error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return "", nil, fmt.Errorf("box [%s] is not a markdown box", boxID)
	}
	if _, err = filesys.ValidateBoxRelativePath(boxID, path); nil != err {
		return "", nil, err
	}

	absPath := filepath.Join(util.DataDir, boxID, path)
	if _, statErr := os.Stat(absPath); nil != statErr {
		if os.IsNotExist(statErr) {
			// 加载一个还不存在的路径是"新建文档"这个流程里完全正常的第一步——
			// 调用方（比如 CM6 打开一个还没建过的笔记路径）应该拿到一个空文档
			// 可以直接开始编辑，而不是一个报错。真正意外的读错误（权限问题等）
			// 仍然正常报错，不在这里吞掉。
			return "", []MarkdownBlockRef{}, nil
		}
		return "", nil, statErr
	}

	luteEngine := util.NewLute()
	tree, err := filesys.LoadTree(boxID, path, luteEngine)
	if nil != err {
		return "", nil, err
	}

	if _, err = filesys.WriteTree(tree); nil != err {
		return "", nil, err
	}
	// 必须在 WriteTree 之后：见 filesys.StripEphemeralMarkdownBlockIDs 的注释。
	filesys.StripEphemeralMarkdownBlockIDs(tree)

	raw, err := os.ReadFile(absPath)
	if nil != err {
		return "", nil, err
	}
	markdown = string(raw)

	// 上面已经调过 StripEphemeralMarkdownBlockIDs，这里能看到的 n.ID 保证是真实存在于
	// 源文本、会被 FormatRenderer 写回磁盘的，不是 ProtyleWYSIWYG 每次解析现发的临时 ID。
	ast.Walk(tree.Root, func(n *ast.Node, entering bool) ast.WalkStatus {
		if !entering || !n.IsBlock() || "" == n.ID {
			return ast.WalkContinue
		}
		level := 0
		if ast.NodeHeading == n.Type {
			level = n.HeadingLevel
		}
		blocks = append(blocks, MarkdownBlockRef{ID: n.ID, Type: n.Type.String(), Level: level})
		return ast.WalkContinue
	})
	return
}

// SaveMarkdownDoc 用调用方（CM6 的防抖全文保存）送来的最新 markdown 文本
// 覆盖一个 markdown box 文档：落盘、重新解析、增量更新 blocktree/sql 索引、
// 推送 WS 刷新事件，最后返回规范化之后真正落盘的字节和最新块列表——
// 复用 LoadMarkdownDoc 保证这一步和"读"看到的是完全同一套规则（同一个
// normalizeOrgEndBlankLines、同一套 ID 分配/持久化逻辑），不重复实现一遍。
//
// 已知的权衡：这里直接落盘会触发 markdown_watcher.go 的外部编辑监听，
// 导致同一次保存被 UpsertIndexes 索引两遍（一遍这里主动触发，一遍 watcher
// 之后探测到文件变化再触发）。索引操作是幂等的，多做一次不是错误，只是
// 有点浪费；给保存和外部编辑分别加"这是我自己刚写的，跳过下一次 watch
// 事件"这类抑制逻辑目前还没有真实场景验证是否值得做，先不做。
func SaveMarkdownDoc(boxID, path, markdown string) (saved string, blocks []MarkdownBlockRef, err error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return "", nil, fmt.Errorf("box [%s] is not a markdown box", boxID)
	}
	if _, err = filesys.ValidateBoxRelativePath(boxID, path); nil != err {
		return "", nil, err
	}

	absPath := filepath.Join(util.DataDir, boxID, path)
	if err = os.MkdirAll(filepath.Dir(absPath), 0755); nil != err {
		return "", nil, err
	}
	if err = filelock.WriteFile(absPath, []byte(markdown)); nil != err {
		return "", nil, err
	}

	saved, blocks, err = LoadMarkdownDoc(boxID, path)
	if nil != err {
		return "", nil, err
	}

	UpsertIndexes([]string{boxID + path})
	util.PushReloadFiletree()
	return
}

// MarkdownDocSummary 是 markdown box 文档树里一个 .md 文件的摘要，供浏览/打开列表用。
type MarkdownDocSummary struct {
	Path  string `json:"path"`  // box 内相对路径，可以直接传给 LoadMarkdownDoc/SaveMarkdownDoc
	Title string `json:"title"` // 目前只是去掉扩展名的文件名；真实标题（比如取正文第一个标题）是后续增量
}

// ListMarkdownDocs 列出一个 markdown box 里的所有 .md 文档，按路径排序。
// 用于给客户端（比如 CM6 那边的文档浏览器）提供"这个 box 里有哪些笔记"，
// 不需要用户手敲路径才能打开已有文档。
func ListMarkdownDocs(boxID string) (docs []MarkdownDocSummary, err error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return nil, fmt.Errorf("box [%s] is not a markdown box", boxID)
	}

	boxDir := filepath.Join(util.DataDir, boxID)
	docs = []MarkdownDocSummary{}
	walkErr := filepath.WalkDir(boxDir, func(p string, d fs.DirEntry, walkErr error) error {
		if nil != walkErr {
			if errors.Is(walkErr, fs.ErrNotExist) {
				return nil
			}
			return walkErr
		}
		if d.IsDir() {
			if ".siyuan" == d.Name() {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".md") {
			return nil
		}
		rel, relErr := filepath.Rel(boxDir, p)
		if nil != relErr {
			return nil
		}
		rel = "/" + filepath.ToSlash(rel)
		docs = append(docs, MarkdownDocSummary{
			Path:  rel,
			Title: strings.TrimSuffix(filepath.Base(rel), ".md"),
		})
		return nil
	})
	if nil != walkErr && !errors.Is(walkErr, fs.ErrNotExist) {
		return nil, walkErr
	}

	sort.Slice(docs, func(i, j int) bool { return docs[i].Path < docs[j].Path })
	return docs, nil
}
