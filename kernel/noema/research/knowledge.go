package research

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type ResearchCellView struct {
	NotebookID   string `json:"notebookId"`
	WorkstreamID string `json:"workstreamId,omitempty"`
	Cell         Cell   `json:"cell"`
	Parents      []Cell `json:"parents"`
	Children     []Cell `json:"children"`
	Dependencies []Cell `json:"dependencies"`
	Dependents   []Cell `json:"dependents"`
}

// ResearchCellLocation is the narrow, local navigation projection used by
// noema://cell links.  It deliberately returns an indexed repository-relative
// path rather than accepting a path from the URL.
type ResearchCellLocation struct {
	NotebookID string `json:"notebookId"`
	CellID     string `json:"cellId"`
	Path       string `json:"path"`
	Revision   string `json:"revision"`
}

type ArtifactFilter struct {
	Query string
	Kind  string
	Limit int
}

type RunOutput struct {
	Run            Run       `json:"run"`
	Handoff        *Artifact `json:"handoff,omitempty"`
	Transcript     *Artifact `json:"transcript,omitempty"`
	HandoffText    string    `json:"handoffText,omitempty"`
	TranscriptText string    `json:"transcriptText,omitempty"`
}

func (s *Store) ReadResearchCell(notebookID, cellID string) (ResearchCellView, error) {
	notebookID, cellID = strings.TrimSpace(notebookID), strings.TrimSpace(cellID)
	if notebookID == "" || cellID == "" {
		return ResearchCellView{}, errors.New("research cell read requires notebook and cell ids")
	}
	var rel string
	if err := s.db.QueryRow(`SELECT path FROM notebooks WHERE id = ?`, notebookID).Scan(&rel); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ResearchCellView{}, fmt.Errorf("research notebook %q not found", notebookID)
		}
		return ResearchCellView{}, err
	}
	data, err := os.ReadFile(filepath.Join(s.root, filepath.FromSlash(rel)))
	if err != nil {
		return ResearchCellView{}, fmt.Errorf("read research notebook: %w", err)
	}
	notebook, err := ParseNotebook(data)
	if err != nil {
		return ResearchCellView{}, err
	}
	byID := make(map[string]Cell, len(notebook.Cells))
	byNode := make(map[string]Cell, len(notebook.WorkNodes))
	for _, cell := range notebook.Cells {
		if cell.Disclosure != "local_only" {
			byID[cell.ID] = cell
			if cell.WorkNodeID != "" {
				if current, exists := byNode[cell.WorkNodeID]; !exists || (current.Kind == "result" && cell.Kind != "result") {
					byNode[cell.WorkNodeID] = cell
				}
			}
		}
	}
	cell, ok := byID[cellID]
	if !ok {
		for _, candidate := range notebook.Cells {
			if candidate.ID == cellID && candidate.Disclosure == "local_only" {
				return ResearchCellView{}, errors.New("local_only research cells are not available to pull tools")
			}
		}
		return ResearchCellView{}, fmt.Errorf("research cell %q not found", cellID)
	}
	view := ResearchCellView{NotebookID: notebook.ID, WorkstreamID: notebook.WorkstreamID, Cell: cell,
		Parents: []Cell{}, Children: []Cell{}, Dependencies: []Cell{}, Dependents: []Cell{}}
	for _, id := range cell.Lineage {
		if related, exists := byNode[id]; exists {
			view.Parents = append(view.Parents, related)
		}
	}
	for _, id := range cell.Depends {
		if related, exists := byNode[id]; exists {
			view.Dependencies = append(view.Dependencies, related)
		}
	}
	for _, candidate := range notebook.Cells {
		if candidate.Disclosure == "local_only" {
			continue
		}
		if containsString(candidate.Lineage, cell.WorkNodeID) {
			view.Children = append(view.Children, candidate)
		}
		if containsString(candidate.Depends, cell.WorkNodeID) {
			view.Dependents = append(view.Dependents, candidate)
		}
	}
	return view, nil
}

