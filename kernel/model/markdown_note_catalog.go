// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package model

import (
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/aaronhe/noema/kernel/filesys"
	noemamarkdown "github.com/aaronhe/noema/kernel/noema/markdown"
)

// MarkdownNoteBlock is the editor-facing portable anchor projection. Offset is
// measured in UTF-16 code units because it is consumed directly by CodeMirror.
type MarkdownNoteBlock struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	EnvKind string `json:"envKind,omitempty"`
	Label   string `json:"label,omitempty"`
	Offset  int    `json:"offset"`
}

type MarkdownNoteDOMTarget struct {
	Label     string   `json:"label"`
	Slug      string   `json:"slug"`
	Path      []string `json:"path"`
	LabelPath []string `json:"labelPath"`
	Level     int      `json:"level"`
	NotePath  string   `json:"notePath"`
}

// MarkdownNoteSummary is the Go-owned equivalent of the historical Node note
// index row. Source parsing is cached per immutable markdownSnapshot; catalog
// reads only clone/sort rows and reconnect their in-memory relationships.
type MarkdownNoteSummary struct {
	Key        string                  `json:"key"`
	ID         string                  `json:"id"`
	Title      string                  `json:"title"`
	File       string                  `json:"file"`
	Link       string                  `json:"link"`
	Path       string                  `json:"path"`
	Ext        string                  `json:"ext"`
	Kind       string                  `json:"kind"`
	Date       string                  `json:"date,omitempty"`
	GroupKey   string                  `json:"groupKey"`
	GroupLabel string                  `json:"groupLabel"`
	Section    string                  `json:"section"`
	Source     string                  `json:"source,omitempty"`
	Project    string                  `json:"project,omitempty"`
	Aliases    []string                `json:"aliases"`
	Summary    string                  `json:"summary,omitempty"`
	Tags       []string                `json:"tags"`
	InlineTags []string                `json:"inlineTags"`
	Blocks     []MarkdownNoteBlock     `json:"blocks"`
	Refs       []string                `json:"refs"`
	Backlinks  []string                `json:"backlinks"`
	Roam       bool                    `json:"roam"`
	DOMTargets []MarkdownNoteDOMTarget `json:"domTargets"`
	LeanBlocks []any                   `json:"leanBlocks"`
	Standalone bool                    `json:"standalone"`
	MtimeMs    float64                 `json:"mtimeMs"`
	Size       int64                   `json:"size"`
}

type MarkdownNoteDirectory struct {
	Path      string `json:"path"`
	Label     string `json:"label"`
	Parent    string `json:"parent"`
	NoteCount int    `json:"noteCount"`
	FileCount int    `json:"fileCount"`
	Generated bool   `json:"generated"`
}

type MarkdownNoteCatalog struct {
	Notes        []MarkdownNoteSummary   `json:"notes"`
	Directories  []MarkdownNoteDirectory `json:"directories"`
	Files        []any                   `json:"files"`
	IndexVersion uint64                  `json:"indexVersion"`
	Source       string                  `json:"source"`
}

type noteMetaValue struct {
	scalar string
	list   []string
	isList bool
}

type noteSourceLine struct {
	start    int
	text     string
	eolUnits int
}

type noteHeading struct {
	label string
	slug  string
	level int
}

var (
	noteMetaPairPattern       = regexp.MustCompile(`^([A-Za-z0-9_-]+)\s*:\s*(.*)$`)
	noteMetaListItemPattern   = regexp.MustCompile(`^\s*-\s*(.+?)\s*$`)
	noteHeadingPattern        = regexp.MustCompile(`^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$`)
	noteInlineTagPattern      = regexp.MustCompile(`(?i)@@tag(?:\([^\n)]*\))?[ \t]+\[([^\]\n]+)\]`)
	noteRefTokenPattern       = regexp.MustCompile(`(?i)#note\("([^"]+)"\)|\broam://[^\s<>)\]|]+`)
	noteAnchorPattern         = regexp.MustCompile(`(?i)\{#([A-Za-z0-9][A-Za-z0-9._:-]{2,127})\}`)
	notePlanningAnchorPattern = regexp.MustCompile(`(?i)\{[^{}\n]*\bid\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9._:-]{2,127})["']?[^{}\n]*\}`)
	noteOrgBeginPattern       = regexp.MustCompile(`(?i)^\s*#\+\s*begin\s+([A-Za-z0-9_-]+)(?:\s+(.*?))?\s*$`)
	noteSemanticPattern       = regexp.MustCompile(`(?i)^@@(part|section)(?:\(([^)\n]*)\))?[ \t]+\[([^\]\n]+)\](?:[ \t]*\{([^}\n]*)\})?$`)
	noteSemanticIDPattern     = regexp.MustCompile(`(?i)(?:^|[, \t])id\s*[:=]\s*["']?([^,"' \t}]+)`)
	noteInlineCodePattern     = regexp.MustCompile("`[^`\n]*`")
	noteSummarySpacePattern   = regexp.MustCompile(`\s+`)
	noteMarkdownHeadingStrip  = regexp.MustCompile(`(?m)^#+\s+`)
	noteTypHeadingStrip       = regexp.MustCompile(`(?m)^=+\s+`)
	noteTypDirectivePattern   = regexp.MustCompile(`(?m)^#(?:import|show|set)[^\n]*$`)
	noteTypMetaPattern        = regexp.MustCompile(`(?s)#metadata\s*\(\(.*?\)\)\s*<note>`)
	noteCallPattern           = regexp.MustCompile(`#note\("([^"]+)"\)\[([^\]]+)\]`)
)

