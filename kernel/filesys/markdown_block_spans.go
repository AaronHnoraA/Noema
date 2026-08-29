// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package filesys

import (
	"bytes"
	"regexp"
	"strings"
)

// linkReferenceDefinition matches a CommonMark link reference definition at the
// start of a line. Such a definition is document-scoped, so its presence means
// no block can be understood from its own bytes.
var linkReferenceDefinition = regexp.MustCompile(`(?m)^ {0,3}\[[^\]]+\]:`)

// fenceMarker recognizes a CommonMark code fence: up to three spaces or tabs of
// indent followed by a run of at least three backticks or tildes. Mirrors the
// scanner in noema/markdown, which is unexported and serves a different pass.
func fenceMarker(line string) (marker byte, run int) {
	index := 0
	for index < len(line) && index < 3 && (' ' == line[index] || '\t' == line[index]) {
		index++
	}
	if index >= len(line) {
		return 0, 0
	}
	marker = line[index]
	if '`' != marker && '~' != marker {
		return 0, 0
	}
	for index+run < len(line) && marker == line[index+run] {
		run++
	}
	if 3 > run {
		return 0, 0
	}
	return marker, run
}

// MarkdownBlockSpan is one top-level block's byte range in a Markdown source.
// From is the first byte of the block; To is one past its last byte, excluding
// the blank lines that separate it from the next block.
type MarkdownBlockSpan struct {
	From int
	To   int
}

// SplitTopLevelMarkdownBlocks locates each top-level block in `source` by a
// line scan, without parsing.
//
// This is what makes the index incremental in the parse as well as the write.
// Block keys are derived from these ranges, so the kernel can tell which blocks
// an edit touched — and therefore which ones it has to hand to Lute — before it
// parses anything. Lute has no incremental mode, so the alternative is parsing
// the whole document on every autosave just to discover that one paragraph
// changed.
//
// It reports ok=false rather than guessing. Splitting is only sound where the
// CommonMark block parser is provably between blocks at top level, and where a
// block's meaning does not depend on the rest of the document. Everything the
// scan is not sure about — a construct it does not model, a document-scoped
// definition — makes it decline, and the caller parses the document whole.
//
// The invariant callers depend on, and which TestBlockSpansMatchLuteTopLevel
// enforces over a corpus, is that a successful split has exactly one span per
// top-level node Lute would produce, in the same order.
func SplitTopLevelMarkdownBlocks(source []byte) (spans []MarkdownBlockSpan, ok bool) {
	if declinesIncrementalSplit(source) {
		return nil, false
	}

	scanner := blockSpanScanner{source: source, blockFrom: -1}
	for scanner.offset < len(source) {
		line, next := scanner.line()
		if !scanner.consume(line, next) {
			return nil, false
		}
	}
	scanner.closeBlock(len(source))
	if scanner.openFence() {
		// An unterminated fence means the tail of the document is a single
		// block whose extent the scan guessed. Let Lute decide instead.
		return nil, false
	}
	return scanner.spans, true
}

// declinesIncrementalSplit rejects whole documents whose blocks cannot be
// understood one at a time.
func declinesIncrementalSplit(source []byte) bool {
	// Link reference definitions and footnotes are document-scoped: a
	// definition anywhere changes how every other block renders, so no block is
	// a function of its own bytes.
	if linkReferenceDefinition.Match(source) || bytes.Contains(source, []byte("[^")) {
		return true
	}
	// Legacy kramdown IAL source takes a different parse configuration entirely
	// (see markdownParseOptions) and carries persisted block ids of its own.
	if bytes.Contains(source, legacyIALMarker) {
		return true
	}
	return false
}

type blockSpanScanner struct {
	source []byte
	offset int
	spans  []MarkdownBlockSpan

	blockFrom int // -1 when between blocks
	blockEnd  int // end of the last non-blank line of the open block

	fenceChar byte
	fenceLen  int
	mathFence bool
	listOpen  bool // the open block is a list, which survives blank lines
	listTask  bool // that list's items are GFM task items
	quoteOpen bool // the open block is a block quote, which does not
}

func (s *blockSpanScanner) openFence() bool {
	return 0 != s.fenceChar || s.mathFence
}

// line returns the current line without its terminator and the offset of the
// next line.
func (s *blockSpanScanner) line() (line string, next int) {
	rest := s.source[s.offset:]
	if index := bytes.IndexByte(rest, '\n'); 0 <= index {
		return string(rest[:index]), s.offset + index + 1
	}
	return string(rest), len(s.source)
}

func (s *blockSpanScanner) startBlock() {
	if s.blockFrom < 0 {
		s.blockFrom = s.offset
	}
}

