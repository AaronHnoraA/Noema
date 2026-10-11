// Noema Wiki search is Copyright (c) 2026 Aaron He and distributed under the
// AGPL-3.0-or-later terms of the Noema kernel.

package wikisearch

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

type nodeKind int

const (
	kindAnd nodeKind = iota
	kindOr
	kindNot
	kindTerm   // one word of free text; matches by prefix
	kindPhrase // quoted text; matches whole
	kindRegex  // /pattern/ over a page's text
	kindField  // field:value
	kindLine   // line:(a b): the words on one line
)

type node struct {
	kind     nodeKind
	field    string
	value    string // folded for comparison
	raw      string // as typed
	pattern  *regexp.Regexp
	children []*node
}

// Query is a parsed search.
type Query struct {
	Source string
	root   *node
	// Namespace and Partition come from a leading "Namespace:" or
	// "public/Namespace:" that names a real namespace.  All is a leading
	// "all:", which lifts any scope the caller would apply.
	Namespace string
	Partition string
	All       bool
	Problems  []string
}

var fieldAliases = map[string]string{
	"intitle": "title", "category": "tag", "repository": "repo", "ns": "namespace",
	"since": "after", "until": "before", "body": "content", "filename": "file",
}

var knownFields = map[string]bool{
	"title": true, "alias": true, "tag": true, "repo": true, "namespace": true, "path": true,
	"file": true, "content": true, "kind": true, "is": true, "linksto": true,
	"after": true, "before": true, "created": true, "line": true,
}

const maxQueryRunes = 512

type lexer struct {
	runes []rune
	at    int
}

func (l *lexer) skipSpace() {
	for l.at < len(l.runes) && unicode.IsSpace(l.runes[l.at]) {
		l.at++
	}
}

func (l *lexer) peek() rune {
	if l.at < len(l.runes) {
		return l.runes[l.at]
	}
	return 0
}

// quoted reads a "..." string whose opening quote is at l.at; \" is a quote.
func (l *lexer) quoted() string {
	var out []rune
	for l.at++; l.at < len(l.runes); l.at++ {
		r := l.runes[l.at]
		if r == '\\' && l.at+1 < len(l.runes) && l.runes[l.at+1] == '"' {
			out = append(out, '"')
			l.at++
			continue
		}
		if r == '"' {
			l.at++
			break
		}
		out = append(out, r)
	}
	return string(out)
}

// bare reads up to the next space or closing parenthesis.
func (l *lexer) bare() string {
	start := l.at
	for l.at < len(l.runes) && !unicode.IsSpace(l.runes[l.at]) && l.runes[l.at] != ')' {
		if l.runes[l.at] == '"' {
			break
		}
		// "field:(" opens a group that belongs to the field.
		if l.runes[l.at] == '(' && l.at > start && l.runes[l.at-1] == ':' {
			break
		}
		l.at++
	}
	return string(l.runes[start:l.at])
}

// NamespaceResolver names the namespace and partition a typed prefix means,
// if it means one.
type NamespaceResolver func(prefix string) (namespace, partition string, ok bool)

// Parse reads a query.  Words are joined by AND; OR, parentheses and a
// leading "-" work as in Obsidian's search.  A leading "Namespace:" narrows
// the search only when resolve knows the name, as in MediaWiki; otherwise the
// colon is ordinary text.
func Parse(source string, resolve NamespaceResolver) *Query {
	text := strings.TrimSpace(norm.NFKC.String(source))
	if runes := []rune(text); len(runes) > maxQueryRunes {
		text = string(runes[:maxQueryRunes])
	}
	query := &Query{Source: text}
	rest := text
	if strings.HasPrefix(strings.ToLower(rest), "all:") {
		query.All = true
		rest = strings.TrimLeft(rest[4:], " ")
	} else if colon := strings.Index(rest, ":"); colon > 0 && resolve != nil {
		prefix := strings.TrimSpace(rest[:colon])
		field := strings.ToLower(prefix)
		if alias, ok := fieldAliases[field]; ok {
			field = alias
		}
		// A search field wins over a namespace of the same name.
		if !knownFields[field] && !strings.ContainsAny(prefix, "\"()") {
			if namespace, partition, ok := resolve(prefix); ok {
				query.Namespace, query.Partition = namespace, partition
				rest = strings.TrimLeft(rest[colon+1:], " ")
			}
		}
	}
	lex := &lexer{runes: []rune(rest)}
	query.root = query.parseOr(lex, 0)
	return query
}

