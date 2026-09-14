// Noema research capture storage is Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package research

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const maxImportedArtifactBytes = 8 * 1024 * 1024

var unsafeCaptureHTMLPattern = regexp.MustCompile(`(?is)<\s*(script|iframe|object|embed|form|input|button|textarea|select|option)\b|\son[a-z0-9_-]+\s*=|(?:href|src)\s*=\s*['"]?\s*(javascript|data|file|blob):`)

type ImportArtifactInput struct {
	Kind          string         `json:"kind"`
	MediaType     string         `json:"mediaType"`
	ContentBase64 string         `json:"contentBase64"`
	WorkstreamID  string         `json:"workstreamId"`
	RunID         string         `json:"runId"`
	SourceURI     string         `json:"sourceUri"`
	Metadata      map[string]any `json:"metadata"`
}

// ArtifactLink records provenance without replacing the ordinary project
// file. The immutable Artifact is a snapshot; SourceURI points back to the
// human-owned file and WorkNodeID explains which unit of work produced it.
type ArtifactLink struct {
	Artifact     Artifact `json:"artifact"`
	RunID        string   `json:"runId"`
	WorkstreamID string   `json:"workstreamId"`
	NotebookID   string   `json:"notebookId,omitempty"`
	WorkNodeID   string   `json:"workNodeId,omitempty"`
	CellID       string   `json:"cellId,omitempty"`
	SourceURI    string   `json:"sourceUri,omitempty"`
	Relation     string   `json:"relation"`
	CreatedAt    string   `json:"createdAt"`
}

type ArtifactLinkFilter struct {
	WorkstreamID string
	NotebookID   string
	WorkNodeID   string
	RunID        string
	Limit        int
}

type CaptureInput struct {
	ClientRequestID string         `json:"clientRequestId"`
	URL             string         `json:"url"`
	Title           string         `json:"title"`
	Adapter         string         `json:"adapter"`
	Completeness    string         `json:"completeness"`
	CapturedAt      string         `json:"capturedAt"`
	Markdown        string         `json:"markdown"`
	SanitizedHTML   string         `json:"sanitizedHtml"`
	WorkstreamID    string         `json:"workstreamId"`
	Metadata        map[string]any `json:"metadata"`
}

type Capture struct {
	ID              string         `json:"id"`
	ClientRequestID string         `json:"clientRequestId"`
	ArtifactID      string         `json:"artifactId"`
	HTMLArtifactID  string         `json:"htmlArtifactId,omitempty"`
	WorkstreamID    string         `json:"workstreamId,omitempty"`
	URL             string         `json:"url"`
	Title           string         `json:"title"`
	Adapter         string         `json:"adapter"`
	Completeness    string         `json:"completeness"`
	CapturedAt      string         `json:"capturedAt"`
	CreatedAt       string         `json:"createdAt"`
	Metadata        map[string]any `json:"metadata"`
}

