// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package katexmacros loads the portable LaTeX preamble subset used by
// Noema's KaTeX renderers. It mirrors shared/katex-macros.mjs; shared fixtures
// keep the Go desktop data plane and browser/Emacs fallback aligned.
package katexmacros

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

var definitionPattern = regexp.MustCompile(`\\(newcommand|renewcommand|providecommand|DeclareMathOperator|def)(\*?)`)

type File struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

type ParseError struct {
	File    string `json:"file"`
	Message string `json:"message"`
}

type Result struct {
	Dir    string            `json:"dir,omitempty"`
	Macros map[string]string `json:"macros"`
	Errors []ParseError      `json:"errors"`
}

// Load reads sorted *.tex files from dir. A missing directory is the same
// optional empty macro environment used by the Node compatibility loader.
func Load(dir string) Result {
	dir = strings.TrimSpace(dir)
	result := Result{Dir: dir, Macros: map[string]string{}, Errors: []ParseError{}}
	info, err := os.Stat(dir)
	if dir == "" || nil != err || !info.IsDir() {
		return result
	}
	entries, err := os.ReadDir(dir)
	if nil != err {
		return result
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	files := []File{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".tex") {
			continue
		}
		raw, readErr := os.ReadFile(filepath.Join(dir, entry.Name()))
		if nil != readErr {
			raw = nil
		}
		files = append(files, File{Name: entry.Name(), Text: string(raw)})
	}
	parsed := Parse(files)
	parsed.Dir = dir
	return parsed
}

// Parse converts LaTeX definitions into KaTeX's macro map. Later files and
// later definitions override earlier ones, matching TeX preamble order.
func Parse(files []File) Result {
	result := Result{Macros: map[string]string{}, Errors: []ParseError{}}
	for _, file := range files {
		name := file.Name
		if name == "" {
			name = "?"
		}
		text := stripComments(file.Text)
		cursor := 0
		for cursor < len(text) {
			match := definitionPattern.FindStringSubmatchIndex(text[cursor:])
			if nil == match {
				break
			}
			start := cursor + match[0]
			end := cursor + match[1]
			kind := text[cursor+match[2] : cursor+match[3]]
			starred := match[4] >= 0 && text[cursor+match[4]:cursor+match[5]] == "*"
			macroName, pos, ok := readName(text, end)
			if !ok {
				result.Errors = append(result.Errors, ParseError{File: name, Message: "Missing macro name after \\" + kind})
				cursor = end
				continue
			}

			body := ""
			switch kind {
			case "DeclareMathOperator":
				value, next, groupOK := readGroup(text, skipSpace(text, pos))
				if !groupOK {
					result.Errors = append(result.Errors, ParseError{File: name, Message: "Malformed \\DeclareMathOperator for " + macroName})
					cursor = end
					continue
				}
				operatorStar := ""
				if starred {
					operatorStar = "*"
				}
				body, pos = "\\operatorname"+operatorStar+"{"+value+"}", next
			case "def":
				bodyStart := strings.IndexByte(text[pos:], '{')
				if bodyStart >= 0 {
					bodyStart += pos
				}
				value, next, groupOK := readGroup(text, bodyStart)
				if !groupOK {
					result.Errors = append(result.Errors, ParseError{File: name, Message: "Malformed \\def for " + macroName})
					cursor = end
					continue
				}
				body, pos = value, next
			default:
				pos = skipOptionals(text, pos)
				value, next, groupOK := readGroup(text, skipSpace(text, pos))
				if !groupOK {
					result.Errors = append(result.Errors, ParseError{File: name, Message: "Malformed \\" + kind + " for " + macroName})
					cursor = end
					continue
				}
				body, pos = value, next
			}
			result.Macros[macroName] = body
			cursor = pos
			if cursor <= start {
				cursor = end
			}
		}
	}
	return result
}

func stripComments(text string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		for pos := 0; pos < len(line); pos++ {
			if line[pos] == '%' && (pos == 0 || line[pos-1] != '\\') {
				lines[i] = line[:pos]
				break
			}
		}
	}
	return strings.Join(lines, "\n")
}

func readGroup(text string, start int) (string, int, bool) {
	if start < 0 || start >= len(text) || text[start] != '{' {
		return "", start, false
	}
	depth := 0
	for pos := start; pos < len(text); pos++ {
		switch text[pos] {
		case '\\':
			pos++
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return text[start+1 : pos], pos + 1, true
			}
		}
	}
	return "", start, false
}

func skipSpace(text string, start int) int {
	for start < len(text) {
		r, size := utf8.DecodeRuneInString(text[start:])
		if !unicode.IsSpace(r) {
			break
		}
		start += size
	}
	return start
}

func readName(text string, start int) (string, int, bool) {
	start = skipSpace(text, start)
	if start >= len(text) {
		return "", start, false
	}
	if text[start] == '{' {
		value, end, ok := readGroup(text, start)
		name := strings.TrimSpace(value)
		if !ok || !validMacroName(name) {
			return "", start, false
		}
		return name, end, true
	}
	if text[start] != '\\' || start+1 >= len(text) {
		return "", start, false
	}
	end := start + 1
	for end < len(text) && isASCIIAlpha(text[end]) {
		end++
	}
	if end == start+1 {
		end++
	}
	return text[start:end], end, true
}

func validMacroName(name string) bool {
	if len(name) < 2 || name[0] != '\\' {
		return false
	}
	if len(name) == 2 {
		return true
	}
	for i := 1; i < len(name); i++ {
		if !isASCIIAlpha(name[i]) {
			return false
		}
	}
	return true
}

func skipOptionals(text string, start int) int {
	for {
		start = skipSpace(text, start)
		if start >= len(text) || text[start] != '[' {
			return start
		}
		close := strings.IndexByte(text[start+1:], ']')
		if close < 0 {
			return start
		}
		start += close + 2
	}
}

func isASCIIAlpha(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z'
}
