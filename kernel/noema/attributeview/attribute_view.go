package attributeview

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var (
	keyPattern   = regexp.MustCompile(`(?i)^[a-z][a-z0-9_-]*$`)
	sortPattern  = regexp.MustCompile(`(?i)^([a-z][a-z0-9_-]*)(?:\s+(asc|desc))?$`)
	identityTail = regexp.MustCompile(`(?i)\s*\{#[0-9a-f-]{36}(?:\s+[^{}\r\n]*)?\}\s*$`)
)

var defaultColumns = []string{"text", "status", "project", "file"}

var fieldTypes = map[string]bool{
	"block": true, "text": true, "number": true, "date": true, "select": true, "mselect": true,
	"url": true, "email": true, "phone": true, "masset": true, "template": true, "created": true,
	"updated": true, "checkbox": true, "relation": true, "rollup": true, "linenumber": true,
}

var filterOperators = []string{
	"not-contains-any", "contains-any", "not-contains", "starts-with", "ends-with", "not-empty",
	"between", "contains", "empty", "false", "true", "not-in", "in", ">=", "<=", "!=", ">", "<", "=",
}

var calcOperators = map[string]bool{
	"unique-values": true, "count-all": true, "count-values": true, "count-unique-values": true,
	"count-empty": true, "count-not-empty": true, "percent-empty": true, "percent-not-empty": true,
	"percent-unique-values": true, "sum": true, "average": true, "median": true, "min": true, "max": true,
	"range": true, "earliest": true, "latest": true, "checked": true, "unchecked": true,
	"percent-checked": true, "percent-unchecked": true, "template": true,
}

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
	NowMs  int64  `json:"nowMs,omitempty"`
}

type Filter struct {
	Key         string   `json:"key,omitempty"`
	Op          string   `json:"op,omitempty"`
	Value       string   `json:"value,omitempty"`
	Combination string   `json:"combination,omitempty"`
	Filters     []Filter `json:"filters,omitempty"`
}

type Calculation struct {
	Key      string `json:"key"`
	Operator string `json:"operator"`
	Template string `json:"template,omitempty"`
}

type Sort struct {
	Key       string `json:"key"`
	Direction string `json:"direction"`
}

type Spec struct {
	Title        string
	Source       string
	Columns      []string
	Filters      []Filter
	Sorts        []Sort
	Types        map[string]string
	Calculations []Calculation
	Limit        int
	View         string
	Group        string
}

