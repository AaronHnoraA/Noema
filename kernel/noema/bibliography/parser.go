// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package bibliography implements Noema's portable BibTeX data model. The
// browser keeps citation source offsets and widgets; this package owns BibTeX
// parsing so App and Emacs can share the Go data kernel without changing the
// Markdown citation syntax.
package bibliography

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

type Entry struct {
	Type           string            `json:"type"`
	Key            string            `json:"key"`
	Fields         map[string]string `json:"fields"`
	Raw            string            `json:"raw,omitempty"`
	Namespace      string            `json:"namespace,omitempty"`
	ShortNamespace string            `json:"shortNamespace,omitempty"`
	File           string            `json:"file,omitempty"`
	Path           string            `json:"path,omitempty"`
	ID             string            `json:"id,omitempty"`
}

type ParseResult struct {
	Entries     []Entry  `json:"entries"`
	Diagnostics []string `json:"diagnostics"`
}

type valuePart struct {
	kind string
	text string
}

type bibRecord struct {
	typ         string
	text        string
	offset, end int
}

type stringDefinition struct {
	parts  []valuePart
	offset int
}

var (
	recordStartPattern = regexp.MustCompile(`^@([A-Za-z]+)\s*([{(])`)
	fieldPattern       = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9_-]*)\s*=`)
	stringPattern      = regexp.MustCompile(`^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*`)
	macroNamePattern   = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]*$`)
	accentPattern      = regexp.MustCompile(`\{?\\(["'` + "`" + `^~=\.uvHckr])\s*\{?([A-Za-z])\}?\}?`)
	ligaturePattern    = regexp.MustCompile(`\\(ae|AE|oe|OE|aa|AA|o|O|l|L|ss)\b(?:\{\})?`)
	outerValuePattern  = regexp.MustCompile(`^["{]+|["}]+$`)
	spacePattern       = regexp.MustCompile(`\s+`)
)

var bibMonths = map[string]string{
	"jan": "January", "feb": "February", "mar": "March", "apr": "April",
	"may": "May", "jun": "June", "jul": "July", "aug": "August",
	"sep": "September", "oct": "October", "nov": "November", "dec": "December",
}

var accentMarks = map[string]string{
	`"`: "\u0308", "'": "\u0301", "`": "\u0300", "^": "\u0302",
	"~": "\u0303", "=": "\u0304", ".": "\u0307", "u": "\u0306",
	"v": "\u030C", "H": "\u030B", "c": "\u0327", "k": "\u0328", "r": "\u030A",
}

var ligatures = map[string]string{
	"ae": "æ", "AE": "Æ", "oe": "œ", "OE": "Œ", "aa": "å", "AA": "Å",
	"o": "ø", "O": "Ø", "l": "ł", "L": "Ł", "ss": "ß",
}

func skipSpaces(source string, pos int) int {
	for pos < len(source) {
		r, size := utf8.DecodeRuneInString(source[pos:])
		if !unicode.IsSpace(r) {
			break
		}
		pos += size
	}
	return pos
}

func readBalanced(source string, pos int, open, close byte) (text string, end int, ok bool) {
	if pos < 0 || pos >= len(source) || source[pos] != open {
		return "", 0, false
	}
	depth, braceDepth := 0, 0
	var quote byte
	for i := pos; i < len(source); i++ {
		ch := source[i]
		if 0 != quote {
			if '\\' == ch && i+1 < len(source) {
				i++
			} else if ch == quote {
				quote = 0
			}
			continue
		}
		if '\\' == ch && i+1 < len(source) {
			i++
			continue
		}
		if '"' == ch {
			quote = ch
			continue
		}
		if '(' == open {
			if '{' == ch {
				braceDepth++
				continue
			}
			if '}' == ch && 0 < braceDepth {
				braceDepth--
				continue
			}
			if 0 < braceDepth {
				continue
			}
		}
		if ch == open {
			depth++
		}
		if ch == close {
			depth--
			if 0 == depth {
				return source[pos+1 : i], i + 1, true
			}
		}
	}
	return "", 0, false
}

func readQuoted(source string, pos int) (text string, end int, ok bool) {
	if pos >= len(source) || ('"' != source[pos] && '\'' != source[pos]) {
		return "", 0, false
	}
	quote := source[pos]
	var out strings.Builder
	for i := pos + 1; i < len(source); i++ {
		ch := source[i]
		if '\\' == ch && i+1 < len(source) {
			out.WriteByte(ch)
			out.WriteByte(source[i+1])
			i++
			continue
		}
		if ch == quote {
			return out.String(), i + 1, true
		}
		out.WriteByte(ch)
	}
	return "", 0, false
}

