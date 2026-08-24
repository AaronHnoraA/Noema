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
	"bytes"
	"regexp"
)

// orgEndMarkerRe 匹配 Noema org-env `#+end <kind>` 终止行（去掉前导空白后）。
// 前导空白容忍度与 shared/command-syntax.mjs 的 isBlockCommandCloseLine 一致。
var orgEndMarkerRe = regexp.MustCompile(`^#\+end(?:_|\s+)[A-Za-z][\w-]*\s*$`)

// listItemLineRe 粗略匹配列表项起始行（含缩进的嵌套列表），用于判断
// "#+end 前一行是否处于列表续行懒解析的风险区"。
var listItemLineRe = regexp.MustCompile(`^\s*([-*+]|\d+[.)])\s`)

// normalizeOrgEndBlankLines 修正 Spike 1 实测发现的一个 lute 解析陷阱：
// `#+begin/#+end` body 若紧接着一个列表结尾且没有空行分隔，CommonMark
// 的列表懒续行规则会把 `#+end xxx` 吞成列表最后一项的续行并重新缩进——
// 详见计划文档 §1.3。空行能可靠阻断懒续行（已用 spike 程序验证）。
//
// 只在有风险的场景插入这个空行：前一行是列表项起始行，或是列表项下的
// 缩进续行。普通段落紧接 #+end 时同样会被 lute 解析成"懒续行"，但
// FormatRenderer 不会给段落续行加缩进，字节不受影响，不需要改动
// ——过度插入空行会为这些本来就干净往返的文档制造无意义的一次性 diff。
// 同时兜底修复磁盘上可能已被旧版内核写坏（缩进吞并）的历史文件——
// 判断依据是去掉前导空白后是否匹配终止行样式，与实际缩进无关。
// 只处理围栏代码块之外的行，避免误改代码示例里字面出现的 "#+end xxx" 文本。
func normalizeOrgEndBlankLines(data []byte) []byte {
	if !bytes.Contains(data, []byte("#+end")) && !bytes.Contains(data, []byte("#+END")) {
		return data
	}

	lines := bytes.Split(data, []byte("\n"))
	out := make([][]byte, 0, len(lines)+4)
	inFence := false
	var fenceMarker byte

	for _, line := range lines {
		trimmed := bytes.TrimSpace(line)

		if inFence {
			out = append(out, line)
			if len(trimmed) >= 3 && trimmed[0] == fenceMarker && allBytesEqual(trimmed, fenceMarker) {
				inFence = false
			}
			continue
		}

		if isFenceOpen(trimmed) {
			inFence = true
			fenceMarker = trimmed[0]
			out = append(out, line)
			continue
		}

		if orgEndMarkerRe.Match(trimmed) && riskyPrecedingLine(out) {
			out = append(out, []byte(nil))
			out = append(out, trimmed) // 顶格：去掉可能存在的历史缩进
			continue
		}

		out = append(out, line)
	}
	return bytes.Join(out, []byte("\n"))
}

// riskyPrecedingLine 判断已输出的最后一行是否处于列表续行懒解析的风险区：
// 列表项起始行本身，或列表项下的缩进续行（前导空白 + 非空内容）。
func riskyPrecedingLine(out [][]byte) bool {
	if 0 == len(out) {
		return false
	}
	prev := out[len(out)-1]
	if 0 == len(bytes.TrimSpace(prev)) {
		return false // 已经是空行，不在风险区
	}
	if listItemLineRe.Match(prev) {
		return true
	}
	// 缩进但非空 = 疑似列表项下的续行（段落/子块）。
	return len(prev) > 0 && (' ' == prev[0] || '\t' == prev[0])
}

func isFenceOpen(trimmed []byte) bool {
	if len(trimmed) < 3 {
		return false
	}
	return allBytesEqual(trimmed[:3], trimmed[0]) && ('`' == trimmed[0] || '~' == trimmed[0])
}

func allBytesEqual(b []byte, want byte) bool {
	for _, c := range b {
		if c != want {
			return false
		}
	}
	return true
}
