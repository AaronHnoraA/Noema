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

package filesys

import (
	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
)

// StripEphemeralMarkdownBlockIDs 清掉 markdown box 解析出的树里那些"假"块 ID。
//
// util.NewLute() 开着 SetProtyleWYSIWYG(true)——这原本是给 protyle 实时编辑会话用的：
// 树里任何没有显式 `{: id=...}` 的块，lute 在 finalParseBlockIAL 里都会现场发一个 ID
// 塞进 n.ID/n.KramdownIAL，但只存在于这次解析的内存里，FormatRenderer 并不会把它写回
// 磁盘（已经用测试验证过：文件字节不受影响）。这对 markdown box 是个陷阱：任何下游代码
// （treenode.UpsertBlockTree、sql 索引队列……）只要看到 n.ID 非空就会把它当成一个真实、
// 稳定的块收进索引；由于这个 ID 每次重新解析都不一样，每次重索引都会插入一批新的垃圾行，
// 上一批因为 ID 对不上也清不掉——索引会无限膨胀，而且都是从未被引用过的普通段落/标题。
//
// Noema 的 markdown 路径不再调用 FormatRenderer/WriteTree，因此 LoadTree 会在返回
// 前直接清掉这些 ID。该顺序只适用于 source-authoritative markdown box；.sy 路径
// 继续使用原来的树写入协议。
//
// 判断依据：源文本里是否真的紧跟着一个字面的 NodeKramdownBlockIAL 兄弟节点
// （对应真实存在的 `{: id=...}` 行）。ApplyMarkdownDocumentIdentity 会先移除
// lute 合成的文档根 IAL，所以这里遇到的 IAL 都是源文本中显式存在的兼容标记；
// 即使它恰好是 Root 的最后一个子节点，也仍属于前面的内容块。
func StripEphemeralMarkdownBlockIDs(tree *parse.Tree) {
	if nil == tree || nil == tree.Root {
		return
	}
	root := tree.Root
	ast.Walk(root, func(n *ast.Node, entering bool) ast.WalkStatus {
		if !entering || root == n || !n.IsBlock() || "" == n.ID {
			return ast.WalkContinue
		}
		hasRealIAL := nil != n.Next && ast.NodeKramdownBlockIAL == n.Next.Type
		if !hasRealIAL {
			n.ID = ""
			n.KramdownIAL = nil
		}
		return ast.WalkContinue
	})
}