func decodeBibTeXText(value string) string {
	decoded := accentPattern.ReplaceAllStringFunc(value, func(match string) string {
		parts := accentPattern.FindStringSubmatch(match)
		if len(parts) != 3 {
			return match
		}
		return norm.NFC.String(parts[2] + accentMarks[parts[1]])
	})
	return ligaturePattern.ReplaceAllStringFunc(decoded, func(match string) string {
		parts := ligaturePattern.FindStringSubmatch(match)
		if len(parts) != 2 {
			return match
		}
		return ligatures[parts[1]]
	})
}

func cleanBibValue(value string) string {
	value = strings.TrimSpace(decodeBibTeXText(value))
	value = outerValuePattern.ReplaceAllString(value, "")
	value = strings.NewReplacer("{", "", "}", "", `\&`, "&", `\_`, "_").Replace(value)
	return strings.TrimSpace(spacePattern.ReplaceAllString(value, " "))
}

func bibValuePart(value string) string {
	return strings.NewReplacer("{", "", "}", "", `\&`, "&", `\_`, "_").Replace(decodeBibTeXText(value))
}

func readBibValueAtom(source string, start int) (part valuePart, end int, ok bool) {
	pos := skipSpaces(source, start)
	if pos >= len(source) {
		return valuePart{}, 0, false
	}
	if '{' == source[pos] {
		text, next, parsed := readBalanced(source, pos, '{', '}')
		return valuePart{kind: "literal", text: text}, next, parsed
	}
	if '"' == source[pos] {
		text, next, parsed := readQuoted(source, pos)
		return valuePart{kind: "literal", text: text}, next, parsed
	}
	end = pos
	for end < len(source) && '#' != source[end] && ',' != source[end] {
		end++
	}
	text := strings.TrimSpace(source[pos:end])
	if "" == text {
		return valuePart{}, 0, false
	}
	return valuePart{kind: "bare", text: text}, end, true
}

func parseBibValueExpression(source string, start int) (parts []valuePart, end int, ok bool) {
	pos := start
	for pos < len(source) {
		part, next, parsed := readBibValueAtom(source, pos)
		if !parsed {
			return nil, 0, false
		}
		parts = append(parts, part)
		pos = skipSpaces(source, next)
		if pos >= len(source) || '#' != source[pos] {
			break
		}
		pos = skipSpaces(source, pos+1)
	}
	return parts, pos, true
}

func parseFields(body string) (key string, fields map[string][]valuePart, fieldOrder []string, diagnostics []string, ok bool) {
	comma := strings.IndexByte(body, ',')
	if comma < 0 {
		return "", nil, nil, nil, false
	}
	key = strings.TrimSpace(body[:comma])
	fields = map[string][]valuePart{}
	pos := comma + 1
	for pos < len(body) {
		pos = skipSpaces(body, pos)
		if pos < len(body) && ',' == body[pos] {
			pos++
			continue
		}
		if "" == strings.TrimSpace(body[pos:]) {
			break
		}
		match := fieldPattern.FindStringSubmatchIndex(body[pos:])
		if nil == match || 0 != match[0] {
			fragment := strings.TrimSpace(body[pos:min(len(body), pos+40)])
			diagnostics = append(diagnostics, fmt.Sprintf("invalid field syntax near %q", fragment))
			break
		}
		name := strings.ToLower(body[pos+match[2] : pos+match[3]])
		pos += match[1]
		parts, next, parsed := parseBibValueExpression(body, pos)
		if !parsed {
			diagnostics = append(diagnostics, "invalid value for field "+name)
			break
		}
		if _, exists := fields[name]; !exists {
			fieldOrder = append(fieldOrder, name)
		}
		fields[name] = parts
		pos = skipSpaces(body, next)
		if pos < len(body) && ',' != body[pos] {
			diagnostics = append(diagnostics, "expected comma after field "+name)
			break
		}
	}
	return key, fields, fieldOrder, diagnostics, "" != key
}

func parseStringBody(body string) (key string, parts []valuePart, ok bool) {
	match := stringPattern.FindStringSubmatchIndex(body)
	if nil == match || 0 != match[0] {
		return "", nil, false
	}
	parts, end, parsed := parseBibValueExpression(body, match[1])
	if !parsed || "" != strings.TrimSpace(body[end:]) {
		return "", nil, false
	}
	return strings.ToLower(body[match[2]:match[3]]), parts, true
}

func bibLocation(source string, offset int) string {
	before := source[:min(max(offset, 0), len(source))]
	line := strings.Count(before, "\n") + 1
	lineStart := strings.LastIndex(before, "\n") + 1
	utf16Offset := len(utf16.Encode([]rune(before)))
	column := len(utf16.Encode([]rune(before[lineStart:]))) + 1
	return fmt.Sprintf("offset %d (line %d, column %d)", utf16Offset, line, column)
}

