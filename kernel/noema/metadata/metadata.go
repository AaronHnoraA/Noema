// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package metadata owns the small, source-authoritative Noema meta-block
// mutation grammar. It deliberately scans source lines instead of parsing the
// document through Lute: metadata edits must preserve unrelated Markdown and
// extension fields byte-for-byte.
package metadata

import (
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	ActionAdd          = "add"
	ActionRemove       = "remove"
	ActionTag          = "tag"
	ActionHideRoam     = "hide-roam"
	ActionActivateRoam = "activate-roam"
)

var (
	orgBeginPattern = regexp.MustCompile(`(?i)^[ \t]*#\+begin(?:_|[ \t]+)([a-z0-9_-]+)(?:[ \t].*)?$`)
	orgEndPattern   = regexp.MustCompile(`(?i)^[ \t]*#\+end(?:_|[ \t]+)([a-z0-9_-]+)[ \t]*$`)
	fieldPattern    = regexp.MustCompile(`^([ \t]*)([A-Za-z0-9_-]+)([ \t]*):[ \t]*(.*)$`)
	listItemPattern = regexp.MustCompile(`^[ \t]*-[ \t]*(.+?)[ \t]*$`)
	headingPattern  = regexp.MustCompile(`^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$`)
	fencePattern    = regexp.MustCompile("^[ \\t]{0,3}(`{3,}|~{3,})")
	validKind       = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)
)

type Request struct {
	Action  string
	Title   *string
	Tags    *[]string
	Kind    *string
	Project *string
}

type Options struct {
	Today string
	NewID func() (string, error)
}

type Result struct {
	Markdown string
	Changed  bool
	ID       string
	Title    string
	Tags     []string
	Kind     string
}

type sourceLine struct {
	start int
	body  int
	end   int
	text  string
	eol   string
}

type metaBlock struct {
	start        int
	contentStart int
	closeStart   int
	end          int
}

type metaField struct {
	key       string
	indent    string
	start     int
	end       int
	value     string
	list      []string
	listStyle bool
}

func linesOf(source string) []sourceLine {
	lines := []sourceLine{}
	for start := 0; start < len(source); {
		body := strings.IndexByte(source[start:], '\n')
		if body < 0 {
			lines = append(lines, sourceLine{start: start, body: len(source), end: len(source), text: source[start:]})
			break
		}
		body += start
		textEnd, eol := body, "\n"
		if textEnd > start && source[textEnd-1] == '\r' {
			textEnd--
			eol = "\r\n"
		}
		lines = append(lines, sourceLine{start: start, body: textEnd, end: body + 1, text: source[start:textEnd], eol: eol})
		start = body + 1
	}
	if len(source) == 0 {
		return []sourceLine{}
	}
	return lines
}

func fenceRun(line string) (marker byte, length int, ok bool) {
	match := fencePattern.FindStringSubmatch(line)
	if len(match) < 2 {
		return 0, 0, false
	}
	return match[1][0], len(match[1]), true
}

func closesFence(line string, marker byte, length int) bool {
	trimmed := strings.TrimLeft(line, " \t")
	if len(trimmed) < length || trimmed[0] != marker {
		return false
	}
	run := 0
	for run < len(trimmed) && trimmed[run] == marker {
		run++
	}
	return run >= length && strings.TrimSpace(trimmed[run:]) == ""
}

func orgName(pattern *regexp.Regexp, line string) string {
	match := pattern.FindStringSubmatch(line)
	if len(match) < 2 {
		return ""
	}
	return strings.ToLower(match[1])
}

func scanMetaBlocks(source string) ([]metaBlock, error) {
	lines := linesOf(source)
	stack := []string{}
	fenceMarker, fenceLength := byte(0), 0
	block := metaBlock{}
	activeMeta := false
	blocks := []metaBlock{}
	for _, line := range lines {
		if fenceMarker != 0 {
			if closesFence(line.text, fenceMarker, fenceLength) {
				fenceMarker, fenceLength = 0, 0
			}
			continue
		}
		if marker, length, ok := fenceRun(line.text); ok {
			fenceMarker, fenceLength = marker, length
			continue
		}
		if name := orgName(orgBeginPattern, line.text); name != "" {
			if len(stack) == 0 && name == "meta" {
				block = metaBlock{start: line.start, contentStart: line.end}
				activeMeta = true
			}
			stack = append(stack, name)
			continue
		}
		if name := orgName(orgEndPattern, line.text); name != "" && len(stack) > 0 && stack[len(stack)-1] == name {
			if len(stack) == 1 && name == "meta" && activeMeta {
				block.closeStart = line.start
				block.end = line.end
				blocks = append(blocks, block)
				activeMeta = false
			}
			stack = stack[:len(stack)-1]
		}
	}
	if activeMeta {
		return nil, fmt.Errorf("unterminated metadata block")
	}
	if len(blocks) > 1 {
		return nil, fmt.Errorf("multiple metadata blocks are ambiguous")
	}
	return blocks, nil
}