func (s *blockSpanScanner) closeBlock(end int) {
	if s.blockFrom < 0 {
		return
	}
	if s.blockEnd > s.blockFrom {
		end = s.blockEnd
	}
	if end > s.blockFrom {
		s.spans = append(s.spans, MarkdownBlockSpan{From: s.blockFrom, To: end})
	}
	s.blockFrom = -1
	s.blockEnd = 0
	s.listOpen = false
	s.listTask = false
	s.quoteOpen = false
}

// consume advances one line, returning false when the scan has to decline.
func (s *blockSpanScanner) consume(line string, next int) bool {
	trimmed := strings.TrimRight(line, " \t\r")
	blank := "" == trimmed

	switch {
	// A closed fence ends its block there and then. Like a heading it is a
	// delimited construct, so whatever follows on the very next line — a
	// trailing `{size: …}` attribute line, say — is a block of its own.
	case 0 != s.fenceChar:
		s.startBlock()
		s.blockEnd = next
		s.offset = next
		if marker, run := fenceMarker(line); 0 != marker && marker == s.fenceChar && run >= s.fenceLen {
			s.fenceChar, s.fenceLen = 0, 0
			s.closeBlock(next)
		}
		return true

	case s.mathFence:
		s.startBlock()
		s.blockEnd = next
		s.offset = next
		if strings.HasPrefix(trimmed, "$$") {
			s.mathFence = false
			s.closeBlock(next)
		}
		return true

	}

	// HTML blocks come in seven types whose start and end conditions differ —
	// an `<!-- -->` comment runs to its terminator and swallows lines that look
	// like headings and list items, while other types end at a blank line.
	// Telling them apart needs the parser, so a document with raw HTML at the
	// left margin is handed to Lute whole.
	if leftMargin(line) && strings.HasPrefix(strings.TrimLeft(line, " \t"), "<") {
		return false
	}

	if blank {
		// A loose list survives a blank line and stays one list, so it only ends
		// once a following line proves it is over; closeBlock trims back to the
		// last non-blank line either way. A block quote does not survive one.
		if !s.listOpen {
			s.closeBlock(s.offset)
		}
		s.offset = next
		return true
	}

	// A thematic break is its own single-line block and also ends whatever came
	// before it. Noema's parse options disable setext headings, so a `---` line
	// after a paragraph is a break rather than that paragraph's underline.
	if thematicBreak(line) {
		s.closeBlock(s.offset)
		s.blockFrom = s.offset
		s.blockEnd = next
		s.closeBlock(next)
		s.offset = next
		return true
	}

	// Several constructs start a new block even with no blank line before them.
	// Missing that merged a paragraph with the list, heading or fence that
	// followed it directly, which real documents do constantly.
	interrupts := s.blockFrom >= 0 && leftMargin(line) && interruptsParagraph(line)
	// A marker that merely continues the container already open is not an
	// interruption: consecutive items are one list, consecutive `>` lines one
	// quote.
	if interrupts && ((s.listOpen && continuesSameList(s.listTask, line)) || (s.quoteOpen && startsQuote(line))) {
		interrupts = false
	}
	if interrupts {
		s.closeBlock(s.offset)
	} else if s.listOpen && s.blockFrom >= 0 && !continuesList(line) {
		s.closeBlock(s.offset)
	}

	opening := s.blockFrom < 0
	s.startBlock()
	if opening {
		s.listOpen = startsListItem(line)
		s.listTask = s.listOpen && taskListItem(line)
		s.quoteOpen = startsQuote(line)
	}

	if marker, run := fenceMarker(line); 0 != marker {
		s.fenceChar, s.fenceLen = marker, run
	} else if strings.HasPrefix(trimmed, "$$") && !strings.HasSuffix(strings.TrimPrefix(trimmed, "$$"), "$$") {
		s.mathFence = true
	} else if strings.HasPrefix(line, "    ") || strings.HasPrefix(line, "\t") {
		// An indented code block also swallows blank lines, and telling it from
		// a continuation line needs the parser's own state.
		return false
	}

	s.blockEnd = next
	s.offset = next
	if atxHeading(line) {
		s.closeBlock(next)
	}
	return true
}

// leftMargin reports at most three columns of indent, past which a line is
// continuation or code rather than the start of a new top-level construct.
func leftMargin(line string) bool {
	indent := 0
	for indent < len(line) && indent < 4 && (' ' == line[indent] || '\t' == line[indent]) {
		indent++
	}
	return 4 > indent
}

