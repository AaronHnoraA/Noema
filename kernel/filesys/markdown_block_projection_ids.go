// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package filesys

import (
	"strconv"

	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	noemaidentity "github.com/aaronhe/noema/kernel/noema/identity"
)

const markdownIndexProjectionProperty = "noema:index-projection"

// AssignMarkdownBlockProjectionIDs gives every top-level Markdown block a
// deterministic in-memory key so the SQL index has block granularity.
//
// Without it a Markdown note reaches the index as exactly one row whose content
// is the whole document: StripEphemeralMarkdownBlockIDs clears the unstable ids
// Lute mints per parse, fromTree skips every block whose id is empty, and
// buildBlockFromNode compensates by folding the entire body into the root
// block. Every autosave then deleted that row and re-tokenized the whole
// document into FTS — measured at 78 µs per KB, so 4.7 ms and 11 MB of garbage
// for one keystroke in a 60 KB note, and upsertTree's block-hash short-circuit
// could never fire because the only "block" was the document.
//
// The keys are derived from the block's own content, which is what makes the
// index incremental in the shape editing actually has:
//
//   - typing inside a block changes that block's key and hash, so exactly one
//     row is deleted and one inserted;
//   - inserting or deleting a block leaves every other block's content — and so
//     its key — untouched, unlike a positional scheme where one insertion at the
//     top would renumber and rewrite the whole document.
//
// Anchored blocks keep the canonical projection ApplyNoemaBlockProjection gave
// them; those are the ids users can actually reference, and they must stay tied
// to the {#uuid} in the source rather than to the text around it.
//
// Nothing here is ever serialized. Like the document key from
// ApplyMarkdownDocumentIdentity, these are internal projections of source that
// remains authoritative on disk, so Noema's rule that only genuinely referenced
// blocks carry a persisted `{: id=...}` — and that a note's bytes stay
// git-diff clean — is untouched.
func AssignMarkdownBlockProjectionIDs(tree *parse.Tree) {
	if nil == tree || nil == tree.Root || "" == tree.Root.ID {
		return
	}
	// Occurrences disambiguate blocks whose content is byte-identical. Counting
	// them in document order keeps earlier duplicates stable when a later one is
	// added, which a plain content hash would not.
	occurrences := map[string]int{}
	for n := tree.Root.FirstChild; nil != n; n = n.Next {
		if !n.IsBlock() || ast.NodeKramdownBlockIAL == n.Type || "" != n.ID {
			continue
		}
		// Path is part of the seed because a block's indexed row carries it, so
		// a rename has to invalidate every row of the document — and the root
		// key alone does not change when a document that has its own {#uuid}
		// anchor moves. HPath is derived from Path and adds nothing, and is not
		// even assigned on the tree yet at this point.
		seed := tree.Root.ID + "\x00" + tree.Path + "\x00" + n.Type.String() + "\x00" + n.Content()
		occurrences[seed]++
		n.ID = noemaidentity.BlockProjectionID(seed + "\x00" + strconv.Itoa(occurrences[seed]))
		if nil == n.Properties {
			n.Properties = map[string]string{}
		}
		// Properties are an in-memory side channel. Unlike KramdownIAL they are
		// not rendered into Markdown or copied into the SQL attributes table.
		n.Properties[markdownIndexProjectionProperty] = "1"
	}
}

// MarkdownIndexProjection reports whether a block id exists only to give the
// inherited blocktree/SQL indexes incremental granularity. Such ids are not
// portable Noema identities and must not cross API boundaries.
func MarkdownIndexProjection(n *ast.Node) bool {
	return nil != n && nil != n.Properties && "1" == n.Properties[markdownIndexProjectionProperty]
}
