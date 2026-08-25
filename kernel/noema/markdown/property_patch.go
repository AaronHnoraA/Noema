// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package markdown

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf16"

	noemaidentity "github.com/aaronhe/noema/kernel/noema/identity"
)

var blockPropertyKeyPattern = regexp.MustCompile(`(?i)^[a-z][a-z0-9_-]*$`)
var unquotedBlockPropertyValuePattern = regexp.MustCompile(`^[A-Za-z0-9._:/@+%-]+$`)

type blockPropertyToken struct {
	start      int
	end        int
	key        string
	valueStart int
	valueEnd   int
	quote      byte
}

type PropertyPatch struct {
	From       int        `json:"from"`
	To         int        `json:"to"`
	Source     string     `json:"source"`
	NextSource string     `json:"nextSource"`
	Definition Definition `json:"definition"`
	Markdown   string     `json:"-"`
}

func parseBlockPropertyTokens(raw string) ([]blockPropertyToken, bool) {
	tokens := []blockPropertyToken{}
	for index := 0; index < len(raw); {
		whitespaceStart := index
		for index < len(raw) && (raw[index] == ' ' || raw[index] == '\t') {
			index++
		}
		if index == len(raw) {
			return tokens, true
		}
		keyStart := index
		if !((raw[index] >= 'A' && raw[index] <= 'Z') || (raw[index] >= 'a' && raw[index] <= 'z')) {
			return nil, false
		}
		index++
		for index < len(raw) && ((raw[index] >= 'A' && raw[index] <= 'Z') || (raw[index] >= 'a' && raw[index] <= 'z') || (raw[index] >= '0' && raw[index] <= '9') || raw[index] == '_' || raw[index] == '-') {
			index++
		}
		key := strings.ToLower(raw[keyStart:index])
		for index < len(raw) && (raw[index] == ' ' || raw[index] == '\t') {
			index++
		}
		if index >= len(raw) || raw[index] != '=' {
			return nil, false
		}
		index++
		for index < len(raw) && (raw[index] == ' ' || raw[index] == '\t') {
			index++
		}
		if index >= len(raw) {
			return nil, false
		}
		token := blockPropertyToken{start: whitespaceStart, key: key, valueStart: index}
		if raw[index] == '"' || raw[index] == '\'' {
			token.quote = raw[index]
			index++
			closed := false
			for index < len(raw) {
				if raw[index] == '\\' && index+1 < len(raw) {
					index += 2
					continue
				}
				if raw[index] == token.quote {
					index++
					closed = true
					break
				}
				index++
			}
			if !closed {
				return nil, false
			}
		} else {
			for index < len(raw) && raw[index] != ' ' && raw[index] != '\t' {
				index++
			}
		}
		token.valueEnd = index
		token.end = index
		tokens = append(tokens, token)
	}
	return tokens, true
}

