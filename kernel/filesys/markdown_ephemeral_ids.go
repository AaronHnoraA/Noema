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
// **调用时机很重要**：必须在 filesys.WriteTree（如果这次调用需要写）之后再调用，
// 不能在 LoadTree 拿到树之后立刻调用。FormatRenderer 渲染时依赖这些临时 ID 的存在
// 来决定某些块类型（比如数学块）后面要不要多空一行；解析完立刻清空会让 WriteTree
// 渲染出和"这棵树本该渲染成的样子"不一致的字节（已经用测试踩到过：数学块后面的
// ID 被提前清空后，第二次落盘会比第一次多一个空行）。调用顺序应该总是：
// LoadTree → （需要的话）WriteTree → StripEphemeralMarkdownBlockIDs → 索引/取块列表。
//
// 判断依据：源文本里是否真的紧跟着一个字面的 NodeKramdownBlockIAL 兄弟节点
// （对应真实存在的 `{: id=...}` 行）——文档根节点的 IAL 是 t.Root.AppendChild
// 挂上去的，永远是 Root 的最后一个子节点，不算某个内容块自己的 IAL，即使这个
// 内容块恰好是文档里的最后一块、导致 n.Next == root.LastChild。
func StripEphemeralMarkdownBlockIDs(tree *parse.Tree) {
	if nil == tree || nil == tree.Root {
		return
	}
	root := tree.Root
	ast.Walk(root, func(n *ast.Node, entering bool) ast.WalkStatus {
		if !entering || root == n || !n.IsBlock() || "" == n.ID {
			return ast.WalkContinue
		}
		hasRealIAL := nil != n.Next && ast.NodeKramdownBlockIAL == n.Next.Type && n.Next != root.LastChild
		if !hasRealIAL {
			n.ID = ""
			n.KramdownIAL = nil
		}
		return ast.WalkContinue
	})
}