// ResolveResearchCell locates a cell for trusted local navigation.  Unlike
// ReadResearchCell this includes local_only cells: navigation is a user-facing
// operation and does not disclose content to an agent.
func (s *Store) ResolveResearchCell(notebookID, cellID string) (ResearchCellLocation, error) {
	notebookID, cellID = strings.TrimSpace(notebookID), strings.TrimSpace(cellID)
	if !strings.HasPrefix(notebookID, "nb_") || !cellIDPattern.MatchString(notebookID) || !cellIDPattern.MatchString(cellID) {
		return ResearchCellLocation{}, errors.New("valid research notebook and cell ids are required")
	}
	location := ResearchCellLocation{NotebookID: notebookID, CellID: cellID}
	err := s.db.QueryRow(`SELECT notebooks.path, notebooks.revision_sha256
		FROM notebooks JOIN cells ON cells.notebook_id = notebooks.id
		WHERE notebooks.id = ? AND cells.cell_id = ?`, notebookID, cellID).Scan(&location.Path, &location.Revision)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ResearchCellLocation{}, fmt.Errorf("research cell %q/%q not found", notebookID, cellID)
		}
		return ResearchCellLocation{}, err
	}
	return location, nil
}

func (s *Store) ListArtifacts(filter ArtifactFilter) ([]Artifact, error) {
	limit := filter.Limit
	if limit < 1 || limit > 1000 {
		limit = 100
	}
	query, args := artifactSelect+` WHERE 1 = 1`, []any{}
	if kind := strings.TrimSpace(filter.Kind); kind != "" {
		query += ` AND kind = ?`
		args = append(args, kind)
	}
	if value := strings.TrimSpace(filter.Query); value != "" {
		query += ` AND (id LIKE ? OR kind LIKE ? OR sha256 LIKE ?)`
		pattern := "%" + value + "%"
		args = append(args, pattern, pattern, pattern)
	}
	query += ` ORDER BY created_at DESC, id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Artifact{}
	for rows.Next() {
		artifact, err := scanArtifact(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, artifact)
	}
	return result, rows.Err()
}

func (s *Store) ReadRunOutput(runID string, includeTranscript bool) (RunOutput, error) {
	run, err := s.GetRun(strings.TrimSpace(runID))
	if err != nil {
		return RunOutput{}, err
	}
	rows, err := s.db.Query(`SELECT payload_json FROM events WHERE run_id = ? AND type = 'run.status.changed' ORDER BY seq DESC`, run.ID)
	if err != nil {
		return RunOutput{}, err
	}
	defer rows.Close()
	var handoffID, transcriptID string
	for rows.Next() {
		var payloadJSON string
		if err := rows.Scan(&payloadJSON); err != nil {
			return RunOutput{}, err
		}
		payload := map[string]any{}
		if json.Unmarshal([]byte(payloadJSON), &payload) != nil {
			continue
		}
		if handoffID == "" {
			handoffID, _ = payload["handoff_artifact_id"].(string)
		}
		if transcriptID == "" {
			transcriptID, _ = payload["transcript_artifact_id"].(string)
		}
		if handoffID != "" && transcriptID != "" {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return RunOutput{}, err
	}
	output := RunOutput{Run: run}
	if handoffID != "" {
		artifact, data, err := s.ReadArtifact(handoffID)
		if err != nil {
			return RunOutput{}, err
		}
		output.Handoff, output.HandoffText = &artifact, string(data)
	}
	if includeTranscript && transcriptID != "" {
		artifact, data, err := s.ReadArtifact(transcriptID)
		if err != nil {
			return RunOutput{}, err
		}
		output.Transcript, output.TranscriptText = &artifact, string(data)
	}
	return output, nil
}

func artifactReadJSON(artifact Artifact, data []byte) map[string]any {
	return map[string]any{"artifact": artifact, "dataBase64": base64.StdEncoding.EncodeToString(data)}
}

func containsString(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
