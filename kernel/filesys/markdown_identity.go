// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema markdown-box identity projection additions are Copyright (c) 2026
// Aaron He and distributed under the same AGPL-3.0-or-later terms.

package filesys

import (
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
func MarkdownDocumentIdentity(markdown []byte) string {
	lines := strings.Split(strings.ReplaceAll(string(markdown), "\r\n", "\n"), "\n")
	metaStart := -1
	for i, line := range lines {
		if 12 <= i {
			break
		}
		if markdownMetaBeginPattern.MatchString(line) {
			metaStart = i
			break
		}
	}
	if 0 <= metaStart {
		candidate := ""
		summaryDepth := 0
		for _, line := range lines[metaStart+1:] {
			if markdownSummaryBeginPattern.MatchString(line) {
				summaryDepth++
				continue
			}
			if 0 < summaryDepth {
				if markdownSummaryEndPattern.MatchString(line) {
					summaryDepth--
				}
				continue
			}
			if markdownMetaEndPattern.MatchString(line) {
				return candidate
			}
			if match := markdownMetaIDPattern.FindStringSubmatch(line); nil != match {
				candidate = strings.Trim(strings.TrimSpace(match[1]), `"'`)
			}
		}
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
	canonical := MarkdownDocumentIdentity(markdown)
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
	projectionID := MarkdownProjectionID(markdown, boxID, p)
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
