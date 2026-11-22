// Package wikiindex derives the Wiki index's fields from notes.
//
// Parse is the kernel's side of the per-note parse contract
// (docs/noema/design/wiki-workspace.md "Index ownership"): from one note's
// text alone it gives what the Node indexer's parseWikiNoteContent gives,
// field for field, pinned by shared/wiki-note-parse-fixtures.json. Offsets
// are UTF-16 code units, as JavaScript counts them, so both sides report the
// same numbers for the same text.
package wikiindex

import (
	"encoding/json"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// Link is a page reference written in the note.
type Link struct {
	Target string `json:"target"`
	Label  string `json:"label"`
}

// Block is an addressable block id in the note.
type Block struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	EnvKind string `json:"envKind"`
	Label   string `json:"label"`
	Offset  int    `json:"offset"`
}

// Note is what the index derives from one note's text.
type Note struct {
	Title                string   `json:"title"`
	PersistedID          string   `json:"persistedId"`
	IdentityStatus       string   `json:"identityStatus"`
	PageNamespaceAliases []string `json:"pageNamespaceAliases"`
	Aliases              []string `json:"aliases"`
	Tags                 []string `json:"tags"`
	Blocks               []Block  `json:"blocks"`
	DuplicateBlockIDs    []string `json:"duplicateBlockIds"`
	WikiLinks            []Link   `json:"wikiLinks"`
}

const (
	blockIDSource            = `[A-Za-z0-9][A-Za-z0-9._:-]{2,127}`
	orgMetaPreambleLineLimit = 12
)

var (
	metaBlockRE      = regexp.MustCompile(`(?im)^[ \t]*#\+begin\s+meta[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*#\+end\s+meta`)
	frontMatterRE    = regexp.MustCompile(`^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)`)
	metaFieldRE      = regexp.MustCompile(`^\s*([A-Za-z][\w-]*):\s*(.*?)\s*$`)
	headingTitleRE   = regexp.MustCompile(`(?m)^#+\s+(.+)$`)
	setextTitleRE    = regexp.MustCompile(`(?m)^=+\s+(.+)$`)
	commentAnchorRE  = regexp.MustCompile(`\{==([^\n]*?)==\}\{>>#(c-[A-Za-z0-9_-]{4,64})<<\}`)
	legacyIDRE       = regexp.MustCompile(`^\d{14}-`)
	uuidShapeRE      = regexp.MustCompile(`(?i)^[0-9a-f-]{36}$`)
	orgOpenRE        = regexp.MustCompile(`(?im)^[ \t]*#\+\s*begin\s+(\S+)(?:[ \t]+([^\n]*))?[ \t]*$`)
	trailingBlockRE  = regexp.MustCompile(`^(?:(.*?)[ \t]+)?\{#(` + blockIDSource + `)(?:[ \t]+([^{}\r\n]*))?\}[ \t]*$`)
	explicitAnchorRE = regexp.MustCompile(`\{#(` + blockIDSource + `)\}`)
	planningIDRE     = regexp.MustCompile(`\{[^{}\n]*\bid\s*[:=]\s*["']?(` + blockIDSource + `)["']?[^{}\n]*\}`)
	trailingAttrsRE  = regexp.MustCompile(`\{[^{}]*\}\s*$`)
	wikiLinkRE       = regexp.MustCompile(`\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]`)
	markdownLinkRE   = regexp.MustCompile(`\[[^\]\n]*\]\(((?:[^()\n]|\([^()\n]*\))+)\)`)
	schemeRE         = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*:`)
	roamRE           = regexp.MustCompile(`(?i)^roam://`)
	localRefRE       = regexp.MustCompile(`(?i)^(?:roam://|#|\./?#)`)
	markdownFragRE   = regexp.MustCompile(`(?i)\.(?:md|markdown)#`)
	fenceOpenRE      = regexp.MustCompile(`^[ \t]{0,3}(` + "`" + `{3,}|~{3,})(.*)$`)
	inlineCodeRE     = regexp.MustCompile("`[^`\n]*`")
	spacesRE         = regexp.MustCompile(`\s+`)
)

var nonSemanticOrgEnvs = map[string]bool{
	"ediff": true, "comment": true, "fold": true, "html": true,
	"lean4": true, "meta": true, "org": true, "tikz": true,
}

