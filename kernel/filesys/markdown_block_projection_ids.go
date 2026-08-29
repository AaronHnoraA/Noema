// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package filesys

import (
	"strconv"

	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	noemaidentity "github.com/aaronhe/noema/kernel/noema/identity"
)

const (
	markdownIndexProjectionProperty  = "noema:index-projection"
	markdownIndexPlaceholderProperty = "noema:index-placeholder"
)

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
func AssignMarkdownBlockProjectionIDs(tree *parse.Tree, source []byte) {
	if nil == tree || nil == tree.Root || "" == tree.Root.ID {
		return
	}
	var unanchored []*ast.Node
	for n := tree.Root.FirstChild; nil != n; n = n.Next {
		if !n.IsBlock() || ast.NodeKramdownBlockIAL == n.Type {
			continue
		}
		if "" == n.ID {
			unanchored = append(unanchored, n)
		}
	}
	if 0 == len(unanchored) {
		return
	}

	seeds := markdownBlockSeeds(tree, source, unanchored)
	occurrences := map[string]int{}
	for index, n := range unanchored {
		seed := seeds[index]
		occurrences[seed]++
		n.ID = markdownBlockProjectionID(tree.Root.ID, tree.Path, seed, occurrences[seed])
		if nil == n.Properties {
			n.Properties = map[string]string{}
		}
		// Properties are an in-memory side channel. Unlike KramdownIAL they are
		// not rendered into Markdown or copied into the SQL attributes table.
		n.Properties[markdownIndexProjectionProperty] = "1"
	}
}

// markdownBlockProjectionID is the one place a block key is minted, so the
// parse-free path and the parsed path cannot drift apart.
//
// Path is part of the key because a block's indexed row carries it: a rename
// has to invalidate every row of the document, and the root key alone does not
// change when a document that has its own {#uuid} anchor moves.
func markdownBlockProjectionID(rootID, path, seed string, occurrence int) string {
	return noemaidentity.BlockProjectionID(
		rootID + "\x00" + path + "\x00" + seed + "\x00" + strconv.Itoa(occurrence))
}

// markdownBlockSeeds returns the per-block seed for every unanchored top-level
// block, in document order.
//
// It prefers the block's own source bytes, because those can be recovered from
// the file without parsing it — which is what lets the index decide whether a
// block changed, and hand Lute only the ones that did. The rendered content is
// the fallback for documents SplitTopLevelMarkdownBlocks declines, which then
// simply keep paying for a whole-document parse.
func markdownBlockSeeds(tree *parse.Tree, source []byte, unanchored []*ast.Node) []string {
	if spans, ok := SplitTopLevelMarkdownBlocks(source); ok {
		if blocks := markdownTopLevelBlockCount(tree); blocks == len(spans) {
			seeds := make([]string, 0, len(unanchored))
			index := 0
			for n := tree.Root.FirstChild; nil != n; n = n.Next {
				if !n.IsBlock() || ast.NodeKramdownBlockIAL == n.Type {
					continue
				}
				if "" == n.ID {
					seeds = append(seeds, string(source[spans[index].From:spans[index].To]))
				}
				index++
			}
			if len(seeds) == len(unanchored) {
				return seeds
			}
		}
	}
	seeds := make([]string, len(unanchored))
	for index, n := range unanchored {
		seeds[index] = n.Type.String() + "\x00" + n.Content()
	}
	return seeds
}

func markdownTopLevelBlockCount(tree *parse.Tree) (count int) {
	for n := tree.Root.FirstChild; nil != n; n = n.Next {
		if n.IsBlock() && ast.NodeKramdownBlockIAL != n.Type {
			count++
		}
	}
	return count
}

// MarkdownIndexPlaceholder reports a node that stands in for a block the index
// already holds. It carries an identity and a type and nothing else, so no
// caller may ever build a row from it.
func MarkdownIndexPlaceholder(n *ast.Node) bool {
	return nil != n && nil != n.Properties && "1" == n.Properties[markdownIndexPlaceholderProperty]
}

// MarkdownIndexProjection reports whether a block id exists only to give the
// inherited blocktree/SQL indexes incremental granularity. Such ids are not
// portable Noema identities and must not cross API boundaries.
func MarkdownIndexProjection(n *ast.Node) bool {
	return nil != n && nil != n.Properties && "1" == n.Properties[markdownIndexProjectionProperty]
}
