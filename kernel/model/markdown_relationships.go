// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema Markdown relationship additions are Copyright (c) 2026 Aaron He
// and distributed under the same AGPL-3.0-or-later terms.

package model

import (
	"fmt"
	"sort"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/sql"
)

// MarkdownRelationship is a page-level projection of a native block ref.
// Paths, rather than disposable internal block IDs, cross the API boundary so
// the production Wiki catalog can merge the edge with its portable page IDs.
type MarkdownRelationship struct {
	FromPath string `json:"fromPath"`
	ToPath   string `json:"toPath"`
}

func ListMarkdownRelationships(boxID string) (ret []MarkdownRelationship, err error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return nil, fmt.Errorf("box [%s] is not a markdown box", boxID)
	}
	sql.FlushQueue()
	rootsByID := map[string]*sql.Block{}
	var rootIDs []string
	for _, root := range sql.GetAllRootBlocks() {
		if root.Box != boxID {
			continue
		}
		rootsByID[root.ID] = root
		rootIDs = append(rootIDs, root.ID)
	}
	if 0 == len(rootIDs) {
		return []MarkdownRelationship{}, nil
	}

	seen := map[string]bool{}
	for defRootID, refRoots := range sql.QueryRefRootBlocksByDefRootIDs(rootIDs) {
		target := rootsByID[defRootID]
		if nil == target || "" == target.Path {
			continue
		}
		for _, source := range refRoots {
			if nil == source || source.Box != boxID || "" == source.Path {
				continue
			}
			key := source.Path + "\x00" + target.Path
			if seen[key] {
				continue
			}
			seen[key] = true
			ret = append(ret, MarkdownRelationship{FromPath: source.Path, ToPath: target.Path})
		}
	}
	sort.Slice(ret, func(i, j int) bool {
		if ret[i].FromPath == ret[j].FromPath {
			return ret[i].ToPath < ret[j].ToPath
		}
		return ret[i].FromPath < ret[j].FromPath
	})
	return
}