func encodeBlockPropertyValue(value string, preferredQuote byte) string {
	if preferredQuote == 0 && unquotedBlockPropertyValuePattern.MatchString(value) {
		return value
	}
	quote := preferredQuote
	if quote == 0 {
		quote = '"'
	}
	escaped := strings.ReplaceAll(value, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, string(quote), `\`+string(quote))
	return string(quote) + escaped + string(quote)
}

func utf16PropertyOffset(value string) int {
	return len(utf16.Encode([]rune(value)))
}

// PatchBlockProperty replaces, inserts, or deletes one property on a unique
// semantic UUIDv7 definition. It never accepts positional identity.
func PatchBlockProperty(source, id, key string, value *string) (PropertyPatch, error) {
	canonical := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(id), "#"))
	key = strings.ToLower(strings.TrimSpace(key))
	if !noemaidentity.IsUUIDv7(canonical) {
		return PropertyPatch{}, fmt.Errorf("block property mutation requires a UUIDv7 identity")
	}
	if !blockPropertyKeyPattern.MatchString(key) || key == "id" {
		return PropertyPatch{}, fmt.Errorf("invalid block property key [%s]", key)
	}
	projection := Scan([]byte(source))
	for _, duplicate := range projection.DuplicateDefinitionIDs {
		if duplicate == canonical {
			return PropertyPatch{}, fmt.Errorf("block identity [%s] is ambiguous", canonical)
		}
	}
	var definition *Definition
	for index := range projection.Definitions {
		if projection.Definitions[index].CanonicalID == canonical {
			candidate := projection.Definitions[index]
			definition = &candidate
			break
		}
	}
	if nil == definition {
		return PropertyPatch{}, fmt.Errorf("block identity [%s] was not found", canonical)
	}

	lineStart := 0
	for line := 1; line < definition.Line; line++ {
		relativeEnd := strings.IndexByte(source[lineStart:], '\n')
		if relativeEnd < 0 {
			return PropertyPatch{}, fmt.Errorf("block identity [%s] source line was not found", canonical)
		}
		lineStart += relativeEnd + 1
	}
	lineEnd := len(source)
	if relativeEnd := strings.IndexByte(source[lineStart:], '\n'); relativeEnd >= 0 {
		lineEnd = lineStart + relativeEnd
	}
	line := strings.TrimSuffix(source[lineStart:lineEnd], "\r")
	match := trailingBlockAnchorPattern.FindStringSubmatchIndex(line)
	if nil == match || !strings.EqualFold(line[match[2]:match[3]], canonical) {
		return PropertyPatch{}, fmt.Errorf("block identity [%s] anchor changed during mutation", canonical)
	}
	anchorStart := match[0]
	anchorWithTail := line[anchorStart:match[1]]
	closeRelative := strings.LastIndexByte(anchorWithTail, '}')
	if closeRelative < 0 {
		return PropertyPatch{}, fmt.Errorf("block identity [%s] anchor is invalid", canonical)
	}
	anchorEnd := anchorStart + closeRelative + 1
	propertiesStart := match[3]
	rawProperties := line[propertiesStart : anchorEnd-1]
	tokens, valid := parseBlockPropertyTokens(rawProperties)
	if !valid {
		return PropertyPatch{}, fmt.Errorf("block identity [%s] has malformed properties", canonical)
	}

	nextProperties := rawProperties
	found := false
	targetCount := 0
	for _, token := range tokens {
		if token.key == key {
			targetCount++
		}
	}
	if 1 < targetCount {
		return PropertyPatch{}, fmt.Errorf("block identity [%s] has duplicate property [%s]", canonical, key)
	}
	for _, token := range tokens {
		if token.key != key {
			continue
		}
		found = true
		if nil == value || *value == "" {
			nextProperties = rawProperties[:token.start] + rawProperties[token.end:]
		} else {
			nextProperties = rawProperties[:token.valueStart] + encodeBlockPropertyValue(*value, token.quote) + rawProperties[token.valueEnd:]
		}
		break
	}
	if !found && nil != value && *value != "" {
		nextProperties = strings.TrimRight(rawProperties, " \t") + " " + key + "=" + encodeBlockPropertyValue(*value, 0)
	}
	oldAnchor := line[anchorStart:anchorEnd]
	newAnchor := line[anchorStart:propertiesStart] + nextProperties + "}"
	nextSource := source[:lineStart+anchorStart] + newAnchor + source[lineStart+anchorEnd:]
	nextProjection := Scan([]byte(nextSource))
	for _, candidate := range nextProjection.Definitions {
		if candidate.CanonicalID == canonical {
			from := utf16PropertyOffset(source[:lineStart+anchorStart])
			return PropertyPatch{
				From: from, To: from + utf16PropertyOffset(oldAnchor), Source: oldAnchor,
				NextSource: newAnchor, Definition: candidate, Markdown: nextSource,
			}, nil
		}
	}
	return PropertyPatch{}, fmt.Errorf("block identity [%s] disappeared after mutation", canonical)
}