// interruptsParagraph reports a line that begins a new block even when the
// previous line was ordinary paragraph text.
//
// Ordered lists are deliberately restricted to `1.`/`1)`: CommonMark only lets
// a list starting at one interrupt a paragraph, and a `2.` line that stays
// inside the paragraph is exactly what Lute does too, so the scan agrees by
// doing nothing.
func interruptsParagraph(line string) bool {
	trimmed := strings.TrimLeft(line, " \t")
	if atxHeading(line) || thematicBreak(line) {
		return true
	}
	if marker, _ := fenceMarker(line); 0 != marker {
		return true
	}
	if strings.HasPrefix(trimmed, "> ") || ">" == strings.TrimRight(trimmed, " \t\r") {
		return true
	}
	if strings.HasPrefix(trimmed, "$$") {
		return true
	}
	if 2 <= len(trimmed) && strings.ContainsRune("-*+", rune(trimmed[0])) &&
		(' ' == trimmed[1] || '\t' == trimmed[1]) {
		return true
	}
	return strings.HasPrefix(trimmed, "1. ") || strings.HasPrefix(trimmed, "1) ") ||
		strings.HasPrefix(trimmed, "1.\t") || strings.HasPrefix(trimmed, "1)\t")
}

// thematicBreak reports a CommonMark thematic break: three or more of `-`, `_`
// or `*`, optionally separated by spaces or tabs, with at most three of indent.
func thematicBreak(line string) bool {
	trimmed := strings.TrimLeft(line, " \t")
	if len(line)-len(trimmed) > 3 {
		return false
	}
	trimmed = strings.TrimRight(trimmed, " \t\r")
	if "" == trimmed {
		return false
	}
	marker := trimmed[0]
	if '-' != marker && '_' != marker && '*' != marker {
		return false
	}
	run := 0
	for index := 0; index < len(trimmed); index++ {
		switch trimmed[index] {
		case marker:
			run++
		case ' ', '\t':
		default:
			return false
		}
	}
	return 3 <= run
}

// atxHeading reports a `#`-prefixed heading, which is a single-line block even
// when it is not separated from its neighbours by blank lines.
func atxHeading(line string) bool {
	trimmed := strings.TrimLeft(line, " \t")
	hashes := 0
	for hashes < len(trimmed) && '#' == trimmed[hashes] {
		hashes++
	}
	return 0 < hashes && 7 > hashes &&
		(hashes == len(trimmed) || ' ' == trimmed[hashes] || '\t' == trimmed[hashes])
}

// continuesSameList reports a marker that belongs to the list already open.
//
// GFM starts a new list when an item's task-ness changes, so a plain bullet
// followed by `- [ ] …` is two lists, not one — which is exactly what Lute
// does and what a scan that only looked for a marker got wrong. Only markers at
// the left margin count; an indented one is a nested list inside the open item.
func continuesSameList(openIsTask bool, line string) bool {
	if !startsListItem(line) {
		return false
	}
	indent := 0
	for indent < len(line) && (' ' == line[indent] || '\t' == line[indent]) {
		indent++
	}
	if 2 <= indent {
		return true
	}
	return taskListItem(line) == openIsTask
}

// taskListItem reports a GFM task list marker such as `- [ ] ` or `* [x] `.
func taskListItem(line string) bool {
	trimmed := strings.TrimLeft(line, " \t")
	if 2 > len(trimmed) || !strings.ContainsRune("-*+", rune(trimmed[0])) {
		return false
	}
	rest := strings.TrimLeft(trimmed[1:], " \t")
	if 3 > len(rest) || '[' != rest[0] || ']' != rest[2] {
		return false
	}
	marker := rest[1]
	return ' ' == marker || 'x' == marker || 'X' == marker
}

// startsQuote reports a block quote marker at the left margin.
func startsQuote(line string) bool {
	trimmed := strings.TrimLeft(line, " \t")
	return strings.HasPrefix(trimmed, "> ") || ">" == strings.TrimRight(trimmed, " \t\r")
}

// startsListItem reports a bullet or ordered list marker at the left margin.
func startsListItem(line string) bool {
	trimmed := strings.TrimLeft(line, " \t")
	if 2 <= len(trimmed) && strings.ContainsRune("-*+", rune(trimmed[0])) && (' ' == trimmed[1] || '\t' == trimmed[1]) {
		return true
	}
	digits := 0
	for digits < len(trimmed) && '0' <= trimmed[digits] && '9' >= trimmed[digits] {
		digits++
	}
	return 0 < digits && digits+1 < len(trimmed) &&
		('.' == trimmed[digits] || ')' == trimmed[digits]) &&
		(' ' == trimmed[digits+1] || '\t' == trimmed[digits+1])
}

// continuesList reports a line that still belongs to an open list: another
// marker, or an indented continuation line.
func continuesList(line string) bool {
	return startsListItem(line) ||
		strings.HasPrefix(line, "  ") || strings.HasPrefix(line, "\t")
}
