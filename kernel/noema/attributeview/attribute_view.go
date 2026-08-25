package attributeview

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var (
	keyPattern    = regexp.MustCompile(`(?i)^[a-z][a-z0-9_-]*$`)
	filterPattern = regexp.MustCompile(`(?i)^([a-z][a-z0-9_-]*)\s+(not-empty|contains|empty|in|!=|=)(?:\s+(.*))?$`)
	sortPattern   = regexp.MustCompile(`(?i)^([a-z][a-z0-9_-]*)(?:\s+(asc|desc))?$`)
	identityTail  = regexp.MustCompile(`(?i)\s*\{#[0-9a-f-]{36}(?:\s+[^{}\r\n]*)?\}\s*$`)
)

var defaultColumns = []string{"text", "status", "project", "file"}

type Item struct {
	ID        string            `json:"id"`
	Kind      string            `json:"kind"`
	Status    string            `json:"status"`
	Text      string            `json:"text"`
	Title     string            `json:"title,omitempty"`
	File      string            `json:"file"`
	NoteTitle string            `json:"noteTitle"`
	Index     int               `json:"index"`
	Line      int               `json:"line"`
	Canon     map[string]string `json:"canon"`
	Args      map[string]string `json:"args,omitempty"`
}

type Request struct {
	Title  string `json:"title"`
	Source string `json:"source"`
	Items  []Item `json:"items"`
}

type Filter struct {
	Key   string `json:"key"`
	Op    string `json:"op"`
	Value string `json:"value"`
}

type Sort struct {
	Key       string `json:"key"`
	Direction string `json:"direction"`
}

type Spec struct {
	Title   string
	Source  string
	Columns []string
	Filters []Filter
	Sorts   []Sort
	Limit   int
	View    string
	Group   string
}

