// Noema research notebook index is Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

// Package research owns the repository-local research index and event ledger
// stored under `<repository>/.agent/`. Research notebook files remain the only
// authority for declared structure; this package only derives an index from
// them and records semantic history.
package research

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/aaronhe/noema/kernel/noema/planning"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	// NotebookSchema identifies the canonical .noema work-document model.
	NotebookSchema = "noema.work-document/2"
	// LegacyNotebookSchema placed WorkNode semantics directly on cells.
	LegacyNotebookSchema = "noema.research-notebook/1"
	// Namespace is the notebook and cell metadata namespace owned by research.
	Namespace = "noema_research"
)

var (
	cellIDPattern         = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	agendaProgressPattern = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+)?$`)
	agendaClockIDPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	graphKinds            = map[string]bool{"question": true, "work": true, "checkpoint": true}
)

// ErrNotResearchNotebook reports a notebook without the research schema.
var ErrNotResearchNotebook = errors.New("not a Noema research notebook")

// Cell is the indexed projection of one notebook cell.
type Cell struct {
	ID            string   `json:"id"`
	CellType      string   `json:"cellType"`
	Kind          string   `json:"kind"`
	Title         string   `json:"title"`
	Source        string   `json:"source"`
	Disclosure    string   `json:"disclosure,omitempty"`
	WorkNodeID    string   `json:"workNodeId,omitempty"`
	State         string   `json:"state,omitempty"`
	Outcome       string   `json:"outcome,omitempty"`
	DroppedReason string   `json:"droppedReason,omitempty"`
	Of            string   `json:"of,omitempty"`
	Lineage       []string `json:"lineage"`
	Depends       []string `json:"depends"`
	Ordinal       int      `json:"ordinal"`
	SourceSHA256  string   `json:"sourceSha256"`
	OutputsSHA256 string   `json:"outputsSha256,omitempty"`
	LatestOutput  string   `json:"latestOutput,omitempty"`
	LatestRunID   string   `json:"latestRunId,omitempty"`
	OutputStatus  string   `json:"outputStatus,omitempty"`
	OutputAgent   string   `json:"outputAgent,omitempty"`
}

// WorkNode is a durable unit in the project work graph. Agenda is projected
// from its primary Cell's visible @@todo / @@clock commands.
type WorkNode struct {
	ID            string          `json:"id"`
	Kind          string          `json:"kind"`
	Title         string          `json:"title"`
	State         string          `json:"state,omitempty"`
	Outcome       string          `json:"outcome,omitempty"`
	DroppedReason string          `json:"droppedReason,omitempty"`
	Disclosure    string          `json:"disclosure,omitempty"`
	Agenda        json.RawMessage `json:"agenda,omitempty"`
}

// Dependency is one explicit WorkNode relationship.
type Dependency struct {
	ID   string `json:"id"`
	From string `json:"from"`
	To   string `json:"to"`
	Type string `json:"type"`
}

// Notebook is the indexed projection of a research notebook.
type Notebook struct {
	ID           string       `json:"notebookId"`
	WorkstreamID string       `json:"workstreamId,omitempty"`
	Title        string       `json:"title"`
	Cells        []Cell       `json:"cells"`
	WorkNodes    []WorkNode   `json:"workNodes"`
	Dependencies []Dependency `json:"dependencies"`
}

type rawCellMeta struct {
	Kind          string   `json:"kind"`
	Title         string   `json:"title"`
	State         string   `json:"state"`
	Outcome       string   `json:"outcome"`
	DroppedReason string   `json:"dropped_reason"`
	Of            string   `json:"of"`
	Lineage       []string `json:"lineage"`
	Depends       []string `json:"depends"`
	Disclosure    string   `json:"disclosure"`
	WorkNodeID    string   `json:"work_node_id"`
}

type rawWorkNode struct {
	ID            string          `json:"id"`
	Kind          string          `json:"kind"`
	Title         string          `json:"title"`
	State         string          `json:"state"`
	Outcome       string          `json:"outcome"`
	DroppedReason string          `json:"dropped_reason"`
	Disclosure    string          `json:"disclosure"`
	Agenda        json.RawMessage `json:"agenda,omitempty"`
}

type rawNotebook struct {
	NBFormat      int `json:"nbformat"`
	NBFormatMinor int `json:"nbformat_minor"`
	Metadata      struct {
		KernelSpec   json.RawMessage `json:"kernelspec"`
		LanguageInfo json.RawMessage `json:"language_info"`
		Research     *struct {
			Schema       string        `json:"schema"`
			NotebookID   string        `json:"notebook_id"`
			WorkstreamID string        `json:"workstream_id"`
			Title        string        `json:"title"`
			WorkNodes    []rawWorkNode `json:"work_nodes"`
			Dependencies []Dependency  `json:"dependencies"`
		} `json:"noema_research"`
	} `json:"metadata"`
	Cells []struct {
		ID             string          `json:"id"`
		CellType       string          `json:"cell_type"`
		Source         json.RawMessage `json:"source"`
		Outputs        json.RawMessage `json:"outputs"`
		ExecutionCount json.RawMessage `json:"execution_count"`
		Metadata       struct {
			Research *rawCellMeta `json:"noema_research"`
		} `json:"metadata"`
	} `json:"cells"`
}

// IsGraphKind reports whether kind is a research graph node kind.
func IsGraphKind(kind string) bool {
	return graphKinds[kind]
}

// Revision returns the canonical content revision of notebook bytes.
func Revision(data []byte) string {
	return "sha256:" + sha256Hex(data)
}

// ParseNotebook validates and projects research notebook JSON.
func ParseNotebook(data []byte) (Notebook, error) {
	var raw rawNotebook
	if err := json.Unmarshal(data, &raw); err != nil {
		return Notebook{}, fmt.Errorf("invalid research notebook JSON: %w", err)
	}
	meta := raw.Metadata.Research
	if meta == nil || (meta.Schema != NotebookSchema && meta.Schema != LegacyNotebookSchema) {
		return Notebook{}, ErrNotResearchNotebook
	}
	if strings.TrimSpace(meta.NotebookID) == "" {
		return Notebook{}, errors.New("noema_research.notebook_id is required")
	}
	notebook := Notebook{
		ID:           strings.TrimSpace(meta.NotebookID),
		WorkstreamID: strings.TrimSpace(meta.WorkstreamID),
		Title:        meta.Title,
		Cells:        make([]Cell, 0, len(raw.Cells)),
		WorkNodes:    []WorkNode{},
		Dependencies: []Dependency{},
	}
	legacy := meta.Schema == LegacyNotebookSchema
	// Early .noema writers could stamp the v2 schema before moving graph
	// fields out of cells. Treat that narrow mixed shape as migration input.
	if !legacy && len(meta.WorkNodes) == 0 {
		for _, rawCell := range raw.Cells {
			if m := rawCell.Metadata.Research; m != nil && graphKinds[m.Kind] {
				legacy = true
				break
			}
		}
	}
	if !legacy {
		if raw.NBFormat != 4 || raw.NBFormatMinor != 5 {
			return Notebook{}, errors.New("Noema work documents require nbformat 4.5")
		}
		if len(raw.Metadata.KernelSpec) > 0 || len(raw.Metadata.LanguageInfo) > 0 {
			return Notebook{}, errors.New("Noema work documents cannot declare Jupyter kernel metadata")
		}
	}
	nodeByID := map[string]WorkNode{}
	nodeIndex := map[string]int{}
	if !legacy {
		for _, item := range meta.WorkNodes {
			id := strings.TrimSpace(item.ID)
			if !strings.HasPrefix(id, "wn_") || len(id) > 96 {
				return Notebook{}, fmt.Errorf("invalid WorkNode id %q", id)
			}
			if _, exists := nodeByID[id]; exists {
				return Notebook{}, fmt.Errorf("duplicate WorkNode id %q", id)
			}
			if !graphKinds[item.Kind] {
				return Notebook{}, fmt.Errorf("WorkNode %q has unsupported kind %q", id, item.Kind)
			}
			if len(item.Agenda) > 0 && string(item.Agenda) != "null" {
				return Notebook{}, fmt.Errorf("WorkNode %q: Agenda belongs in the primary Cell's visible @@todo / @@clock commands", id)
			}
			node := WorkNode{ID: id, Kind: item.Kind, Title: item.Title, State: item.State,
				Outcome: item.Outcome, DroppedReason: item.DroppedReason, Disclosure: item.Disclosure}
			nodeIndex[id] = len(notebook.WorkNodes)
			notebook.WorkNodes = append(notebook.WorkNodes, node)
			nodeByID[id] = node
		}
		for _, edge := range meta.Dependencies {
			if edge.Type != "lineage" && edge.Type != "depends" {
				return Notebook{}, fmt.Errorf("dependency %q has unsupported type %q", edge.ID, edge.Type)
			}
			_, fromExists := nodeByID[edge.From]
			_, toExists := nodeByID[edge.To]
			_ = fromExists
			_ = toExists
			notebook.Dependencies = append(notebook.Dependencies, edge)
		}
	}
	seen := make(map[string]bool, len(raw.Cells))
	legacyBindings := map[string]string{}
	if legacy {
		for _, rawCell := range raw.Cells {
			m := rawCell.Metadata.Research
			if m == nil || !graphKinds[m.Kind] {
				continue
			}
			id := legacyWorkNodeID(notebook.ID, rawCell.ID)
			legacyBindings[rawCell.ID] = id
			node := WorkNode{ID: id, Kind: m.Kind, Title: m.Title, State: m.State, Outcome: m.Outcome,
				DroppedReason: m.DroppedReason, Disclosure: m.Disclosure}
			nodeIndex[id] = len(notebook.WorkNodes)
			notebook.WorkNodes = append(notebook.WorkNodes, node)
			nodeByID[id] = node
		}
		for _, rawCell := range raw.Cells {
			m, to := rawCell.Metadata.Research, legacyBindings[rawCell.ID]
			if m == nil || to == "" {
				continue
			}
			for typ, parents := range map[string][]string{"lineage": m.Lineage, "depends": m.Depends} {
				for _, parentCellID := range uniqueStrings(parents) {
					from := legacyBindings[parentCellID]
					if from == "" {
						from = legacyWorkNodeID(notebook.ID, parentCellID)
					}
					if from != to {
						notebook.Dependencies = append(notebook.Dependencies, Dependency{
							ID: dependencyID(from, to, typ), From: from, To: to, Type: typ,
						})
					}
				}
			}
		}
	}
	if err := validateWorkDAG(nodeByID, notebook.Dependencies); err != nil {
		return Notebook{}, err
	}
	parents := map[string]map[string][]string{}
	for _, edge := range notebook.Dependencies {
		if parents[edge.To] == nil {
			parents[edge.To] = map[string][]string{}
		}
		parents[edge.To][edge.Type] = append(parents[edge.To][edge.Type], edge.From)
	}
	for index, rawCell := range raw.Cells {
		if !cellIDPattern.MatchString(rawCell.ID) {
			return Notebook{}, fmt.Errorf("cell %d has invalid id %q", index, rawCell.ID)
		}
		if seen[rawCell.ID] {
			return Notebook{}, fmt.Errorf("duplicate cell id %q", rawCell.ID)
		}
		seen[rawCell.ID] = true
		source, err := notebookSource(rawCell.Source)
		if err != nil {
			return Notebook{}, fmt.Errorf("cell %q: %w", rawCell.ID, err)
		}
		cell := Cell{
			ID:           rawCell.ID,
			CellType:     rawCell.CellType,
			Ordinal:      index,
			Lineage:      []string{},
			Depends:      []string{},
			SourceSHA256: sha256Hex([]byte(source)),
			Source:       source,
		}
		if len(rawCell.Outputs) > 0 {
			cell.OutputsSHA256 = sha256Hex(rawCell.Outputs)
			cell.LatestOutput, cell.LatestRunID, cell.OutputStatus, cell.OutputAgent, err = latestWorkOutput(rawCell.Outputs)
			if err != nil {
				return Notebook{}, fmt.Errorf("cell %q: %w", rawCell.ID, err)
			}
		}
		if m := rawCell.Metadata.Research; m != nil {
			if m.Kind != "" && !(legacy && (graphKinds[m.Kind] || m.Kind == "result")) {
				return Notebook{}, fmt.Errorf("cell %q has unsupported research kind %q", rawCell.ID, m.Kind)
			}
			cell.Kind = m.Kind
			cell.WorkNodeID = strings.TrimSpace(m.WorkNodeID)
			if legacy {
				cell.WorkNodeID = legacyBindings[rawCell.ID]
				if m.Kind == "result" {
					cell.WorkNodeID = legacyBindings[m.Of]
				}
			}
			if node, ok := nodeByID[cell.WorkNodeID]; ok {
				if cell.Kind != "result" {
					if rawCell.CellType == "code" && node.Kind == "work" {
						cell.Kind = "work"
					} else if rawCell.CellType == "markdown" && node.Kind != "work" {
						cell.Kind = node.Kind
					}
				}
				cell.Title, cell.State, cell.Outcome = node.Title, node.State, node.Outcome
				cell.DroppedReason, cell.Disclosure = node.DroppedReason, node.Disclosure
				cell.Lineage = uniqueStrings(parents[node.ID]["lineage"])
				cell.Depends = uniqueStrings(parents[node.ID]["depends"])
				if cell.Kind == "result" {
					cell.Of = node.ID
				}
			}
		}
		if !legacy {
			switch rawCell.CellType {
			case "code":
				node, ok := nodeByID[cell.WorkNodeID]
				if !ok || node.Kind != "work" {
					return Notebook{}, fmt.Errorf("cell %q code storage must bind a work WorkNode", rawCell.ID)
				}
				if string(rawCell.ExecutionCount) != "null" || len(rawCell.Outputs) == 0 || string(rawCell.Outputs) == "null" {
					return Notebook{}, fmt.Errorf("cell %q work storage requires null execution_count and outputs", rawCell.ID)
				}
				cell.Kind = "work"
			case "markdown":
				if len(rawCell.ExecutionCount) > 0 || len(rawCell.Outputs) > 0 {
					return Notebook{}, fmt.Errorf("cell %q markdown storage cannot carry runtime fields", rawCell.ID)
				}
				if cell.Kind == "" {
					cell.Kind = "note"
				}
			default:
				return Notebook{}, fmt.Errorf("cell %q has unsupported cell_type %q", rawCell.ID, rawCell.CellType)
			}
		} else if cell.Kind == "" {
			if rawCell.CellType == "code" {
				cell.Kind = "code"
			} else {
				cell.Kind = "note"
			}
		}
		notebook.Cells = append(notebook.Cells, cell)
	}
	primarySeen := map[string]bool{}
	for _, cell := range notebook.Cells {
		node, ok := nodeByID[cell.WorkNodeID]
		if !ok || primarySeen[node.ID] || (node.Kind == "work") != (cell.CellType == "code") {
			continue
		}
		primarySeen[node.ID] = true
		agenda, present, err := parseWorkAgendaDirective(cell.Source, node.Kind)
		if err != nil {
			return Notebook{}, fmt.Errorf("WorkNode %q: %w", node.ID, err)
		}
		if present {
			node.Agenda = agenda
			notebook.WorkNodes[nodeIndex[node.ID]] = node
			nodeByID[node.ID] = node
		}
	}
	return notebook, nil
}

// parseWorkAgendaDirective reads leading Markdown @@todo / @@clock commands.
// Planning commands after ordinary body text remain user content.
func parseWorkAgendaDirective(source, kind string) (json.RawMessage, bool, error) {
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(source, "\r\n", "\n"), "\r", "\n"), "\n")
	values := map[string]any{}
	clocks := []map[string]string{}
	found := false
	aliases := map[string]string{"due": "ddl", "deadline": "ddl", "scheduled": "sche", "start": "sche", "priority": "prio", "proj": "project", "ctx": "context", "pct": "progress", "finish": "end"}
	parseAttrs := func(parts []string) (map[string]string, error) {
		attrs := map[string]string{}
		for _, part := range parts {
			part = strings.TrimSpace(strings.TrimSuffix(part, ","))
			if part == "" || strings.HasPrefix(part, "#") || strings.HasPrefix(part, "//") {
				continue
			}
			pair := regexp.MustCompile(`^([A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*(.*?)\s*$`).FindStringSubmatch(part)
			if pair == nil {
				return nil, fmt.Errorf("malformed planning attribute: %s", part)
			}
			key, value := strings.ToLower(pair[1]), strings.Trim(strings.TrimSpace(pair[2]), `"'`)
			if canonical := aliases[key]; canonical != "" {
				key = canonical
			}
			if _, exists := attrs[key]; exists {
				return nil, fmt.Errorf("duplicate agenda field: %s", key)
			}
			if value != "" {
				attrs[key] = value
			}
		}
		return attrs, nil
	}
	command := regexp.MustCompile(`^@@(todo|clock)(?:\(([^)\n]*)\))?\s+\[(.*)\]\s*(\{.*)$`)
	for i := 0; i < len(lines); {
		line := lines[i]
		if strings.TrimSpace(line) == "" {
			i++
			continue
		}
		if regexp.MustCompile(`^@@[A-Za-z][A-Za-z0-9_-]*\(.*\)\s*$`).MatchString(line) {
			i++
			continue
		}
		match := command.FindStringSubmatch(line)
		if match == nil {
			break
		}
		commandKind, status, rawAttrs := match[1], strings.TrimSpace(match[2]), strings.TrimSpace(match[4])
		var attrParts []string
		if strings.HasSuffix(rawAttrs, "}") {
			attrParts = strings.Split(strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(rawAttrs, "{"), "}")), ",")
			i++
		} else if rawAttrs == "{" {
			closed := false
			for i = i + 1; i < len(lines); i++ {
				if strings.TrimSpace(lines[i]) == "}" {
					closed = true
					i++
					break
				}
				attrParts = append(attrParts, lines[i])
			}
			if !closed {
				return nil, false, errors.New("unclosed planning attribute block")
			}
		} else {
			return nil, false, errors.New("malformed planning attribute block")
		}
		attrs, err := parseAttrs(attrParts)
		if err != nil {
			return nil, false, err
		}
		if commandKind == "todo" {
			if found {
				return nil, false, errors.New("only one leading @@todo is allowed")
			}
			found = true
			for key, value := range attrs {
				values[key] = value
			}
			if kind != "work" && status != "" && status != "todo" {
				values["status"] = status
			}
		} else {
			if !found {
				return nil, false, errors.New("@@clock requires a leading @@todo")
			}
			clock := map[string]string{"id": attrs["id"], "from": attrs["from"]}
			if attrs["to"] != "" {
				clock["to"] = attrs["to"]
			}
			clocks = append(clocks, clock)
		}
	}
	if !found {
		return nil, false, nil
	}
	if len(clocks) > 0 {
		values["clocks"] = clocks
	}
	raw, err := json.Marshal(values)
	if err != nil {
		return nil, false, err
	}
	if err := validateWorkAgenda(raw, kind); err != nil {
		return nil, false, err
	}
	return raw, true, nil
}

