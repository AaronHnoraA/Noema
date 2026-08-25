// Package planning implements Noema's portable, span-aware planning DSL.
//
// Markdown stays the source of truth. The parser therefore preserves the raw
// command bytes and reports offsets in JavaScript UTF-16 code units, matching
// shared/planning-dsl.mjs and CodeMirror rather than Go byte offsets.
package planning

import (
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

var planningKinds = map[string]bool{
	"todo": true, "itodo": true, "project": true, "milestone": true, "clock": true,
}

var titlePlanningKinds = map[string]bool{
	"project": true, "milestone": true, "clock": true,
}

var dateValueKeys = map[string]bool{
	"ddl": true, "due": true, "deadline": true, "sche": true, "scheduled": true,
	"start": true, "end": true, "finish": true, "date": true, "when": true,
	"done": true, "from": true, "to": true,
}

var knownAttrKeys = func() map[string]bool {
	ret := map[string]bool{"from": true, "to": true, "note": true, "task": true}
	for _, key := range []string{
		"id", "ddl", "due", "deadline", "sche", "scheduled", "start", "end", "finish",
		"prio", "priority", "repeat", "rep", "every", "warn", "lead", "after", "dep",
		"blocks", "project", "proj", "area", "phase", "goal", "effort", "progress", "pct",
		"owner", "date", "when", "tags", "context", "ctx", "done", "log",
	} {
		ret[key] = true
	}
	return ret
}()

var (
	relativeDatePattern = regexp.MustCompile(`(?i)^[+-]\d+\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$`)
	yearDatePattern     = regexp.MustCompile(`^\d{4}-\d{1,2}(?:-\d{1,2})?(?:[ T]\d{1,2}:\d{2})?$`)
	isoDatePattern      = regexp.MustCompile(`(?i)^\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$`)
	shortDatePattern    = regexp.MustCompile(`^\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2})?$`)
	repeaterPattern     = regexp.MustCompile(`(?i)^(?:\+\+|\.\+|\+)?\d+\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$`)
	leadPattern         = regexp.MustCompile(`(?i)^\d+\s*(d|day|days|w|week|weeks|m|month|months)?$`)
	durationPattern     = regexp.MustCompile(`(?i)^\d+(?:\.\d+)?\s*(d|day|days|h|hour|hours|m|min|mins|minute|minutes)?$`)
	durationHM          = regexp.MustCompile(`^\d+:[0-5]\d$`)
	monthNamePattern    = regexp.MustCompile(`(?i)^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:,)?\s+\d{4}$`)
	metaOpenPattern     = regexp.MustCompile(`(?i)^[ \t]*#\+[ \t]*begin[ \t]+meta(?:[ \t]+[^\r\n]*)?[ \t]*$`)
	metaClosePattern    = regexp.MustCompile(`(?i)^[ \t]*#\+[ \t]*end[ \t]+meta[ \t]*$`)
	summaryOpenPattern  = regexp.MustCompile(`(?i)^[ \t]*#\+[ \t]*begin[ \t]+summary(?:[ \t]+[^\r\n]*)?[ \t]*$`)
	summaryClosePattern = regexp.MustCompile(`(?i)^[ \t]*#\+[ \t]*end[ \t]+summary[ \t]*$`)
)

// Span uses one-based line/column values and UTF-16 offsets, exactly like the
// JavaScript parser consumed by the renderer and mutation locators.
type Span struct {
	From   int `json:"from"`
	To     int `json:"to"`
	Line   int `json:"line"`
	Column int `json:"column"`
}

type Diagnostic struct {
	Kind    string `json:"kind"`
	Key     string `json:"key,omitempty"`
	Message string `json:"message"`
}

type Node struct {
	Kind        string            `json:"kind"`
	Status      string            `json:"status"`
	Title       string            `json:"title"`
	Attrs       map[string]string `json:"attrs"`
	AttrsRaw    string            `json:"attrsRaw"`
	Shape       string            `json:"shape"`
	Span        Span              `json:"span"`
	Raw         string            `json:"raw"`
	Diagnostics []Diagnostic      `json:"diagnostics"`
}

type byteNode struct {
	node      Node
	from, to  int
	lineStart int
	attrOrder []string
}

type commandHeader struct {
	kind, status string
	body         int
}

// Scan returns all planning nodes, or only the requested kind. "todo"
// intentionally includes both @@todo and @@itodo for compatibility.
func Scan(source, wanted string) []Node {
	text := source
	wanted = strings.ToLower(strings.TrimSpace(wanted))
	lineStarts := byteLineStarts(text)
	var found []byteNode

	for cursor := 0; cursor < len(text); {
		rel := strings.Index(text[cursor:], "@@")
		if rel < 0 {
			break
		}
		from := cursor + rel
		header, ok := parseHeader(text, from)
		if !ok || !planningKinds[header.kind] {
			cursor = from + 2
			continue
		}

		var parsed byteNode
		if header.body < len(text) && text[header.body] == '[' {
			parsed, ok = parseBracketNode(text, from, header, lineStarts)
		} else if titlePlanningKinds[header.kind] {
			parsed, ok = parseTitleNode(text, from, header, lineStarts)
		} else if header.kind == "todo" || header.kind == "itodo" {
			parsed, ok = parseBareTodo(text, from, header, lineStarts)
		}
		if !ok {
			cursor = from + 2
			continue
		}
		if kindMatches(parsed.node.Kind, wanted) {
			found = append(found, parsed)
		}
		if parsed.to > from {
			cursor = parsed.to
		} else {
			cursor = from + 2
		}
	}

	sort.Slice(found, func(i, j int) bool {
		if found[i].from == found[j].from {
			return found[i].to < found[j].to
		}
		return found[i].from < found[j].from
	})
	ret := make([]Node, 0, len(found))
	for _, item := range found {
		item.node.Span = Span{
			From:   utf16Length(text[:item.from]),
			To:     utf16Length(text[:item.to]),
			Line:   lineForByte(lineStarts, item.from),
			Column: utf16Length(text[item.lineStart:item.from]) + 1,
		}
		item.node.Raw = text[item.from:item.to]
		ret = append(ret, item.node)
	}
	return ret
}

// ScanDocument applies the same leading meta-summary exclusion used by the
// Node note index. Summary prose may contain examples such as @@todo, but
// those examples are descriptive metadata rather than live planning items.
// Filtering the source range (instead of rewriting it) preserves UTF-8 bytes
// while retaining JavaScript-compatible UTF-16 offsets after non-ASCII text.
func ScanDocument(source, wanted string) []Node {
	nodes := Scan(source, wanted)
	from, to, ok := metaSummaryUTF16Range(source)
	if !ok {
		return nodes
	}
	ret := make([]Node, 0, len(nodes))
	for _, node := range nodes {
		if node.Span.To <= from || node.Span.From >= to {
			ret = append(ret, node)
		}
	}
	return ret
}

type sourceLine struct {
	from, to int
	text     string
}

func metaSummaryUTF16Range(source string) (from, to int, ok bool) {
	lines := sourceLines(source)
	metaLine := -1
	limit := len(lines)
	if limit > 12 {
		limit = 12
	}
	for i := 0; i < limit; i++ {
		if metaOpenPattern.MatchString(lines[i].text) {
			metaLine = i
			break
		}
	}
	if metaLine < 0 {
		return 0, 0, false
	}
	depth, summaryLine := 0, -1
	for i := metaLine + 1; i < len(lines); i++ {
		if depth > 0 {
			if summaryOpenPattern.MatchString(lines[i].text) {
				depth++
			} else if summaryClosePattern.MatchString(lines[i].text) {
				depth--
			}
			if depth == 0 {
				return utf16Length(source[:lines[summaryLine].from]), utf16Length(source[:lines[i].to]), true
			}
			continue
		}
		if summaryOpenPattern.MatchString(lines[i].text) {
			depth = 1
			summaryLine = i
			continue
		}
		if metaClosePattern.MatchString(lines[i].text) {
			return 0, 0, false
		}
	}
	return 0, 0, false
}

func sourceLines(source string) []sourceLine {
	ret := []sourceLine{}
	for from := 0; from <= len(source); {
		rel := strings.IndexByte(source[from:], '\n')
		to := len(source)
		if rel >= 0 {
			to = from + rel
		}
		text := source[from:to]
		text = strings.TrimSuffix(text, "\r")
		ret = append(ret, sourceLine{from: from, to: to, text: text})
		if rel < 0 {
			break
		}
		from = to + 1
	}
	return ret
}

func parseHeader(text string, from int) (commandHeader, bool) {
	pos := from + 2
	if pos >= len(text) || !isASCIIAlpha(text[pos]) {
		return commandHeader{}, false
	}
	nameFrom := pos
	for pos < len(text) && isIdentifierByte(text[pos]) {
		pos++
	}
	header := commandHeader{kind: strings.ToLower(text[nameFrom:pos])}
	if pos < len(text) && text[pos] == '(' {
		close := strings.IndexByte(text[pos+1:], ')')
		if close < 0 {
			return commandHeader{}, false
		}
		close += pos + 1
		if strings.ContainsAny(text[pos+1:close], "\r\n") {
			return commandHeader{}, false
		}
		header.status = strings.TrimSpace(text[pos+1 : close])
		pos = close + 1
	}
	spacesFrom := pos
	for pos < len(text) && (text[pos] == ' ' || text[pos] == '\t') {
		pos++
	}
	if pos == spacesFrom {
		return commandHeader{}, false
	}
	header.body = pos
	return header, true
}

func parseBracketNode(text string, from int, header commandHeader, lineStarts []int) (byteNode, bool) {
	openBracket := header.body
	closeBracket := findClose(text, openBracket, ']')
	if closeBracket < 0 {
		return byteNode{}, false
	}
	to := closeBracket + 1
	shape := "inline"
	attrsRaw := ""
	attrs := parsedAttrs{values: map[string]string{}}
	pos := closeBracket + 1
	for pos < len(text) && (text[pos] == ' ' || text[pos] == '\t') {
		pos++
	}
	if pos < len(text) && text[pos] == '{' {
		closeBrace := findClose(text, pos, '}')
		if closeBrace >= 0 {
			to = closeBrace + 1
			attrsRaw = text[pos:to]
			attrs = parseAttrs(attrsRaw)
		} else {
			closeBrace = findBlockBrace(text, pos+1)
			if closeBrace < 0 {
				// shared/planning-dsl.mjs suppresses the partial inline node.
				return byteNode{}, false
			}
			to = closeBrace + 1
			shape = "block"
			attrsRaw = text[pos:to]
			attrs = parseAttrs(attrsRaw)
		}
	}
	lineStart := lineStarts[lineForByte(lineStarts, from)-1]
	return byteNode{
		node: Node{
			Kind: header.kind, Status: header.status,
			Title: unescapeBracketTitle(strings.TrimSpace(text[openBracket+1 : closeBracket])),
			Attrs: attrs.values, AttrsRaw: attrsRaw, Shape: shape,
			Diagnostics: diagnoseAttrs(attrs),
		},
		from: from, to: to, lineStart: lineStart, attrOrder: attrs.order,
	}, true
}

func parseTitleNode(text string, from int, header commandHeader, lineStarts []int) (byteNode, bool) {
	lineEnd := strings.IndexByte(text[header.body:], '\n')
	if lineEnd < 0 {
		lineEnd = len(text)
	} else {
		lineEnd += header.body
	}
	openRel := strings.IndexByte(text[header.body:lineEnd], '{')
	if openRel < 0 {
		return byteNode{}, false
	}
	openBrace := header.body + openRel
	title := strings.TrimSpace(text[header.body:openBrace])
	if title == "" {
		return byteNode{}, false
	}
	to := -1
	shape := "inline"
	if close := findClose(text[:lineEnd], openBrace, '}'); close >= 0 {
		to = close + 1
	} else if close := findBlockBrace(text, openBrace+1); close >= 0 {
		to = close + 1
		shape = "block"
	}
	if to < 0 {
		return byteNode{}, false
	}
	attrsRaw := text[openBrace:to]
	attrs := parseAttrs(attrsRaw)
	lineStart := lineStarts[lineForByte(lineStarts, from)-1]
	return byteNode{
		node: Node{
			Kind: header.kind, Status: header.status, Title: title,
			Attrs: attrs.values, AttrsRaw: attrsRaw, Shape: shape,
			Diagnostics: diagnoseAttrs(attrs),
		},
		from: from, to: to, lineStart: lineStart, attrOrder: attrs.order,
	}, true
}

func parseBareTodo(text string, from int, header commandHeader, lineStarts []int) (byteNode, bool) {
	lineEnd := strings.IndexByte(text[header.body:], '\n')
	if lineEnd < 0 {
		lineEnd = len(text)
	} else {
		lineEnd += header.body
	}
	bodyTo, to := lineEnd, lineEnd
	attrsRaw := ""
	if metaFrom, attrsFrom, ok := trailingInlineAttrs(text, header.body, lineEnd); ok {
		attrsTo := attrsFrom + len(strings.TrimRight(text[attrsFrom:lineEnd], " \t"))
		attrsRaw = text[attrsFrom:attrsTo]
		bodyTo = metaFrom
	}
	title := strings.TrimSpace(text[header.body:bodyTo])
	if title == "" || strings.HasPrefix(title, "[") {
		return byteNode{}, false
	}
	attrs := parseAttrs(attrsRaw)
	lineStart := lineStarts[lineForByte(lineStarts, from)-1]
	return byteNode{
		node: Node{
			Kind: header.kind, Status: header.status, Title: title,
			Attrs: attrs.values, AttrsRaw: attrsRaw, Shape: "inline",
			Diagnostics: diagnoseAttrs(attrs),
		},
		from: from, to: to, lineStart: lineStart, attrOrder: attrs.order,
	}, true
}

func trailingInlineAttrs(text string, bodyFrom, lineEnd int) (metaFrom, attrsFrom int, ok bool) {
	line := text[bodyFrom:lineEnd]
	trimmedEnd := len(strings.TrimRight(line, " \t"))
	if trimmedEnd == 0 || line[trimmedEnd-1] != '}' {
		return 0, 0, false
	}
	open := strings.LastIndexByte(line[:trimmedEnd], '{')
	if open <= 0 || strings.ContainsAny(line[open+1:trimmedEnd-1], "{}\n") {
		return 0, 0, false
	}
	if line[open-1] != ' ' && line[open-1] != '\t' {
		return 0, 0, false
	}
	attrsFrom = bodyFrom + open
	for open > 0 && (line[open-1] == ' ' || line[open-1] == '\t') {
		open--
	}
	return bodyFrom + open, attrsFrom, true
}

func findClose(text string, open int, closeChar byte) int {
	if open < 0 || open >= len(text) {
		return -1
	}
	openChar := text[open]
	nestedDepth := 0
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
		if closeChar == '}' && (ch == '"' || ch == '\'') {
			quote = ch
			continue
		}
		if closeChar == ']' && ch == '\\' && i+1 < len(text) && (text[i+1] == '(' || text[i+1] == '[') {
			mathClose := "\\)"
			if text[i+1] == '[' {
				mathClose = "\\]"
			}
			start := i + 2
			if rel := strings.Index(text[start:], mathClose); rel >= 0 {
				found := start + rel
				if !strings.ContainsAny(text[start:found], "\r\n") {
					i = found + len(mathClose) - 1
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
			nestedDepth++
			continue
		}
		if ch == closeChar {
			if nestedDepth > 0 {
				nestedDepth--
				continue
			}
			return i
		}
	}
	return -1
}

func findBlockBrace(text string, from int) int {
	for pos := from; pos < len(text); {
		rel := strings.IndexByte(text[pos:], '\n')
		if rel < 0 {
			return -1
		}
		line := pos + rel + 1
		end := line
		for end < len(text) && (text[end] == ' ' || text[end] == '\t') {
			end++
		}
		if end < len(text) && text[end] == '}' {
			return end
		}
		pos = line
	}
	return -1
}

type parsedAttrs struct {
	values map[string]string
	order  []string
}

func parseAttrs(raw string) parsedAttrs {
	if raw == "" {
		return parsedAttrs{values: map[string]string{}}
	}
	if strings.Contains(raw, "\n") {
		return parseBlockAttrs(strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(raw), "{"), "}"))
	}
	return parseInlineAttrs(raw)
}

