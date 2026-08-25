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

package conf

import "github.com/aaronhe/noema/kernel/util"

// BoxKindSy 是 box 的默认存储形态：块树以 .sy JSON 落盘，文件名即块 ID。
const BoxKindSy = "sy"

// BoxKindMarkdown 表示 box 以 .md 文件为落盘真相源；块树只在内存中存在，
// 通过 lute 的 parse.Parse/FormatRenderer 在读写两端与 markdown 字节互转。
// 见 kernel/filesys/tree.go 的 markdown 读写分支与计划文档 Phase 1.1。
const BoxKindMarkdown = "markdown"

// BoxConf 维护 .siyuan/conf.json 笔记本配置。
type BoxConf struct {
	Name                  string         `json:"name"`                   // 笔记本名称
	Kind                  string         `json:"kind,omitempty"`         // 存储形态："" 或 "sy"（默认）、"markdown"
	Root                  string         `json:"root,omitempty"`         // external markdown box 的绝对内容根；配置仍留在 workspace
	RepositoryID          string         `json:"repositoryId,omitempty"` // noema.toml 中 portable UUIDv7 仓库身份
	Sort                  int            `json:"sort"`                   // 排序字段
	Icon                  string         `json:"icon"`                   // 图标
	Closed                bool           `json:"closed"`                 // 是否处于关闭状态
	RefCreateSaveBox      string         `json:"refCreateSaveBox"`       // 块引时新建文档存储笔记本
	RefCreateSavePath     string         `json:"refCreateSavePath"`      // 块引时新建文档存储路径
	DocCreateSaveBox      string         `json:"docCreateSaveBox"`       // 新建文档存储笔记本
	DocCreateSavePath     string         `json:"docCreateSavePath"`      // 新建文档存储路径
	DocCreateTemplatePath string         `json:"docCreateTemplatePath"`  // 新建文档使用的模板路径
	DailyNoteSavePath     string         `json:"dailyNoteSavePath"`      // 新建日记存储路径
	DailyNoteTemplatePath string         `json:"dailyNoteTemplatePath"`  // 新建日记使用的模板路径
	SortMode              int            `json:"sortMode"`               // 排序方式
	Encrypted             bool           `json:"encrypted"`              // 是否为加密笔记本
	BoxCrypt              *BoxEncryption `json:"boxCrypt"`               // 笔记本加密参数，仅 Encrypted=true 时有值
}

// BoxEncryption 维护单个加密笔记本的密钥包络参数。WrappedDEK 是用全局 KEK 加密后的 DEK，本身可落盘。
type BoxEncryption struct {
	Spec       int    `json:"spec"`               // 当前包络规范标识，WrappedDEK 绑定 boxID AAD
	WrappedDEK []byte `json:"wrappedDEK"`         // 用 KEK 经 AES-GCM 加密后的 DEK
	WrapNonce  []byte `json:"wrapNonce"`          // 包络用的 GCM nonce（从加密信封中提取）
	Metadata   []byte `json:"metadata,omitempty"` // 用 DEK 加密的图标和排序元数据
	CreatedAt  int64  `json:"createdAt"`          // 创建时间，单位毫秒，便于未来按时间轮换密钥
}

func NewBoxConf() *BoxConf {
	return &BoxConf{
		Name:                  "Untitled",
		Closed:                true,
		DailyNoteSavePath:     "/daily note/{{now | date \"2006/01\"}}/{{now | date \"2006-01-02\"}}",
		DailyNoteTemplatePath: "",
		SortMode:              util.SortModeFileTree,
		Encrypted:             false,
	}
}