func markdownNoteLines(source string) []noteSourceLine {
	ret := []noteSourceLine{}
	for start := 0; start <= len(source); {
		end := strings.IndexByte(source[start:], '\n')
		if end < 0 {
			ret = append(ret, noteSourceLine{start: start, text: source[start:]})
			break
		}
		end += start
		text, eolUnits := source[start:end], 1
		if strings.HasSuffix(text, "\r") {
			text = strings.TrimSuffix(text, "\r")
			eolUnits = 2
		}
		ret = append(ret, noteSourceLine{start: start, text: text, eolUnits: eolUnits})
		start = end + 1
	}
	return ret
}

func markdownNoteUnquote(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && (value[0] == '"' && value[len(value)-1] == '"' || value[0] == '\'' && value[len(value)-1] == '\'') {
		value = value[1 : len(value)-1]
	}
	return strings.ReplaceAll(value, `\_`, "_")
}

func markdownNoteList(value string, splitSpaces bool) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return []string{}
	}
	if strings.HasPrefix(value, "(") {
		quoted := regexp.MustCompile(`"((?:[^"\\]|\\.)*)"`).FindAllStringSubmatch(value, -1)
		ret := make([]string, 0, len(quoted))
		for _, match := range quoted {
			ret = append(ret, strings.ReplaceAll(strings.ReplaceAll(match[1], `\"`, `"`), `\\`, `\`))
		}
		return ret
	}
	return strings.FieldsFunc(value, func(r rune) bool {
		return r == ',' || r == '\n' || splitSpaces && (r == ' ' || r == '\t')
	})
}

func parseMarkdownNoteMetaLines(lines []string) map[string]noteMetaValue {
	ret := map[string]noteMetaValue{}
	current := ""
	for _, raw := range lines {
		if item := noteMetaListItemPattern.FindStringSubmatch(raw); len(item) > 1 && current != "" {
			value := ret[current]
			value.isList = true
			value.list = append(value.list, markdownNoteUnquote(item[1]))
			ret[current] = value
			continue
		}
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		pair := noteMetaPairPattern.FindStringSubmatch(line)
		if len(pair) < 3 {
			continue
		}
		key, rawValue := strings.ToLower(pair[1]), strings.TrimSpace(pair[2])
		if rawValue == "" {
			ret[key] = noteMetaValue{isList: true, list: []string{}}
			current = key
			continue
		}
		if key == "tags" || key == "refs" || key == "aliases" {
			ret[key] = noteMetaValue{isList: true, list: markdownNoteList(rawValue, key != "aliases")}
		} else {
			ret[key] = noteMetaValue{scalar: markdownNoteUnquote(rawValue)}
		}
		current = ""
	}
	return ret
}

func markdownNoteMetadata(source string, lines []noteSourceLine) (ret map[string]noteMetaValue, metaFrom, metaTo int) {
	ret = map[string]noteMetaValue{}
	first := 0
	for first < len(lines) && strings.TrimSpace(lines[first].text) == "" {
		first++
	}
	if first < len(lines) && strings.TrimSpace(lines[first].text) == "---" {
		for end := first + 1; end < len(lines); end++ {
			if strings.TrimSpace(lines[end].text) != "---" {
				continue
			}
			raw := make([]string, 0, end-first-1)
			for _, line := range lines[first+1 : end] {
				raw = append(raw, line.text)
			}
			for key, value := range parseMarkdownNoteMetaLines(raw) {
				ret[key] = value
			}
			metaFrom = lines[first].start
			if end+1 < len(lines) {
				metaTo = lines[end+1].start
			} else {
				metaTo = len(source)
			}
			break
		}
	}

	for begin := 0; begin < len(lines); begin++ {
		open := noteOrgBeginPattern.FindStringSubmatch(lines[begin].text)
		if len(open) < 2 || !strings.EqualFold(open[1], "meta") {
			continue
		}
		depth, summaryDepth := 1, 0
		raw := []string{}
		for end := begin + 1; end < len(lines); end++ {
			marker := noteOrgBeginPattern.FindStringSubmatch(lines[end].text)
			trimmed := strings.ToLower(strings.TrimSpace(lines[end].text))
			if len(marker) > 1 {
				depth++
				if strings.EqualFold(marker[1], "summary") {
					summaryDepth++
				}
				continue
			}
			if strings.HasPrefix(trimmed, "#+end ") || strings.HasPrefix(trimmed, "#+end_") {
				name := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(trimmed, "#+end "), "#+end_"))
				if name == "summary" && summaryDepth > 0 {
					summaryDepth--
					depth--
					continue
				}
				if name == "meta" && depth == 1 {
					metaFrom = lines[begin].start
					if end+1 < len(lines) {
						metaTo = lines[end+1].start
					} else {
						metaTo = len(source)
					}
					for key, value := range parseMarkdownNoteMetaLines(raw) {
						ret[key] = value
					}
					return ret, metaFrom, metaTo
				}
				if depth > 1 {
					depth--
				}
				continue
			}
			if summaryDepth == 0 && depth == 1 {
				raw = append(raw, lines[end].text)
			}
		}
		break
	}
	return ret, metaFrom, metaTo
}

func noteMetaScalar(meta map[string]noteMetaValue, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(meta[key].scalar); value != "" {
			return value
		}
		if len(meta[key].list) > 0 {
			return strings.TrimSpace(meta[key].list[0])
		}
	}
	return ""
}

func noteMetaList(meta map[string]noteMetaValue, key string) []string {
	value := meta[key]
	if value.isList {
		return append([]string(nil), value.list...)
	}
	return markdownNoteList(value.scalar, key != "aliases")
}

func normalizeMarkdownNoteTags(values []string) []string {
	byKey := map[string]string{}
	for _, value := range values {
		clean := strings.TrimPrefix(strings.TrimSpace(value), "#")
		if clean == "" {
			continue
		}
		key := strings.ToLower(clean)
		if previous, ok := byKey[key]; !ok || clean == key && previous != key {
			byKey[key] = clean
		}
	}
	ret := make([]string, 0, len(byKey))
	for _, value := range byKey {
		ret = append(ret, value)
	}
	sort.Strings(ret)
	return ret
}

func normalizeMarkdownNoteKind(value string) string {
	value = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), `\_`, "_"))
	if value == "" || value == "note" || value == "default" {
		return "default"
	}
	for index, r := range value {
		if !(r >= 'a' && r <= 'z' || index > 0 && (r >= '0' && r <= '9' || r == '_' || r == '-')) {
			return "default"
		}
	}
	return value
}

func markdownNoteFence(line string) byte {
	trimmed := strings.TrimLeft(line, " \t")
	if len(line)-len(trimmed) > 3 || len(trimmed) < 3 || trimmed[0] != '`' && trimmed[0] != '~' {
		return 0
	}
	marker := trimmed[0]
	if strings.HasPrefix(trimmed, strings.Repeat(string(marker), 3)) {
		return marker
	}
	return 0
}

func markdownNoteUTF16Length(value string) int {
	ret := 0
	for _, r := range value {
		ret++
		if r > 0xffff {
			ret++
		}
	}
	return ret
}

func markdownNoteSlug(value string) string {
	var builder strings.Builder
	lastHyphen := false
	punctuation := `!"#$%&'()*+,./:;<=>?@[\]^` + "`" + `{|}~`
	for _, r := range strings.ToLower(strings.TrimSpace(value)) {
		if unicode.IsControl(r) || strings.ContainsRune(punctuation, r) {
			continue
		}
		if unicode.IsSpace(r) {
			if builder.Len() > 0 && !lastHyphen {
				builder.WriteByte('-')
				lastHyphen = true
			}
			continue
		}
		builder.WriteRune(r)
		lastHyphen = r == '-'
	}
	return strings.Trim(builder.String(), "-")
}

func markdownNoteSemanticHeading(line string) (noteHeading, bool) {
	match := noteSemanticPattern.FindStringSubmatch(strings.TrimSpace(line))
	if len(match) < 4 {
		return noteHeading{}, false
	}
	level := 1
	if strings.EqualFold(match[1], "section") {
		switch strings.ToLower(strings.TrimSpace(match[2])) {
		case "sub":
			level = 3
		case "subsub":
			level = 4
		case "subsubsub":
			level = 5
		default:
			level = 2
		}
	}
	label := strings.TrimSpace(match[3])
	slug := markdownNoteSlug(label)
	if id := noteSemanticIDPattern.FindStringSubmatch(match[4]); len(id) > 1 {
		slug = strings.TrimSpace(id[1])
	}
	return noteHeading{label: label, slug: slug, level: level}, true
}

func markdownNoteDOMTargets(lines []noteSourceLine, metaFrom, metaTo int, title, path string) []MarkdownNoteDOMTarget {
	hasSemantic := false
	for _, line := range lines {
		if _, ok := markdownNoteSemanticHeading(line.text); ok {
			hasSemantic = true
			break
		}
	}
	headings := []noteHeading{}
	fence := byte(0)
	hasH1 := false
	used := map[string]int{}
	unique := func(slug string) string {
		if slug == "" {
			slug = "section"
		}
		used[slug]++
		if used[slug] > 1 {
			return slug + "-" + strconvItoa(used[slug])
		}
		return slug
	}
	for _, line := range lines {
		if metaTo > metaFrom && line.start >= metaFrom && line.start < metaTo {
			continue
		}
		if marker := markdownNoteFence(line.text); marker != 0 {
			if fence == 0 {
				fence = marker
			} else if fence == marker {
				fence = 0
			}
			continue
		}
		if fence != 0 {
			continue
		}
		if semantic, ok := markdownNoteSemanticHeading(line.text); ok {
			semantic.slug = unique(semantic.slug)
			headings = append(headings, semantic)
		}
		match := noteHeadingPattern.FindStringSubmatch(line.text)
		if len(match) < 3 {
			continue
		}
		level := len(match[1])
		if hasSemantic {
			level += 5
		}
		if level == 1 {
			hasH1 = true
		}
		label := strings.TrimSpace(match[2])
		headings = append(headings, noteHeading{label: label, slug: unique(markdownNoteSlug(label)), level: level})
	}
	if !hasSemantic && !hasH1 && title != "" {
		headings = append([]noteHeading{{label: title, slug: unique(markdownNoteSlug(title)), level: 1}}, headings...)
	}
	ret := make([]MarkdownNoteDOMTarget, 0, len(headings))
	type stackEntry struct {
		level int
		path  []string
	}
	paths, labels := []stackEntry{}, []stackEntry{}
	for _, heading := range headings {
		for len(paths) > 0 && paths[len(paths)-1].level >= heading.level {
			paths, labels = paths[:len(paths)-1], labels[:len(labels)-1]
		}
		parentPath, parentLabels := []string{}, []string{}
		if len(paths) > 0 {
			parentPath = paths[len(paths)-1].path
			parentLabels = labels[len(labels)-1].path
		}
		targetPath := append(append([]string{}, parentPath...), heading.slug)
		labelPath := append(append([]string{}, parentLabels...), heading.label)
		paths = append(paths, stackEntry{level: heading.level, path: targetPath})
		labels = append(labels, stackEntry{level: heading.level, path: labelPath})
		ret = append(ret, MarkdownNoteDOMTarget{
			Label: heading.label, Slug: heading.slug, Path: targetPath,
			LabelPath: labelPath, Level: heading.level, NotePath: path,
		})
	}
	return ret
}

func strconvItoa(value int) string {
	if value < 10 {
		return string(rune('0' + value))
	}
	// Heading duplicate counts above nine are vanishingly rare; avoid pulling
	// formatting into the per-heading hot path while still handling them.
	digits := []byte{}
	for value > 0 {
		digits = append(digits, byte('0'+value%10))
		value /= 10
	}
	for left, right := 0, len(digits)-1; left < right; left, right = left+1, right-1 {
		digits[left], digits[right] = digits[right], digits[left]
	}
	return string(digits)
}

func markdownNoteInlineTags(lines []noteSourceLine, metaFrom, metaTo int) []string {
	ret := []string{}
	fence := byte(0)
	for _, line := range lines {
		if metaTo > metaFrom && line.start >= metaFrom && line.start < metaTo {
			continue
		}
		if marker := markdownNoteFence(line.text); marker != 0 {
			if fence == 0 {
				fence = marker
			} else if fence == marker {
				fence = 0
			}
			continue
		}
		if fence != 0 {
			continue
		}
		visible := noteInlineCodePattern.ReplaceAllString(line.text, "")
		for _, match := range noteInlineTagPattern.FindAllStringSubmatch(visible, -1) {
			if value := strings.TrimSpace(match[1]); value != "" {
				ret = append(ret, value)
			}
		}
	}
	return ret
}

func markdownNoteBlocks(lines []noteSourceLine, metaFrom, metaTo int, projection noemamarkdown.Projection) []MarkdownNoteBlock {
	_ = projection // The broad catalog grammar intentionally retains legacy IDs.
	byID := map[string]MarkdownNoteBlock{}
	order := []string{}
	fence, offset := byte(0), 0
	for _, line := range lines {
		lineUnits := markdownNoteUTF16Length(line.text) + line.eolUnits
		if metaTo > metaFrom && line.start >= metaFrom && line.start < metaTo {
			offset += lineUnits
			continue
		}
		if marker := markdownNoteFence(line.text); marker != 0 {
			if fence == 0 {
				fence = marker
			} else if fence == marker {
				fence = 0
			}
			offset += lineUnits
			continue
		}
		if fence != 0 {
			offset += lineUnits
			continue
		}
		visible := noteInlineCodePattern.ReplaceAllStringFunc(line.text, func(value string) string { return strings.Repeat(" ", len(value)) })
		org := noteOrgBeginPattern.FindStringSubmatch(visible)
		for _, match := range noteAnchorPattern.FindAllStringSubmatchIndex(visible, -1) {
			id := visible[match[2]:match[3]]
			block := MarkdownNoteBlock{ID: id, Kind: "anchor", Label: id, Offset: offset + markdownNoteUTF16Length(visible[:match[0]])}
			if len(org) > 1 {
				kind := strings.ToLower(org[1])
				block.Kind, block.EnvKind = "org-env", kind
				title := ""
				if len(org) > 2 {
					title = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(org[2]), visible[match[0]:match[1]]))
				}
				block.Label = kind
				if title != "" {
					block.Label += " · " + title
				}
			}
			if _, exists := byID[id]; !exists {
				order = append(order, id)
			}
			byID[id] = block
		}
		for _, match := range notePlanningAnchorPattern.FindAllStringSubmatchIndex(visible, -1) {
			id := visible[match[2]:match[3]]
			if _, exists := byID[id]; exists {
				continue
			}
			label := strings.TrimSpace(visible[:match[0]])
			if label == "" {
				label = id
			}
			order = append(order, id)
			byID[id] = MarkdownNoteBlock{ID: id, Kind: "planning", Label: label, Offset: offset + markdownNoteUTF16Length(visible[:match[0]])}
		}
		offset += lineUnits
	}
	ret := make([]MarkdownNoteBlock, 0, len(order))
	for _, id := range order {
		ret = append(ret, byID[id])
	}
	return ret
}

