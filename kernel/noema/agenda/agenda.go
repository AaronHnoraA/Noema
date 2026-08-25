// Package agenda evaluates Noema planning items after the Markdown parser has
// produced source-faithful nodes. It owns vault-wide dependency resolution and
// urgency while callers retain host-specific page metadata and response shape.
package agenda

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	noemaplanning "github.com/aaronhe/noema/kernel/noema/planning"
)

type Todo struct {
	ID        string            `json:"id"`
	Status    string            `json:"status"`
	Text      string            `json:"text"`
	File      string            `json:"file"`
	NoteTitle string            `json:"noteTitle"`
	Index     int               `json:"index"`
	Line      int               `json:"line"`
	Source    string            `json:"source"`
	Canon     map[string]string `json:"canon"`
}

type PlanningItem struct {
	ID     string            `json:"id"`
	Status string            `json:"status"`
	Title  string            `json:"title"`
	Text   string            `json:"text"`
	File   string            `json:"file"`
	Index  int               `json:"index"`
	Line   int               `json:"line"`
	Source string            `json:"source"`
	Canon  map[string]string `json:"canon"`
	Args   map[string]string `json:"args,omitempty"`
	TodoID string            `json:"todoId,omitempty"`
}

type Evaluation struct {
	ID              string   `json:"id"`
	Deps            []string `json:"deps"`
	EffectiveStatus string   `json:"effectiveStatus"`
	BlockedBy       []string `json:"blockedBy"`
	Urgency         float64  `json:"urgency"`
}

type Candidate struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

type Lint struct {
	TodoID     string      `json:"todoId,omitempty"`
	File       string      `json:"file,omitempty"`
	Line       int         `json:"line,omitempty"`
	Kind       string      `json:"kind"`
	Ref        string      `json:"ref,omitempty"`
	Via        string      `json:"via,omitempty"`
	Message    string      `json:"message"`
	Candidates []Candidate `json:"candidates,omitempty"`
}

type EvaluateRequest struct {
	Todos           []Todo         `json:"todos"`
	Projects        []PlanningItem `json:"projects,omitempty"`
	Milestones      []PlanningItem `json:"milestones,omitempty"`
	Clocks          []PlanningItem `json:"clocks,omitempty"`
	TodayMs         int64          `json:"todayMs"`
	IncludePlanning bool           `json:"includePlanning,omitempty"`
	IncludeGantt    bool           `json:"includeGantt,omitempty"`
	IncludeView     bool           `json:"includeView,omitempty"`
	From            string         `json:"from,omitempty"`
	Days            int            `json:"days,omitempty"`
}

type EvaluateResult struct {
	Todos        []Evaluation      `json:"todos"`
	Lints        []Lint            `json:"lints"`
	Gantt        *GanttModel       `json:"gantt,omitempty"`
	Clocks       []ClockEvaluation `json:"clocks,omitempty"`
	Clocktable   *ClockModel       `json:"clocktable,omitempty"`
	ProjectModel []ProjectSummary  `json:"projectModel"`
	ClockLints   []Lint            `json:"clockLints,omitempty"`
	View         *AgendaView       `json:"view,omitempty"`
}

type AgendaRange struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Today string `json:"today"`
}

type AgendaEntry struct {
	Kind    string  `json:"kind"`
	Label   string  `json:"label"`
	TodoID  string  `json:"todoId"`
	Date    string  `json:"date"`
	DateKey string  `json:"dateKey"`
	Time    *string `json:"time"`
	Urgency float64 `json:"urgency"`
	Virtual bool    `json:"virtual,omitempty"`
}

type AgendaDay struct {
	Date    string        `json:"date"`
	Entries []AgendaEntry `json:"entries"`
}

type AgendaStats struct {
	Open      int `json:"open"`
	Doing     int `json:"doing"`
	Done      int `json:"done"`
	Cancelled int `json:"cancelled"`
	Blocked   int `json:"blocked"`
	Overdue   int `json:"overdue"`
}

type AgendaView struct {
	Range    AgendaRange    `json:"range"`
	Days     []AgendaDay    `json:"days"`
	LogByDay map[string]int `json:"logByDay"`
	Stats    AgendaStats    `json:"stats"`
}

type ClockEvaluation struct {
	TodoID string `json:"todoId"`
}

type ClockTask struct {
	TodoID        string `json:"todoId"`
	Text          string `json:"text"`
	File          string `json:"file"`
	Minutes       int    `json:"minutes"`
	EffortMinutes int    `json:"effortMinutes"`
}

type RunningClock struct {
	TodoID       string `json:"todoId"`
	Text         string `json:"text"`
	File         string `json:"file"`
	From         string `json:"from"`
	MinutesSoFar int    `json:"minutesSoFar"`
}

type ClockModel struct {
	Tasks     []ClockTask    `json:"tasks"`
	ByDay     map[string]int `json:"byDay"`
	ByProject map[string]int `json:"byProject"`
	Running   *RunningClock  `json:"running"`
}

type ProjectSummary struct {
	ID             string   `json:"id"`
	Key            string   `json:"key"`
	Title          string   `json:"title"`
	Status         string   `json:"status"`
	Area           string   `json:"area"`
	Phase          string   `json:"phase"`
	File           string   `json:"file"`
	Open           int      `json:"open"`
	Doing          int      `json:"doing"`
	Done           int      `json:"done"`
	Cancelled      int      `json:"cancelled"`
	Blocked        int      `json:"blocked"`
	Total          int      `json:"total"`
	Progress       float64  `json:"progress"`
	EffortMinutes  int      `json:"effortMinutes"`
	ClockedMinutes int      `json:"clockedMinutes"`
	ChildTodoIDs   []string `json:"childTodoIds"`
}

