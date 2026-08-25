package planning

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// TodoPatch is the semantic write contract used by the desktop host. Attrs
// are canonical keys; a nil value means remove the key. Existing source
// aliases are retained by PatchTodoSource.
type TodoPatch struct {
	Op       string             `json:"op,omitempty"`
	Status   *string            `json:"status,omitempty"`
	Attrs    map[string]*string `json:"attrs,omitempty"`
	AfterAdd *string            `json:"afterAdd,omitempty"`
	NowMs    int64              `json:"nowMs,omitempty"`
}

// TodoCreate is the semantic contract for a brand-new planning item. The
// model layer owns ID allocation and document creation; this package owns the
// portable @@todo source grammar and value normalization.
type TodoCreate struct {
	Title  string            `json:"title"`
	Status string            `json:"status,omitempty"`
	Attrs  map[string]string `json:"attrs,omitempty"`
	NowMs  int64             `json:"nowMs,omitempty"`
}

var todoKeyAliases = map[string][]string{
	"id": {"id"}, "ddl": {"ddl", "due", "deadline"},
	"sche": {"sche", "scheduled", "start"}, "end": {"end", "finish"},
	"prio": {"prio", "priority"}, "repeat": {"repeat", "rep", "every"},
	"warn": {"warn", "lead"}, "after": {"after", "dep"}, "blocks": {"blocks"},
	"project": {"project", "proj"}, "area": {"area"}, "phase": {"phase"},
	"goal": {"goal"}, "effort": {"effort"}, "progress": {"progress", "pct"},
	"owner": {"owner"}, "date": {"date", "when"}, "tags": {"tags"},
	"context": {"context", "ctx"}, "done": {"done"}, "log": {"log"},
}

var todoCanonicalPatchOrder = []string{
	"id", "ddl", "sche", "end", "date", "prio", "repeat", "warn", "after",
	"blocks", "project", "area", "phase", "goal", "effort", "progress", "owner",
	"tags", "context", "done", "log",
}

var todoCreateKeys = map[string]bool{
	"ddl": true, "sche": true, "end": true, "prio": true, "repeat": true,
	"warn": true, "after": true, "blocks": true, "project": true, "area": true,
	"phase": true, "goal": true, "effort": true, "progress": true, "owner": true,
	"tags": true, "context": true,
}

var (
	semanticRelativeDate = regexp.MustCompile(`(?i)^([+-])(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$`)
	semanticYearDate     = regexp.MustCompile(`^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:[ T](\d{1,2}):(\d{2}))?$`)
	semanticISODate      = regexp.MustCompile(`(?i)^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$`)
	semanticShortDate    = regexp.MustCompile(`^(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$`)
	semanticRepeater     = regexp.MustCompile(`(?i)^(\+\+|\.\+|\+)?(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$`)
)

type semanticRepeaterValue struct {
	mode string
	n    int
	unit byte
}

type semanticDateValue struct {
	time    time.Time
	hasTime bool
}