func (s *Store) ImportArtifact(input ImportArtifactInput) (Artifact, error) {
	input.Kind, input.MediaType = strings.TrimSpace(input.Kind), strings.TrimSpace(input.MediaType)
	input.WorkstreamID, input.RunID = strings.TrimSpace(input.WorkstreamID), strings.TrimSpace(input.RunID)
	if input.Kind == "" || input.MediaType == "" {
		return Artifact{}, errors.New("artifact import requires kind and media type")
	}
	reserved := map[string]bool{"run-spec": true, "context-manifest": true, "context-item": true,
		"handoff": true, "transcript": true, "web-capture": true, "web-capture-html": true}
	if reserved[input.Kind] {
		return Artifact{}, fmt.Errorf("artifact kind %q is reserved for Noema", input.Kind)
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(input.ContentBase64))
	if err != nil {
		return Artifact{}, fmt.Errorf("decode artifact import: %w", err)
	}
	if len(data) == 0 || len(data) > maxImportedArtifactBytes {
		return Artifact{}, fmt.Errorf("artifact import must contain 1-%d bytes", maxImportedArtifactBytes)
	}
	artifact, err := s.putArtifactBytes(input.Kind, input.MediaType, data)
	if err != nil {
		return Artifact{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Artifact{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var run Run
	if input.RunID != "" {
		run, err = scanRun(tx.QueryRow(runSelect+` WHERE id = ?`, input.RunID))
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return Artifact{}, fmt.Errorf("run %q not found", input.RunID)
			}
			return Artifact{}, err
		}
		if input.WorkstreamID != "" && input.WorkstreamID != run.WorkstreamID {
			return Artifact{}, errors.New("artifact workstream does not match its Run")
		}
		input.WorkstreamID = run.WorkstreamID
	}
	if input.WorkstreamID != "" {
		if err := requireWorkstreamTx(tx, input.WorkstreamID); err != nil {
			return Artifact{}, err
		}
	}
	artifact, err = ensureArtifactTx(tx, artifact)
	if err != nil {
		return Artifact{}, err
	}
	payload := map[string]any{"artifact_id": artifact.ID, "kind": artifact.Kind, "sha256": artifact.SHA256,
		"media_type": artifact.MediaType, "byte_count": artifact.ByteCount}
	if source := strings.TrimSpace(input.SourceURI); source != "" {
		payload["source_uri"] = source
	}
	if len(input.Metadata) > 0 {
		payload["metadata"] = input.Metadata
	}
	if run.ID != "" {
		relation := "produced"
		if change, _ := input.Metadata["change"].(string); change == "created" || change == "modified" {
			relation = change
		}
		if _, err := tx.Exec(`INSERT OR IGNORE INTO artifact_links(
			artifact_id, run_id, workstream_id, notebook_id, work_node_id, cell_id, source_uri, relation, created_at
		) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`, artifact.ID, run.ID, run.WorkstreamID, run.NotebookID,
			run.WorkNodeID, run.CellID, strings.TrimSpace(input.SourceURI), relation,
			time.Now().UTC().Truncate(time.Millisecond).UnixMilli()); err != nil {
			return Artifact{}, err
		}
	}
	if _, err := appendEvent(tx, Event{Type: "artifact.created", WorkstreamID: input.WorkstreamID,
		NotebookID: run.NotebookID, CellID: run.CellID, WorkNodeID: run.WorkNodeID, RunID: run.ID, SessionID: run.SessionID},
		time.Now().UTC().Truncate(time.Millisecond).UnixMilli(), payload); err != nil {
		return Artifact{}, err
	}
	if err := tx.Commit(); err != nil {
		return Artifact{}, err
	}
	return artifact, nil
}

func (s *Store) ListArtifactLinks(filter ArtifactLinkFilter) ([]ArtifactLink, error) {
	limit := filter.Limit
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	query := `SELECT a.id, a.kind, a.sha256, a.media_type, a.byte_count, a.created_at,
		l.run_id, l.workstream_id, l.notebook_id, l.work_node_id, l.cell_id, l.source_uri, l.relation, l.created_at
		FROM artifact_links l JOIN artifacts a ON a.id = l.artifact_id WHERE 1 = 1`
	args := []any{}
	for _, clause := range []struct {
		column string
		value  string
	}{
		{"l.workstream_id", strings.TrimSpace(filter.WorkstreamID)},
		{"l.notebook_id", strings.TrimSpace(filter.NotebookID)},
		{"l.work_node_id", strings.TrimSpace(filter.WorkNodeID)},
		{"l.run_id", strings.TrimSpace(filter.RunID)},
	} {
		if clause.value != "" {
			query += " AND " + clause.column + " = ?"
			args = append(args, clause.value)
		}
	}
	if len(args) == 0 {
		return nil, errors.New("artifact links require a WorkNode, Run, notebook, or workstream filter")
	}
	query += " ORDER BY l.created_at DESC, a.id LIMIT ?"
	args = append(args, limit)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	links := []ArtifactLink{}
	for rows.Next() {
		var link ArtifactLink
		var artifactCreated, linkCreated int64
		if err := rows.Scan(&link.Artifact.ID, &link.Artifact.Kind, &link.Artifact.SHA256, &link.Artifact.MediaType,
			&link.Artifact.ByteCount, &artifactCreated, &link.RunID, &link.WorkstreamID, &link.NotebookID,
			&link.WorkNodeID, &link.CellID, &link.SourceURI, &link.Relation, &linkCreated); err != nil {
			return nil, err
		}
		link.Artifact.CreatedAt = formatMillis(artifactCreated)
		link.CreatedAt = formatMillis(linkCreated)
		links = append(links, link)
	}
	return links, rows.Err()
}

func (s *Store) CreateCapture(input CaptureInput) (Capture, error) {
	input.ClientRequestID = strings.TrimSpace(input.ClientRequestID)
	input.URL, input.Title = strings.TrimSpace(input.URL), strings.TrimSpace(input.Title)
	input.Adapter, input.Completeness = strings.TrimSpace(input.Adapter), strings.TrimSpace(input.Completeness)
	input.WorkstreamID = strings.TrimSpace(input.WorkstreamID)
	if input.ClientRequestID == "" || len(input.ClientRequestID) > 200 {
		return Capture{}, errors.New("capture requires a bounded client request id")
	}
	parsedURL, err := url.Parse(input.URL)
	if err != nil || parsedURL.Host == "" || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
		return Capture{}, errors.New("capture URL must be an absolute http(s) URL")
	}
	if len(input.Title) > 1000 || len(input.Markdown) == 0 || len([]byte(input.Markdown)) > maxImportedArtifactBytes {
		return Capture{}, errors.New("capture title or Markdown exceeds its limit")
	}
	allowedAdapters := map[string]bool{"generic-selection": true, "generic-page": true, "official-chatgpt": true, "official-claude": true}
	allowedCompleteness := map[string]bool{"selection": true, "full": true, "partial": true, "export": true}
	if !allowedAdapters[input.Adapter] || !allowedCompleteness[input.Completeness] {
		return Capture{}, errors.New("capture adapter or completeness is unsupported")
	}
	if len([]byte(input.SanitizedHTML)) > maxImportedArtifactBytes || unsafeCaptureHTML(input.SanitizedHTML) {
		return Capture{}, errors.New("capture HTML is not sanitized")
	}
	if containsSecretMetadata(input.Metadata) {
		return Capture{}, errors.New("capture metadata contains a credential-like field")
	}
	capturedAt := time.Now().UTC().Truncate(time.Millisecond)
	if input.CapturedAt != "" {
		parsed, err := time.Parse(time.RFC3339, input.CapturedAt)
		if err != nil {
			return Capture{}, errors.New("capture capturedAt must be RFC3339")
		}
		capturedAt = parsed.UTC().Truncate(time.Millisecond)
	}
	markdownArtifact, err := s.putArtifactBytes("web-capture", "text/markdown; charset=utf-8", []byte(input.Markdown))
	if err != nil {
		return Capture{}, err
	}
	var htmlArtifact Artifact
	if input.SanitizedHTML != "" {
		htmlArtifact, err = s.putArtifactBytes("web-capture-html", "text/html; charset=utf-8", []byte(input.SanitizedHTML))
		if err != nil {
			return Capture{}, err
		}
	}
	metadataJSON, err := json.Marshal(input.Metadata)
	if err != nil {
		return Capture{}, fmt.Errorf("encode capture metadata: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return Capture{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if prior, err := getCaptureTx(tx, input.ClientRequestID); err == nil {
		return prior, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return Capture{}, err
	}
	if input.WorkstreamID != "" {
		if err := requireWorkstreamTx(tx, input.WorkstreamID); err != nil {
			return Capture{}, err
		}
	}
	markdownArtifact, err = ensureArtifactTx(tx, markdownArtifact)
	if err != nil {
		return Capture{}, err
	}
	if htmlArtifact.ID != "" {
		htmlArtifact, err = ensureArtifactTx(tx, htmlArtifact)
		if err != nil {
			return Capture{}, err
		}
	}
	id, err := prefixedUUID("cap_")
	if err != nil {
		return Capture{}, err
	}
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	var workstream any
	if input.WorkstreamID != "" {
		workstream = input.WorkstreamID
	}
	var htmlID any
	if htmlArtifact.ID != "" {
		htmlID = htmlArtifact.ID
	}
	if _, err := tx.Exec(`INSERT INTO captures(id, client_request_id, artifact_id, html_artifact_id, workstream_id,
		url, title, adapter, completeness, captured_at, created_at, metadata_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, input.ClientRequestID, markdownArtifact.ID, htmlID, workstream, input.URL, input.Title, input.Adapter,
		input.Completeness, capturedAt.UnixMilli(), nowMs, string(metadataJSON)); err != nil {
		return Capture{}, err
	}
	capture := Capture{ID: id, ClientRequestID: input.ClientRequestID, ArtifactID: markdownArtifact.ID,
		HTMLArtifactID: htmlArtifact.ID, WorkstreamID: input.WorkstreamID, URL: input.URL, Title: input.Title,
		Adapter: input.Adapter, Completeness: input.Completeness, CapturedAt: formatMillis(capturedAt.UnixMilli()),
		CreatedAt: formatMillis(nowMs), Metadata: input.Metadata}
	if _, err := appendEvent(tx, Event{Type: "capture.created", WorkstreamID: input.WorkstreamID}, nowMs,
		map[string]any{"capture_id": id, "artifact_id": markdownArtifact.ID, "html_artifact_id": htmlArtifact.ID,
			"url": input.URL, "adapter": input.Adapter, "completeness": input.Completeness}); err != nil {
		return Capture{}, err
	}
	if err := tx.Commit(); err != nil {
		return Capture{}, err
	}
	return capture, nil
}

func (s *Store) ListCaptures(limit int) ([]Capture, error) {
	if limit < 1 || limit > 1000 {
		limit = 200
	}
	rows, err := s.db.Query(`SELECT id, client_request_id, artifact_id, COALESCE(html_artifact_id, ''),
		COALESCE(workstream_id, ''), url, title, adapter, completeness, captured_at, created_at, metadata_json
		FROM captures ORDER BY created_at DESC, id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Capture{}
	for rows.Next() {
		capture, err := scanCapture(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, capture)
	}
	return result, rows.Err()
}

func getCaptureTx(tx *sql.Tx, requestID string) (Capture, error) {
	return scanCapture(tx.QueryRow(`SELECT id, client_request_id, artifact_id, COALESCE(html_artifact_id, ''),
		COALESCE(workstream_id, ''), url, title, adapter, completeness, captured_at, created_at, metadata_json
		FROM captures WHERE client_request_id = ?`, requestID))
}

type captureScanner interface{ Scan(...any) error }

func scanCapture(scanner captureScanner) (Capture, error) {
	var capture Capture
	var capturedAt, createdAt int64
	var metadataJSON string
	err := scanner.Scan(&capture.ID, &capture.ClientRequestID, &capture.ArtifactID, &capture.HTMLArtifactID,
		&capture.WorkstreamID, &capture.URL, &capture.Title, &capture.Adapter, &capture.Completeness,
		&capturedAt, &createdAt, &metadataJSON)
	if err != nil {
		return Capture{}, err
	}
	if err := json.Unmarshal([]byte(metadataJSON), &capture.Metadata); err != nil {
		return Capture{}, err
	}
	capture.CapturedAt, capture.CreatedAt = formatMillis(capturedAt), formatMillis(createdAt)
	return capture, nil
}

func requireWorkstreamTx(tx *sql.Tx, id string) error {
	var found string
	if err := tx.QueryRow(`SELECT id FROM workstreams WHERE id = ?`, id).Scan(&found); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("workstream %q not found", id)
		}
		return err
	}
	return nil
}

func unsafeCaptureHTML(value string) bool {
	return unsafeCaptureHTMLPattern.MatchString(value)
}

func containsSecretMetadata(value any) bool {
	switch current := value.(type) {
	case map[string]any:
		for key, child := range current {
			lower := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "-", ""), "_", ""))
			if strings.Contains(lower, "cookie") || strings.Contains(lower, "authorization") ||
				strings.Contains(lower, "password") || strings.Contains(lower, "token") || strings.Contains(lower, "secret") {
				return true
			}
			if containsSecretMetadata(child) {
				return true
			}
		}
	case []any:
		for _, child := range current {
			if containsSecretMetadata(child) {
				return true
			}
		}
	}
	return false
}