type GanttSource struct {
	File   string `json:"file"`
	Index  int    `json:"index"`
	Line   int    `json:"line"`
	Source string `json:"source"`
	Text   string `json:"text"`
}

type GanttTask struct {
	ID           string      `json:"id"`
	Name         string      `json:"name"`
	Project      string      `json:"project"`
	Status       string      `json:"status"`
	Source       GanttSource `json:"source"`
	Dependencies []string    `json:"dependencies"`
	Progress     float64     `json:"progress"`
	Start        string      `json:"start"`
	End          string      `json:"end"`
}

type GanttMilestone struct {
	ID      string      `json:"id"`
	Name    string      `json:"name"`
	Project string      `json:"project"`
	Date    string      `json:"date"`
	Source  GanttSource `json:"source"`
}

type GanttLane struct {
	ID           string   `json:"id"`
	Key          string   `json:"key"`
	Name         string   `json:"name"`
	Start        string   `json:"start"`
	End          string   `json:"end"`
	ChildTaskIDs []string `json:"childTaskIds"`
}

type GanttModel struct {
	Tasks      []GanttTask      `json:"tasks"`
	Backlog    []GanttTask      `json:"backlog"`
	Milestones []GanttMilestone `json:"milestones"`
	Lanes      []GanttLane      `json:"lanes"`
	Lints      []Lint           `json:"lints"`
}

type evaluatedTodo struct {
	Todo
	deps, blockedBy []string
	effectiveStatus string
}

type depRef struct {
	id, noteTitle, text, raw string
}

var (
	stableIDPattern       = regexp.MustCompile(`^#([A-Za-z0-9]+)$`)
	noteRefPattern        = regexp.MustCompile(`^\[\[([^]]+)]]::(.*)$`)
	leadPattern           = regexp.MustCompile(`(?i)^(\d+)\s*(d|day|days|w|week|weeks|m|month|months)?$`)
	agendaRepeaterPattern = regexp.MustCompile(`(?i)^(?:\+\+|\.\+|\+)?(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$`)
)

type agendaRepeater struct {
	n    int
	unit byte
}

// Evaluate decorates todos in their input order. The ordinal result shape
// lets Node merge the computed fields back without discarding Wiki/Git page
// metadata during the staged backend migration.
func Evaluate(request EvaluateRequest) EvaluateResult {
	now := time.Now()
	if request.TodayMs > 0 {
		now = time.UnixMilli(request.TodayMs).In(time.Local)
	}
	items := make([]*evaluatedTodo, 0, len(request.Todos))
	for _, todo := range request.Todos {
		copy := todo
		if nil == copy.Canon {
			copy.Canon = map[string]string{}
		}
		items = append(items, &evaluatedTodo{Todo: copy, deps: []string{}, blockedBy: []string{}})
	}
	lints := []Lint{}
	titleIndex := map[string]map[string]bool{}
	for _, todo := range items {
		key := normalizeTitle(todo.NoteTitle)
		if key == "" {
			continue
		}
		if nil == titleIndex[key] {
			titleIndex[key] = map[string]bool{}
		}
		titleIndex[key][todo.File] = true
	}

	byID := map[string]*evaluatedTodo{}
	for _, todo := range items {
		if strings.HasPrefix(todo.ID, "#") {
			if _, duplicate := byID[todo.ID]; duplicate {
				original := todo.ID
				todo.ID = fmt.Sprintf("%s:%d", todo.File, todo.Index)
				lints = append(lints, Lint{
					TodoID: todo.ID, File: todo.File, Line: todo.Line, Kind: "duplicate-id", Ref: original,
					Message: fmt.Sprintf(`Duplicate id %q; fell back to a positional id`, original),
				})
			}
		}
		byID[todo.ID] = todo
	}

	for _, todo := range items {
		if raw := todo.Canon["after"]; raw != "" {
			todo.deps = append(todo.deps, resolveTargets(todo, raw, titleIndex, items, byID, &lints, "after")...)
		}
	}
	for _, todo := range items {
		if raw := todo.Canon["blocks"]; raw != "" {
			for _, targetID := range resolveTargets(todo, raw, titleIndex, items, byID, &lints, "blocks") {
				if target := byID[targetID]; nil != target && !contains(target.deps, todo.ID) {
					target.deps = append(target.deps, todo.ID)
				}
			}
		}
	}

	results := make([]Evaluation, 0, len(items))
	for _, todo := range items {
		todo.deps = unique(todo.deps)
		open := []string{}
		for _, id := range todo.deps {
			if dependency := byID[id]; nil != dependency && dependency.Status != "done" && dependency.Status != "cancelled" {
				open = append(open, id)
			}
		}
		if (todo.Status == "todo" || todo.Status == "doing") && len(open) > 0 {
			todo.effectiveStatus = "blocked"
			todo.blockedBy = open
		} else {
			todo.effectiveStatus = todo.Status
			todo.blockedBy = []string{}
		}
		results = append(results, Evaluation{
			ID: todo.ID, Deps: todo.deps, EffectiveStatus: todo.effectiveStatus,
			BlockedBy: todo.blockedBy, Urgency: urgency(todo, now),
		})
	}
	ret := EvaluateResult{Todos: results, Lints: lints}
	if request.IncludeGantt {
		ret.Gantt = buildGantt(items, request.Projects, request.Milestones)
	}
	if request.IncludePlanning {
		clocks := append([]PlanningItem{}, request.Clocks...)
		clockLints := resolveClockReferences(clocks, items)
		clockLints = append(clockLints, lintClockSpans(clocks, now)...)
		ret.Clocks = make([]ClockEvaluation, len(clocks))
		for index := range clocks {
			ret.Clocks[index] = ClockEvaluation{TodoID: clocks[index].TodoID}
		}
		ret.Clocktable = buildClockTable(clocks, items, request.Projects, now)
		ret.ProjectModel = buildProjectSummaries(request.Projects, items, clocks, now)
		ret.ClockLints = clockLints
	}
	if request.IncludeView {
		ret.View = buildAgendaView(items, request.From, request.Days, now)
	}
	return ret
}