func markdownNoteDecodeRef(value string) string {
	decoded, err := url.PathUnescape(value)
	if nil != err {
		decoded = value
	}
	var builder strings.Builder
	for index := 0; index < len(decoded); index++ {
		if decoded[index] == '\\' && index+1 < len(decoded) && strings.ContainsRune("\\`*_[\\](){}#+.!<>-", rune(decoded[index+1])) {
			index++
		}
		builder.WriteByte(decoded[index])
	}
	return builder.String()
}

func markdownNoteProtocol(value string) string {
	colon := strings.IndexByte(value, ':')
	if colon <= 0 {
		return ""
	}
	protocol := strings.ToLower(value[:colon])
	for index, r := range protocol {
		if !(unicode.IsLetter(r) || index > 0 && (unicode.IsDigit(r) || r == '+' || r == '.' || r == '-')) {
			return ""
		}
	}
	return protocol
}

func markdownNoteRoamRef(value string) string {
	raw := strings.TrimSpace(value)
	protocol := markdownNoteProtocol(raw)
	if protocol != "" && protocol != "roam" {
		return ""
	}
	if protocol != "roam" && !strings.ContainsAny(raw, "#@") {
		return ""
	}
	body := raw
	if protocol == "roam" {
		body = body[len("roam://"):]
		if strings.HasPrefix(strings.ToLower(body), "wiki/") {
			body = body[5:]
		}
	}
	if cut := strings.IndexAny(body, "?&"); cut >= 0 {
		body = body[:cut]
	}
	if cut := strings.IndexByte(body, '#'); cut >= 0 {
		body = body[:cut]
	}
	lower := strings.ToLower(body)
	if md := strings.Index(lower, ".md@"); md >= 0 {
		body = body[:md+3]
	} else if markdown := strings.Index(lower, ".markdown@"); markdown >= 0 {
		body = body[:markdown+9]
	} else if cut := strings.IndexByte(body, '@'); cut >= 0 {
		body = body[:cut]
	}
	body = strings.Trim(strings.TrimRight(body, ".,;:"), "/")
	return strings.TrimSpace(markdownNoteDecodeRef(body))
}

