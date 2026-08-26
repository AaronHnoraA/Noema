// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema's portable LaTeX command scanner is Copyright (c) 2026 Aaron He and
// distributed under the same AGPL-3.0-or-later terms.

package latex

import (
	"sort"
	"strings"
	"unicode"
)

type inlineCommand struct {
	Name        string
	SwitchValue string
	Context     string
	Args        map[string]string
	FullFrom    int
	FullTo      int
}

func isCommandNameStart(ch byte) bool {
	return ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z'
}

func isCommandNameChar(ch byte) bool {
	return isCommandNameStart(ch) || ch >= '0' && ch <= '9' || ch == '_' || ch == '-'
}

func escapedAt(text string, at int) bool {
	slashes := 0
	for i := at - 1; i >= 0 && text[i] == '\\'; i-- {
		slashes++
	}
	return slashes%2 == 1
}

func findDelimitedClose(text string, open int, close byte) int {
	openChar := text[open]
	depth := 0
	quote := byte(0)
	for i := open + 1; i < len(text); i++ {
		ch := text[i]
		if quote != 0 {
			if ch == '\\' && i+1 < len(text) {
				i++
			} else if ch == quote {
				quote = 0
			}
			continue
		}
		if close == '}' && (ch == '\'' || ch == '"') {
			quote = ch
			continue
		}
		if close == ']' && ch == '\\' && i+1 < len(text) && (text[i+1] == '(' || text[i+1] == '[') {
			mathClose := "\\)"
			if text[i+1] == '[' {
				mathClose = "\\]"
			}
			if found := strings.Index(text[i+2:], mathClose); found >= 0 {
				span := text[i+2 : i+2+found]
				if !strings.ContainsAny(span, "\r\n") {
					i += 1 + found + len(mathClose)
					continue
				}
			}
		}
		if ch == '\\' && i+1 < len(text) {
			i++
			continue
		}
		if ch == '\n' || ch == '\r' {
			return -1
		}
		if ch == openChar {
			depth++
			continue
		}
		if ch == close {
			if depth > 0 {
				depth--
				continue
			}
			return i
		}
	}
	return -1
}

func splitArgumentChunks(body string) []string {
	chunks := []string{}
	start := 0
	quote := byte(0)
	escaped := false
	depth := 0
	for i := 0; i < len(body); i++ {
		ch := body[i]
		if escaped {
			escaped = false
			continue
		}
		if ch == '\\' {
			escaped = true
			continue
		}
		if quote != 0 {
			if ch == quote {
				quote = 0
			}
			continue
		}
		if ch == '\'' || ch == '"' {
			quote = ch
			continue
		}
		if ch == '{' {
			depth++
		} else if ch == '}' && depth > 0 {
			depth--
		}
		if depth != 0 || ch != ';' && ch != ',' {
			continue
		}
		if ch == ',' {
			currentHasAssignment := hasArgumentAssignment(body[start:i])
			nextStartsAssignment := startsArgumentAssignment(body[i+1:])
			if currentHasAssignment && !nextStartsAssignment {
				continue
			}
		}
		chunks = append(chunks, body[start:i])
		start = i + 1
	}
	return append(chunks, body[start:])
}

func skipSpaces(value string, at int) int {
	for at < len(value) && (value[at] == ' ' || value[at] == '\t' || value[at] == '\r' || value[at] == '\n') {
		at++
	}
	return at
}

func argumentKeyAt(value string, at int) (key string, after int, ok bool) {
	at = skipSpaces(value, at)
	if at >= len(value) || !isCommandNameStart(value[at]) {
		return "", at, false
	}
	end := at + 1
	for end < len(value) && isCommandNameChar(value[end]) {
		end++
	}
	after = skipSpaces(value, end)
	if after >= len(value) || value[after] != ':' && value[after] != '=' {
		return "", at, false
	}
	return strings.ToLower(value[at:end]), after + 1, true
}

func startsArgumentAssignment(value string) bool {
	_, _, ok := argumentKeyAt(value, 0)
	return ok
}

func hasArgumentAssignment(value string) bool {
	for i := 0; i < len(value); i++ {
		if !isCommandNameStart(value[i]) || i > 0 && isCommandNameChar(value[i-1]) {
			continue
		}
		if _, _, ok := argumentKeyAt(value, i); ok {
			return true
		}
	}
	return false
}

func cleanArgumentValue(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && (value[0] == '\'' || value[0] == '"') && value[len(value)-1] == value[0] {
		quote := string(value[0])
		return strings.ReplaceAll(value[1:len(value)-1], "\\"+quote, quote)
	}
	return value
}