func resolveTargets(todo *evaluatedTodo, raw string, titleIndex map[string]map[string]bool, todos []*evaluatedTodo, byID map[string]*evaluatedTodo, lints *[]Lint, via string) []string {
	targets := []string{}
	for _, ref := range parseDepRefs(raw) {
		if ref.id != "" {
			target := byID["#"+ref.id]
			if nil != target && target.ID != todo.ID {
				targets = append(targets, target.ID)
			} else {
				*lints = append(*lints, Lint{TodoID: todo.ID, File: todo.File, Line: todo.Line, Kind: "broken-ref", Ref: ref.raw, Via: via, Message: fmt.Sprintf(`No todo with id %q`, ref.raw)})
			}
			continue
		}
		scopeFiles := map[string]bool{}
		if ref.noteTitle != "" {
			files := titleIndex[normalizeTitle(ref.noteTitle)]
			if len(files) == 0 {
				*lints = append(*lints, Lint{TodoID: todo.ID, File: todo.File, Line: todo.Line, Kind: "broken-ref", Ref: ref.raw, Via: via, Message: fmt.Sprintf(`No note titled %q`, ref.noteTitle)})
				continue
			}
			if len(files) > 1 {
				*lints = append(*lints, Lint{TodoID: todo.ID, File: todo.File, Line: todo.Line, Kind: "ambiguous-note", Ref: ref.raw, Via: via, Message: fmt.Sprintf(`Multiple notes titled %q`, ref.noteTitle)})
				continue
			}
			for file := range files {
				scopeFiles[file] = true
			}
		} else {
			scopeFiles[todo.File] = true
		}
		scope := []*evaluatedTodo{}
		for _, candidate := range todos {
			if scopeFiles[candidate.File] {
				scope = append(scope, candidate)
			}
		}
		tier, hits := matchTodo(scope, ref.text, todo.ID)
		switch tier {
		case "none":
			*lints = append(*lints, Lint{TodoID: todo.ID, File: todo.File, Line: todo.Line, Kind: "broken-ref", Ref: ref.raw, Via: via, Message: fmt.Sprintf(`No matching todo for %q`, ref.text)})
		case "ambiguous":
			candidates := make([]Candidate, 0, len(hits))
			for _, hit := range hits {
				candidates = append(candidates, Candidate{ID: hit.ID, Text: hit.Text})
			}
			*lints = append(*lints, Lint{TodoID: todo.ID, File: todo.File, Line: todo.Line, Kind: "ambiguous-ref", Ref: ref.raw, Via: via, Message: fmt.Sprintf(`Multiple todos match %q`, ref.text), Candidates: candidates})
		default:
			targets = append(targets, hits[0].ID)
		}
	}
	return targets
}