func findMetaBlock(source string) (metaBlock, bool) {
	blocks, err := scanMetaBlocks(source)
	if err != nil || len(blocks) != 1 {
		return metaBlock{}, false
	}
	return blocks[0], true
}

func unquote(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && (value[0] == '"' && value[len(value)-1] == '"' || value[0] == '\'' && value[len(value)-1] == '\'') {
		value = value[1 : len(value)-1]
	}
	return strings.ReplaceAll(value, `\_`, "_")
}

func parseList(value string, splitSpaces bool) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return []string{}
	}
	if strings.HasPrefix(value, "(") {
		quoted := regexp.MustCompile(`"((?:[^"\\]|\\.)*)"`).FindAllStringSubmatch(value, -1)
		ret := make([]string, 0, len(quoted))
		for _, match := range quoted {
			ret = append(ret, strings.ReplaceAll(strings.ReplaceAll(match[1], `\\"`, `"`), `\\\\`, `\\`))
		}
		return ret
	}
	separator := func(r rune) bool { return r == ',' || r == '\n' || splitSpaces && (r == ' ' || r == '\t') }
	return strings.FieldsFunc(value, separator)
}

func fieldsIn(source string, block metaBlock) map[string]metaField {
	ret := map[string]metaField{}
	lines := linesOf(source)
	depth := 0
	fenceMarker, fenceLength := byte(0), 0
	for index := 0; index < len(lines); index++ {
		line := lines[index]
		if line.start < block.contentStart || line.start >= block.closeStart {
			continue
		}
		if fenceMarker != 0 {
			if closesFence(line.text, fenceMarker, fenceLength) {
				fenceMarker, fenceLength = 0, 0
			}
			continue
		}
		if marker, length, ok := fenceRun(line.text); ok {
			fenceMarker, fenceLength = marker, length
			continue
		}
		if name := orgName(orgBeginPattern, line.text); name != "" {
			depth++
			continue
		}
		if name := orgName(orgEndPattern, line.text); name != "" && depth > 0 {
			depth--
			continue
		}
		if depth != 0 {
			continue
		}
		match := fieldPattern.FindStringSubmatch(line.text)
		if len(match) < 5 {
			continue
		}
		key := strings.ToLower(match[2])
		field := metaField{key: key, indent: match[1], start: line.start, end: line.end, value: unquote(match[4])}
		if strings.TrimSpace(match[4]) == "" {
			for next := index + 1; next < len(lines); next++ {
				candidate := lines[next]
				if candidate.start >= block.closeStart {
					break
				}
				item := listItemPattern.FindStringSubmatch(candidate.text)
				if len(item) < 2 {
					break
				}
				field.listStyle = true
				field.list = append(field.list, unquote(item[1]))
				field.end = candidate.end
				index = next
			}
		}
		ret[key] = field
	}
	return ret
}

func fieldValues(field metaField, splitSpaces bool) []string {
	if field.listStyle {
		return append([]string{}, field.list...)
	}
	return parseList(field.value, splitSpaces)
}

func normalizeTags(values []string) []string {
	byKey := map[string]string{}
	for _, value := range values {
		clean := strings.NewReplacer("\r", " ", "\n", " ").Replace(value)
		clean = strings.TrimPrefix(strings.TrimSpace(clean), "#")
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

func sameStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func newlineFor(source string) string {
	if strings.Contains(source, "\r\n") {
		return "\r\n"
	}
	return "\n"
}

func normalizeKind(value string) string {
	kind := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), `\_`, "_"))
	if kind == "" || kind == "note" || kind == "default" || !validKind.MatchString(kind) {
		return "default"
	}
	return kind
}