func markdownNoteFileRef(value string) string {
	raw := strings.TrimSpace(value)
	protocol := markdownNoteProtocol(raw)
	if protocol != "" && protocol != "file" {
		return ""
	}
	if protocol == "file" {
		raw = raw[len("file:"):]
		raw = strings.TrimPrefix(raw, "//")
	}
	if cut := strings.IndexAny(raw, "?#"); cut >= 0 {
		raw = raw[:cut]
	}
	lower := strings.ToLower(raw)
	for _, ext := range []string{".markdown", ".md"} {
		if at := strings.Index(lower, ext+"@"); at >= 0 {
			raw = raw[:at+len(ext)]
			lower = strings.ToLower(raw)
			break
		}
	}
	if strings.HasSuffix(lower, ".md") || strings.HasSuffix(lower, ".markdown") {
		return markdownNoteDecodeRef(raw)
	}
	return ""
}

func markdownNoteMarkdownHrefs(source string) []string {
	ret := []string{}
	escaped := func(index int) bool {
		slashes := 0
		for index--; index >= 0 && source[index] == '\\'; index-- {
			slashes++
		}
		return slashes%2 == 1
	}
	for index := 0; index < len(source); index++ {
		if source[index] != '[' || escaped(index) || index+1 < len(source) && source[index+1] == '[' {
			continue
		}
		close, depth := index+1, 0
		for close < len(source) {
			if source[close] == '\\' && close+1 < len(source) {
				close += 2
				continue
			}
			if source[close] == '[' {
				depth++
			} else if source[close] == ']' {
				if depth == 0 {
					break
				}
				depth--
			}
			close++
		}
		if close+1 >= len(source) || source[close+1] != '(' {
			continue
		}
		cursor := close + 2
		for cursor < len(source) && (source[cursor] == ' ' || source[cursor] == '\t') {
			cursor++
		}
		start := cursor
		if cursor < len(source) && source[cursor] == '<' {
			start, cursor = cursor+1, cursor+1
			for cursor < len(source) && source[cursor] != '>' && source[cursor] != '\n' {
				cursor++
			}
		} else {
			depth := 0
			for cursor < len(source) {
				char := source[cursor]
				if char == '\\' && cursor+1 < len(source) {
					cursor += 2
					continue
				}
				if char == '(' {
					depth++
				} else if char == ')' {
					if depth == 0 {
						break
					}
					depth--
				} else if depth == 0 && (char == ' ' || char == '\t' || char == '\n' || char == '\r') {
					break
				}
				cursor++
			}
		}
		if cursor > start {
			ret = append(ret, source[start:cursor])
		}
		index = close
	}
	return ret
}