func buildAgendaView(todos []*evaluatedTodo, fromRaw string, requestedDays int, now time.Time) *AgendaView {
	today := noemaplanning.Midnight(now)
	from := today
	if parsed, _, ok := noemaplanning.ParseDateValue(fromRaw, now); ok && strings.TrimSpace(fromRaw) != "" {
		from = noemaplanning.Midnight(parsed)
	}
	days := requestedDays
	if days == 0 {
		days = 7
	}
	if days < 1 {
		days = 1
	} else if days > 90 {
		days = 90
	}
	view := &AgendaView{Days: make([]AgendaDay, 0, days), LogByDay: map[string]int{}}
	for index := 0; index < days; index++ {
		date := from.Add(time.Duration(index) * 24 * time.Hour).In(time.Local).Format("2006-01-02")
		view.Days = append(view.Days, AgendaDay{Date: date, Entries: []AgendaEntry{}})
	}
	buckets := map[string]*AgendaDay{}
	for index := range view.Days {
		buckets[view.Days[index].Date] = &view.Days[index]
	}
	todayKey := today.Format("2006-01-02")
	addEntry := func(date string, entry AgendaEntry) {
		if bucket := buckets[date]; nil != bucket {
			bucket.Entries = append(bucket.Entries, entry)
		}
	}
	addLogDate := func(raw string) {
		if parsed, _, ok := noemaplanning.ParseDateValue(raw, now); ok {
			view.LogByDay[parsed.Format("2006-01-02")]++
		}
	}
	for _, todo := range todos {
		urgencyScore := urgency(todo, now)
		if deadline := todo.Canon["ddl"]; deadline != "" {
			if parsed, _, ok := noemaplanning.ParseDateValue(deadline, now); ok {
				date := parsed.Format("2006-01-02")
				daysLeft := int(math.Round(parsed.Sub(today).Hours() / 24))
				open := todo.Status != "done" && todo.Status != "cancelled"
				if daysLeft < 0 {
					if open {
						addEntry(todayKey, agendaEntryFor(todo, "overdue", fmt.Sprintf("%d d ago:", -daysLeft), deadline, "ddl", urgencyScore, now))
					}
				} else {
					label := fmt.Sprintf("In %d d.", daysLeft)
					if daysLeft == 0 {
						label = "Deadline"
					}
					addEntry(date, agendaEntryFor(todo, "deadline", label, deadline, "ddl", urgencyScore, now))
					warn := parseLeadDays(todo.Canon["warn"], 14)
					if open && daysLeft > 0 && daysLeft <= warn {
						addEntry(todayKey, agendaEntryFor(todo, "warning", fmt.Sprintf("In %d d.", daysLeft), deadline, "ddl", urgencyScore, now))
					}
				}
			}
		}
		if scheduled := todo.Canon["sche"]; scheduled != "" {
			if parsed, _, ok := noemaplanning.ParseDateValue(scheduled, now); ok {
				date := parsed.Format("2006-01-02")
				if !parsed.Before(today) {
					addEntry(date, agendaEntryFor(todo, "scheduled", "Scheduled", scheduled, "sche", urgencyScore, now))
				} else if todo.Status != "done" && todo.Status != "cancelled" {
					late := int(math.Round(today.Sub(parsed).Hours() / 24))
					addEntry(todayKey, agendaEntryFor(todo, "sched-carry", fmt.Sprintf("Sched %dx:", late), scheduled, "sche", urgencyScore, now))
				}
			}
		}
		if done := todo.Canon["done"]; done != "" {
			addLogDate(done)
			if parsed, _, ok := noemaplanning.ParseDateValue(done, now); ok {
				addEntry(parsed.Format("2006-01-02"), agendaEntryFor(todo, "log", "Closed", done, "done", urgencyScore, now))
			}
		}
		if logValue := todo.Canon["log"]; logValue != "" {
			for _, raw := range strings.Split(logValue, "&") {
				date := strings.TrimSpace(raw)
				if date != "" && date != todo.Canon["done"] {
					addLogDate(date)
				}
			}
		}
		if repeatRaw := todo.Canon["repeat"]; repeatRaw != "" && todo.Status != "done" && todo.Status != "cancelled" {
			rangeEnd := from.Add(time.Duration(days) * 24 * time.Hour)
			for _, anchor := range []struct{ date, kind string }{{todo.Canon["ddl"], "deadline"}, {todo.Canon["sche"], "scheduled"}} {
				if anchor.date == "" {
					continue
				}
				for _, occurrence := range expandAgendaRepeats(anchor.date, repeatRaw, from, rangeEnd, now) {
					label := "Repeats"
					if anchor.kind == "scheduled" {
						label = "Repeats (sched)"
					}
					entry := AgendaEntry{Kind: "repeat", Label: label, TodoID: todo.ID, Date: occurrence.date, DateKey: occurrence.dateKey, Time: occurrence.time, Urgency: urgencyScore, Virtual: true}
					addEntry(occurrence.dateKey, entry)
				}
			}
		}
	}
	for index := range view.Days {
		sort.SliceStable(view.Days[index].Entries, func(i, j int) bool {
			a, b := view.Days[index].Entries[i], view.Days[index].Entries[j]
			if nil != a.Time && nil != b.Time {
				return *a.Time < *b.Time
			}
			if nil != a.Time {
				return true
			}
			if nil != b.Time {
				return false
			}
			return a.Urgency > b.Urgency
		})
	}
	for _, todo := range todos {
		if todo.effectiveStatus == "blocked" {
			view.Stats.Blocked++
		} else {
			switch todo.Status {
			case "todo":
				view.Stats.Open++
			case "doing":
				view.Stats.Doing++
			case "done":
				view.Stats.Done++
			case "cancelled":
				view.Stats.Cancelled++
			}
		}
		if deadline := todo.Canon["ddl"]; deadline != "" && todo.Status != "done" && todo.Status != "cancelled" {
			if parsed, _, ok := noemaplanning.ParseDateValue(deadline, now); ok && parsed.Before(today) {
				view.Stats.Overdue++
			}
		}
	}
	view.Range = AgendaRange{From: view.Days[0].Date, To: view.Days[len(view.Days)-1].Date, Today: todayKey}
	return view
}

func agendaEntryFor(todo *evaluatedTodo, kind, label, date, dateKey string, urgencyScore float64, now time.Time) AgendaEntry {
	var clockTime *string
	if parsed, hasTime, ok := noemaplanning.ParseDateValue(date, now); ok && hasTime {
		value := parsed.Format("15:04")
		clockTime = &value
	}
	return AgendaEntry{Kind: kind, Label: label, TodoID: todo.ID, Date: date, DateKey: dateKey, Time: clockTime, Urgency: urgencyScore}
}

type agendaOccurrence struct {
	date, dateKey string
	time          *string
}

func expandAgendaRepeats(rawDate, repeaterRaw string, rangeStart, rangeEnd, now time.Time) []agendaOccurrence {
	match := agendaRepeaterPattern.FindStringSubmatch(strings.TrimSpace(repeaterRaw))
	if nil == match {
		return []agendaOccurrence{}
	}
	n, _ := strconv.Atoi(match[1])
	unitRaw := strings.ToLower(match[2])
	unit := byte('y')
	if strings.HasPrefix(unitRaw, "d") {
		unit = 'd'
	} else if strings.HasPrefix(unitRaw, "w") {
		unit = 'w'
	} else if strings.HasPrefix(unitRaw, "m") {
		unit = 'm'
	}
	current := rawDate
	parsedAnchor, anchorHasTime, anchorOK := noemaplanning.ParseDateValue(rawDate, now)
	if anchorOK && parsedAnchor.Before(rangeStart) {
		if unit == 'd' || unit == 'w' {
			stepMs := float64(n) * 86400000
			if unit == 'w' {
				stepMs *= 7
			}
			if stepMs > 0 {
				k := int(math.Max(0, math.Floor(float64(rangeStart.Sub(parsedAnchor).Milliseconds())/stepMs)-1))
				if k > 0 {
					current = formatAgendaDate(shiftAgendaDate(parsedAnchor, k*n, unit), anchorHasTime)
				}
			}
		} else {
			for guard := 0; guard < 2400; guard++ {
				parsedCurrent, _, currentOK := noemaplanning.ParseDateValue(current, now)
				next := applyAgendaRepeater(current, n, unit, now)
				parsedNext, _, nextOK := noemaplanning.ParseDateValue(next, now)
				if !currentOK || !nextOK || !parsedNext.After(parsedCurrent) || !parsedNext.Before(rangeStart) {
					break
				}
				current = next
			}
		}
	}
	ret := []agendaOccurrence{}
	for guard := 0; guard < 366; guard++ {
		parsedCurrent, _, currentOK := noemaplanning.ParseDateValue(current, now)
		next := applyAgendaRepeater(current, n, unit, now)
		parsedNext, hasTime, nextOK := noemaplanning.ParseDateValue(next, now)
		if !currentOK || !nextOK || !parsedNext.After(parsedCurrent) || !parsedNext.Before(rangeEnd) {
			break
		}
		if !parsedNext.Before(rangeStart) {
			var clockTime *string
			if hasTime {
				value := parsedNext.Format("15:04")
				clockTime = &value
			}
			ret = append(ret, agendaOccurrence{date: next, dateKey: parsedNext.Format("2006-01-02"), time: clockTime})
		}
		current = next
	}
	return ret
}