func sourceTitle(source, fileName string) string {
	meta, hasMeta := findMetaBlock(source)
	fenceMarker, fenceLength := byte(0), 0
	for _, line := range linesOf(source) {
		if hasMeta && line.start >= meta.start && line.start < meta.end {
			continue
		}
		if fenceMarker != 0 {
			if closesFence(line.text, fenceMarker, fenceLength) {
				fenceMarker, fenceLength = 0, 0
			}
			continue
		}
		if marker, length, ok := fenceRun(line.text); ok {
			fenceMarker, fenceLength = marker, length
			continue
		}
		if match := headingPattern.FindStringSubmatch(line.text); len(match) > 1 && strings.TrimSpace(match[1]) != "" {
			return strings.TrimSpace(match[1])
		}
	}
	name := filepath.Base(fileName)
	name = strings.TrimSuffix(name, filepath.Ext(name))
	if strings.TrimSpace(name) == "" {
		return "Untitled"
	}
	return name
}

func scalar(fields map[string]metaField, key string) string {
	return fields[key].value
}

func setScalar(source, key, value string, remove bool) string {
	block, ok := findMetaBlock(source)
	if !ok {
		return source
	}
	fields := fieldsIn(source, block)
	field, exists := fields[key]
	if remove {
		if !exists {
			return source
		}
		return source[:field.start] + source[field.end:]
	}
	value = strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ").Replace(value))
	if exists && field.value == value && !field.listStyle {
		return source
	}
	eol := newlineFor(source)
	rendered := key + ": " + value + eol
	if exists {
		rendered = field.indent + key + ": " + value + eol
		return source[:field.start] + rendered + source[field.end:]
	}
	return source[:block.closeStart] + rendered + source[block.closeStart:]
}

func setList(source, key string, values []string) string {
	block, ok := findMetaBlock(source)
	if !ok {
		return source
	}
	fields := fieldsIn(source, block)
	field, exists := fields[key]
	values = normalizeTags(values)
	if exists && sameStrings(normalizeTags(fieldValues(field, key != "aliases")), values) {
		return source
	}
	eol := newlineFor(source)
	rendered := key + ": " + strings.Join(values, ", ") + eol
	if exists {
		if field.listStyle {
			var builder strings.Builder
			builder.WriteString(field.indent + key + ":" + eol)
			for _, value := range values {
				builder.WriteString(field.indent + "  - " + value + eol)
			}
			rendered = builder.String()
		} else {
			rendered = field.indent + key + ": " + strings.Join(values, ", ") + eol
		}
		return source[:field.start] + rendered + source[field.end:]
	}
	return source[:block.closeStart] + rendered + source[block.closeStart:]
}

func initialBlock(source, fileName string, request Request, options Options) (string, error) {
	today := strings.TrimSpace(options.Today)
	if today == "" {
		return "", fmt.Errorf("metadata date is required")
	}
	title := sourceTitle(source, fileName)
	if request.Title != nil && strings.TrimSpace(*request.Title) != "" {
		title = strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ").Replace(*request.Title))
	}
	kind := "default"
	if request.Kind != nil {
		kind = normalizeKind(*request.Kind)
	}
	tags := []string{}
	if request.Tags != nil {
		tags = normalizeTags(*request.Tags)
	}
	id := ""
	if request.Action != ActionHideRoam {
		if options.NewID == nil {
			return "", fmt.Errorf("metadata UUIDv7 allocator is required")
		}
		var err error
		if id, err = options.NewID(); err != nil {
			return "", err
		}
	}
	eol := newlineFor(source)
	lines := []string{"#+begin meta"}
	if id != "" {
		lines = append(lines, "id: "+id)
	}
	lines = append(lines, "title: "+title, "date: "+today, "kind: "+kind)
	if request.Action == ActionHideRoam {
		lines = append(lines, "roam: off")
	}
	if request.Project != nil && strings.TrimSpace(*request.Project) != "" {
		lines = append(lines, "project: "+strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(*request.Project), "\r", " "), "\n", " "))
	}
	lines = append(lines, "tags: "+strings.Join(tags, ", "), "refs:", "#+end meta", "")
	body := strings.TrimLeft(source, " \t\r\n")
	return strings.Join(lines, eol) + eol + body, nil
}