// Parse derives the index fields of the note CONTENT read from FILE.
func Parse(content, file string) Note {
	approved := commentAnchorRE.ReplaceAllString(approvedEdiffMarkdown(content), "$1")
	meta := metadata(content)
	persisted := strings.TrimSpace(meta["id"])
	status := "provisional"
	if persisted != "" {
		status = "managed"
		if legacyIDRE.MatchString(persisted) || !uuidShapeRE.MatchString(persisted) {
			status = "legacy"
		}
	}
	nsAliases := []string{}
	for _, alias := range parseList(meta["namespace_aliases"]) {
		if normalized := NormalizeNamespace(alias); normalized != "" {
			nsAliases = append(nsAliases, normalized)
		}
	}
	blocks, duplicates := blockIDs(approved)
	return Note{
		Title:                titleFor(file, content, meta),
		PersistedID:          persisted,
		IdentityStatus:       status,
		PageNamespaceAliases: nsAliases,
		Aliases:              parseList(meta["aliases"]),
		Tags:                 parseList(meta["tags"]),
		Blocks:               blocks,
		DuplicateBlockIDs:    duplicates,
		WikiLinks:            wikiLinks(approved),
	}
}

// NormalizeNamespace matches shared/wiki-link.mjs normalizeWikiNamespace.
func NormalizeNamespace(value string) string {
	parts := []string{}
	for _, part := range strings.Split(strings.TrimSpace(norm.NFKC.String(value)), "/") {
		part = spacesRE.ReplaceAllString(strings.TrimSpace(part), " ")
		if part != "" {
			parts = append(parts, part)
		}
	}
	return strings.Join(parts, "/")
}