func applyAgendaRepeater(raw string, n int, unit byte, now time.Time) string {
	parsed, hasTime, ok := noemaplanning.ParseDateValue(raw, now)
	if !ok {
		return raw
	}
	return formatAgendaDate(shiftAgendaDate(parsed, n, unit), hasTime)
}

func shiftAgendaDate(value time.Time, n int, unit byte) time.Time {
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

func formatAgendaDate(value time.Time, hasTime bool) string {
	if hasTime {
		return value.Format("2006-01-02 15:04")
	}
	return value.Format("2006-01-02")
}

func parseDepRefs(raw string) []depRef {
	refs := []depRef{}
	for _, part := range strings.Split(strings.TrimSpace(raw), "&") {
		piece := strings.TrimSpace(part)
		if piece == "" {
			continue
		}
		if match := stableIDPattern.FindStringSubmatch(piece); nil != match {
			refs = append(refs, depRef{id: match[1], raw: piece})
			continue
		}
		if match := noteRefPattern.FindStringSubmatch(piece); nil != match {
			if text := strings.TrimSpace(match[2]); text != "" {
				refs = append(refs, depRef{noteTitle: strings.TrimSpace(match[1]), text: text, raw: piece})
			}
			continue
		}
		refs = append(refs, depRef{text: piece, raw: piece})
	}
	return refs
}

func matchTodo(scope []*evaluatedTodo, needleText, excludeID string) (string, []*evaluatedTodo) {
	needle := normalizeTitle(needleText)
	candidates := []*evaluatedTodo{}
	for _, todo := range scope {
		if todo.ID != excludeID {
			candidates = append(candidates, todo)
		}
	}
	match := func(predicate func(string) bool) []*evaluatedTodo {
		ret := []*evaluatedTodo{}
		for _, todo := range candidates {
			if predicate(normalizeTitle(todo.Text)) {
				ret = append(ret, todo)
			}
		}
		return ret
	}
	for _, predicate := range []struct {
		name string
		fn   func(string) bool
	}{
		{"exact", func(text string) bool { return text == needle }},
		{"prefix", func(text string) bool { return strings.HasPrefix(text, needle) }},
		{"substring", func(text string) bool { return strings.Contains(text, needle) }},
	} {
		hits := match(predicate.fn)
		if len(hits) == 1 {
			return predicate.name, hits
		}
		if len(hits) > 1 {
			return "ambiguous", hits
		}
	}
	return "none", []*evaluatedTodo{}
}

func urgency(todo *evaluatedTodo, now time.Time) float64 {
	weights := map[string]float64{"A": 4, "B": 3, "C": 2, "D": 1, "E": 0, "F": -1}
	priority := strings.ToUpper(todo.Canon["prio"])
	weight, exists := weights[priority]
	if !exists {
		weight = weights["D"]
	}
	dateScore := float64(0)
	if deadline := todo.Canon["ddl"]; deadline != "" {
		if parsed, _, ok := noemaplanning.ParseDateValue(deadline, now); ok {
			today := noemaplanning.Midnight(now)
			daysLeft := math.Round(parsed.Sub(today).Hours() / 24)
			warn := math.Max(1, float64(parseLeadDays(todo.Canon["warn"], 14)))
			if daysLeft < 0 {
				dateScore = 500 + math.Min(-daysLeft, 10)*100
			} else {
				dateScore = math.Max(0, ((warn-daysLeft)*500)/warn)
			}
		}
	}
	doing := float64(0)
	if todo.Status == "doing" {
		doing = 50
	}
	blocked := float64(0)
	if todo.effectiveStatus == "blocked" {
		blocked = 2000
	}
	return weight*1000 + dateScore + doing - blocked
}

func parseLeadDays(raw string, fallback int) int {
	match := leadPattern.FindStringSubmatch(strings.TrimSpace(raw))
	if nil == match {
		return fallback
	}
	n, _ := strconv.Atoi(match[1])
	unit := strings.ToLower(match[2])
	if strings.HasPrefix(unit, "w") {
		return n * 7
	}
	if strings.HasPrefix(unit, "m") {
		return n * 30
	}
	return n
}

func buildGantt(todos []*evaluatedTodo, projects, milestones []PlanningItem) *GanttModel {
	model := &GanttModel{Tasks: []GanttTask{}, Backlog: []GanttTask{}, Milestones: []GanttMilestone{}, Lanes: []GanttLane{}, Lints: []Lint{}}
	for _, todo := range todos {
		start := todo.Canon["sche"]
		explicitEnd := todo.Canon["end"]
		end := explicitEnd
		if end == "" && start != "" {
			end = todo.Canon["ddl"]
		}
		displayEnd := explicitEnd
		if displayEnd == "" {
			displayEnd = todo.Canon["ddl"]
		}
		status := todo.effectiveStatus
		if status == "" {
			status = todo.Status
		}
		task := GanttTask{
			ID: todo.ID, Name: semanticTitle(todo.Text, "(empty todo)"),
			Project: inferPlanningProject(todo.File, todo.Index, todo.Canon, projects), Status: status,
			Source:       GanttSource{File: todo.File, Index: todo.Index, Line: todo.Line, Source: todo.Source, Text: todo.Text},
			Dependencies: append([]string{}, todo.deps...), Progress: ganttProgress(todo), Start: start, End: end,
		}
		if start != "" && end != "" {
			model.Tasks = append(model.Tasks, task)
		} else {
			task.End = displayEnd
			model.Backlog = append(model.Backlog, task)
			if explicitEnd != "" && start == "" && todo.Status != "done" && todo.Status != "cancelled" {
				model.Lints = append(model.Lints, Lint{TodoID: todo.ID, File: todo.File, Line: todo.Line, Kind: "missing-gantt-date", Ref: semanticTitle(todo.Text, todo.ID), Message: "Partially scheduled Gantt tasks need both sche/start and end/ddl"})
			}
		}
	}
	for _, milestone := range milestones {
		date := milestone.Canon["date"]
		if date == "" {
			model.Lints = append(model.Lints, Lint{TodoID: milestone.ID, File: milestone.File, Line: milestone.Line, Kind: "missing-milestone-date", Ref: semanticTitle(milestone.Title, semanticTitle(milestone.Text, semanticTitle(milestone.ID, "Milestone"))), Message: "Milestones need date"})
			continue
		}
		title := semanticTitle(milestone.Title, semanticTitle(milestone.Text, "Milestone"))
		model.Milestones = append(model.Milestones, GanttMilestone{
			ID: milestone.ID, Name: title,
			Project: inferPlanningProject(milestone.File, milestone.Index, milestone.Canon, projects), Date: date,
			Source: GanttSource{File: milestone.File, Index: milestone.Index, Line: milestone.Line, Source: milestone.Source, Text: milestone.Text},
		})
	}
	model.Lanes = buildGanttLanes(model.Tasks, projects)
	for _, cycle := range detectDependencyCycles(todos) {
		ref := strings.Join(cycle, " -> ")
		model.Lints = append(model.Lints, Lint{Kind: "cycle", Ref: ref, Message: "Dependency cycle: " + ref})
	}
	return model
}

func resolveClockReferences(clocks []PlanningItem, todos []*evaluatedTodo) []Lint {
	lints := []Lint{}
	byID := map[string]*evaluatedTodo{}
	titleIndex := map[string]map[string]bool{}
	for _, todo := range todos {
		byID[todo.ID] = todo
		key := normalizeTitle(todo.NoteTitle)
		if key != "" {
			if nil == titleIndex[key] {
				titleIndex[key] = map[string]bool{}
			}
			titleIndex[key][todo.File] = true
		}
	}
	for index := range clocks {
		clock := &clocks[index]
		clock.TodoID = ""
		refs := parseDepRefs(clock.Args["task"])
		if len(refs) > 0 && refs[0].id != "" {
			ref := refs[0]
			if target := byID["#"+ref.id]; nil != target {
				clock.TodoID = target.ID
				continue
			}
			lints = append(lints, Lint{File: clock.File, Line: clock.Line, Kind: "broken-clock-ref", Ref: ref.raw, Message: fmt.Sprintf(`No todo with id %q`, ref.raw)})
			continue
		}
		refs = parseDepRefs(semanticTitle(clock.Title, clock.Text))
		if len(refs) == 0 {
			continue
		}
		ref := refs[0]
		scopeFiles := map[string]bool{}
		if ref.noteTitle != "" {
			files := titleIndex[normalizeTitle(ref.noteTitle)]
			if len(files) == 0 {
				lints = append(lints, Lint{File: clock.File, Line: clock.Line, Kind: "broken-clock-ref", Ref: ref.raw, Message: fmt.Sprintf(`No note titled %q`, ref.noteTitle)})
				continue
			}
			if len(files) > 1 {
				lints = append(lints, Lint{File: clock.File, Line: clock.Line, Kind: "ambiguous-clock-ref", Ref: ref.raw, Message: fmt.Sprintf(`Multiple notes titled %q`, ref.noteTitle)})
				continue
			}
			for file := range files {
				scopeFiles[file] = true
			}
		} else {
			scopeFiles[clock.File] = true
		}
		scope := []*evaluatedTodo{}
		for _, todo := range todos {
			if scopeFiles[todo.File] {
				scope = append(scope, todo)
			}
		}
		tier, hits := matchTodo(scope, ref.text, "")
		if tier == "none" {
			lints = append(lints, Lint{File: clock.File, Line: clock.Line, Kind: "broken-clock-ref", Ref: ref.raw, Message: fmt.Sprintf(`No matching todo for %q`, ref.text)})
		} else if tier == "ambiguous" {
			candidates := make([]Candidate, 0, len(hits))
			for _, hit := range hits {
				candidates = append(candidates, Candidate{ID: hit.ID, Text: hit.Text})
			}
			lints = append(lints, Lint{File: clock.File, Line: clock.Line, Kind: "ambiguous-clock-ref", Ref: ref.raw, Message: fmt.Sprintf(`Multiple todos match %q`, ref.text), Candidates: candidates})
		} else {
			clock.TodoID = hits[0].ID
		}
	}
	return lints
}

func buildClockTable(clocks []PlanningItem, todos []*evaluatedTodo, projects []PlanningItem, now time.Time) *ClockModel {
	model := &ClockModel{Tasks: []ClockTask{}, ByDay: map[string]int{}, ByProject: map[string]int{}, Running: nil}
	byID := map[string]*evaluatedTodo{}
	byTaskIndex := map[string]int{}
	for _, todo := range todos {
		byID[todo.ID] = todo
	}
	for _, clock := range clocks {
		minutes := clockMinutes(clock, now)
		if clock.Args["from"] != "" && clock.Args["to"] == "" && nil == model.Running {
			model.Running = &RunningClock{TodoID: clock.TodoID, Text: semanticTitle(clock.Title, clock.Text), File: clock.File, From: clock.Args["from"], MinutesSoFar: minutes}
		}
		todo := byID[clock.TodoID]
		key := clock.TodoID
		if key == "" {
			key = fmt.Sprintf("%s:%d", clock.File, clock.Index)
		}
		position, exists := byTaskIndex[key]
		if !exists {
			text, file, effort := semanticTitle(clock.Title, clock.Text), clock.File, 0
			if nil != todo {
				text, file = todo.Text, todo.File
				effort, _ = parseDurationMinutes(todo.Canon["effort"])
			}
			model.Tasks = append(model.Tasks, ClockTask{TodoID: clock.TodoID, Text: text, File: file, EffortMinutes: effort})
			position = len(model.Tasks) - 1
			byTaskIndex[key] = position
		}
		model.Tasks[position].Minutes += minutes
		if from, _, ok := noemaplanning.ParseDateValue(clock.Args["from"], now); ok {
			day := noemaplanning.Midnight(from).Format("2006-01-02")
			model.ByDay[day] += minutes
		}
		if nil != todo {
			if project := inferPlanningProject(todo.File, todo.Index, todo.Canon, projects); project != "" {
				model.ByProject[project] += minutes
			}
		}
	}
	sort.SliceStable(model.Tasks, func(i, j int) bool { return model.Tasks[i].Minutes > model.Tasks[j].Minutes })
	return model
}

func buildProjectSummaries(projects []PlanningItem, todos []*evaluatedTodo, clocks []PlanningItem, now time.Time) []ProjectSummary {
	clockMinutesByTodo := map[string]int{}
	for _, clock := range clocks {
		if clock.TodoID != "" {
			clockMinutesByTodo[clock.TodoID] += clockMinutes(clock, now)
		}
	}
	entries := []ProjectSummary{}
	byKey := map[string]int{}
	progressByKey := map[string]*string{}
	for _, project := range projects {
		key := projectKey(project)
		status := project.Status
		if status == "" {
			status = "active"
		}
		entries = append(entries, ProjectSummary{
			ID: project.ID, Key: key, Title: semanticTitle(project.Title, semanticTitle(project.Text, key)),
			Status: status, Area: project.Canon["area"], Phase: project.Canon["phase"], File: project.File,
			ChildTodoIDs: []string{},
		})
		byKey[key] = len(entries) - 1
		if raw, exists := project.Canon["progress"]; exists {
			copy := raw
			progressByKey[key] = &copy
		}
	}
	for _, todo := range todos {
		key := inferPlanningProject(todo.File, todo.Index, todo.Canon, projects)
		position, exists := byKey[key]
		if !exists {
			continue
		}
		entry := &entries[position]
		entry.Total++
		entry.ChildTodoIDs = append(entry.ChildTodoIDs, todo.ID)
		if todo.effectiveStatus == "blocked" {
			entry.Blocked++
		} else {
			switch todo.Status {
			case "todo":
				entry.Open++
			case "doing":
				entry.Doing++
			case "done":
				entry.Done++
			case "cancelled":
				entry.Cancelled++
			}
		}
		if effort, ok := parseDurationMinutes(todo.Canon["effort"]); ok && effort != 0 {
			entry.EffortMinutes += effort
		}
		entry.ClockedMinutes += clockMinutesByTodo[todo.ID]
	}
	for index := range entries {
		entry := &entries[index]
		if raw := progressByKey[entry.Key]; nil != raw {
			value, err := strconv.ParseFloat(*raw, 64)
			if nil != err {
				value = 0
			}
			entry.Progress = math.Max(0, math.Min(100, value))
		} else {
			countable := entry.Total - entry.Cancelled
			if countable > 0 {
				entry.Progress = math.Round((float64(entry.Done) / float64(countable)) * 100)
			}
		}
	}
	sort.SliceStable(entries, func(i, j int) bool {
		return entries[i].Total > entries[j].Total || entries[i].Total == entries[j].Total && entries[i].Title < entries[j].Title
	})
	return entries
}

type clockSpan struct {
	clock    PlanningItem
	from, to time.Time
}

func lintClockSpans(clocks []PlanningItem, now time.Time) []Lint {
	lints, open, spans := []Lint{}, []PlanningItem{}, []clockSpan{}
	for _, clock := range clocks {
		from, _, ok := noemaplanning.ParseDateValue(clock.Args["from"], now)
		if !ok {
			continue
		}
		toRaw := clock.Args["to"]
		if toRaw == "" {
			open = append(open, clock)
			spans = append(spans, clockSpan{clock: clock, from: from, to: now})
			continue
		}
		to, _, ok := noemaplanning.ParseDateValue(toRaw, now)
		if !ok {
			continue
		}
		if to.Before(from) {
			lints = append(lints, Lint{File: clock.File, Line: clock.Line, Kind: "reversed-clock-span", Ref: clock.Source, TodoID: clock.TodoID, Message: "Clock ends before it starts (counted as 0 min)"})
			continue
		}
		spans = append(spans, clockSpan{clock: clock, from: from, to: to})
	}
	if len(open) > 1 {
		sort.SliceStable(open, func(i, j int) bool { return open[i].Args["from"] < open[j].Args["from"] })
		for _, clock := range open[1:] {
			lints = append(lints, Lint{File: clock.File, Line: clock.Line, Kind: "multiple-running-clocks", Ref: clock.Source, TodoID: clock.TodoID, Message: "Multiple running clocks; only the first is shown as running"})
		}
	}
	sort.SliceStable(spans, func(i, j int) bool { return spans[i].from.Before(spans[j].from) })
	var maxTo time.Time
	for _, span := range spans {
		if !maxTo.IsZero() && span.from.Before(maxTo) {
			lints = append(lints, Lint{File: span.clock.File, Line: span.clock.Line, Kind: "overlapping-clocks", Ref: span.clock.Source, TodoID: span.clock.TodoID, Message: "Overlaps another clock; totals over-count"})
		}
		if maxTo.IsZero() || span.to.After(maxTo) {
			maxTo = span.to
		}
	}
	return lints
}

func clockMinutes(clock PlanningItem, now time.Time) int {
	from, _, ok := noemaplanning.ParseDateValue(clock.Args["from"], now)
	if !ok {
		return 0
	}
	end := now
	if raw := clock.Args["to"]; raw != "" {
		if parsed, _, valid := noemaplanning.ParseDateValue(raw, now); valid {
			end = parsed
		}
	}
	return int(math.Max(0, math.Round(end.Sub(from).Minutes())))
}

var (
	durationHMPattern    = regexp.MustCompile(`^(\d+):([0-5]\d)$`)
	durationValuePattern = regexp.MustCompile(`(?i)^(\d+(?:\.\d+)?)\s*(d|day|days|h|hour|hours|m|min|mins|minute|minutes)?$`)
)

func parseDurationMinutes(raw string) (int, bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return 0, false
	}
	if match := durationHMPattern.FindStringSubmatch(text); nil != match {
		hours, _ := strconv.Atoi(match[1])
		minutes, _ := strconv.Atoi(match[2])
		return hours*60 + minutes, true
	}
	match := durationValuePattern.FindStringSubmatch(text)
	if nil == match {
		return 0, false
	}
	value, _ := strconv.ParseFloat(match[1], 64)
	unit := strings.ToLower(match[2])
	if unit == "" || strings.HasPrefix(unit, "h") {
		value *= 60
	} else if strings.HasPrefix(unit, "d") {
		value *= 8 * 60
	}
	return int(math.Round(value)), true
}