func parseBlockAttrs(body string) parsedAttrs {
	ret := parsedAttrs{values: map[string]string{}}
	for _, line := range strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "//") {
			continue
		}
		key, value, ok := splitPair(trimmed)
		if !ok {
			continue
		}
		value = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(value), ","))
		value = trimMatchingOuterQuote(value)
		putAttr(&ret, key, value)
	}
	return ret
}

func parseInlineAttrs(raw string) parsedAttrs {
	body := strings.TrimSpace(raw)
	body = strings.TrimPrefix(body, "{")
	body = strings.TrimSuffix(body, "}")
	body = strings.TrimSpace(body)
	ret := parsedAttrs{values: map[string]string{}}
	if body == "" {
		return ret
	}
	for _, chunk := range splitArgChunks(body) {
		item := strings.TrimSpace(chunk)
		if item == "" {
			continue
		}
		if isIdentifier(item) {
			putAttr(&ret, item, strings.ToLower(item))
			continue
		}
		matched := false
		for pos := 0; pos < len(item); {
			for pos < len(item) && (item[pos] == ' ' || item[pos] == '\t') {
				pos++
			}
			keyFrom := pos
			if pos >= len(item) || !isASCIIAlpha(item[pos]) {
				break
			}
			pos++
			for pos < len(item) && isIdentifierByte(item[pos]) {
				pos++
			}
			key := item[keyFrom:pos]
			for pos < len(item) && (item[pos] == ' ' || item[pos] == '\t') {
				pos++
			}
			if pos >= len(item) || (item[pos] != ':' && item[pos] != '=') {
				break
			}
			pos++
			for pos < len(item) && (item[pos] == ' ' || item[pos] == '\t') {
				pos++
			}
			valueFrom := pos
			if pos < len(item) && (item[pos] == '"' || item[pos] == '\'') {
				quote := item[pos]
				pos++
				for pos < len(item) && item[pos] != quote {
					pos++
				}
				if pos < len(item) {
					pos++
				}
			} else {
				pos = nextAssignment(item, pos)
			}
			value := trimMatchingOuterQuote(strings.TrimSpace(item[valueFrom:pos]))
			if key != "" && value != "" {
				putAttr(&ret, key, value)
			}
			matched = true
		}
		if !matched {
			if key, value, ok := splitPair(item); ok {
				value = trimMatchingOuterQuote(strings.TrimSpace(value))
				if value != "" {
					putAttr(&ret, key, value)
				}
			}
		}
	}
	return ret
}