func markdownNoteRefs(source string, meta map[string]noteMetaValue) []string {
	ret, seen := []string{}, map[string]bool{}
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value != "" && !seen[value] {
			seen[value] = true
			ret = append(ret, value)
		}
	}
	for _, value := range noteMetaList(meta, "refs") {
		add(value)
	}
	for _, match := range noteRefTokenPattern.FindAllStringSubmatch(source, -1) {
		if len(match) > 1 && match[1] != "" {
			add(match[1])
		} else {
			add(markdownNoteRoamRef(match[0]))
		}
	}
	for _, href := range markdownNoteMarkdownHrefs(source) {
		add(markdownNoteFileRef(href))
		add(markdownNoteRoamRef(href))
	}
	escaped := func(index int) bool {
		slashes := 0
		for index--; index >= 0 && source[index] == '\\'; index-- {
			slashes++
		}
		return slashes%2 == 1
	}
	for index := 0; index+3 < len(source); index++ {
		if source[index] != '[' || source[index+1] != '[' || escaped(index) {
			continue
		}
		end := strings.Index(source[index+2:], "]]")
		if end < 0 {
			continue
		}
		end += index + 2
		target := source[index+2 : end]
		if pipe := strings.IndexByte(target, '|'); pipe >= 0 {
			target = target[:pipe]
		}
		target = strings.TrimSpace(target)
		if strings.HasPrefix(strings.ToLower(target), "roam://") {
			add(markdownNoteRoamRef(target))
		} else {
			add(target)
		}
		index = end + 1
	}
	return ret
}

