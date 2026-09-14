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
	"regexp"
	"strings"
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
	cellIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	graphKinds    = map[string]bool{"question": true, "work": true, "checkpoint": true}
	researchKinds = map[string]bool{"result": true}
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
}

// WorkNode is a durable unit in the project work graph. It is deliberately
// independent of Cell: one node may bind several cells or no cell at all.
type WorkNode struct {
	ID            string `json:"id"`
	Kind          string `json:"kind"`
	Title         string `json:"title"`
	State         string `json:"state,omitempty"`
	Outcome       string `json:"outcome,omitempty"`
	DroppedReason string `json:"droppedReason,omitempty"`
	Disclosure    string `json:"disclosure,omitempty"`
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
	ID            string `json:"id"`
	Kind          string `json:"kind"`
	Title         string `json:"title"`
	State         string `json:"state"`
	Outcome       string `json:"outcome"`
	DroppedReason string `json:"dropped_reason"`
	Disclosure    string `json:"disclosure"`
}

type rawNotebook struct {
	Metadata struct {
		Research *struct {
			Schema       string        `json:"schema"`
			NotebookID   string        `json:"notebook_id"`
			WorkstreamID string        `json:"workstream_id"`
			Title        string        `json:"title"`
			WorkNodes    []rawWorkNode `json:"work_nodes"`
			Dependencies []Dependency  `json:"dependencies"`
		} `json:"noema_research"`
	} `json:"metadata"`
	Cells []struct {
		ID       string          `json:"id"`
		CellType string          `json:"cell_type"`
		Source   json.RawMessage `json:"source"`
		Metadata struct {
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
	nodeByID := map[string]WorkNode{}
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
			node := WorkNode{ID: id, Kind: item.Kind, Title: item.Title, State: item.State,
				Outcome: item.Outcome, DroppedReason: item.DroppedReason, Disclosure: item.Disclosure}
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
		if m := rawCell.Metadata.Research; m != nil {
			if m.Kind != "" && !researchKinds[m.Kind] && !(legacy && graphKinds[m.Kind]) {
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
				if cell.Kind != "result" && rawCell.CellType != "code" {
					cell.Kind = node.Kind
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
		if rawCell.CellType == "code" && cell.Kind != "result" {
			cell.Kind = "code"
		}
		if cell.Kind == "" {
			if rawCell.CellType == "code" {
				cell.Kind = "code"
			} else {
				cell.Kind = "note"
			}
		}
		notebook.Cells = append(notebook.Cells, cell)
	}
	return notebook, nil
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