type Diagnostic struct {
	Line    int    `json:"line"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

type Column struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Type  string `json:"type,omitempty"`
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
	Title        string              `json:"title"`
	Source       string              `json:"source"`
	Columns      []Column            `json:"columns"`
	Rows         []Row               `json:"rows"`
	Total        int                 `json:"total"`
	Truncated    bool                `json:"truncated"`
	Diagnostics  []Diagnostic        `json:"diagnostics"`
	View         string              `json:"view,omitempty"`
	GroupBy      string              `json:"groupBy,omitempty"`
	Calculations []CalculationResult `json:"calculations,omitempty"`
}

type CalculationResult struct {
	Key      string `json:"key"`
	Operator string `json:"operator"`
	Type     string `json:"type"`
	Value    any    `json:"value"`
}

func ParseSpec(raw, title string) (Spec, []Diagnostic) {
	cleanedTitle := strings.TrimSpace(identityTail.ReplaceAllString(title, ""))
	if cleanedTitle == "" {
		cleanedTitle = "Attribute view"
	}
	spec := Spec{Title: cleanedTitle, Source: "todo", Columns: append([]string{}, defaultColumns...), Filters: []Filter{}, Sorts: []Sort{}, Types: map[string]string{}, Calculations: []Calculation{}, Limit: 50, View: "table"}
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
			filter, ok := parseFilterClause(value)
			if !ok {
				diagnostics = append(diagnostics, Diagnostic{Line: line, Kind: "invalid-filter", Message: fmt.Sprintf(`Invalid filter %q`, value)})
			} else if len(spec.Filters) < 20 {
				spec.Filters = append(spec.Filters, filter)
			}
		case "filter-any", "filter-all":
			children := []Filter{}
			valid := true
			for _, clause := range strings.Split(value, ";") {
				filter, ok := parseFilterClause(clause)
				if !ok {
					valid = false
					break
				}
				children = append(children, filter)
			}
			if !valid || len(children) == 0 {
				diagnostics = append(diagnostics, Diagnostic{Line: line, Kind: "invalid-filter-group", Message: fmt.Sprintf(`Invalid %s group %q`, key, value)})
			} else if len(spec.Filters) < 20 {
				combination := "and"
				if key == "filter-any" {
					combination = "or"
				}
				spec.Filters = append(spec.Filters, Filter{Combination: combination, Filters: children})
			}
		case "type":
			parts := strings.Fields(value)
			fieldType := ""
			if len(parts) == 2 {
				fieldType = normalizeFieldType(parts[1])
			}
			if len(parts) != 2 || !keyPattern.MatchString(parts[0]) || !fieldTypes[fieldType] {
				diagnostics = append(diagnostics, Diagnostic{Line: line, Kind: "invalid-type", Message: fmt.Sprintf(`Invalid field type %q`, value)})
			} else {
				spec.Types[strings.ToLower(parts[0])] = fieldType
			}
		case "calc":
			parts := strings.Fields(value)
			if len(parts) < 2 || !keyPattern.MatchString(parts[0]) || !calcOperators[strings.ToLower(parts[1])] {
				diagnostics = append(diagnostics, Diagnostic{Line: line, Kind: "invalid-calc", Message: fmt.Sprintf(`Invalid calculation %q`, value)})
			} else if len(spec.Calculations) < 20 {
				template := ""
				if len(parts) > 2 {
					template = strings.Join(parts[2:], " ")
				}
				spec.Calculations = append(spec.Calculations, Calculation{Key: strings.ToLower(parts[0]), Operator: strings.ToLower(parts[1]), Template: template})
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
	nowMs := request.NowMs
	if nowMs == 0 {
		nowMs = time.Now().UnixMilli()
	}
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
			if !matchesFilterTyped(item, filter, spec.Types, nowMs) {
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
			compared := compareTypedValues(itemValue(candidates[i].item, order.Key), itemValue(candidates[j].item, order.Key), spec.Types[order.Key], nowMs)
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
		columns[index] = Column{Key: key, Label: labelForKey(key), Type: spec.Types[key]}
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
	var calculations []CalculationResult
	if len(spec.Calculations) > 0 {
		items := make([]Item, len(candidates))
		for index, candidate := range candidates {
			items[index] = candidate.item
		}
		for _, calculation := range spec.Calculations {
			calculations = append(calculations, calculate(items, calculation, spec.Types, nowMs))
		}
	}
	return Result{Title: spec.Title, Source: spec.Source, Columns: columns, Rows: rows, Total: len(candidates), Truncated: len(candidates) > len(rows), Diagnostics: diagnostics, View: view, GroupBy: groupBy, Calculations: calculations}
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

func normalizeFieldType(raw string) string {
	value := strings.NewReplacer("-", "", "_", "", " ", "").Replace(strings.ToLower(raw))
	return value
}

func parseFilterClause(raw string) (Filter, bool) {
	text := strings.TrimSpace(raw)
	keyEnd := strings.IndexAny(text, " \t")
	if keyEnd < 1 {
		return Filter{}, false
	}
	key := strings.ToLower(strings.TrimSpace(text[:keyEnd]))
	if !keyPattern.MatchString(key) {
		return Filter{}, false
	}
	rest := strings.TrimSpace(text[keyEnd:])
	for _, operator := range filterOperators {
		if !strings.EqualFold(rest, operator) && !strings.HasPrefix(strings.ToLower(rest), strings.ToLower(operator)+" ") {
			continue
		}
		value := strings.TrimSpace(rest[len(operator):])
		op := strings.ToLower(operator)
		if value == "" && op != "empty" && op != "not-empty" && op != "true" && op != "false" {
			return Filter{}, false
		}
		return Filter{Key: key, Op: op, Value: value}, true
	}
	return Filter{}, false
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

func collectionValues(value string) []string {
	values := []string{}
	for _, part := range strings.FieldsFunc(value, func(r rune) bool { return r == '|' || r == ',' }) {
		if clean := strings.TrimSpace(part); clean != "" {
			values = append(values, strings.ToLower(clean))
		}
	}
	return values
}

func checkboxValue(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on", "checked", "done":
		return true
	}
	return false
}

func dateValue(value string, nowMs int64) float64 {
	raw := strings.ToLower(strings.TrimSpace(value))
	now := time.UnixMilli(nowMs).In(time.Local)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	switch raw {
	case "today":
		return float64(today.UnixMilli())
	case "yesterday":
		return float64(today.AddDate(0, 0, -1).UnixMilli())
	case "tomorrow":
		return float64(today.AddDate(0, 0, 1).UnixMilli())
	}
	if match := regexp.MustCompile(`(?i)^([+-]?\d+)\s*([dwmy])$`).FindStringSubmatch(raw); match != nil {
		count, _ := strconv.Atoi(match[1])
		date := today
		switch strings.ToLower(match[2]) {
		case "d":
			date = date.AddDate(0, 0, count)
		case "w":
			date = date.AddDate(0, 0, count*7)
		case "m":
			date = date.AddDate(0, count, 0)
		case "y":
			date = date.AddDate(count, 0, 0)
		}
		return float64(date.UnixMilli())
	}
	if match := regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})(?:$|[ t])`).FindStringSubmatch(raw); match != nil {
		year, _ := strconv.Atoi(match[1])
		month, _ := strconv.Atoi(match[2])
		day, _ := strconv.Atoi(match[3])
		return float64(time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.Local).UnixMilli())
	}
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		return float64(parsed.UnixMilli())
	}
	return math.NaN()
}