func markdownNoteSummary(source string, meta map[string]noteMetaValue, metaFrom, metaTo int) string {
	if value := noteMetaScalar(meta, "summary"); value != "" {
		return value
	}
	if metaTo > metaFrom {
		source = source[:metaFrom] + source[metaTo:]
	}
	source = noteTypMetaPattern.ReplaceAllString(source, "")
	source = noteTypDirectivePattern.ReplaceAllString(source, "")
	source = noteCallPattern.ReplaceAllString(source, "$2")
	source = noteTypHeadingStrip.ReplaceAllString(source, "")
	source = noteMarkdownHeadingStrip.ReplaceAllString(source, "")
	source = strings.Map(func(r rune) rune {
		if strings.ContainsRune("#*_`$()[]{}", r) {
			return ' '
		}
		return r
	}, source)
	source = strings.TrimSpace(noteSummarySpacePattern.ReplaceAllString(source, " "))
	if utf8.RuneCountInString(source) <= 220 {
		return source
	}
	runes := []rune(source)
	return string(runes[:220])
}

func markdownNoteGroupLabel(group string) string {
	if group == "" || group == "Root" {
		return "Root"
	}
	parts := strings.Split(strings.ReplaceAll(group, "\\", "/"), "/")
	leaf := parts[len(parts)-1]
	if strings.ToUpper(leaf) == leaf {
		return leaf
	}
	words := strings.FieldsFunc(leaf, func(r rune) bool { return r == '-' || r == '_' })
	for index, word := range words {
		runes := []rune(word)
		if len(runes) > 0 {
			runes[0] = unicode.ToUpper(runes[0])
			words[index] = string(runes)
		}
	}
	return strings.Join(words, " ")
}