func parseList(value string) []string {
	text := strings.TrimSpace(value)
	out := []string{}
	if text == "" {
		return out
	}
	quoted := strings.HasPrefix(text, "[") && strings.HasSuffix(text, "]")
	if quoted {
		text = text[1 : len(text)-1]
	}
	for _, part := range strings.Split(text, ",") {
		part = strings.TrimSpace(part)
		if quoted {
			part = trimOneQuote(part)
		}
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

// trimOneQuote drops one leading and one trailing quote, as /^['"]|['"]$/g does.
func trimOneQuote(value string) string {
	if strings.HasPrefix(value, `"`) || strings.HasPrefix(value, "'") {
		value = value[1:]
	}
	if strings.HasSuffix(value, `"`) || strings.HasSuffix(value, "'") {
		value = value[:len(value)-1]
	}
	return value
}

func metadata(content string) map[string]string {
	fields := map[string]string{}
	source := ""
	if front := frontMatterRE.FindStringSubmatch(content); front != nil && front[1] != "" {
		source = front[1]
	} else if loc := metaBlockRE.FindStringSubmatchIndex(content); loc != nil {
		// The meta block is page identity only in the preamble.
		if strings.Count(content[:loc[0]], "\n") < orgMetaPreambleLineLimit {
			source = content[loc[2]:loc[3]]
		}
	}
	for _, line := range regexp.MustCompile(`\r?\n`).Split(source, -1) {
		match := metaFieldRE.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		fields[strings.ToLower(match[1])] = trimOneQuote(match[2])
	}
	return fields
}

func titleFor(file, content string, meta map[string]string) string {
	if title := meta["title"]; title != "" {
		return strings.TrimSpace(title)
	}
	if match := headingTitleRE.FindStringSubmatch(content); match != nil {
		return strings.TrimSpace(match[1])
	}
	if match := setextTitleRE.FindStringSubmatch(content); match != nil {
		return strings.TrimSpace(match[1])
	}
	base := filepath.Base(file)
	return strings.TrimSpace(strings.TrimSuffix(base, filepath.Ext(base)))
}

// utf16Len is the length JavaScript gives TEXT.
func utf16Len(text string) int {
	n := 0
	for _, r := range text {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// maskMarkdownCode blanks fenced and inline code, keeping UTF-16 lengths.
func maskMarkdownCode(content string) string {
	var out strings.Builder
	fenceChar, fenceLen := byte(0), 0
	for _, raw := range splitKeepNewline(content) {
		line := strings.TrimSuffix(raw, "\n")
		newline := raw[len(line):]
		if match := fenceOpenRE.FindStringSubmatch(line); match != nil {
			marker := match[1]
			closing := fenceChar != 0 && marker[0] == fenceChar && len(marker) >= fenceLen && strings.TrimSpace(match[2]) == ""
			if fenceChar == 0 {
				fenceChar, fenceLen = marker[0], len(marker)
			} else if closing {
				fenceChar, fenceLen = 0, 0
			}
			out.WriteString(strings.Repeat(" ", utf16Len(line)) + newline)
			continue
		}
		if fenceChar != 0 {
			out.WriteString(strings.Repeat(" ", utf16Len(line)) + newline)
			continue
		}
		out.WriteString(inlineCodeRE.ReplaceAllStringFunc(line, func(code string) string {
			return strings.Repeat(" ", utf16Len(code))
		}) + newline)
	}
	return out.String()
}

func splitKeepNewline(text string) []string {
	lines := []string{}
	for text != "" {
		at := strings.IndexByte(text, '\n')
		if at < 0 {
			lines = append(lines, text)
			break
		}
		lines = append(lines, text[:at+1])
		text = text[at+1:]
	}
	return lines
}

func parseOrgEnvBlockID(kind, value string) (title, blockID string) {
	raw := strings.TrimSpace(value)
	if nonSemanticOrgEnvs[strings.ToLower(strings.TrimSpace(kind))] {
		return raw, ""
	}
	match := trailingBlockRE.FindStringSubmatch(raw)
	if match == nil {
		return raw, ""
	}
	return strings.TrimSpace(match[1]), match[2]
}

func blockIDs(content string) ([]Block, []string) {
	visible := maskMarkdownCode(content)
	offset := func(byteIndex int) int { return utf16Len(visible[:byteIndex]) }
	ids := []Block{}
	orgAnchors := map[string]bool{}
	for _, m := range orgOpenRE.FindAllStringSubmatchIndex(visible, -1) {
		envKind := strings.ToLower(visible[m[2]:m[3]])
		rest := ""
		if m[4] >= 0 {
			rest = visible[m[4]:m[5]]
		}
		title, id := parseOrgEnvBlockID(envKind, rest)
		if id == "" {
			continue
		}
		at := offset(m[0] + strings.LastIndex(visible[m[0]:m[1]], id))
		label := envKind
		if title != "" {
			label += " · " + title
		}
		ids = append(ids, Block{ID: id, Kind: "org-env", Label: label, EnvKind: envKind, Offset: at})
		orgAnchors[id+"\x00"+strconv.Itoa(at)] = true
	}
	for _, m := range explicitAnchorRE.FindAllStringSubmatchIndex(visible, -1) {
		id := visible[m[2]:m[3]]
		at := offset(m[0])
		if orgAnchors[id+"\x00"+strconv.Itoa(at+2)] {
			continue
		}
		ids = append(ids, Block{ID: id, Kind: "anchor", Label: id, Offset: at})
	}
	for _, m := range planningIDRE.FindAllStringSubmatchIndex(visible, -1) {
		id := visible[m[2]:m[3]]
		lineStart := strings.LastIndex(visible[:m[0]], "\n") + 1
		lineEnd := strings.Index(visible[m[0]:], "\n")
		if lineEnd < 0 {
			lineEnd = len(visible)
		} else {
			lineEnd += m[0]
		}
		label := strings.TrimSpace(trailingAttrsRE.ReplaceAllString(visible[lineStart:lineEnd], ""))
		if label == "" {
			label = id
		}
		ids = append(ids, Block{ID: id, Kind: "planning", Label: label, Offset: offset(m[0])})
	}
	// First occurrence orders, last occurrence wins (a JavaScript Map).
	order := []string{}
	last := map[string]Block{}
	counts := map[string]int{}
	for _, block := range ids {
		if _, seen := last[block.ID]; !seen {
			order = append(order, block.ID)
		}
		last[block.ID] = block
		counts[block.ID]++
	}
	blocks := []Block{}
	duplicates := []string{}
	for _, id := range order {
		blocks = append(blocks, last[id])
		if counts[id] > 1 {
			duplicates = append(duplicates, id)
		}
	}
	return blocks, duplicates
}

func wikiLinks(content string) []Link {
	source := maskMarkdownCode(content)
	links := []Link{}
	for pos := 0; pos < len(source); {
		m := wikiLinkRE.FindStringSubmatchIndex(source[pos:])
		if m == nil {
			break
		}
		start := pos + m[0]
		// `\[[x]]` is literal: the JavaScript pattern's (?<!\\).
		if start > 0 && source[start-1] == '\\' {
			_, size := utf8.DecodeRuneInString(source[start:])
			pos = start + size
			continue
		}
		rawTarget := source[pos+m[2] : pos+m[3]]
		target := strings.TrimSpace(rawTarget)
		label := target
		if m[4] >= 0 {
			label = strings.TrimSpace(source[pos+m[4] : pos+m[5]])
		}
		if target != "" && label != "" {
			links = append(links, Link{Target: target, Label: label})
		}
		pos += m[1]
	}
	for _, m := range markdownLinkRE.FindAllStringSubmatch(source, -1) {
		target := strings.TrimSpace(m[1])
		external := schemeRE.MatchString(target) && !roamRE.MatchString(target)
		if !external && (localRefRE.MatchString(target) || markdownFragRE.MatchString(target)) {
			links = append(links, Link{Target: target, Label: ""})
		}
	}
	return links
}

var (
	ediffOpenRE   = regexp.MustCompile(`(?i)^#\+begin ediff(?:[ \t]+(.*?))?[ \t]*$`)
	ediffCloseRE  = regexp.MustCompile(`(?i)^#\+end ediff[ \t]*$`)
	ediffFenceRE  = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})")
	ediffChangeRE = regexp.MustCompile(`^[ +\-]`)
)

type ediffLine struct {
	text          string
	from, to, end int
}

type ediffChange struct {
	kind      byte
	text      string
	noNewline bool
}

// approvedEdiffMarkdown resolves each valid review block to its old side, as
// shared/ediff-source.mjs does for indexing and export.
func approvedEdiffMarkdown(source string) string {
	lines := []ediffLine{}
	for at := 0; at < len(source); {
		end := strings.IndexByte(source[at:], '\n')
		if end < 0 {
			lines = append(lines, ediffLine{source[at:], at, len(source), len(source)})
			break
		}
		lines = append(lines, ediffLine{source[at : at+end], at, at + end, at + end + 1})
		at += end + 1
	}
	var out strings.Builder
	cursor := 0
	fence := ""
	for i := 0; i < len(lines); i++ {
		line := lines[i].text
		if fence != "" {
			trimmed := strings.TrimRight(line, " \t\r\v\f")
			lead := len(trimmed) - len(strings.TrimLeft(trimmed, " "))
			body := trimmed[lead:]
			if lead <= 3 && len(body) >= len(fence) && strings.Trim(body, fence[:1]) == "" {
				fence = ""
			}
			continue
		}
		if m := ediffFenceRE.FindStringSubmatch(line); m != nil {
			fence = m[1]
			continue
		}
		if !ediffOpenRE.MatchString(line) {
			continue
		}
		closeAt := i + 1
		for closeAt < len(lines) && !ediffCloseRE.MatchString(lines[closeAt].text) {
			closeAt++
		}
		if closeAt >= len(lines) {
			continue
		}
		bad := false
		body := i + 1
		for ; body < closeAt; body++ {
			text := lines[body].text
			if text == "@@ediff-status rejected" {
				continue
			} else if strings.HasPrefix(text, "@@ediff-comment ") {
				var comment string
				if json.Unmarshal([]byte(text[len("@@ediff-comment "):]), &comment) != nil {
					bad = true
				}
			} else if strings.HasPrefix(text, "@@ediff-author ") {
				var author struct {
					Name *string `json:"name"`
				}
				if json.Unmarshal([]byte(text[len("@@ediff-author "):]), &author) != nil || author.Name == nil {
					bad = true
				}
			} else {
				break
			}
		}
		changes := []ediffChange{}
		for j := body; j < closeAt; j++ {
			raw := lines[j].text
			if raw == "\\ No newline at end of file" {
				if len(changes) == 0 || changes[len(changes)-1].noNewline {
					bad = true
				} else {
					changes[len(changes)-1].noNewline = true
				}
			} else if ediffChangeRE.MatchString(raw) {
				changes = append(changes, ediffChange{kind: raw[0], text: raw[1:]})
			} else {
				bad = true
			}
		}
		edits := false
		oldLines, newLines := []ediffChange{}, []ediffChange{}
		for _, change := range changes {
			if change.kind == '+' || change.kind == '-' {
				edits = true
			}
			if change.kind != '+' {
				oldLines = append(oldLines, change)
			}
			if change.kind != '-' {
				newLines = append(newLines, change)
			}
		}
		if !edits {
			bad = true
		}
		end := lines[closeAt].end
		for _, side := range [][]ediffChange{oldLines, newLines} {
			for index, change := range side {
				if change.noNewline && (index != len(side)-1 || end != len(source)) {
					bad = true
				}
			}
		}
		from, to := lines[i].from, lines[closeAt].to
		out.WriteString(source[cursor:from])
		if bad {
			out.WriteString(source[from:end])
		} else if len(oldLines) > 0 {
			texts := make([]string, len(oldLines))
			for index, change := range oldLines {
				texts[index] = change.text
			}
			out.WriteString(strings.Join(texts, "\n"))
			if !oldLines[len(oldLines)-1].noNewline && end > to {
				out.WriteString("\n")
			}
		}
		cursor = end
		i = closeAt
	}
	out.WriteString(source[cursor:])
	return out.String()
}
