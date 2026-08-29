// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package filesys

import (
	"bytes"

	"github.com/88250/lute"
	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	"github.com/aaronhe/noema/kernel/treenode"
)

// markdownAnchorMarker is the opener of a `{#uuid}` block anchor.
var markdownAnchorMarker = []byte("{#")

// MarkdownIncrementalTree parses only the blocks an edit actually changed.
//
// Lute has no incremental mode, so the kernel used to parse the whole document
// on every autosave — several milliseconds and tens of megabytes of garbage for
// a 60 KB note — purely to discover that one paragraph moved. Block keys are
// derived from a block's own source bytes, so SplitTopLevelMarkdownBlocks can
// name every block in the document without parsing any of it. Blocks whose key
// is already in `indexed` are known byte-identical to what produced that row,
// so they are represented by a keyed placeholder and never handed to Lute;
// everything else is parsed on its own.
//
// The placeholders are safe precisely because they are only ever created for
// blocks the index already has: fromTree skips them as unchanged and never
// looks inside, and upsertBlockTree sees the same id and type it stored, so
// neither writes a row from an empty node.
//
// ok is false when the document cannot be treated one block at a time, and the
// caller parses it whole:
//
//   - SplitTopLevelMarkdownBlocks declined it;
//   - it carries `{#uuid}` anchors, whose canonical keys come from a
//     whole-document projection rather than from the block's own bytes;
//   - nothing in it is already indexed, so there is nothing to skip.
func MarkdownIncrementalTree(
	source []byte, boxID, p string, luteEngine *lute.Lute, indexed map[string]string,
) (ret *parse.Tree, ok bool) {
	if 1 > len(indexed) || bytes.Contains(source, markdownAnchorMarker) {
		return nil, false
	}
	spans, split := SplitTopLevelMarkdownBlocks(source)
	if !split || 1 > len(spans) {
		return nil, false
	}

	rootID := MarkdownProjectionID(source, boxID, p)
	keys := markdownSpanKeys(source, spans, rootID, p)

	reused := 0
	for _, key := range keys {
		if _, found := indexed[key]; found {
			reused++
		}
	}
	// One block changed out of two is not worth a second code path; the whole
	// point is skipping most of a document.
	if reused*2 <= len(keys) {
		return nil, false
	}

	ret = &parse.Tree{Box: boxID, Path: p, ID: rootID, HPath: markdownHPath(p)}
	ret.Root = &ast.Node{Type: ast.NodeDocument, ID: rootID, Path: p}

	for index, span := range spans {
		key := keys[index]
		if abbr, found := indexed[key]; found {
			ret.Root.AppendChild(markdownBlockPlaceholder(key, abbr))
			continue
		}
		block := markdownParseOneBlock(source[span.From:span.To], boxID, p, luteEngine)
		if nil == block {
			return nil, false
		}
		block.ID = key
		if nil == block.Properties {
			block.Properties = map[string]string{}
		}
		block.Properties[markdownIndexProjectionProperty] = "1"
		ret.Root.AppendChild(block)
	}

	// The canonical document identity lives on the root's IAL and model/API
	// adapters recover it from there, so a partial tree has to carry it too.
	if canonical := MarkdownDocumentIdentity(source); "" != canonical {
		ret.Root.KramdownIAL = [][]string{{markdownCanonicalIDAttr, canonical}}
	}
	ret.Hash = treenode.NodeHash(ret.Root, ret, luteEngine)
	return ret, true
}

// MarkdownBlockProjectionKeys names every top-level block of a document without
// parsing it, in document order. ok mirrors MarkdownIncrementalTree's rules.
func MarkdownBlockProjectionKeys(source []byte, boxID, p string) (keys []string, ok bool) {
	if bytes.Contains(source, markdownAnchorMarker) {
		return nil, false
	}
	spans, split := SplitTopLevelMarkdownBlocks(source)
	if !split {
		return nil, false
	}
	return markdownSpanKeys(source, spans, MarkdownProjectionID(source, boxID, p), p), true
}

func markdownSpanKeys(source []byte, spans []MarkdownBlockSpan, rootID, p string) []string {
	keys := make([]string, len(spans))
	occurrences := map[string]int{}
	for index, span := range spans {
		seed := string(source[span.From:span.To])
		occurrences[seed]++
		keys[index] = markdownBlockProjectionID(rootID, p, seed, occurrences[seed])
	}
	return keys
}

// markdownBlockPlaceholder stands in for a block the index already holds. It
// carries the identity and type upsertBlockTree compares against, and nothing
// else: no caller may read its content, because it has none.
func markdownBlockPlaceholder(key, abbr string) *ast.Node {
	nodeType := ast.NodeParagraph
	if name := treenode.FromAbbrType(abbr); "" != name {
		if resolved := ast.Str2NodeType(name); 0 != resolved {
			nodeType = resolved
		}
	}
	node := &ast.Node{Type: nodeType, ID: key}
	node.Properties = map[string]string{
		markdownIndexProjectionProperty:  "1",
		markdownIndexPlaceholderProperty: "1",
	}
	return node
}

// markdownParseOneBlock parses one block's source in isolation. The split
// guarantees exactly one top-level block comes back; anything else means the
// scan and Lute disagree and the caller must fall back.
func markdownParseOneBlock(source []byte, boxID, p string, luteEngine *lute.Lute) *ast.Node {
	tree := parse.Parse(p, normalizeOrgEndBlankLines(source), markdownParseOptions(source, luteEngine))
	if nil == tree || nil == tree.Root {
		return nil
	}
	var block *ast.Node
	for n := tree.Root.FirstChild; nil != n; n = n.Next {
		if !n.IsBlock() || ast.NodeKramdownBlockIAL == n.Type {
			continue
		}
		if nil != block {
			return nil
		}
		block = n
	}
	if nil == block {
		return nil
	}
	block.Unlink()
	StripEphemeralMarkdownBlockIDs(&parse.Tree{Root: wrapForStrip(block)})
	return block
}

// wrapForStrip gives StripEphemeralMarkdownBlockIDs the document root it walks
// from, without giving it the real tree.
func wrapForStrip(block *ast.Node) *ast.Node {
	root := &ast.Node{Type: ast.NodeDocument}
	root.AppendChild(block)
	return root
}
