// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema markdown-box identity projection additions are Copyright (c) 2026
// Aaron He and distributed under the same AGPL-3.0-or-later terms.

package filesys

import (
	"bytes"
	"errors"
	"regexp"
	"strings"

	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	noemaidentity "github.com/aaronhe/noema/kernel/noema/identity"
)

const markdownCanonicalIDAttr = "custom-noema-id"

var (
	markdownMetaBeginPattern    = regexp.MustCompile(`(?i)^\s*#\+begin\s+meta(?:\s.*)?$`)
	markdownMetaEndPattern      = regexp.MustCompile(`(?i)^\s*#\+end\s+meta\s*$`)
	markdownSummaryBeginPattern = regexp.MustCompile(`(?i)^\s*#\+begin\s+summary(?:\s.*)?$`)
	markdownSummaryEndPattern   = regexp.MustCompile(`(?i)^\s*#\+end\s+summary\s*$`)
	markdownMetaIDPattern       = regexp.MustCompile(`(?i)^\s*id\s*:\s*(\S.*?)\s*$`)
	legacyDocIALIDPattern       = regexp.MustCompile(`(?m)^\s*\{:\s+[^\n}]*\bid="([0-9]{14}-[0-9a-z]{7})"[^\n}]*\btype="?doc"?[^\n}]*\}\s*$`)
	legacyDocIALOpener          = []byte("{:")
	carriageReturn              = []byte("\r")
)

// ErrMarkdownTreeWriteUnsupported is returned when a caller tries to send a
// markdown box through SiYuan's AST formatter. Noema's source text is the
// authority: markdown mutations must use the text protocol or a targeted
// source patch, never a whole-document AST render.
var ErrMarkdownTreeWriteUnsupported = errors.New("markdown boxes are source-authoritative; use the markdown text protocol instead of WriteTree")

// MarkdownDocumentIdentity returns the canonical identity declared by Noema's
// leading org-env meta block. The meta opener must start within the first 12
// lines, matching Noema's existing metadata recognition boundary. A legacy
// SiYuan document IAL is accepted only as a read-compatibility fallback; this
// package never creates one.
// It walks the source line by line rather than materializing a slice of every
// line, because only the opening meta block can carry the canonical ID.
func MarkdownDocumentIdentity(markdown []byte) string {
	rest := markdown
	canonical := ""
	inMeta := false
	summaryDepth := 0
	for lineNumber := 0; 0 < len(rest) || 0 == lineNumber; lineNumber++ {
		var line []byte
		if index := bytes.IndexByte(rest, '\n'); 0 <= index {
			line, rest = rest[:index], rest[index+1:]
		} else {
			line, rest = rest, nil
		}
		line = bytes.TrimSuffix(line, carriageReturn)

		if !inMeta {
			if 12 <= lineNumber {
				break
			}
			inMeta = markdownMetaBeginPattern.Match(line)
			continue
		}
		if markdownSummaryBeginPattern.Match(line) {
			summaryDepth++
			continue
		}
		if 0 < summaryDepth {
			if markdownSummaryEndPattern.Match(line) {
				summaryDepth--
			}
			continue
		}
		if markdownMetaEndPattern.Match(line) {
			return canonical
		}
		if match := markdownMetaIDPattern.FindSubmatch(line); nil != match {
			canonical = strings.Trim(strings.TrimSpace(string(match[1])), `"'`)
		}
	}
	// Reaching here means either there was no meta opener at all or the meta
	// block was never terminated; both fall through to the legacy fallback,
	// discarding any id an unterminated block had already declared.
	//
	// The legacy SiYuan document IAL is a read-compatibility fallback only, so
	// guard its whole-document scan behind the literal every such IAL starts
	// with and ordinary Noema notes never pay for it.
	if !bytes.Contains(markdown, legacyDocIALOpener) {
		return ""
	}
	if match := legacyDocIALIDPattern.FindSubmatch(markdown); nil != match {
		return string(match[1])
	}
	return ""
}

// MarkdownProjectionID produces a valid SiYuan-shaped internal node key from
// Noema's canonical identity. It is a deterministic, disposable projection:
// callers must expose MarkdownDocumentIdentity at product/API boundaries and
// must never serialize this key into Markdown. Unregistered documents use the
// box/path pair, matching Noema's existing provisional page-identity model.
func MarkdownProjectionID(markdown []byte, boxID, p string) string {
	return markdownProjectionIDOf(MarkdownDocumentIdentity(markdown), boxID, p)
}

func markdownProjectionIDOf(canonical, boxID, p string) string {
	fallback := boxID + "\x00" + strings.TrimSpace(strings.ReplaceAll(p, "\\", "/"))
	return noemaidentity.ProjectionID(canonical, fallback)
}

// ApplyMarkdownDocumentIdentity removes lute's synthetic document IAL and
// installs the deterministic internal root key. The canonical Noema identity
// is retained only on the in-memory AST so model/API adapters can recover it;
// WriteTree rejects markdown trees, so this attribute cannot leak to source.
func ApplyMarkdownDocumentIdentity(tree *parse.Tree, markdown []byte, boxID, p string) {
	if nil == tree || nil == tree.Root {
		return
	}
	if last := tree.Root.LastChild; nil != last && ast.NodeKramdownBlockIAL == last.Type {
		if strings.Contains(last.TokensStr(), `type="doc"`) || strings.Contains(last.TokensStr(), `type=doc`) {
			last.Unlink()
		}
	}
	tree.Root.KramdownIAL = nil
	canonical := MarkdownDocumentIdentity(markdown)
	if "" != canonical {
		tree.Root.KramdownIAL = [][]string{{markdownCanonicalIDAttr, canonical}}
	}
	projectionID := markdownProjectionIDOf(canonical, boxID, p)
	tree.Root.ID = projectionID
	tree.ID = projectionID
}

// MarkdownCanonicalDocumentID returns the user-facing document identity for a
// loaded markdown tree, falling back to its deterministic provisional key.
func MarkdownCanonicalDocumentID(tree *parse.Tree) string {
	if nil == tree || nil == tree.Root {
		return ""
	}
	if canonical := tree.Root.IALAttr(markdownCanonicalIDAttr); "" != canonical {
		return canonical
	}
	return tree.ID
}