func validateWorkDAG(nodes map[string]WorkNode, dependencies []Dependency) error {
	parents := map[string][]string{}
	seen := map[string]bool{}
	for _, edge := range dependencies {
		if edge.From == edge.To && edge.From != "" {
			return fmt.Errorf("dependency %q makes WorkNode %q depend on itself", edge.ID, edge.From)
		}
		key := edge.From + "\x00" + edge.To + "\x00" + edge.Type
		if seen[key] {
			return fmt.Errorf("duplicate dependency %q -> %q (%s)", edge.From, edge.To, edge.Type)
		}
		seen[key] = true
		if _, ok := nodes[edge.From]; !ok {
			continue
		}
		if _, ok := nodes[edge.To]; !ok {
			continue
		}
		parents[edge.To] = append(parents[edge.To], edge.From)
	}
	marks := map[string]uint8{}
	var visit func(string) bool
	visit = func(id string) bool {
		marks[id] = 1
		for _, parent := range parents[id] {
			if marks[parent] == 1 || (marks[parent] == 0 && visit(parent)) {
				return true
			}
		}
		marks[id] = 2
		return false
	}
	for id := range nodes {
		if marks[id] == 0 && visit(id) {
			return fmt.Errorf("work dependencies form a cycle involving %q", id)
		}
	}
	return nil
}

