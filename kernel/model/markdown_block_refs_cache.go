// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package model

import (
	"bytes"
	"encoding/binary"
	"hash/maphash"
)

var markdownSignatureSeed = maphash.MakeSeed()

// markdownBlockRefSignature digests everything about a document that its block
// list can depend on, straight from the source bytes.
//
// A block list names the document and the blocks it anchors, so it can only
// change if an anchor moved, appeared or vanished, or if the block a given
// anchor belongs to changed shape. The first is covered by digesting every line
// that carries a "{#" anchor. The second is covered by also digesting every
// line that is blank or opens with a block-structural marker — headings, list
// bullets, quotes, fences, tables, org markers, indented code — because those
// are the lines that decide where one block ends and the next begins.
//
// The digest is deliberately conservative: including a line that turns out not
// to matter only costs a parse that could have been skipped, while excluding
// one that does matter would hand back a stale block list. Ordinary prose
// edits, which is what a debounced editor sends between anchors, touch none of
// these lines.
//
// It runs as a single pass over the bytes with no allocation, because it is on
// the save response path for every note.
func markdownBlockRefSignature(canonicalDocID string, source []byte) uint64 {
	var h maphash.Hash
	h.SetSeed(markdownSignatureSeed)
	h.WriteString(canonicalDocID)
	h.WriteByte(0)

	var lineNumber uint32
	rest := source
	for {
		line := rest
		final := true
		if index := bytes.IndexByte(rest, '\n'); 0 <= index {
			line, rest, final = rest[:index], rest[index+1:], false
		}
		lineNumber++
		if markdownLineAffectsBlocks(line) {
			var number [4]byte
			binary.LittleEndian.PutUint32(number[:], lineNumber)
			h.Write(number[:])
			h.Write(line)
			h.WriteByte(1)
		}
		if final {
			break
		}
	}
	return h.Sum64()
}

// markdownLineAffectsBlocks reports whether a line can influence the document's
// block list: it either carries an anchor, or is a block boundary.
func markdownLineAffectsBlocks(line []byte) bool {
	if bytes.Contains(line, markdownAnchorOpener) {
		return true
	}

	indent := 0
	for indent < len(line) && (' ' == line[indent] || '\t' == line[indent]) {
		if '\t' == line[indent] {
			return true // an indented code block boundary
		}
		indent++
	}
	if 4 <= indent {
		return true // an indented code block boundary
	}
	if indent == len(line) {
		return true // blank: paragraphs begin and end here
	}

	switch c := line[indent]; c {
	case '#', '-', '*', '+', '>', '`', '~', '|', '=', '_', ':', '$':
		// Headings, bullets, quotes, fences, tables, setext underlines,
		// thematic breaks, org markers and math fences all open with one of
		// these.
		return true
	default:
		// An ordered list marker: digits followed by '.' or ')'.
		at := indent
		for at < len(line) && '0' <= line[at] && line[at] <= '9' {
			at++
		}
		return at > indent && at < len(line) && ('.' == line[at] || ')' == line[at])
	}
}

var markdownAnchorOpener = []byte("{#")
