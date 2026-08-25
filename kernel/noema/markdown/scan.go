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
	"unicode/utf16"

	"github.com/88250/lute/parse"
	noemaidentity "github.com/aaronhe/noema/kernel/noema/identity"
)

const treeProjectionProperty = "noema:markdown-projection"

var (
	trailingBlockAnchorPattern = regexp.MustCompile(`(?i)\{#([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:[ \t]+([^{}\r\n]*))?\}[ \t]*$`)
	orgAnyBeginPattern         = regexp.MustCompile(`(?i)^[ \t]*#\+begin[ \t]+([a-z0-9_-]+)\b`)
	orgAnyEndPattern           = regexp.MustCompile(`(?i)^[ \t]*#\+end[ \t]+([a-z0-9_-]+)\b`)
	blockRefPattern            = regexp.MustCompile(`(?i)\(\(([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:[ \t]+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'))?\)\)`)
	fencePattern               = regexp.MustCompile("^[ \\t]{0,3}(`{3,}|~{3,})")
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

func utf16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func parseBlockProperties(raw string) map[string]string {
	ret := map[string]string{}
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
			ret[key] = value
		}
	}
	if len(ret) == 0 {
		return nil
	}
	return ret
}

func maskDelimited(line string, marker byte) string {
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

// Scan extracts Noema UUIDv7 definitions and references while ignoring fenced
// code, indented code, inline code/math, and non-semantic org environments.
func Scan(source []byte) Projection {
	lines := strings.Split(strings.ReplaceAll(string(source), "\r\n", "\n"), "\n")
	lineOffsets := make([]int, len(lines))
	for index := 1; index < len(lines); index++ {
		lineOffsets[index] = lineOffsets[index-1] + utf16Length(lines[index-1]) + 1
	}
	ret := Projection{}
	definitionCounts := map[string]int{}
	fenceChar := byte(0)
	fenceLen := 0
	ignoredOrg := ""
	mathFence := false

	for index, line := range lines {
		lineNumber := index + 1
		trimmed := strings.TrimSpace(line)

		if 0 != fenceChar {
			if match := fencePattern.FindStringSubmatch(line); nil != match && match[1][0] == fenceChar && len(match[1]) >= fenceLen {
				fenceChar, fenceLen = 0, 0
			}
			continue
		}
		if match := fencePattern.FindStringSubmatch(line); nil != match {
			fenceChar, fenceLen = match[1][0], len(match[1])
			continue
		}
		if strings.HasPrefix(trimmed, "$$") {
			if 1 == strings.Count(trimmed, "$$") {
				mathFence = !mathFence
			}
			continue
		}
		if mathFence || strings.HasPrefix(line, "    ") || strings.HasPrefix(line, "\t") {
			continue
		}

		if "" != ignoredOrg {
			if match := orgAnyEndPattern.FindStringSubmatch(line); nil != match && strings.EqualFold(match[1], ignoredOrg) {
				ignoredOrg = ""
			}
			continue
		}
		if match := orgAnyBeginPattern.FindStringSubmatch(line); nil != match {
			kind := strings.ToLower(match[1])
			if nonSemanticOrgEnvs[kind] {
				ignoredOrg = kind
				continue
			}
		}

		if match := trailingBlockAnchorPattern.FindStringSubmatchIndex(line); nil != match {
			canonical := strings.ToLower(line[match[2]:match[3]])
			propertiesRaw := ""
			if 0 <= match[4] {
				propertiesRaw = line[match[4]:match[5]]
			}
			kind := "block"
			orgEnv := false
			text := strings.TrimSpace(line[:match[0]])
			if orgMatch := orgAnyBeginPattern.FindStringSubmatchIndex(line); nil != orgMatch {
				kind = strings.ToLower(line[orgMatch[2]:orgMatch[3]])
				orgEnv = true
				text = strings.TrimSpace(line[orgMatch[1]:match[0]])
			}
			definitionCounts[canonical]++
			ret.Definitions = append(ret.Definitions, Definition{
				CanonicalID: canonical, ProjectionID: noemaidentity.ProjectionID(canonical, ""),
				Line: lineNumber, Index: lineOffsets[index], Kind: kind, OrgEnv: orgEnv,
				Text: text, Properties: parseBlockProperties(propertiesRaw),
			})
		}

		ret.References = append(ret.References, scanLineReferences(line, lineNumber)...)
	}

	for id, count := range definitionCounts {
		if 1 < count {
			ret.DuplicateDefinitionIDs = append(ret.DuplicateDefinitionIDs, id)
		}
	}
	sort.Strings(ret.DuplicateDefinitionIDs)
	return ret
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