func numericValue(value string) float64 {
	number, err := strconv.ParseFloat(strings.ReplaceAll(value, ",", ""), 64)
	if err != nil {
		return math.NaN()
	}
	return number
}

func compareNumbers(left, right float64) int {
	if math.IsNaN(left) {
		return 1
	}
	if math.IsNaN(right) {
		return -1
	}
	if left < right {
		return -1
	}
	if left > right {
		return 1
	}
	return 0
}

func compareTypedValues(a, b, fieldType string, nowMs int64) int {
	switch fieldType {
	case "number", "linenumber":
		return compareNumbers(numericValue(a), numericValue(b))
	case "date", "created", "updated":
		return compareNumbers(dateValue(a, nowMs), dateValue(b, nowMs))
	case "checkbox":
		left, right := checkboxValue(a), checkboxValue(b)
		if left == right {
			return 0
		}
		if left {
			return 1
		}
		return -1
	}
	return compareValues(a, b)
}

func equalTypedValues(actual, expected, fieldType string, nowMs int64) bool {
	switch fieldType {
	case "mselect", "masset", "relation", "rollup":
		left := uniqueLower(collectionValues(actual), len(collectionValues(actual)))
		right := uniqueLower(collectionValues(expected), len(collectionValues(expected)))
		if len(left) != len(right) {
			return false
		}
		sort.Strings(left)
		sort.Strings(right)
		for index := range left {
			if left[index] != right[index] {
				return false
			}
		}
		return true
	case "number", "linenumber", "date", "created", "updated", "checkbox":
		return compareTypedValues(actual, expected, fieldType, nowMs) == 0
	}
	return strings.EqualFold(actual, expected)
}