func (q *Query) parseOr(l *lexer, depth int) *node {
	alternatives := []*node{q.parseAnd(l, depth)}
	for {
		l.skipSpace()
		if !isWord(l, "OR") {
			break
		}
		l.at += 2
		alternatives = append(alternatives, q.parseAnd(l, depth))
	}
	if len(alternatives) == 1 {
		return alternatives[0]
	}
	return &node{kind: kindOr, children: alternatives}
}

func isWord(l *lexer, word string) bool {
	end := l.at + len(word)
	if end > len(l.runes) || string(l.runes[l.at:end]) != word {
		return false
	}
	return end == len(l.runes) || unicode.IsSpace(l.runes[end])
}

func (q *Query) parseAnd(l *lexer, depth int) *node {
	var parts []*node
	for {
		l.skipSpace()
		if l.at >= len(l.runes) || isWord(l, "OR") {
			break
		}
		if l.peek() == ')' {
			if depth > 0 {
				break
			}
			l.at++ // a stray parenthesis is not worth failing a search over
			continue
		}
		if part := q.parseUnit(l, depth); part != nil {
			parts = append(parts, part)
		}
		if len(parts) >= 24 {
			q.Problems = append(q.Problems, "only the first 24 terms are searched")
			l.at = len(l.runes)
		}
	}
	if len(parts) == 1 {
		return parts[0]
	}
	return &node{kind: kindAnd, children: parts}
}

func (q *Query) parseUnit(l *lexer, depth int) *node {
	if l.peek() == '-' && l.at+1 < len(l.runes) && !unicode.IsSpace(l.runes[l.at+1]) {
		l.at++
		inner := q.parseUnit(l, depth)
		if inner == nil {
			return nil
		}
		return &node{kind: kindNot, children: []*node{inner}}
	}
	switch l.peek() {
	case '(':
		l.at++
		inner := q.parseOr(l, depth+1)
		l.skipSpace()
		if l.peek() == ')' {
			l.at++
		}
		return inner
	case '"':
		return textNode(l.quoted(), true)
	case '/':
		if pattern, ok := q.regex(l); ok {
			return pattern
		}
	case '#':
		if tag := l.bare(); len(tag) > 1 {
			return &node{kind: kindField, field: "tag", value: strings.ToLower(tag[1:]), raw: tag}
		}
		return nil
	case '[':
		// Obsidian's [property:value].  Noema indexes the fields below, not
		// arbitrary properties.
		start := l.at
		for l.at < len(l.runes) && l.runes[l.at] != ']' {
			l.at++
		}
		inside := string(l.runes[start+1 : l.at])
		if l.at < len(l.runes) {
			l.at++
		}
		name, value, _ := strings.Cut(inside, ":")
		if field, ok := canonicalField(name); ok {
			return q.fieldNode(field, strings.TrimSpace(value), "["+inside+"]")
		}
		q.Problems = append(q.Problems, fmt.Sprintf("property %q is not indexed; searched as text", strings.TrimSpace(name)))
		return textNode(inside, true)
	}
	word := l.bare()
	if word == "" {
		// A quote opening mid-word: read it as its own phrase.
		if l.peek() == '"' {
			return textNode(l.quoted(), true)
		}
		l.at++
		return nil
	}
	if colon := strings.Index(word, ":"); colon > 0 {
		if field, ok := canonicalField(word[:colon]); ok {
			value := word[colon+1:]
			raw := word
			if value == "" && l.peek() == '"' {
				value = l.quoted()
				raw += `"` + value + `"`
			} else if value == "" && l.peek() == '(' {
				start := l.at
				for l.at < len(l.runes) && l.runes[l.at] != ')' {
					l.at++
				}
				value = string(l.runes[start+1 : l.at])
				if l.at < len(l.runes) {
					l.at++
				}
				raw += "(" + value + ")"
			}
			return q.fieldNode(field, value, raw)
		}
	}
	return textNode(word, false)
}