// Patch applies one facade-level metadata intent. Existing blocks are edited
// field-by-field so comments, summary bodies, extension fields, line endings,
// and the rest of the document remain byte-stable.
func Patch(source, fileName string, request Request, options Options) (Result, error) {
	original := source
	action := strings.ToLower(strings.TrimSpace(request.Action))
	switch action {
	case ActionAdd, ActionRemove, ActionTag, ActionHideRoam, ActionActivateRoam:
	default:
		return Result{}, fmt.Errorf("unsupported metadata action [%s]", request.Action)
	}
	request.Action = action
	blocks, err := scanMetaBlocks(source)
	if err != nil {
		return Result{}, err
	}
	block, exists := metaBlock{}, len(blocks) == 1
	if exists {
		block = blocks[0]
	}
	if action == ActionRemove {
		if !exists {
			return Result{Markdown: source, Changed: false}, nil
		}
		next := source[:block.start] + source[block.end:]
		next = strings.TrimLeft(next, " \t\r\n")
		return Result{Markdown: next, Changed: next != source}, nil
	}
	if !exists {
		next, err := initialBlock(source, fileName, request, options)
		if err != nil {
			return Result{}, err
		}
		fields := fieldsIn(next, mustMetaBlock(next))
		return resultFor(source, next, fields), nil
	}

	fields := fieldsIn(source, block)
	id := scalar(fields, "id")
	roamOff := strings.EqualFold(strings.TrimSpace(scalar(fields, "roam")), "off") && action != ActionActivateRoam
	if id == "" && !roamOff && action != ActionHideRoam {
		if options.NewID == nil {
			return Result{}, fmt.Errorf("metadata UUIDv7 allocator is required")
		}
		allocated, err := options.NewID()
		if err != nil {
			return Result{}, err
		}
		source = setScalar(source, "id", allocated, false)
	}

	title := scalar(fields, "title")
	if request.Title != nil && strings.TrimSpace(*request.Title) != "" {
		title = strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ").Replace(*request.Title))
	}
	if strings.TrimSpace(title) == "" {
		title = sourceTitle(source, fileName)
	}
	source = setScalar(source, "title", title, false)

	date := scalar(fields, "date")
	if strings.TrimSpace(date) == "" {
		date = strings.TrimSpace(options.Today)
		if date == "" {
			return Result{}, fmt.Errorf("metadata date is required")
		}
	}
	source = setScalar(source, "date", date, false)

	kind := scalar(fields, "kind")
	if request.Kind != nil {
		kind = *request.Kind
	}
	if strings.TrimSpace(kind) == "" || request.Kind != nil {
		kind = normalizeKind(kind)
	}
	source = setScalar(source, "kind", kind, false)

	fields = fieldsIn(source, mustMetaBlock(source))
	currentTags := normalizeTags(fieldValues(fields["tags"], true))
	desiredTags := currentTags
	if action == ActionTag {
		if request.Tags != nil {
			desiredTags = normalizeTags(append(append([]string{}, currentTags...), (*request.Tags)...))
		}
	} else if action == ActionAdd && request.Tags != nil {
		desiredTags = normalizeTags(*request.Tags)
	}
	source = setList(source, "tags", desiredTags)
	fields = fieldsIn(source, mustMetaBlock(source))
	if _, ok := fields["refs"]; !ok {
		source = setList(source, "refs", []string{})
	}

	if request.Project != nil {
		project := strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(*request.Project), "\r", " "), "\n", " ")
		source = setScalar(source, "project", project, project == "")
	}
	if action == ActionHideRoam {
		source = setScalar(source, "roam", "off", false)
	} else if action == ActionActivateRoam {
		source = setScalar(source, "roam", "", true)
	}
	return resultFor(original, source, fieldsIn(source, mustMetaBlock(source))), nil
}

func mustMetaBlock(source string) metaBlock {
	block, _ := findMetaBlock(source)
	return block
}

func resultFor(original, next string, fields map[string]metaField) Result {
	return Result{
		Markdown: next,
		Changed:  next != original,
		ID:       scalar(fields, "id"),
		Title:    scalar(fields, "title"),
		Tags:     normalizeTags(fieldValues(fields["tags"], true)),
		Kind:     normalizeKind(scalar(fields, "kind")),
	}
}