func matchesFilterTyped(item Item, filter Filter, types map[string]string, nowMs int64) bool {
	if len(filter.Filters) > 0 || filter.Combination != "" {
		if filter.Combination == "or" {
			for _, child := range filter.Filters {
				if matchesFilterTyped(item, child, types, nowMs) {
					return true
				}
			}
			return false
		}
		for _, child := range filter.Filters {
			if !matchesFilterTyped(item, child, types, nowMs) {
				return false
			}
		}
		return true
	}
	actual, expected := itemValue(item, filter.Key), filter.Value
	fieldType := types[filter.Key]
	if fieldType == "" {
		fieldType = "text"
	}
	empty := actual == ""
	if fieldType == "mselect" || fieldType == "masset" || fieldType == "relation" || fieldType == "rollup" {
		empty = len(collectionValues(actual)) == 0
	}
	switch filter.Op {
	case "empty":
		return empty
	case "not-empty":
		return !empty
	case "true":
		return checkboxValue(actual)
	case "false":
		return !checkboxValue(actual)
	case "=":
		return equalTypedValues(actual, expected, fieldType, nowMs)
	case "!=":
		return !equalTypedValues(actual, expected, fieldType, nowMs)
	case ">", ">=", "<", "<=":
		compared := compareTypedValues(actual, expected, fieldType, nowMs)
		if filter.Op == ">" {
			return compared > 0
		}
		if filter.Op == ">=" {
			return compared >= 0
		}
		if filter.Op == "<" {
			return compared < 0
		}
		return compared <= 0
	case "contains", "not-contains":
		matched := false
		if fieldType == "mselect" || fieldType == "masset" || fieldType == "relation" || fieldType == "rollup" {
			actualValues := collectionValues(actual)
			matched = true
			for _, expectedValue := range collectionValues(expected) {
				found := false
				for _, actualValue := range actualValues {
					if actualValue == expectedValue {
						found = true
						break
					}
				}
				if !found {
					matched = false
					break
				}
			}
		} else {
			matched = strings.Contains(strings.ToLower(actual), strings.ToLower(expected))
		}
		if filter.Op == "not-contains" {
			return !matched
		}
		return matched
	case "contains-any", "in", "not-contains-any", "not-in":
		actualValues := collectionValues(actual)
		if len(actualValues) == 0 && actual != "" {
			actualValues = []string{strings.ToLower(actual)}
		}
		matched := false
		for _, expectedValue := range collectionValues(expected) {
			for _, actualValue := range actualValues {
				if actualValue == expectedValue {
					matched = true
					break
				}
			}
			if matched {
				break
			}
		}
		if filter.Op == "not-contains-any" || filter.Op == "not-in" {
			return !matched
		}
		return matched
	case "starts-with":
		return strings.HasPrefix(strings.ToLower(actual), strings.ToLower(expected))
	case "ends-with":
		return strings.HasSuffix(strings.ToLower(actual), strings.ToLower(expected))
	case "between":
		bounds := strings.SplitN(expected, "..", 2)
		if len(bounds) != 2 || strings.TrimSpace(bounds[0]) == "" || strings.TrimSpace(bounds[1]) == "" {
			return false
		}
		return compareTypedValues(actual, strings.TrimSpace(bounds[0]), fieldType, nowMs) >= 0 && compareTypedValues(actual, strings.TrimSpace(bounds[1]), fieldType, nowMs) <= 0
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

func calculate(items []Item, calculation Calculation, types map[string]string, nowMs int64) CalculationResult {
	raw := make([]string, len(items))
	values := []string{}
	unique := []string{}
	uniqueIndexes := map[string]int{}
	numbers := []float64{}
	typeName := types[calculation.Key]
	if typeName == "" {
		typeName = "text"
	}
	checked := 0
	for index, item := range items {
		value := itemValue(item, calculation.Key)
		raw[index] = value
		if checkboxValue(value) {
			checked++
		}
		if value == "" {
			continue
		}
		values = append(values, value)
		key := strings.ToLower(value)
		if uniqueIndex, ok := uniqueIndexes[key]; ok {
			unique[uniqueIndex] = value
		} else {
			uniqueIndexes[key] = len(unique)
			unique = append(unique, value)
		}
		if number := numericValue(value); !math.IsNaN(number) {
			numbers = append(numbers, number)
		}
	}
	percent := func(count int) float64 {
		if len(raw) == 0 {
			return 0
		}
		return float64(count) / float64(len(raw))
	}
	sum := 0.0
	for _, number := range numbers {
		sum += number
	}
	sorted := append([]float64{}, numbers...)
	sort.Float64s(sorted)
	var median any
	if len(sorted) > 0 {
		middle := len(sorted) / 2
		if len(sorted)%2 == 1 {
			median = sorted[middle]
		} else {
			median = (sorted[middle-1] + sorted[middle]) / 2
		}
	}
	var value any
	switch calculation.Operator {
	case "unique-values":
		uniqueValues := make([]any, len(unique))
		for index, item := range unique {
			uniqueValues[index] = item
		}
		value = uniqueValues
	case "count-all":
		value = float64(len(raw))
	case "count-values", "count-not-empty":
		value = float64(len(values))
	case "count-unique-values":
		value = float64(len(unique))
	case "count-empty":
		value = float64(len(raw) - len(values))
	case "percent-empty":
		value = percent(len(raw) - len(values))
	case "percent-not-empty":
		value = percent(len(values))
	case "percent-unique-values":
		value = percent(len(unique))
	case "sum":
		value = sum
	case "average":
		if len(numbers) > 0 {
			value = sum / float64(len(numbers))
		}
	case "median":
		value = median
	case "min":
		if len(sorted) > 0 {
			value = sorted[0]
		}
	case "max":
		if len(sorted) > 0 {
			value = sorted[len(sorted)-1]
		}
	case "range":
		if len(sorted) > 0 {
			value = sorted[len(sorted)-1] - sorted[0]
		}
	case "earliest", "latest":
		type dateEntry struct {
			value string
			time  float64
		}
		dates := []dateEntry{}
		for _, rawValue := range values {
			if timestamp := dateValue(rawValue, nowMs); !math.IsNaN(timestamp) {
				dates = append(dates, dateEntry{value: rawValue, time: timestamp})
			}
		}
		sort.SliceStable(dates, func(i, j int) bool { return dates[i].time < dates[j].time })
		if len(dates) > 0 {
			if calculation.Operator == "earliest" {
				value = dates[0].value
			} else {
				value = dates[len(dates)-1].value
			}
		}
	case "checked":
		value = float64(checked)
	case "unchecked":
		value = float64(len(raw) - checked)
	case "percent-checked":
		value = percent(checked)
	case "percent-unchecked":
		value = percent(len(raw) - checked)
	case "template":
		average := 0.0
		if len(numbers) > 0 {
			average = sum / float64(len(numbers))
		}
		minimum, maximum := 0.0, 0.0
		if len(sorted) > 0 {
			minimum, maximum = sorted[0], sorted[len(sorted)-1]
		}
		medianNumber := 0.0
		if number, ok := median.(float64); ok {
			medianNumber = number
		}
		variables := map[string]string{
			"values": strings.Join(unique, ", "), "strings": strings.Join(values, ", "), "raw": strings.Join(raw, ", "),
			"count": strconv.Itoa(len(raw)), "sum": formatNumber(sum), "avg": formatNumber(average),
			"min": formatNumber(minimum), "max": formatNumber(maximum), "median": formatNumber(medianNumber),
			"nonEmptyCount": strconv.Itoa(len(values)),
		}
		template := calculation.Template
		if template == "" {
			template = "{{count}}"
		}
		pattern := regexp.MustCompile(`\{\{\s*(values|strings|raw|count|sum|avg|min|max|median|nonEmptyCount)\s*\}\}`)
		value = pattern.ReplaceAllStringFunc(template, func(token string) string {
			match := pattern.FindStringSubmatch(token)
			return variables[match[1]]
		})
	}
	return CalculationResult{Key: calculation.Key, Operator: calculation.Operator, Type: typeName, Value: value}
}

func formatNumber(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
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
