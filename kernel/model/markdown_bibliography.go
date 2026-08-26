// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package model

import (
	"fmt"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	noemabibliography "github.com/aaronhe/noema/kernel/noema/bibliography"
)

func LoadMarkdownBibliography(boxID, path, metadata string) (noemabibliography.Library, error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return noemabibliography.Library{}, fmt.Errorf("box [%s] is not a markdown box", boxID)
	}
	normalized, err := normalizedMarkdownDocPath(boxID, path)
	if nil != err {
		return noemabibliography.Library{}, err
	}
	return noemabibliography.Load(filesys.BoxRootPath(boxID), normalized, metadata)
}
