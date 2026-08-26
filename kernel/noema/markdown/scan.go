// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package markdown scans only Noema's portable block-identity/reference wire
// syntax. It is deliberately not a second Markdown parser: Lute continues to
// own CommonMark structure, while this scanner masks code/math regions and
// extracts the small syntax surface Lute cannot recognize.
package markdown

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"

	"github.com/88250/lute/parse"
	noemaidentity "github.com/aaronhe/noema/kernel/noema/identity"
)

const (
	treeProjectionProperty = "noema:markdown-projection"
	blockAnchorOpener      = "{#"
	canonicalIDLength      = 36 // 8-4-4-4-12 hexadecimal UUID
	blockRefOpener         = "(("
)

var (
	trailingBlockAnchorPattern = regexp.MustCompile(`(?i)\{#([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:[ \t]+([^{}\r\n]*))?\}[ \t]*$`)
	orgAnyBeginPattern         = regexp.MustCompile(`(?i)^[ \t]*#\+begin[ \t]+([a-z0-9_-]+)\b`)
	orgAnyEndPattern           = regexp.MustCompile(`(?i)^[ \t]*#\+end[ \t]+([a-z0-9_-]+)\b`)
	blockRefPattern            = regexp.MustCompile(`(?i)\(\(([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:[ \t]+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'))?\)\)`)
	unescapeLabelPattern       = regexp.MustCompile(`\\(.)`)
)

var nonSemanticOrgEnvs = map[string]bool{
	"comment": true,
	"fold":    true,
	"html":    true,
	"lean4":   true,
	"meta":    true,
	"org":     true,
	"tikz":    true,
}

type Definition struct {
	CanonicalID  string            `json:"canonicalId"`
	ProjectionID string            `json:"projectionId"`
	Line         int               `json:"line"`
	Index        int               `json:"index"`
	Kind         string            `json:"kind"`
	OrgEnv       bool              `json:"orgEnv,omitempty"`
	Text         string            `json:"text,omitempty"`
	Properties   map[string]string `json:"properties,omitempty"`
}

type Reference struct {
	CanonicalID  string `json:"canonicalId"`
	ProjectionID string `json:"projectionId"`
	Label        string `json:"label,omitempty"`
	Raw          string `json:"raw"`
	Line         int    `json:"line"`
}

type Projection struct {
	Definitions            []Definition `json:"definitions,omitempty"`
	References             []Reference  `json:"references,omitempty"`
	DuplicateDefinitionIDs []string     `json:"duplicateDefinitionIds,omitempty"`
}

func unescapeLabel(value string) string {
	return unescapeLabelPattern.ReplaceAllString(value, "$1")
}

// utf16Length counts UTF-16 code units without materializing the rune and
// code-unit slices utf16.Encode would allocate. Scan calls this for every
// line of every document, so the two allocations per line dominated it.
func utf16Length(value string) int {
	ret := 0
	for _, r := range value {
		if 0xFFFF < r {
			ret += 2
		} else {
			ret++
		}
	}
	return ret
}

// fenceMarker recognizes a CommonMark code fence: up to three spaces or tabs
// of indent followed by a run of at least three backticks or tildes. It is
// hand-coded because Scan tests every line of every document against it.
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

// looksLikeOrgMarker is the cheap precondition shared by orgAnyBeginPattern
// and orgAnyEndPattern, both of which are anchored at `^[ \t]*#\+`.
func looksLikeOrgMarker(line string) bool {
	index := 0
	for index < len(line) && (' ' == line[index] || '\t' == line[index]) {
		index++
	}
	return index+1 < len(line) && '#' == line[index] && '+' == line[index+1]
}

func parseBlockProperties(raw string) map[string]string {
	// Most anchors are a bare {#uuid} with no properties at all, so the map is
	// only allocated once there is something to put in it.
	if "" == raw {
		return nil
	}
	var ret map[string]string
	for index := 0; index < len(raw); {
		for index < len(raw) && (raw[index] == ' ' || raw[index] == '\t') {
			index++
		}
		start := index
		if index >= len(raw) || !((raw[index] >= 'A' && raw[index] <= 'Z') || (raw[index] >= 'a' && raw[index] <= 'z')) {
			for index < len(raw) && raw[index] != ' ' && raw[index] != '\t' {
				index++
			}
			continue
		}
		index++
		for index < len(raw) && ((raw[index] >= 'A' && raw[index] <= 'Z') || (raw[index] >= 'a' && raw[index] <= 'z') || (raw[index] >= '0' && raw[index] <= '9') || raw[index] == '_' || raw[index] == '-') {
			index++
		}
		key := strings.ToLower(raw[start:index])
		for index < len(raw) && (raw[index] == ' ' || raw[index] == '\t') {
			index++
		}
		if index >= len(raw) || raw[index] != '=' {
			continue
		}
		index++
		for index < len(raw) && (raw[index] == ' ' || raw[index] == '\t') {
			index++
		}
		value := ""
		if index < len(raw) && (raw[index] == '"' || raw[index] == '\'') {
			quote := raw[index]
			index++
			var builder strings.Builder
			for index < len(raw) {
				if raw[index] == '\\' && index+1 < len(raw) {
					builder.WriteByte(raw[index+1])
					index += 2
					continue
				}
				if raw[index] == quote {
					index++
					break
				}
				builder.WriteByte(raw[index])
				index++
			}
			value = builder.String()
		} else {
			start = index
			for index < len(raw) && raw[index] != ' ' && raw[index] != '\t' {
				index++
			}
			value = raw[start:index]
		}
		if key != "" && key != "id" {
			if nil == ret {
				ret = map[string]string{}
			}
			ret[key] = value
		}
	}
	if len(ret) == 0 {
		return nil
	}
	return ret
}