func markdownNoteFromSnapshot(boxID, path string, snapshot *markdownSnapshot) MarkdownNoteSummary {
	source := string(snapshot.source)
	lines := markdownNoteLines(source)
	meta, metaFrom, metaTo := markdownNoteMetadata(source, lines)
	relative := strings.TrimPrefix(filepath.ToSlash(path), "/")
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(relative)), ".")
	title := noteMetaScalar(meta, "title")
	if title == "" {
		for _, line := range lines {
			if match := noteHeadingPattern.FindStringSubmatch(line.text); len(match) > 2 {
				title = strings.TrimSpace(match[2])
				break
			}
		}
	}
	if title == "" {
		title = strings.TrimSuffix(filepath.Base(relative), filepath.Ext(relative))
	}
	metadataID := noteMetaScalar(meta, "id")
	id := metadataID
	if id == "" {
		id = relative
	}
	group := filepath.ToSlash(filepath.Dir(relative))
	if group == "." || group == "" {
		group = "Root"
	}
	section := group
	if slash := strings.IndexByte(group, '/'); slash >= 0 {
		section = group[:slash]
	}
	kind := normalizeMarkdownNoteKind(noteMetaScalar(meta, "kind", "kinds"))
	visibleSource := source
	if metaTo > metaFrom {
		visibleSource = source[:metaFrom] + source[metaTo:]
	}
	ret := MarkdownNoteSummary{
		Key: id, ID: id, Title: title, File: filepath.Join(filesys.BoxRootPath(boxID), filepath.FromSlash(relative)),
		Link: relative, Path: relative, Ext: ext, Kind: kind,
		Date: noteMetaScalar(meta, "date"), GroupKey: group, GroupLabel: markdownNoteGroupLabel(group), Section: section,
		Source: noteMetaScalar(meta, "source"), Project: noteMetaScalar(meta, "project", "proj"),
		Aliases: noteMetaList(meta, "aliases"), Summary: markdownNoteSummary(source, meta, metaFrom, metaTo),
		Tags: normalizeMarkdownNoteTags(noteMetaList(meta, "tags")), InlineTags: markdownNoteInlineTags(lines, metaFrom, metaTo),
		Blocks: markdownNoteBlocks(lines, metaFrom, metaTo, snapshot.propertyProjection()), Refs: markdownNoteRefs(visibleSource, meta),
		Backlinks: []string{}, Roam: metadataID != "" && !strings.EqualFold(noteMetaScalar(meta, "roam"), "off"),
		LeanBlocks: []any{}, Standalone: false, MtimeMs: snapshot.mtimeMs, Size: snapshot.size,
	}
	ret.DOMTargets = markdownNoteDOMTargets(lines, metaFrom, metaTo, title, relative)
	return ret
}

func cloneMarkdownNoteSummary(note MarkdownNoteSummary) MarkdownNoteSummary {
	note.Aliases = append([]string(nil), note.Aliases...)
	note.Tags = append([]string(nil), note.Tags...)
	note.InlineTags = append([]string(nil), note.InlineTags...)
	note.Blocks = append([]MarkdownNoteBlock(nil), note.Blocks...)
	note.Refs = append([]string(nil), note.Refs...)
	note.Backlinks = append([]string(nil), note.Backlinks...)
	note.DOMTargets = append([]MarkdownNoteDOMTarget(nil), note.DOMTargets...)
	for index := range note.DOMTargets {
		note.DOMTargets[index].Path = append([]string(nil), note.DOMTargets[index].Path...)
		note.DOMTargets[index].LabelPath = append([]string(nil), note.DOMTargets[index].LabelPath...)
	}
	note.LeanBlocks = []any{}
	return note
}