func parseArgumentChunk(chunk string, out map[string]string) {
	chunk = strings.TrimSpace(chunk)
	if chunk == "" {
		return
	}
	if isBareArgument(chunk) {
		out[strings.ToLower(chunk)] = strings.ToLower(chunk)
		return
	}
	for pos := 0; pos < len(chunk); {
		key, valueFrom, ok := argumentKeyAt(chunk, pos)
		if !ok {
			pos++
			continue
		}
		valueFrom = skipSpaces(chunk, valueFrom)
		valueTo := len(chunk)
		quote := byte(0)
		escaped := false
		depth := 0
		for i := valueFrom; i < len(chunk); i++ {
			ch := chunk[i]
			if escaped {
				escaped = false
				continue
			}
			if ch == '\\' {
				escaped = true
				continue
			}
			if quote != 0 {
				if ch == quote {
					quote = 0
				}
				continue
			}
			if ch == '\'' || ch == '"' {
				quote = ch
				continue
			}
			if ch == '{' {
				depth++
			} else if ch == '}' && depth > 0 {
				depth--
			}
			if depth == 0 && unicode.IsSpace(rune(ch)) {
				if _, _, next := argumentKeyAt(chunk, i); next {
					valueTo = i
					break
				}
			}
		}
		value := cleanArgumentValue(chunk[valueFrom:valueTo])
		if key != "" && value != "" {
			out[key] = value
		}
		if valueTo >= len(chunk) {
			break
		}
		pos = valueTo
	}
}

func isBareArgument(value string) bool {
	if value == "" || !isCommandNameStart(value[0]) {
		return false
	}
	for i := 1; i < len(value); i++ {
		if !isCommandNameChar(value[i]) {
			return false
		}
	}
	return true
}

func parseCommandArgs(raw string) map[string]string {
	body := strings.TrimSpace(raw)
	if strings.HasPrefix(body, "{") {
		body = strings.TrimPrefix(body, "{")
	}
	if strings.HasSuffix(body, "}") {
		body = strings.TrimSuffix(body, "}")
	}
	body = strings.TrimSpace(body)
	out := map[string]string{}
	for _, chunk := range splitArgumentChunks(body) {
		parseArgumentChunk(chunk, out)
	}
	return out
}

func scanInlineCommands(text string) []inlineCommand {
	commands := []inlineCommand{}
	for at := 0; at+2 < len(text); {
		rel := strings.Index(text[at:], "@@")
		if rel < 0 {
			break
		}
		from := at + rel
		nameFrom := from + 2
		if nameFrom >= len(text) || !isCommandNameStart(text[nameFrom]) {
			at = nameFrom
			continue
		}
		nameTo := nameFrom + 1
		for nameTo < len(text) && isCommandNameChar(text[nameTo]) {
			nameTo++
		}
		name := strings.ToLower(text[nameFrom:nameTo])
		cursor := nameTo
		switchValue := ""
		if cursor < len(text) && text[cursor] == '(' {
			close := strings.IndexByte(text[cursor+1:], ')')
			if close < 0 || strings.ContainsAny(text[cursor+1:cursor+1+close], "\r\n") {
				at = nameTo
				continue
			}
			switchValue = strings.TrimSpace(text[cursor+1 : cursor+1+close])
			cursor += close + 2
		}
		if name == "latexmk" {
			if switchValue != "" {
				commands = append(commands, inlineCommand{Name: name, SwitchValue: switchValue, Args: map[string]string{}, FullFrom: from, FullTo: cursor})
			}
			at = max(cursor, nameTo)
			continue
		}
		spaceFrom := cursor
		cursor = skipSpaces(text, cursor)
		if cursor >= len(text) || text[cursor] != '[' || name != "cite" && name != "tag" && cursor == spaceFrom {
			if (name == "todo" || name == "itodo") && cursor > spaceFrom && cursor < len(text) && text[cursor] != '[' {
				lineEnd := cursor
				for lineEnd < len(text) && text[lineEnd] != '\r' && text[lineEnd] != '\n' {
					lineEnd++
				}
				context := strings.TrimRight(text[cursor:lineEnd], " \t")
				if context != "" {
					commands = append(commands, inlineCommand{Name: name, SwitchValue: switchValue, Context: context, Args: map[string]string{}, FullFrom: from, FullTo: lineEnd})
				}
			}
			at = max(cursor, nameTo)
			continue
		}
		if name == "cite" && escapedAt(text, from) {
			at = cursor + 1
			continue
		}
		close := findDelimitedClose(text, cursor, ']')
		if close < 0 {
			at = cursor + 1
			continue
		}
		fullTo := close + 1
		argsRaw := ""
		metaAt := skipSpaces(text, fullTo)
		if metaAt < len(text) && text[metaAt] == '{' {
			if metaClose := findDelimitedClose(text, metaAt, '}'); metaClose >= 0 {
				argsRaw = text[metaAt : metaClose+1]
				fullTo = metaClose + 1
			}
		}
		commands = append(commands, inlineCommand{
			Name: name, SwitchValue: switchValue, Context: text[cursor+1 : close], Args: parseCommandArgs(argsRaw), FullFrom: from, FullTo: fullTo,
		})
		at = fullTo
	}
	sort.SliceStable(commands, func(i, j int) bool {
		return commands[i].FullFrom < commands[j].FullFrom || commands[i].FullFrom == commands[j].FullFrom && commands[i].FullTo < commands[j].FullTo
	})
	return commands
}