func scanBibRecords(source string, diagnostics *[]string) []bibRecord {
	records := []bibRecord{}
	for pos := 0; pos < len(source); {
		if '%' == source[pos] {
			newline := strings.IndexByte(source[pos+1:], '\n')
			if newline < 0 {
				break
			}
			pos += newline + 2
			continue
		}
		if '@' != source[pos] {
			pos++
			continue
		}
		match := recordStartPattern.FindStringSubmatchIndex(source[pos:])
		if nil == match || 0 != match[0] {
			pos++
			continue
		}
		openPos := pos + match[1] - 1
		open := source[openPos]
		close := byte(')')
		if '{' == open {
			close = '}'
		}
		text, end, parsed := readBalanced(source, openPos, open, close)
		if !parsed {
			*diagnostics = append(*diagnostics, "Unclosed BibTeX entry near "+bibLocation(source, pos))
			break
		}
		records = append(records, bibRecord{
			typ: strings.ToLower(source[pos+match[2] : pos+match[3]]), text: text, offset: pos, end: end,
		})
		pos = end
	}
	return records
}

func Parse(source string) ParseResult {
	result := ParseResult{Entries: []Entry{}, Diagnostics: []string{}}
	records := scanBibRecords(source, &result.Diagnostics)
	definitions := map[string]stringDefinition{}
	definitionOrder := []string{}
	for _, record := range records {
		if "string" != record.typ {
			continue
		}
		key, parts, ok := parseStringBody(record.text)
		if !ok {
			result.Diagnostics = append(result.Diagnostics, "Invalid BibTeX @string near "+bibLocation(source, record.offset))
			continue
		}
		if _, exists := definitions[key]; exists {
			result.Diagnostics = append(result.Diagnostics, "Duplicate BibTeX string macro: "+key)
		} else {
			definitionOrder = append(definitionOrder, key)
		}
		definitions[key] = stringDefinition{parts: parts, offset: record.offset}
	}

	cache := map[string]string{}
	for key, value := range bibMonths {
		cache[key] = value
	}
	diagnosticSet := map[string]struct{}{}
	for _, diagnostic := range result.Diagnostics {
		diagnosticSet[diagnostic] = struct{}{}
	}
	addDiagnostic := func(message string) {
		if _, exists := diagnosticSet[message]; exists {
			return
		}
		diagnosticSet[message] = struct{}{}
		result.Diagnostics = append(result.Diagnostics, message)
	}
	var resolveParts func(parts []valuePart, stack []string) string
	resolveParts = func(parts []valuePart, stack []string) string {
		var out strings.Builder
		for _, part := range parts {
			if "literal" == part.kind {
				out.WriteString(bibValuePart(part.text))
				continue
			}
			raw := strings.TrimSpace(part.text)
			name := strings.ToLower(raw)
			if !validMacroName(raw) {
				out.WriteString(bibValuePart(raw))
				continue
			}
			if value, exists := cache[name]; exists {
				out.WriteString(value)
				continue
			}
			definition, exists := definitions[name]
			if !exists {
				addDiagnostic("Unknown BibTeX string macro: " + raw)
				out.WriteString(raw)
				continue
			}
			if contains(stack, name) {
				addDiagnostic("Cyclic BibTeX string macro: " + strings.Join(append(append([]string{}, stack...), name), " -> "))
				out.WriteString(raw)
				continue
			}
			value := resolveParts(definition.parts, append(append([]string{}, stack...), name))
			cache[name] = value
			out.WriteString(value)
		}
		return cleanBibValue(out.String())
	}
	for _, name := range definitionOrder {
		if _, exists := cache[name]; !exists {
			cache[name] = resolveParts(definitions[name].parts, []string{name})
		}
	}

	for _, record := range records {
		if "comment" == record.typ || "preamble" == record.typ || "string" == record.typ {
			continue
		}
		key, fields, fieldOrder, diagnostics, ok := parseFields(record.text)
		if !ok {
			result.Diagnostics = append(result.Diagnostics, "Invalid BibTeX entry near "+bibLocation(source, record.offset))
			continue
		}
		for _, diagnostic := range diagnostics {
			result.Diagnostics = append(result.Diagnostics, key+": "+diagnostic)
		}
		resolved := map[string]string{}
		for _, name := range fieldOrder {
			resolved[name] = resolveParts(fields[name], nil)
		}
		result.Entries = append(result.Entries, Entry{
			Type: record.typ, Key: key, Fields: resolved, Raw: source[record.offset:record.end],
		})
	}
	return result
}

func validMacroName(value string) bool {
	return macroNamePattern.MatchString(value)
}

func contains(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}
