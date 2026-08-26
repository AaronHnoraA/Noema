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
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/aaronhe/noema/kernel/conf"
)

// BoxKindProvider 由 model 层在 init 时注入，用于查询 boxID 对应的存储形态
// （conf.BoxKindSy / conf.BoxKindMarkdown）。filesys 不能直接 import model
// （会形成 model → filesys → model 循环依赖），故采用回调注入，与 DEKProvider 同构。
// 未注入或返回空串时按 conf.BoxKindSy 处理，兼容所有既有 .sy box。
var BoxKindProvider func(boxID string) string

func boxKind(boxID string) string {
	if BoxKindProvider == nil {
		return conf.BoxKindSy
	}
	if kind := BoxKindProvider(boxID); "" != kind {
		return kind
	}
	return conf.BoxKindSy
}

func isMarkdownBox(boxID string) bool {
	return conf.BoxKindMarkdown == boxKind(boxID)
}

// ErrBoxDocumentPathKind marks a path whose extension does not belong to the
// source format selected by its box. It prevents a caller from treating a
// stray .sy file in a Markdown repository as Markdown (or vice versa).
var ErrBoxDocumentPathKind = errors.New("document path does not match notebook kind")

func IsMarkdownDocumentPath(p string) bool {
	ext := strings.ToLower(filepath.Ext(filepath.ToSlash(strings.TrimSpace(p))))
	return ".md" == ext || ".markdown" == ext
}

func IsNativeDocumentPath(p string) bool {
	return strings.HasSuffix(filepath.ToSlash(strings.TrimSpace(p)), ".sy")
}

func IsDocumentPathForKind(kind, p string) bool {
	if conf.BoxKindMarkdown == kind {
		return IsMarkdownDocumentPath(p)
	}
	return IsNativeDocumentPath(p)
}

func IsBoxDocumentPath(boxID, p string) bool {
	return IsDocumentPathForKind(boxKind(boxID), p)
}

func ValidateBoxDocumentPath(boxID, p string) error {
	if IsBoxDocumentPath(boxID, p) {
		return nil
	}
	return fmt.Errorf("%w: notebook [%s] kind [%s], path [%s]", ErrBoxDocumentPathKind, boxID, boxKind(boxID), p)
}