func canonicalMarkdownNoteRef(value string) string {
	if roam := markdownNoteRoamRef(value); roam != "" {
		value = roam
	}
	value = strings.ReplaceAll(strings.TrimSpace(markdownNoteDecodeRef(value)), "\\", "/")
	parts := []string{}
	absolute := strings.HasPrefix(value, "/")
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			if len(parts) > 0 && parts[len(parts)-1] != ".." {
				parts = parts[:len(parts)-1]
			} else if !absolute {
				parts = append(parts, part)
			}
			continue
		}
		parts = append(parts, part)
	}
	prefix := ""
	if absolute {
		prefix = "/"
	}
	return strings.ToLower(prefix + strings.Join(parts, "/"))
}

func markdownNoteReferenceValues(note MarkdownNoteSummary) []string {
	return append([]string{
		note.ID, note.Key, note.Title, note.Path, note.Link, note.Source, note.File, filepath.Base(note.File),
	}, note.Aliases...)
}

func resolveMarkdownNoteRelationships(raw []MarkdownNoteSummary) []MarkdownNoteSummary {
	sort.Slice(raw, func(i, j int) bool { return raw[i].Path < raw[j].Path })
	unique := map[string]MarkdownNoteSummary{}
	for _, note := range raw {
		current, exists := unique[note.ID]
		if !exists || note.Path == note.Source || current.Ext != "md" && note.Ext == "md" {
			unique[note.ID] = cloneMarkdownNoteSummary(note)
		}
	}
	index := map[string]string{}
	for id, note := range unique {
		for _, value := range markdownNoteReferenceValues(note) {
			if key := canonicalMarkdownNoteRef(value); key != "" {
				if _, exists := index[key]; !exists {
					index[key] = id
				}
			}
		}
	}
	for id, note := range unique {
		resolved, seen := []string{}, map[string]bool{}
		for _, ref := range note.Refs {
			target := index[canonicalMarkdownNoteRef(ref)]
			if target == "" || target == id || seen[target] {
				continue
			}
			seen[target] = true
			resolved = append(resolved, target)
			targetNote := unique[target]
			targetNote.Backlinks = append(targetNote.Backlinks, id)
			unique[target] = targetNote
		}
		sort.Strings(resolved)
		note.Refs = resolved
		unique[id] = note
	}
	ret := make([]MarkdownNoteSummary, 0, len(unique))
	for _, note := range unique {
		note.Backlinks = sortedUniqueMarkdownStrings(note.Backlinks)
		ret = append(ret, note)
	}
	sort.Slice(ret, func(i, j int) bool {
		if ret[i].Title == ret[j].Title {
			return ret[i].Path < ret[j].Path
		}
		return ret[i].Title < ret[j].Title
	})
	return ret
}

func sortedUniqueMarkdownStrings(values []string) []string {
	seen, ret := map[string]bool{}, []string{}
	for _, value := range values {
		if value != "" && !seen[value] {
			seen[value] = true
			ret = append(ret, value)
		}
	}
	sort.Strings(ret)
	return ret
}

func markdownNoteDirectories(notes []MarkdownNoteSummary) []MarkdownNoteDirectory {
	counts := map[string]int{"Root": 0}
	for _, note := range notes {
		counts["Root"]++
		if note.GroupKey == "" || note.GroupKey == "Root" {
			continue
		}
		parts := strings.Split(filepath.ToSlash(note.GroupKey), "/")
		for index := range parts {
			counts[strings.Join(parts[:index+1], "/")]++
		}
	}
	ret := make([]MarkdownNoteDirectory, 0, len(counts))
	for path, count := range counts {
		parent := "Root"
		if slash := strings.LastIndexByte(path, '/'); slash >= 0 {
			parent = path[:slash]
		}
		ret = append(ret, MarkdownNoteDirectory{
			Path: path, Label: markdownNoteGroupLabel(path), Parent: parent, NoteCount: count,
		})
	}
	sort.Slice(ret, func(i, j int) bool {
		if ret[i].Path == "Root" {
			return true
		}
		if ret[j].Path == "Root" {
			return false
		}
		return ret[i].Path < ret[j].Path
	})
	return ret
}