type Diagnostic struct {
	Line    int    `json:"line"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

type Column struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

type Cell struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type Row struct {
	ID    string  `json:"id"`
	Kind  string  `json:"kind"`
	File  string  `json:"file"`
	Index int     `json:"index"`
	Line  int     `json:"line"`
	Cells []Cell  `json:"cells"`
	Group *string `json:"group,omitempty"`
}

type Result struct {
	Title       string       `json:"title"`
	Source      string       `json:"source"`
	Columns     []Column     `json:"columns"`
	Rows        []Row        `json:"rows"`
	Total       int          `json:"total"`
	Truncated   bool         `json:"truncated"`
	Diagnostics []Diagnostic `json:"diagnostics"`
	View        string       `json:"view,omitempty"`
	GroupBy     string       `json:"groupBy,omitempty"`
}

func ParseSpec(raw, title string) (Spec, []Diagnostic) {
	cleanedTitle := strings.TrimSpace(identityTail.ReplaceAllString(title, ""))
	if cleanedTitle == "" {
		cleanedTitle = "Attribute view"
	}
	spec := Spec{Title: cleanedTitle, Source: "todo", Columns: append([]string{}, defaultColumns...), Filters: []Filter{}, Sorts: []Sort{}, Limit: 50, View: "table"}
	diagnostics := []Diagnostic{}
	for index, sourceLine := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		line := index + 1
		text := strings.TrimSpace(sourceLine)
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		separator := strings.Index(text, ":")
		if separator < 1 {
			diagnostics = append(diagnostics, Diagnostic{Line: line, Kind: "invalid-directive", Message: fmt.Sprintf(`Expected "key: value", got %q`, text)})
			continue
		}
		key := strings.ToLower(strings.TrimSpace(text[:separator]))
		value := strings.TrimSpace(text[separator+1:])
		switch key {
		case "source":
			source := strings.ToLower(value)
			if source == "planning" || source == "todo" || source == "project" || source == "milestone" || source == "clock" || source == "block" || source == "prose" || source == "org-env" {
				spec.Source = source
			} else {
				diagnostics = append(diagnostics, Diagnostic{Line: line, Kind: "invalid-source", Message: fmt.Sprintf(`Unknown attribute-view source %q`, value)})
			}
		case "columns":
			columns := splitList(value)
			valid := len(columns) > 0
			for _, column := range columns {
				if !keyPattern.MatchString(column) {
					valid = false
					break
				}
			}
			if !valid {
				diagnostics = append(diagnostics, Diagnostic{Line: line, Kind: "invalid-columns", Message: "Columns must be comma-separated attribute names"})
			} else {
				spec.Columns = uniqueLower(columns, 20)
			}
		case "filter":
			match := filterPattern.FindStringSubmatch(value)
			if nil == match || (strings.ToLower(matchValue(match, 2)) != "empty" && strings.ToLower(matchValue(match, 2)) != "not-empty" && strings.TrimSpace(matchValue(match, 3)) == "") {
				diagnostics = append(diagnostics, Diagnostic{Line: line, Kind: "invalid-filter", Message: fmt.Sprintf(`Invalid filter %q`, value)})
			} else if len(spec.Filters) < 20 {
				spec.Filters = append(spec.Filters, Filter{Key: strings.ToLower(match[1]), Op: strings.ToLower(match[2]), Value: strings.TrimSpace(matchValue(match, 3))})
			}
		case "sort":
			sorts := splitList(value)
			parsed := []Sort{}
			valid := len(sorts) > 0
			for _, rawSort := range sorts {
				match := sortPattern.FindStringSubmatch(rawSort)
				if nil == match {
					valid = false
					break
				}
				direction := strings.ToLower(matchValue(match, 2))
				if direction == "" {
					direction = "asc"
				}
				parsed = append(parsed, Sort{Key: strings.ToLower(match[1]), Direction: direction})
			}
			if !valid {
				diagnostics = append(diagnostics, Diagnostic{Line: line, Kind: "invalid-sort", Message: fmt.Sprintf(`Invalid sort %q`, value)})
			} else {
				for _, parsedSort := range parsed {
					if len(spec.Sorts) < 10 {
						spec.Sorts = append(spec.Sorts, parsedSort)
					}
				}
			}
		case "limit":
			limit, err := strconv.Atoi(value)
			if err != nil || limit < 1 {
				diagnostics = append(diagnostics, Diagnostic{Line: line, Kind: "invalid-limit", Message: "Limit must be a positive integer"})
			} else if limit > 200 {
				spec.Limit = 200
			} else {
				spec.Limit = limit
			}
		case "view":
			view := strings.ToLower(value)
			if view == "table" || view == "gallery" || view == "kanban" {
				spec.View = view
			} else {
				diagnostics = append(diagnostics, Diagnostic{Line: line, Kind: "invalid-view", Message: fmt.Sprintf(`Unknown attribute-view view %q`, value)})
			}
		case "group":
			if keyPattern.MatchString(value) {
				spec.Group = strings.ToLower(value)
			} else {
				diagnostics = append(diagnostics, Diagnostic{Line: line, Kind: "invalid-group", Message: "Group must be an attribute name"})
			}
		default:
			diagnostics = append(diagnostics, Diagnostic{Line: line, Kind: "unknown-directive", Message: fmt.Sprintf(`Unknown attribute-view directive %q`, key)})
		}
	}
	return spec, diagnostics
}

func Evaluate(request Request) Result {
	spec, diagnostics := ParseSpec(request.Source, request.Title)
	groupBy := ""
	if spec.View == "kanban" {
		groupBy = spec.Group
		if groupBy == "" {
			groupBy = "status"
		}
	}
	type candidate struct {
		item    Item
		ordinal int
	}
	candidates := []candidate{}
	for ordinal, item := range request.Items {
		planningSource := spec.Source == "planning" && (item.Kind == "todo" || item.Kind == "project" || item.Kind == "milestone" || item.Kind == "clock")
		blockSource := spec.Source == "block" && (item.Kind == "prose" || item.Kind == "org-env")
		if !planningSource && !blockSource && item.Kind != spec.Source {
			continue
		}
		matched := true
		for _, filter := range spec.Filters {
			if !matchesFilter(item, filter) {
				matched = false
				break
			}
		}
		if matched {
			candidates = append(candidates, candidate{item: item, ordinal: ordinal})
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		for _, order := range spec.Sorts {
			compared := compareValues(itemValue(candidates[i].item, order.Key), itemValue(candidates[j].item, order.Key))
			if compared != 0 {
				if order.Direction == "desc" {
					return compared > 0
				}
				return compared < 0
			}
		}
		return candidates[i].ordinal < candidates[j].ordinal
	})
	columns := make([]Column, len(spec.Columns))
	for index, key := range spec.Columns {
		columns[index] = Column{Key: key, Label: labelForKey(key)}
	}
	rowCount := len(candidates)
	if rowCount > spec.Limit {
		rowCount = spec.Limit
	}
	rows := make([]Row, 0, rowCount)
	for _, candidate := range candidates[:rowCount] {
		cells := make([]Cell, len(columns))
		for index, column := range columns {
			cells[index] = Cell{Key: column.Key, Value: itemValue(candidate.item, column.Key)}
		}
		var group *string
		if groupBy != "" {
			value := itemValue(candidate.item, groupBy)
			group = &value
		}
		rows = append(rows, Row{ID: candidate.item.ID, Kind: candidate.item.Kind, File: candidate.item.File, Index: candidate.item.Index, Line: candidate.item.Line, Cells: cells, Group: group})
	}
	view := ""
	if spec.View != "table" {
		view = spec.View
	}
	return Result{Title: spec.Title, Source: spec.Source, Columns: columns, Rows: rows, Total: len(candidates), Truncated: len(candidates) > len(rows), Diagnostics: diagnostics, View: view, GroupBy: groupBy}
}

func splitList(raw string) []string {
	ret := []string{}
	for _, value := range strings.Split(raw, ",") {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			ret = append(ret, trimmed)
		}
	}
	return ret
}

func uniqueLower(values []string, limit int) []string {
	seen := map[string]bool{}
	ret := []string{}
	for _, value := range values {
		value = strings.ToLower(value)
		if !seen[value] && len(ret) < limit {
			seen[value] = true
			ret = append(ret, value)
		}
	}
	return ret
}

func matchValue(match []string, index int) string {
	if index >= 0 && index < len(match) {
		return match[index]
	}
	return ""
}

func itemValue(item Item, key string) string {
	switch key {
	case "kind", "type":
		return item.Kind
	case "note", "notetitle", "note-title":
		return item.NoteTitle
	case "title":
		if item.Title != "" {
			return item.Title
		}
		return item.Text
	case "id":
		return item.ID
	case "status":
		return item.Status
	case "text":
		return item.Text
	case "file":
		return item.File
	case "line":
		if item.Line > 0 {
			return strconv.Itoa(item.Line)
		}
		return ""
	}
	if value, ok := item.Canon[key]; ok {
		return value
	}
	return item.Args[key]
}

func matchesFilter(item Item, filter Filter) bool {
	actual := itemValue(item, filter.Key)
	expected := filter.Value
	switch filter.Op {
	case "empty":
		return actual == ""
	case "not-empty":
		return actual != ""
	case "=":
		return strings.EqualFold(actual, expected)
	case "!=":
		return !strings.EqualFold(actual, expected)
	case "contains":
		return strings.Contains(strings.ToLower(actual), strings.ToLower(expected))
	case "in":
		for _, value := range strings.Split(expected, "|") {
			if strings.EqualFold(actual, strings.TrimSpace(value)) {
				return true
			}
		}
	}
	return false
}

func compareValues(a, b string) int {
	if a == b {
		return 0
	}
	if a == "" {
		return 1
	}
	if b == "" {
		return -1
	}
	numberA, errA := strconv.ParseFloat(a, 64)
	numberB, errB := strconv.ParseFloat(b, 64)
	if errA == nil && errB == nil {
		if numberA < numberB {
			return -1
		}
		return 1
	}
	return strings.Compare(strings.ToLower(a), strings.ToLower(b))
}

func labelForKey(key string) string {
	labels := map[string]string{"text": "Task", "status": "Status", "project": "Project", "prio": "Priority", "ddl": "Deadline", "sche": "Scheduled", "file": "File", "kind": "Type", "line": "Line", "note": "Note", "notetitle": "Note"}
	if label := labels[key]; label != "" {
		return label
	}
	parts := strings.FieldsFunc(key, func(r rune) bool { return r == '-' || r == '_' })
	for index, part := range parts {
		if part != "" {
			parts[index] = strings.ToUpper(part[:1]) + part[1:]
		}
	}
	return strings.Join(parts, " ")
}