func splitArgChunks(body string) []string {
	var chunks []string
	start := 0
	quote := byte(0)
	escaped, nesting := false, 0
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
		if ch == '"' || ch == '\'' {
			quote = ch
			continue
		}
		if ch == '{' {
			nesting++
		} else if ch == '}' && nesting > 0 {
			nesting--
		}
		if nesting != 0 {
			continue
		}
		if ch == ';' || (ch == ',' && commaSeparates(body[start:i], body[i+1:])) {
			chunks = append(chunks, body[start:i])
			start = i + 1
		}
	}
	return append(chunks, body[start:])
}

func commaSeparates(current, next string) bool {
	return !containsAssignment(current) || startsAssignment(next)
}

func containsAssignment(text string) bool {
	for i := 0; i < len(text); i++ {
		if !isASCIIAlpha(text[i]) {
			continue
		}
		j := i + 1
		for j < len(text) && isIdentifierByte(text[j]) {
			j++
		}
		for j < len(text) && (text[j] == ' ' || text[j] == '\t') {
			j++
		}
		if j < len(text) && (text[j] == ':' || text[j] == '=') {
			return true
		}
	}
	return false
}

func startsAssignment(text string) bool {
	text = strings.TrimLeft(text, " \t")
	if text == "" || !isASCIIAlpha(text[0]) {
		return false
	}
	pos := 1
	for pos < len(text) && isIdentifierByte(text[pos]) {
		pos++
	}
	for pos < len(text) && (text[pos] == ' ' || text[pos] == '\t') {
		pos++
	}
	return pos < len(text) && (text[pos] == ':' || text[pos] == '=')
}

