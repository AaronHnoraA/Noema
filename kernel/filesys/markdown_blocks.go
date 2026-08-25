// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema UUIDv7 block projection additions are Copyright (c) 2026 Aaron He
// and distributed under the same AGPL-3.0-or-later terms.

package filesys

import (
	"strings"

	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	noemamarkdown "github.com/aaronhe/noema/kernel/noema/markdown"
)

// ApplyNoemaBlockProjection assigns deterministic disposable IDs to Lute
// blocks carrying a canonical Noema {#UUIDv7} anchor. The canonical ID stays
// in an in-memory custom IAL attribute for API/SQL adapters; Markdown WriteTree
// is forbidden, so neither value can leak back into source.
func ApplyNoemaBlockProjection(tree *parse.Tree, source []byte) noemamarkdown.Projection {
	projection := noemamarkdown.Scan(source)
	if nil == tree || nil == tree.Root {
		return projection
	}

	duplicates := map[string]bool{}
	for _, id := range projection.DuplicateDefinitionIDs {
		duplicates[id] = true
	}
	for _, definition := range projection.Definitions {
		if duplicates[definition.CanonicalID] {
			continue
		}
		literal := "{#" + definition.CanonicalID
		orgOpener := "+begin " + definition.Kind
		var best *ast.Node
		bestTextLen := int(^uint(0) >> 1)
		ast.Walk(tree.Root, func(n *ast.Node, entering bool) ast.WalkStatus {
			if !entering || n == tree.Root || !n.IsBlock() {
				return ast.WalkContinue
			}
			text := n.Text()
			lowerText := strings.ToLower(text)
			matches := strings.Contains(lowerText, literal)
			if definition.OrgEnv {
				// CommonMark treats the two '#' characters in '#+begin ... {#id}'
				// as Markdown markers and Lute's Text() omits them. Match the
				// remaining opener plus UUID for org-env definitions.
				matches = strings.Contains(lowerText, orgOpener) && strings.Contains(lowerText, definition.CanonicalID)
			}
			if !matches {
				return ast.WalkContinue
			}
			if len(text) < bestTextLen {
				best = n
				bestTextLen = len(text)
			}
			return ast.WalkContinue
		})
		if nil == best {
			continue
		}
		best.ID = definition.ProjectionID
		best.SetIALAttr(markdownCanonicalIDAttr, definition.CanonicalID)
	}

	noemamarkdown.AttachProjection(tree, projection)
	return projection
}

// MarkdownCanonicalBlockID hides inherited internal projections at Noema API
// boundaries. Legacy SiYuan blocks have no custom identity and fall back to
// their existing ID.
func MarkdownCanonicalBlockID(n *ast.Node) string {
	if nil == n {
		return ""
	}
	if canonical := n.IALAttr(markdownCanonicalIDAttr); "" != canonical {
		return canonical
	}
	return n.ID
}