func canonicalField(name string) (string, bool) {
	field := strings.ToLower(strings.TrimSpace(name))
	if alias, ok := fieldAliases[field]; ok {
		field = alias
	}
	return field, knownFields[field]
}

func textNode(text string, phrase bool) *node {
	value := strings.ToLower(strings.TrimSpace(text))
	if !phrase {
		value = strings.TrimSuffix(value, "*") // every word already matches by prefix
	}
	if value == "" {
		return nil
	}
	if phrase {
		return &node{kind: kindPhrase, value: value, raw: text}
	}
	return &node{kind: kindTerm, value: value, raw: text}
}

func (q *Query) fieldNode(field, value, raw string) *node {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if field == "line" {
		words := strings.Fields(strings.ToLower(value))
		return &node{kind: kindLine, field: field, value: strings.Join(words, " "), raw: raw}
	}
	if field == "tag" {
		value = strings.TrimPrefix(value, "#")
	}
	if strings.HasPrefix(value, "/") && strings.HasSuffix(value, "/") && len(value) > 2 && (field == "path" || field == "file" || field == "title" || field == "content") {
		pattern, err := regexp.Compile("(?i)" + value[1:len(value)-1])
		if err != nil {
			q.Problems = append(q.Problems, fmt.Sprintf("%s: %v", raw, err))
			return nil
		}
		return &node{kind: kindRegex, field: field, raw: raw, pattern: pattern}
	}
	return &node{kind: kindField, field: field, value: strings.ToLower(value), raw: raw}
}

func (q *Query) regex(l *lexer) (*node, bool) {
	end := -1
	for i := l.at + 1; i < len(l.runes); i++ {
		if l.runes[i] == '\\' {
			i++
			continue
		}
		if l.runes[i] == '/' && (i+1 == len(l.runes) || unicode.IsSpace(l.runes[i+1]) || l.runes[i+1] == ')') {
			end = i
			break
		}
	}
	if end <= l.at+1 {
		return nil, false
	}
	source := string(l.runes[l.at+1 : end])
	raw := string(l.runes[l.at : end+1])
	l.at = end + 1
	pattern, err := regexp.Compile("(?i)" + source)
	if err != nil {
		q.Problems = append(q.Problems, fmt.Sprintf("%s: %v", raw, err))
		return nil, true
	}
	return &node{kind: kindRegex, field: "content", raw: raw, pattern: pattern}, true
}

// textTerms are the words and phrases a page must contain: the free text of
// a query that is one conjunction.  plain is false once OR or a negated word
// is involved, when "the title the person typed" has no single meaning.
func (q *Query) textTerms() (terms []string, plain bool) {
	plain = true
	var walk func(*node, bool)
	walk = func(n *node, top bool) {
		if n == nil {
			return
		}
		switch n.kind {
		case kindAnd:
			for _, child := range n.children {
				walk(child, top)
			}
		case kindTerm, kindPhrase:
			if top {
				terms = append(terms, n.value)
			}
		case kindOr:
			plain = false
		case kindNot:
			if child := n.children[0]; child.kind == kindTerm || child.kind == kindPhrase {
				plain = false
			}
		}
	}
	walk(q.root, true)
	return terms, plain
}

// positiveWords are the words whose presence can be highlighted or ranked,
// wherever they stand in the query.
func (q *Query) positiveWords() []string {
	var words []string
	var walk func(*node)
	walk = func(n *node) {
		if n == nil {
			return
		}
		switch n.kind {
		case kindAnd, kindOr:
			for _, child := range n.children {
				walk(child)
			}
		case kindTerm, kindPhrase:
			words = append(words, n.value)
		case kindLine:
			words = append(words, strings.Fields(n.value)...)
		case kindField:
			if n.field == "content" || n.field == "title" {
				words = append(words, n.value)
			}
		}
	}
	walk(q.root)
	return words
}

