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

const (
	canonicalAnchorOpener = "{#"
	canonicalIDLength     = 36 // 8-4-4-4-12 lowercase hexadecimal UUID
	orgEnvOpenerPrefix    = "+begin "
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

	// Definitions are indexed by canonical ID so one tree walk can resolve all
	// of them. The previous implementation walked the whole tree once per
	// definition and rebuilt every block's text on each walk, which made
	// loading a document quadratic in (anchors x blocks) — a 50 KB note with
	// one anchor per block cost ~90 ms and a million allocations.
	byCanonicalID := make(map[string]int, len(projection.Definitions))
	var orgPending []int
	for index := range projection.Definitions {
		definition := &projection.Definitions[index]
		if duplicates[definition.CanonicalID] {
			continue
		}
		byCanonicalID[definition.CanonicalID] = index
		if definition.OrgEnv {
			orgPending = append(orgPending, index)
		}
	}
	if 0 == len(byCanonicalID) {
		noemamarkdown.AttachProjection(tree, projection)
		return projection
	}

	best := make([]*ast.Node, len(projection.Definitions))
	bestTextLen := make([]int, len(projection.Definitions))
	for index := range bestTextLen {
		bestTextLen[index] = int(^uint(0) >> 1)
	}
	consider := func(index int, n *ast.Node, textLen int) {
		if textLen < bestTextLen[index] {
			best[index] = n
			bestTextLen[index] = textLen
		}
	}

	ast.Walk(tree.Root, func(n *ast.Node, entering bool) ast.WalkStatus {
		if !entering || n == tree.Root || !n.IsBlock() {
			return ast.WalkContinue
		}
		text := n.Text()

		// Ordinary definitions are anchored by a literal "{#<uuid>}" in the
		// block text, so the anchors present in this block can be read off
		// directly instead of testing every definition against it.
		for at := 0; at < len(text); {
			found := strings.Index(text[at:], canonicalAnchorOpener)
			if 0 > found {
				break
			}
			at += found + len(canonicalAnchorOpener)
			if at+canonicalIDLength > len(text) {
				break
			}
			candidate := text[at : at+canonicalIDLength]
			index, ok := byCanonicalID[candidate]
			if !ok {
				index, ok = byCanonicalID[strings.ToLower(candidate)]
			}
			if ok && !projection.Definitions[index].OrgEnv {
				consider(index, n, len(text))
			}
			at += canonicalIDLength
		}

		// CommonMark treats the two '#' characters in '#+begin ... {#id}' as
		// Markdown markers and Lute's Text() omits them, so org-env
		// definitions match on the remaining opener plus the bare UUID.
		if 0 < len(orgPending) {
			lowerText := strings.ToLower(text)
			for _, index := range orgPending {
				definition := &projection.Definitions[index]
				if strings.Contains(lowerText, orgEnvOpenerPrefix+definition.Kind) &&
					strings.Contains(lowerText, definition.CanonicalID) {
					consider(index, n, len(text))
				}
			}
		}
		return ast.WalkContinue
	})

	for index := range projection.Definitions {
		node := best[index]
		if nil == node {
			continue
		}
		definition := &projection.Definitions[index]
		node.ID = definition.ProjectionID
		node.SetIALAttr(markdownCanonicalIDAttr, definition.CanonicalID)
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