func maskDelimited(line string, marker byte) string {
	if 0 > strings.IndexByte(line, marker) {
		return line
	}
	masked := []byte(line)
	for i := 0; i < len(line); {
		if line[i] != marker || (0 < i && '\\' == line[i-1]) {
			i++
			continue
		}
		run := 1
		for i+run < len(line) && line[i+run] == marker {
			run++
		}
		end := strings.Index(line[i+run:], strings.Repeat(string(marker), run))
		if end < 0 {
			break
		}
		end += i + run
		for j := i; j < end+run; j++ {
			masked[j] = ' '
		}
		i = end + run
	}
	return string(masked)
}

func scanLineReferences(line string, lineNumber int) (ret []Reference) {
	if !strings.Contains(line, blockRefOpener) {
		return nil
	}
	masked := maskDelimited(line, '`')
	masked = maskDelimited(masked, '$')
	for _, match := range blockRefPattern.FindAllStringSubmatchIndex(masked, -1) {
		canonical := strings.ToLower(masked[match[2]:match[3]])
		label := ""
		if 0 <= match[4] {
			label = line[match[4]:match[5]]
		} else if 0 <= match[6] {
			label = line[match[6]:match[7]]
		}
		ret = append(ret, Reference{
			CanonicalID:  canonical,
			ProjectionID: noemaidentity.ProjectionID(canonical, ""),
			Label:        unescapeLabel(label),
			Raw:          line[match[0]:match[1]],
			Line:         lineNumber,
		})
	}
	return
}

// lineScanner carries the block-level state Scan threads across lines: the
// open code fence, the open math fence, and the non-semantic org environment
// currently being skipped.
type lineScanner struct {
	projection       Projection
	definitionCounts map[string]int
	fenceChar        byte
	fenceLen         int
	ignoredOrg       string
	mathFence        bool
}

// matchTrailingBlockAnchor hand-codes trailingBlockAnchorPattern:
//
//	(?i)\{#(<uuidv7>)(?:[ \t]+([^{}\r\n]*))?\}[ \t]*$
//
// Running the regexp engine once per anchored line was the largest single cost
// of scanning a document that actually uses block anchors, and every anchored
// line in every note pays it on every save.
//
// It reports the canonical ID span, the optional property span (-1 when the
// group did not participate) and the offset of the opening "{#", matching what
// FindStringSubmatchIndex would have returned.
func matchTrailingBlockAnchor(line string) (idStart, idEnd, propStart, propEnd, matchStart int, ok bool) {
	end := len(line)
	for 0 < end && (' ' == line[end-1] || '\t' == line[end-1]) {
		end--
	}
	if 0 == end || '}' != line[end-1] {
		return 0, 0, -1, -1, 0, false
	}
	closing := end - 1

	for at := 0; ; {
		found := strings.Index(line[at:], blockAnchorOpener)
		if 0 > found {
			return 0, 0, -1, -1, 0, false
		}
		start := at + found
		at = start + len(blockAnchorOpener)
		id := at
		if id+canonicalIDLength > closing {
			continue
		}
		if !isCanonicalAnchorID(line[id : id+canonicalIDLength]) {
			continue
		}
		rest := id + canonicalIDLength
		if rest == closing {
			return id, rest, -1, -1, start, true
		}
		// The regexp needs at least one space or tab between the ID and the
		// property text, and the property text may hold neither brace nor a
		// line break.
		property := rest
		for property < closing && (' ' == line[property] || '\t' == line[property]) {
			property++
		}
		if property == rest || strings.ContainsAny(line[property:closing], "{}\r\n") {
			continue
		}
		return id, rest, property, closing, start, true
	}
}

func isHexDigit(c byte) bool {
	return ('0' <= c && c <= '9') || ('a' <= c && c <= 'f') || ('A' <= c && c <= 'F')
}

// isCanonicalAnchorID matches [0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}
// case-insensitively, the UUIDv7 shape Noema anchors use.
func isCanonicalAnchorID(value string) bool {
	if canonicalIDLength != len(value) {
		return false
	}
	for index := 0; index < canonicalIDLength; index++ {
		c := value[index]
		switch index {
		case 8, 13, 18, 23:
			if '-' != c {
				return false
			}
		case 14:
			if '7' != c {
				return false
			}
		case 19:
			if '8' != c && '9' != c && 'a' != c && 'b' != c && 'A' != c && 'B' != c {
				return false
			}
		default:
			if !isHexDigit(c) {
				return false
			}
		}
	}
	return true
}