func legacyWorkNodeID(notebookID, cellID string) string {
	return "wn_legacy_" + sha256Hex([]byte(notebookID + "\x00" + cellID))[:24]
}

func dependencyID(from, to, typ string) string {
	return "dep_" + sha256Hex([]byte(from + "\x00" + to + "\x00" + typ))[:24]
}

func notebookSource(raw json.RawMessage) (string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", nil
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text, nil
	}
	var parts []string
	if err := json.Unmarshal(raw, &parts); err != nil {
		return "", errors.New("source must be a string or an array of strings")
	}
	return strings.Join(parts, ""), nil
}

func latestWorkOutput(raw json.RawMessage) (text, runID, status, agent string, err error) {
	var outputs []struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if err = json.Unmarshal(raw, &outputs); err != nil {
		return "", "", "", "", errors.New("outputs must be an array")
	}
	for index := len(outputs) - 1; index >= 0; index-- {
		data := outputs[index].Data
		if data == nil {
			continue
		}
		if value := data["text/markdown"]; len(value) > 0 {
			text, _ = notebookSource(value)
		}
		if text == "" {
			if value := data["text/plain"]; len(value) > 0 {
				text, _ = notebookSource(value)
			}
		}
		if value := data["application/vnd.noema.run+json"]; len(value) > 0 {
			var run struct {
				RunID  string `json:"run_id"`
				Status string `json:"status"`
				Agent  string `json:"agent"`
			}
			if json.Unmarshal(value, &run) == nil {
				runID, status, agent = run.RunID, run.Status, run.Agent
			}
		}
		if text != "" || runID != "" {
			return text, runID, status, agent, nil
		}
	}
	return "", "", "", "", nil
}