func nextAssignment(text string, from int) int {
	for i := from; i < len(text); i++ {
		if text[i] != ' ' && text[i] != '\t' {
			continue
		}
		j := i
		for j < len(text) && (text[j] == ' ' || text[j] == '\t') {
			j++
		}
		if j >= len(text) || !isASCIIAlpha(text[j]) {
			continue
		}
		j++
		for j < len(text) && isIdentifierByte(text[j]) {
			j++
		}
		for j < len(text) && (text[j] == ' ' || text[j] == '\t') {
			j++
		}
		if j < len(text) && (text[j] == ':' || text[j] == '=') {
			return i
		}
	}
	return len(text)
}

func splitPair(text string) (string, string, bool) {
	text = strings.TrimSpace(text)
	if text == "" || !isASCIIAlpha(text[0]) {
		return "", "", false
	}
	pos := 1
	for pos < len(text) && isIdentifierByte(text[pos]) {
		pos++
	}
	key := text[:pos]
	for pos < len(text) && (text[pos] == ' ' || text[pos] == '\t') {
		pos++
	}
	if pos >= len(text) || (text[pos] != ':' && text[pos] != '=') {
		return "", "", false
	}
	return strings.ToLower(key), text[pos+1:], true
}

func putAttr(ret *parsedAttrs, key, value string) {
	key = strings.ToLower(strings.TrimSpace(key))
	if key == "" || value == "" {
		return
	}
	if _, exists := ret.values[key]; !exists {
		ret.order = append(ret.order, key)
	}
	ret.values[key] = value
}