// CreateTodoSource renders a new inline todo entirely from semantic fields.
// The caller-provided ID is always authoritative; request attrs cannot
// override it or introduce completion-only metadata.
func CreateTodoSource(create TodoCreate, id string) (string, error) {
	title := strings.TrimSpace(create.Title)
	if title == "" {
		return "", fmt.Errorf("todo title is required")
	}
	id = strings.TrimSpace(strings.TrimPrefix(id, "#"))
	if id == "" {
		return "", fmt.Errorf("todo ID is required")
	}

	now := semanticMutationTime(create.NowMs)
	attrs := map[string]string{"id": id}
	order := []string{"id"}
	for _, key := range todoCanonicalPatchOrder {
		if !todoCreateKeys[key] {
			continue
		}
		raw, exists := create.Attrs[key]
		if !exists {
			continue
		}
		value := normalizeSemanticCanonicalValue(key, &raw, now)
		if value == "" {
			continue
		}
		attrs[key] = value
		order = append(order, key)
	}

	status := normalizeSemanticTodoStatus(create.Status)
	statusPart := ""
	if status != "todo" {
		statusPart = "(" + status + ")"
	}
	escapedTitle := strings.NewReplacer(`\`, `\\`, `]`, `\]`).Replace(title)
	return "@@todo" + statusPart + " [" + escapedTitle + "] " + serializeSemanticAttrs(attrs, order, false), nil
}

// PatchTodoSource applies canonical todo attributes, status changes, and
// repeater completion without requiring Node to render replacement source.
func PatchTodoSource(node Node, patch TodoPatch) string {
	if node.Kind != "todo" && node.Kind != "itodo" {
		return node.Raw
	}
	attrs, order := semanticNodeAttrs(node)
	values := map[string]*string{}
	patchOrder := []string{}
	setPatch := func(key string, value *string) {
		if _, exists := values[key]; !exists {
			patchOrder = append(patchOrder, key)
		}
		values[key] = value
	}
	for _, key := range todoCanonicalPatchOrder {
		if value, exists := patch.Attrs[key]; exists {
			setPatch(key, value)
		}
	}
	if nil != patch.AfterAdd {
		value := appendSemanticDepRef(semanticCanonicalAttr(attrs, "after"), *patch.AfterAdd)
		setPatch("after", &value)
	}

	now := semanticMutationTime(patch.NowMs)
	status := ""
	if strings.EqualFold(strings.TrimSpace(patch.Op), "complete") {
		done := formatSemanticDate(now, false)
		if repeater, ok := parseSemanticRepeater(semanticCanonicalAttr(attrs, "repeat")); ok {
			if ddl := semanticCanonicalAttr(attrs, "ddl"); ddl != "" {
				value := applySemanticRepeater(ddl, repeater, now)
				setPatch("ddl", &value)
			}
			if scheduled := semanticCanonicalAttr(attrs, "sche"); scheduled != "" {
				value := applySemanticRepeater(scheduled, repeater, now)
				setPatch("sche", &value)
			}
			setPatch("done", &done)
			parts := semanticNonEmptyParts(semanticCanonicalAttr(attrs, "log"), "&")
			parts = append(parts, done)
			if len(parts) > 30 {
				parts = parts[len(parts)-30:]
			}
			logValue := strings.Join(parts, " & ")
			setPatch("log", &logValue)
			status = "todo"
		} else {
			setPatch("done", &done)
			status = "done"
		}
	} else if nil != patch.Status {
		status = normalizeSemanticTodoStatus(*patch.Status)
	}

	for _, canonKey := range patchOrder {
		value := normalizeSemanticCanonicalValue(canonKey, values[canonKey], now)
		aliases := todoKeyAliases[canonKey]
		if len(aliases) == 0 {
			aliases = []string{canonKey}
		}
		if value == "" {
			for _, alias := range aliases {
				delete(attrs, alias)
				order = removeSemanticAttrOrder(order, alias)
			}
			continue
		}
		key := aliases[0]
		for _, alias := range aliases {
			if _, exists := attrs[alias]; exists {
				key = alias
				break
			}
		}
		if _, exists := attrs[key]; !exists {
			order = append(order, key)
		}
		attrs[key] = value
	}

	var statusPtr *string
	if status != "" {
		statusPtr = &status
	}
	return renderSemanticNode(node, attrs, order, statusPtr)
}

// PatchNodeSource applies generic raw planning attributes. It is used for
// clock-out and deliberately does not apply todo aliases or value grammar.
func PatchNodeSource(node Node, patch map[string]*string, status *string) string {
	attrs, order := semanticNodeAttrs(node)
	keys := make([]string, 0, len(patch))
	for key := range patch {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := patch[key]
		if nil == value || strings.TrimSpace(*value) == "" {
			delete(attrs, key)
			order = removeSemanticAttrOrder(order, key)
			continue
		}
		if _, exists := attrs[key]; !exists {
			order = append(order, key)
		}
		attrs[key] = *value
	}
	return renderSemanticNode(node, attrs, order, status)
}

// ClockSourceForTodo renders the source inserted by clock-in from semantic
// attrs and the freshly located todo title.
func ClockSourceForTodo(todo Node, attrs map[string]*string) string {
	value := func(key string) string {
		if raw := attrs[key]; nil != raw {
			return strings.TrimSpace(*raw)
		}
		return ""
	}
	title := strings.NewReplacer(`\`, `\\`, `]`, `\]`).Replace(todo.Title)
	return "@@clock [" + title + "]{from: " + value("from") + ", task: " + value("task") + "}"
}

func semanticNodeAttrs(node Node) (map[string]string, []string) {
	attrs := map[string]string{}
	for key, value := range node.Attrs {
		attrs[key] = value
	}
	parsed := parseAttrs(node.AttrsRaw)
	order := append([]string{}, parsed.order...)
	for key := range attrs {
		if !semanticContains(order, key) {
			order = append(order, key)
		}
	}
	return attrs, order
}

func semanticCanonicalAttr(attrs map[string]string, canonKey string) string {
	aliases := todoKeyAliases[canonKey]
	if len(aliases) == 0 {
		aliases = []string{canonKey}
	}
	for _, alias := range aliases {
		if value := attrs[alias]; value != "" {
			return value
		}
	}
	return ""
}

func normalizeSemanticCanonicalValue(key string, value *string, now time.Time) string {
	if nil == value {
		return ""
	}
	raw := strings.TrimSpace(*value)
	if raw == "" {
		return ""
	}
	switch key {
	case "prio":
		raw = strings.ToUpper(raw)
		if len(raw) != 1 || raw[0] < 'A' || raw[0] > 'Z' {
			return ""
		}
		return raw
	case "ddl", "sche", "end", "date", "done":
		if parsed, ok := parseSemanticDate(raw, now); ok {
			return formatSemanticDate(parsed.time, parsed.hasTime)
		}
		return raw
	case "progress":
		number, err := strconv.ParseFloat(raw, 64)
		if nil != err {
			number = 0
		}
		if number < 0 {
			number = 0
		} else if number > 100 {
			number = 100
		}
		return strconv.FormatFloat(number, 'f', -1, 64)
	case "repeat":
		if _, ok := parseSemanticRepeater(raw); !ok {
			return ""
		}
	}
	return raw
}

func renderSemanticNode(node Node, attrs map[string]string, order []string, status *string) string {
	raw := node.Raw
	if nil != status {
		if header, ok := parseHeader(raw, 0); ok {
			trimmed := strings.TrimSpace(*status)
			prefix := "@@" + node.Kind + " "
			if trimmed != "" && trimmed != "todo" {
				prefix = "@@" + node.Kind + "(" + trimmed + ") "
			}
			raw = prefix + raw[header.body:]
		}
	}
	attrsRaw := serializeSemanticAttrs(attrs, order, node.Shape == "block")
	if attrsRaw == "" && titlePlanningKinds[node.Kind] {
		attrsRaw = "{}"
	}
	return replaceSemanticAttrs(raw, attrsRaw)
}

func serializeSemanticAttrs(attrs map[string]string, order []string, block bool) string {
	keys := []string{}
	for _, key := range order {
		if strings.TrimSpace(attrs[key]) != "" && !semanticContains(keys, key) {
			keys = append(keys, key)
		}
	}
	remaining := []string{}
	for key, value := range attrs {
		if strings.TrimSpace(value) != "" && !semanticContains(keys, key) {
			remaining = append(remaining, key)
		}
	}
	sort.Strings(remaining)
	keys = append(keys, remaining...)
	if len(keys) == 0 {
		if block {
			return "{}"
		}
		return ""
	}
	if block {
		lines := make([]string, 0, len(keys))
		for _, key := range keys {
			lines = append(lines, "  "+key+": "+attrs[key])
		}
		return "{\n" + strings.Join(lines, "\n") + "\n}"
	}
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+"="+serializeSemanticValue(attrs[key]))
	}
	return "{" + strings.Join(parts, ", ") + "}"
}

func serializeSemanticValue(value string) string {
	if !strings.ContainsAny(value, ",;{}[]\"'") && !strings.ContainsFunc(value, unicode.IsSpace) {
		return value
	}
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return strings.TrimSuffix(out.String(), "\n")
}

func replaceSemanticAttrs(raw, attrsRaw string) string {
	bracket := strings.IndexByte(raw, '[')
	pos := -1
	if bracket >= 0 {
		close := findClose(raw, bracket, ']')
		if close < 0 {
			return raw
		}
		pos = close + 1
		for pos < len(raw) && (raw[pos] == ' ' || raw[pos] == '\t') {
			pos++
		}
	} else if header, ok := parseHeader(raw, 0); ok {
		lineEnd := strings.IndexByte(raw[header.body:], '\n')
		if lineEnd < 0 {
			lineEnd = len(raw)
		} else {
			lineEnd += header.body
		}
		pos = strings.IndexByte(raw[header.body:lineEnd], '{')
		if pos < 0 {
			if attrsRaw == "" {
				return raw
			}
			return strings.TrimRightFunc(raw, unicode.IsSpace) + " " + attrsRaw
		}
		pos += header.body
	} else {
		return raw
	}
	if pos < len(raw) && raw[pos] == '{' {
		if strings.Contains(raw[pos:], "\n") {
			return strings.TrimRightFunc(raw[:pos], unicode.IsSpace) + semanticOptionalSpace(attrsRaw) + attrsRaw
		}
		if end := findClose(raw, pos, '}'); end >= 0 {
			return strings.TrimRightFunc(raw[:pos], unicode.IsSpace) + semanticOptionalSpace(attrsRaw) + attrsRaw + raw[end+1:]
		}
	}
	if attrsRaw == "" {
		return raw
	}
	return strings.TrimRightFunc(raw, unicode.IsSpace) + " " + attrsRaw
}

func semanticOptionalSpace(attrs string) string {
	if attrs == "" {
		return ""
	}
	return " "
}

func parseSemanticRepeater(raw string) (semanticRepeaterValue, bool) {
	match := semanticRepeater.FindStringSubmatch(strings.TrimSpace(raw))
	if nil == match {
		return semanticRepeaterValue{}, false
	}
	n, _ := strconv.Atoi(match[2])
	mode := "+"
	if match[1] == "++" || match[1] == ".+" {
		mode = match[1]
	}
	unit := byte('y')
	lower := strings.ToLower(match[3])
	if strings.HasPrefix(lower, "d") {
		unit = 'd'
	} else if strings.HasPrefix(lower, "w") {
		unit = 'w'
	} else if strings.HasPrefix(lower, "m") {
		unit = 'm'
	}
	return semanticRepeaterValue{mode: mode, n: n, unit: unit}, true
}

func applySemanticRepeater(raw string, repeater semanticRepeaterValue, now time.Time) string {
	parsed, ok := parseSemanticDate(raw, now)
	if !ok {
		return raw
	}
	todayBase := now
	if !parsed.hasTime {
		todayBase = semanticMidnight(now)
	}
	var next time.Time
	if repeater.mode == ".+" {
		next = shiftSemanticDate(todayBase, repeater.n, repeater.unit)
	} else {
		next = shiftSemanticDate(parsed.time, repeater.n, repeater.unit)
		if repeater.mode == "++" {
			for guard := 0; !next.After(todayBase) && guard < 10000; guard++ {
				next = shiftSemanticDate(next, repeater.n, repeater.unit)
			}
		}
	}
	return formatSemanticDate(next, parsed.hasTime)
}

func shiftSemanticDate(value time.Time, n int, unit byte) time.Time {
	switch unit {
	case 'd':
		return value.AddDate(0, 0, n)
	case 'w':
		return value.AddDate(0, 0, 7*n)
	case 'm':
		return value.AddDate(0, n, 0)
	default:
		return value.AddDate(n, 0, 0)
	}
}

func parseSemanticDate(raw string, now time.Time) (semanticDateValue, bool) {
	text := strings.TrimSpace(raw)
	lower := strings.ToLower(text)
	switch lower {
	case "today", "今天":
		return semanticDateValue{time: semanticMidnight(now)}, true
	case "tomorrow", "明天":
		return semanticDateValue{time: semanticMidnight(now).AddDate(0, 0, 1)}, true
	case "yesterday", "昨天":
		return semanticDateValue{time: semanticMidnight(now).AddDate(0, 0, -1)}, true
	case "now":
		return semanticDateValue{time: now, hasTime: true}, true
	}
	if match := semanticRelativeDate.FindStringSubmatch(lower); nil != match {
		n, _ := strconv.Atoi(match[2])
		if match[1] == "-" {
			n = -n
		}
		unit := byte(strings.ToLower(match[3])[0])
		return semanticDateValue{time: shiftSemanticDate(semanticMidnight(now), n, unit)}, true
	}
	normalized := strings.NewReplacer("年", "-", "月", "-", "日", "", "号", "", ".", "-", "/", "-").Replace(text)
	if match := semanticYearDate.FindStringSubmatch(normalized); nil != match {
		year := semanticInt(match[1])
		month := semanticInt(match[2])
		day := semanticIntDefault(match[3], 1)
		hour := semanticInt(match[4])
		minute := semanticInt(match[5])
		return semanticDateValue{time: time.Date(year, time.Month(month), day, hour, minute, 0, 0, time.Local), hasTime: match[4] != ""}, true
	}
	if match := semanticISODate.FindStringSubmatch(normalized); nil != match {
		return semanticDateValue{time: time.Date(semanticInt(match[1]), time.Month(semanticInt(match[2])), semanticInt(match[3]), semanticInt(match[4]), semanticInt(match[5]), 0, 0, time.Local), hasTime: true}, true
	}
	if match := semanticShortDate.FindStringSubmatch(normalized); nil != match {
		month, day := semanticInt(match[1]), semanticInt(match[2])
		if month < 1 || month > 12 || day < 1 || day > 31 {
			return semanticDateValue{}, false
		}
		return semanticDateValue{time: time.Date(now.Year(), time.Month(month), day, semanticInt(match[3]), semanticInt(match[4]), 0, 0, time.Local), hasTime: match[3] != ""}, true
	}
	for _, layout := range []string{"Jan 2, 2006", "January 2, 2006", "Jan 2 2006", "January 2 2006"} {
		if parsed, err := time.ParseInLocation(layout, text, time.Local); nil == err {
			return semanticDateValue{time: parsed}, true
		}
	}
	return semanticDateValue{}, false
}

func semanticMutationTime(ms int64) time.Time {
	if ms <= 0 {
		return time.Now()
	}
	return time.UnixMilli(ms).In(time.Local)
}

func semanticMidnight(value time.Time) time.Time {
	return time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, value.Location())
}

func formatSemanticDate(value time.Time, hasTime bool) string {
	if hasTime {
		return value.Format("2006-01-02 15:04")
	}
	return value.Format("2006-01-02")
}

// ParseDateValue exposes the shared planning wall-clock grammar to the Go
// agenda model without making callers duplicate date normalization.
func ParseDateValue(raw string, now time.Time) (value time.Time, hasTime, ok bool) {
	parsed, ok := parseSemanticDate(raw, now)
	if !ok {
		return time.Time{}, false, false
	}
	return parsed.time, parsed.hasTime, true
}

// Midnight returns local calendar midnight for agenda day arithmetic.
func Midnight(value time.Time) time.Time { return semanticMidnight(value) }

func normalizeSemanticTodoStatus(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	switch value {
	case "", "open", "unchecked":
		return "todo"
	case "~", "-", "wip", "active":
		return "doing"
	case "x", "checked", "complete":
		return "done"
	case "!", "block":
		return "blocked"
	case "cancel", "canceled", "cancelled":
		return "cancelled"
	case "todo", "doing", "done", "blocked":
		return value
	default:
		return "todo"
	}
}

func appendSemanticDepRef(existing, ref string) string {
	parts := semanticNonEmptyParts(existing, "&")
	if !semanticContains(parts, ref) {
		parts = append(parts, ref)
	}
	return strings.Join(parts, " & ")
}

func semanticNonEmptyParts(raw, separator string) []string {
	ret := []string{}
	for _, part := range strings.Split(raw, separator) {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			ret = append(ret, trimmed)
		}
	}
	return ret
}

func removeSemanticAttrOrder(order []string, key string) []string {
	ret := order[:0]
	for _, candidate := range order {
		if candidate != key {
			ret = append(ret, candidate)
		}
	}
	return ret
}

func semanticContains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func semanticInt(raw string) int {
	value, _ := strconv.Atoi(raw)
	return value
}

func semanticIntDefault(raw string, fallback int) int {
	if raw == "" {
		return fallback
	}
	return semanticInt(raw)
}