func uniqueStrings(values []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// Agenda is parsed from the primary Cell's visible @@todo / @@clock commands. The raw
// object is retained only in the in-memory index projection.
func validateWorkAgenda(raw json.RawMessage, kind string) error {
	if len(raw) == 0 {
		return nil
	}
	var values map[string]json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil || values == nil {
		return errors.New("agenda must be an object")
	}
	for key, entry := range values {
		if key == "clocks" {
			if err := validateWorkClocks(entry); err != nil {
				return err
			}
			continue
		}
		var value string
		if string(entry) == "null" {
			return fmt.Errorf("agenda.%s must be a string", key)
		}
		if err := json.Unmarshal(entry, &value); err != nil {
			return fmt.Errorf("agenda.%s must be a string", key)
		}
		switch key {
		case "sche", "ddl", "end", "done":
			if value == "" {
				continue
			}
			date, hasTime, ok := planning.ParseDateValue(value, time.Now())
			layout := "2006-01-02"
			if hasTime {
				layout += " 15:04"
			}
			if !ok || date.Format(layout) != value {
				return fmt.Errorf("invalid agenda.%s canonical date", key)
			}
		case "prio":
			if value != "" && !regexp.MustCompile(`^[A-Z]$`).MatchString(value) {
				return errors.New("invalid agenda priority")
			}
		case "effort":
			if value != "" && !regexp.MustCompile(`(?i)^(?:[0-9]+:[0-5][0-9]|[0-9]+(?:\.[0-9]+)?\s*(?:d|day|days|h|hour|hours|m|min|mins|minute|minutes)?)$`).MatchString(strings.TrimSpace(value)) {
				return errors.New("invalid agenda effort")
			}
		case "progress":
			if value != "" {
				progress, err := strconv.ParseFloat(value, 64)
				if err != nil || !agendaProgressPattern.MatchString(value) || progress < 0 || progress > 100 {
					return errors.New("agenda.progress must be between 0 and 100")
				}
			}
		case "status":
			if kind == "work" || (value != "todo" && value != "doing" && value != "blocked" && value != "done" && value != "cancelled") {
				return errors.New("invalid agenda status; work nodes use state")
			}
		case "tags", "context", "project":
		default:
			return fmt.Errorf("unsupported agenda field: %s", key)
		}
	}
	return nil
}

func validateWorkClocks(raw json.RawMessage) error {
	var clocks []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &clocks); err != nil || clocks == nil {
		return errors.New("agenda.clocks must be an array")
	}
	ids := map[string]bool{}
	running := 0
	for _, clock := range clocks {
		if clock == nil {
			return errors.New("agenda clock must be an object")
		}
		for key := range clock {
			if key != "id" && key != "from" && key != "to" {
				return errors.New("unsupported agenda clock field")
			}
		}
		var id string
		if err := json.Unmarshal(clock["id"], &id); err != nil || !agendaClockIDPattern.MatchString(id) || ids[id] {
			return errors.New("invalid or duplicate agenda clock ID")
		}
		ids[id] = true
		var from string
		for _, key := range []string{"from", "to"} {
			entry, exists := clock[key]
			if key == "to" && !exists {
				running++
				continue
			}
			var value string
			if err := json.Unmarshal(entry, &value); err != nil {
				return fmt.Errorf("agenda clock.%s requires a canonical date and time", key)
			}
			date, hasTime, ok := planning.ParseDateValue(value, time.Now())
			if !ok || !hasTime || date.Format("2006-01-02 15:04") != value {
				return fmt.Errorf("agenda clock.%s requires a canonical date and time", key)
			}
			if key == "from" {
				from = value
			} else if value < from {
				return errors.New("agenda clock.to is before from")
			}
		}
	}
	if running > 1 {
		return errors.New("a WorkNode may have only one running clock")
	}
	return nil
}