func diagnoseAttrs(attrs parsedAttrs) []Diagnostic {
	ret := []Diagnostic{}
	for _, key := range attrs.order {
		value := strings.TrimSpace(attrs.values[key])
		if value == "" {
			continue
		}
		switch {
		case dateValueKeys[key] && !validDate(value):
			ret = append(ret, Diagnostic{Kind: "invalid-date", Key: key, Message: `Unparseable date in "` + key + `": ` + value})
		case (key == "repeat" || key == "rep" || key == "every") && !repeaterPattern.MatchString(value):
			ret = append(ret, Diagnostic{Kind: "invalid-repeater", Key: key, Message: `Unparseable repeater in "` + key + `": ` + value})
		case (key == "warn" || key == "lead") && !leadPattern.MatchString(value):
			ret = append(ret, Diagnostic{Kind: "invalid-lead-time", Key: key, Message: `Unparseable lead time in "` + key + `": ` + value})
		case key == "effort" && !(durationPattern.MatchString(value) || durationHM.MatchString(value)):
			ret = append(ret, Diagnostic{Kind: "invalid-duration", Key: key, Message: `Unparseable duration in "` + key + `": ` + value})
		case (key == "after" || key == "dep" || key == "blocks" || key == "task") && !hasDependency(value):
			ret = append(ret, Diagnostic{Kind: "invalid-dep-ref", Key: key, Message: `Empty dependency reference in "` + key + `"`})
		case !knownAttrKeys[key]:
			ret = append(ret, Diagnostic{Kind: "unknown-key", Key: key, Message: `Unrecognized planning key "` + key + `"`})
		}
	}
	return ret
}