// Scan extracts Noema UUIDv7 definitions and references while ignoring fenced
// code, indented code, inline code/math, and non-semantic org environments.
func Scan(source []byte) Projection {
	text := strings.ReplaceAll(string(source), "\r\n", "\n")
	scanner := &lineScanner{definitionCounts: map[string]int{}}

	// Lines are walked in place while the UTF-16 offset accumulates, rather
	// than splitting the whole document up front and pre-computing an offset
	// table. Each line-level regexp is guarded by the cheap literal its
	// pattern is anchored on, so an ordinary prose line runs none of them.
	rest := text
	offset := 0
	for lineNumber := 1; ; lineNumber++ {
		line := rest
		final := true
		if index := strings.IndexByte(rest, '\n'); 0 <= index {
			line, rest, final = rest[:index], rest[index+1:], false
		}
		scanner.scanLine(line, lineNumber, offset)
		offset += utf16Length(line) + 1
		if final {
			break
		}
	}

	ret := scanner.projection
	for id, count := range scanner.definitionCounts {
		if 1 < count {
			ret.DuplicateDefinitionIDs = append(ret.DuplicateDefinitionIDs, id)
		}
	}
	sort.Strings(ret.DuplicateDefinitionIDs)
	return ret
}

func (scanner *lineScanner) scanLine(line string, lineNumber, index int) {
	trimmed := strings.TrimSpace(line)

	if 0 != scanner.fenceChar {
		if marker, run := fenceMarker(line); 0 != marker && marker == scanner.fenceChar && run >= scanner.fenceLen {
			scanner.fenceChar, scanner.fenceLen = 0, 0
		}
		return
	}
	if marker, run := fenceMarker(line); 0 != marker {
		scanner.fenceChar, scanner.fenceLen = marker, run
		return
	}
	if strings.HasPrefix(trimmed, "$$") {
		if 1 == strings.Count(trimmed, "$$") {
			scanner.mathFence = !scanner.mathFence
		}
		return
	}
	if scanner.mathFence || strings.HasPrefix(line, "    ") || strings.HasPrefix(line, "\t") {
		return
	}

	orgMarker := looksLikeOrgMarker(line)
	if "" != scanner.ignoredOrg {
		if orgMarker {
			if match := orgAnyEndPattern.FindStringSubmatch(line); nil != match && strings.EqualFold(match[1], scanner.ignoredOrg) {
				scanner.ignoredOrg = ""
			}
		}
		return
	}
	if orgMarker {
		if match := orgAnyBeginPattern.FindStringSubmatch(line); nil != match {
			kind := strings.ToLower(match[1])
			if nonSemanticOrgEnvs[kind] {
				scanner.ignoredOrg = kind
				return
			}
		}
	}

	if strings.Contains(line, blockAnchorOpener) {
		if idStart, idEnd, propStart, propEnd, matchStart, matched := matchTrailingBlockAnchor(line); matched {
			canonical := strings.ToLower(line[idStart:idEnd])
			propertiesRaw := ""
			if 0 <= propStart {
				propertiesRaw = line[propStart:propEnd]
			}
			kind := "block"
			orgEnv := false
			text := strings.TrimSpace(line[:matchStart])
			if orgMarker {
				if orgMatch := orgAnyBeginPattern.FindStringSubmatchIndex(line); nil != orgMatch {
					kind = strings.ToLower(line[orgMatch[2]:orgMatch[3]])
					orgEnv = true
					text = strings.TrimSpace(line[orgMatch[1]:matchStart])
				}
			}
			scanner.definitionCounts[canonical]++
			scanner.projection.Definitions = append(scanner.projection.Definitions, Definition{
				CanonicalID: canonical, ProjectionID: noemaidentity.ProjectionID(canonical, ""),
				Line: lineNumber, Index: index, Kind: kind, OrgEnv: orgEnv,
				Text: text, Properties: parseBlockProperties(propertiesRaw),
			})
		}
	}

	scanner.projection.References = append(scanner.projection.References, scanLineReferences(line, lineNumber)...)
}

// AttachProjection keeps scanner results on a Markdown tree without changing
// source or allocating a process-global registry that would retain trees.
func AttachProjection(tree *parse.Tree, projection Projection) {
	if nil == tree || nil == tree.Root {
		return
	}
	if nil == tree.Root.Properties {
		tree.Root.Properties = map[string]string{}
	}
	raw, _ := json.Marshal(projection)
	tree.Root.Properties[treeProjectionProperty] = string(raw)
}

func ProjectionFromTree(tree *parse.Tree) Projection {
	if nil == tree || nil == tree.Root || nil == tree.Root.Properties {
		return Projection{}
	}
	var ret Projection
	_ = json.Unmarshal([]byte(tree.Root.Properties[treeProjectionProperty]), &ret)
	return ret
}