func buildGanttLanes(tasks []GanttTask, projects []PlanningItem) []GanttLane {
	byKey := map[string][]GanttTask{}
	for _, task := range tasks {
		byKey[task.Project] = append(byKey[task.Project], task)
	}
	lanes := []GanttLane{}
	for _, project := range projects {
		key := projectKey(project)
		children := byKey[key]
		start := project.Canon["sche"]
		end := project.Canon["end"]
		if end == "" {
			end = project.Canon["ddl"]
		}
		if start == "" {
			starts := []string{}
			for _, child := range children {
				starts = append(starts, child.Start)
			}
			sort.Strings(starts)
			if len(starts) > 0 {
				start = starts[0]
			}
		}
		if end == "" {
			ends := []string{}
			for _, child := range children {
				ends = append(ends, child.End)
			}
			sort.Strings(ends)
			if len(ends) > 0 {
				end = ends[len(ends)-1]
			}
		}
		if start == "" || end == "" {
			continue
		}
		ids := make([]string, 0, len(children))
		for _, child := range children {
			ids = append(ids, child.ID)
		}
		lanes = append(lanes, GanttLane{ID: project.ID, Key: key, Name: semanticTitle(project.Title, semanticTitle(project.Text, key)), Start: start, End: end, ChildTaskIDs: ids})
	}
	return lanes
}