func validDate(value string) bool {
	lower := strings.ToLower(strings.TrimSpace(value))
	if lower == "today" || lower == "tomorrow" || lower == "yesterday" || lower == "now" ||
		lower == "今天" || lower == "明天" || lower == "昨天" || relativeDatePattern.MatchString(lower) {
		return true
	}
	norm := strings.NewReplacer("年", "-", "月", "-", "日", "", "号", "", ".", "-", "/", "-").Replace(strings.TrimSpace(value))
	if yearDatePattern.MatchString(norm) || isoDatePattern.MatchString(norm) {
		return true
	}
	if shortDatePattern.MatchString(norm) {
		parts := strings.FieldsFunc(norm, func(r rune) bool { return r == '-' || r == ' ' || r == 'T' || r == ':' })
		return len(parts) >= 2 && numberInRange(parts[0], 1, 12) && numberInRange(parts[1], 1, 31)
	}
	// JavaScript Date.parse also accepts these stable, locale-independent forms.
	return monthNamePattern.MatchString(value)
}

func numberInRange(raw string, min, max int) bool {
	n := 0
	if raw == "" {
		return false
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] < '0' || raw[i] > '9' {
			return false
		}
		n = n*10 + int(raw[i]-'0')
	}
	return n >= min && n <= max
}