// Explain says in plain words what the query asks for.
func (q *Query) Explain() []string {
	var lines []string
	if q.All {
		lines = append(lines, "in every namespace")
	}
	if q.Namespace != "" {
		scope := q.Namespace
		if q.Partition != "" {
			scope = q.Partition + "/" + scope
		}
		lines = append(lines, "in namespace "+scope)
	}
	if q.root != nil {
		if text := explainNode(q.root); text != "" {
			lines = append(lines, text)
		}
	}
	return append(lines, q.Problems...)
}

func explainNode(n *node) string {
	switch n.kind {
	case kindAnd, kindOr:
		joiner := " and "
		if n.kind == kindOr {
			joiner = " or "
		}
		parts := make([]string, 0, len(n.children))
		for _, child := range n.children {
			part := explainNode(child)
			if child.kind == kindAnd || child.kind == kindOr {
				part = "(" + part + ")"
			}
			parts = append(parts, part)
		}
		return strings.Join(parts, joiner)
	case kindNot:
		return "not " + explainNode(n.children[0])
	case kindTerm:
		return fmt.Sprintf("a word beginning %q", n.value)
	case kindPhrase:
		return fmt.Sprintf("the phrase %q", n.value)
	case kindRegex:
		return fmt.Sprintf("%s matching %s", n.field, strings.TrimPrefix(n.raw, n.field+":"))
	case kindLine:
		return fmt.Sprintf("one line with %q", n.value)
	}
	switch n.field {
	case "is":
		return "is " + n.value
	case "after", "before":
		return fmt.Sprintf("modified %s %s", n.field, n.value)
	case "created":
		return "dated " + n.value
	case "linksto":
		return "links to " + n.value
	}
	return fmt.Sprintf("%s contains %q", n.field, n.value)
}

// dateBound is the local start of the day a calendar date (2026, 2026-10,
// 2026-10-09) or an age (7d, 2w, 3m, 1y) names, in epoch milliseconds.
func dateBound(value string, now time.Time) (int64, bool) {
	text := strings.ToLower(strings.TrimSpace(value))
	if match := ageRe.FindStringSubmatch(text); match != nil {
		count, _ := strconv.Atoi(match[1])
		start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		switch match[2] {
		case "d":
			start = start.AddDate(0, 0, -count)
		case "w":
			start = start.AddDate(0, 0, -7*count)
		case "m":
			start = start.AddDate(0, -count, 0)
		default:
			start = start.AddDate(-count, 0, 0)
		}
		return start.UnixMilli(), true
	}
	match := dateRe.FindStringSubmatch(text)
	if match == nil {
		return 0, false
	}
	year, _ := strconv.Atoi(match[1])
	month, day := 1, 1
	if match[2] != "" {
		month, _ = strconv.Atoi(match[2])
	}
	if match[3] != "" {
		day, _ = strconv.Atoi(match[3])
	}
	if month < 1 || month > 12 || day < 1 || day > 31 {
		return 0, false
	}
	bound := time.Date(year, time.Month(month), day, 0, 0, 0, 0, now.Location())
	if int(bound.Month()) != month {
		return 0, false
	}
	return bound.UnixMilli(), true
}

// datePeriod is the period a `created:` value names: [from, to), to zero for
// an age, which has no end.
func datePeriod(value string, now time.Time) (from, to int64, ok bool) {
	from, ok = dateBound(value, now)
	if !ok {
		return 0, 0, false
	}
	match := dateRe.FindStringSubmatch(strings.ToLower(strings.TrimSpace(value)))
	if match == nil {
		return from, 0, true
	}
	end := time.UnixMilli(from).In(now.Location())
	switch {
	case match[3] != "":
		end = end.AddDate(0, 0, 1)
	case match[2] != "":
		end = end.AddDate(0, 1, 0)
	default:
		end = end.AddDate(1, 0, 0)
	}
	return from, end.UnixMilli(), true
}

var (
	ageRe  = regexp.MustCompile(`^(\d{1,4})([dwmy])$`)
	dateRe = regexp.MustCompile(`^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$`)
)