func inferPlanningProject(file string, index int, canon map[string]string, projects []PlanningItem) string {
	if explicit := canon["project"]; explicit != "" {
		return explicit
	}
	bestIndex := -1
	best := ""
	for _, project := range projects {
		if project.File == file && project.Index < index && project.Index > bestIndex {
			bestIndex = project.Index
			best = projectSlug(semanticTitle(project.Title, project.Text))
		}
	}
	return best
}

func projectKey(project PlanningItem) string {
	if explicit := project.Canon["project"]; explicit != "" {
		return explicit
	}
	return projectSlug(semanticTitle(project.Title, project.Text))
}

func projectSlug(raw string) string {
	var out strings.Builder
	dash := false
	for _, r := range strings.ToLower(strings.TrimSpace(raw)) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r >= 0x4e00 && r <= 0x9fff {
			out.WriteRune(r)
			dash = false
		} else if out.Len() > 0 && !dash {
			out.WriteByte('-')
			dash = true
		}
	}
	ret := strings.Trim(out.String(), "-")
	if ret == "" {
		return "inbox"
	}
	return ret
}

func ganttProgress(todo *evaluatedTodo) float64 {
	if raw, exists := todo.Canon["progress"]; exists {
		value, err := strconv.ParseFloat(raw, 64)
		if nil != err {
			value = 0
		}
		return math.Max(0, math.Min(100, value))
	}
	if todo.Status == "done" {
		return 100
	}
	return 0
}

func detectDependencyCycles(todos []*evaluatedTodo) [][]string {
	byID := map[string]*evaluatedTodo{}
	for _, todo := range todos {
		byID[todo.ID] = todo
	}
	visiting, visited := map[string]bool{}, map[string]bool{}
	cycles := [][]string{}
	var visit func(string, []string)
	visit = func(id string, stack []string) {
		if visiting[id] {
			at := 0
			for index, candidate := range stack {
				if candidate == id {
					at = index
					break
				}
			}
			cycle := append([]string{}, stack[at:]...)
			cycles = append(cycles, append(cycle, id))
			return
		}
		if visited[id] {
			return
		}
		visiting[id] = true
		if todo := byID[id]; nil != todo {
			for _, dependency := range todo.deps {
				visit(dependency, append(stack, dependency))
			}
		}
		delete(visiting, id)
		visited[id] = true
	}
	for _, todo := range todos {
		visit(todo.ID, []string{todo.ID})
	}
	return cycles
}

func semanticTitle(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}

func normalizeTitle(value string) string { return strings.ToLower(strings.TrimSpace(value)) }

func unique(values []string) []string {
	ret := []string{}
	for _, value := range values {
		if !contains(ret, value) {
			ret = append(ret, value)
		}
	}
	return ret
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