func hasDependency(value string) bool {
	for _, part := range strings.Split(value, "&") {
		if strings.TrimSpace(part) != "" {
			return true
		}
	}
	return false
}

func trimMatchingOuterQuote(value string) string {
	if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
		quote := string(value[0])
		return strings.ReplaceAll(value[1:len(value)-1], "\\"+quote, quote)
	}
	return value
}

func unescapeBracketTitle(title string) string {
	var ret strings.Builder
	for i := 0; i < len(title); i++ {
		if title[i] == '\\' && i+1 < len(title) && (title[i+1] == ']' || title[i+1] == '\\') {
			i++
		}
		ret.WriteByte(title[i])
	}
	return ret.String()
}

func kindMatches(kind, wanted string) bool {
	if wanted == "" {
		return true
	}
	if wanted == "todo" {
		return kind == "todo" || kind == "itodo"
	}
	return kind == wanted
}

func byteLineStarts(text string) []int {
	ret := []int{0}
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			ret = append(ret, i+1)
		}
	}
	return ret
}

func lineForByte(starts []int, index int) int {
	pos := sort.Search(len(starts), func(i int) bool { return starts[i] > index })
	if pos < 1 {
		return 1
	}
	return pos
}

func utf16Length(text string) int {
	if text == "" {
		return 0
	}
	count := 0
	for len(text) > 0 {
		r, size := utf8.DecodeRuneInString(text)
		text = text[size:]
		if r == utf8.RuneError && size == 1 {
			count++
			continue
		}
		count += len(utf16.Encode([]rune{r}))
	}
	return count
}

func isASCIIAlpha(ch byte) bool {
	return ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z'
}

func isIdentifierByte(ch byte) bool {
	return isASCIIAlpha(ch) || ch >= '0' && ch <= '9' || ch == '_' || ch == '-'
}

func isIdentifier(text string) bool {
	if text == "" || !isASCIIAlpha(text[0]) {
		return false
	}
	for i := 1; i < len(text); i++ {
		if !isIdentifierByte(text[i]) {
			return false
		}
	}
	return true
}
