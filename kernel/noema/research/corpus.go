// Noema artifact corpus indexing is Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package research

// This file implements the deterministic Foundation slice from agent.md:
// repository Markdown is snapshotted into CAS, split into exact byte-addressed
// blocks, and projected into a rebuildable FTS5 index.  Discovery may hash the
// corpus, but unchanged sources are never reparsed and targeted file updates do
// work proportional to the changed set rather than the whole corpus.

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	ArtifactCorpusParserVersion = "noema.markdown-blocks/1"
	maxCorpusFiles              = 100_000
	corpusBatchSize             = 500
)

type IndexArtifactCorpusInput struct {
	WorkstreamID string   `json:"workstreamId"`
	RelativeRoot string   `json:"relativeRoot"`
	Paths        []string `json:"paths"`
	Actor        string   `json:"actor"`
}

type ArtifactCorpusIndexResult struct {
	WorkstreamID          string `json:"workstreamId"`
	RelativeRoot          string `json:"relativeRoot,omitempty"`
	Mode                  string `json:"mode"`
	ScannedFiles          int    `json:"scannedFiles"`
	ParsedFiles           int    `json:"parsedFiles"`
	CreatedSources        int    `json:"createdSources"`
	UpdatedSources        int    `json:"updatedSources"`
	UnchangedSources      int    `json:"unchangedSources"`
	RemovedSources        int    `json:"removedSources"`
	ParsedBlocks          int    `json:"parsedBlocks"`
	ExactDuplicateSources int    `json:"exactDuplicateSources"`
	InferenceCalls        int    `json:"inferenceCalls"`
	Generation            int64  `json:"generation"`
	ElapsedMillis         int64  `json:"elapsedMillis"`
}

type ArtifactSource struct {
	ID            string `json:"id"`
	WorkstreamID  string `json:"workstreamId"`
	Path          string `json:"path"`
	SourceURI     string `json:"sourceUri"`
	ArtifactID    string `json:"artifactId"`
	ContentSHA256 string `json:"contentSha256"`
	ParserVersion string `json:"parserVersion"`
	ByteCount     int64  `json:"byteCount"`
	ModifiedNS    int64  `json:"modifiedNs"`
	IndexedAt     string `json:"indexedAt"`
}

type ArtifactBlock struct {
	ID            string `json:"id"`
	SourceID      string `json:"sourceId"`
	ArtifactID    string `json:"artifactId"`
	Ordinal       int    `json:"ordinal"`
	Kind          string `json:"kind"`
	ByteStart     int64  `json:"byteStart"`
	ByteEnd       int64  `json:"byteEnd"`
	Content       string `json:"content"`
	ContentSHA256 string `json:"contentSha256"`
	ASTPath       string `json:"astPath"`
	IndexedAt     string `json:"indexedAt"`
}

type ArtifactBlockHit struct {
	BlockID      string `json:"blockId"`
	WorkstreamID string `json:"workstreamId"`
	SourceID     string `json:"sourceId"`
	ArtifactID   string `json:"artifactId"`
	SourceURI    string `json:"sourceUri"`
	ByteStart    int64  `json:"byteStart"`
	ByteEnd      int64  `json:"byteEnd"`
	Excerpt      string `json:"excerpt"`
}

type SearchArtifactBlocksInput struct {
	WorkstreamID string `json:"workstreamId"`
	Query        string `json:"query"`
	Limit        int    `json:"limit"`
}

type corpusSourceState struct {
	ID, Path, ArtifactID, Digest, ParserVersion string
}

type corpusChange struct {
	Source   ArtifactSource
	Artifact Artifact
	Blocks   []ArtifactBlock
	Delete   bool
	Created  bool
}

// IndexMarkdownCorpus discovers and reconciles every Markdown source beneath
// RelativeRoot. It hashes all discovered files to detect change, but parses and
// updates CAS/FTS only for new or content-changed sources.
func (s *Store) IndexMarkdownCorpus(input IndexArtifactCorpusInput) (ArtifactCorpusIndexResult, error) {
	started := time.Now()
	input, err := s.validateCorpusInput(input, false)
	if err != nil {
		return ArtifactCorpusIndexResult{}, err
	}
	files, err := s.discoverMarkdownCorpus(input.RelativeRoot)
	if err != nil {
		return ArtifactCorpusIndexResult{}, err
	}
	result, err := s.indexMarkdownPaths(input, files, true)
	result.Mode, result.RelativeRoot, result.ScannedFiles = "reconcile", input.RelativeRoot, len(files)
	result.ElapsedMillis = time.Since(started).Milliseconds()
	return result, err
}

// IndexMarkdownFiles applies an event-driven bounded update. Only the explicit
// repository-relative paths are read and parsed; a missing path removes its
// prior source projection. This is the normal editor/filesystem-event path.
func (s *Store) IndexMarkdownFiles(input IndexArtifactCorpusInput) (ArtifactCorpusIndexResult, error) {
	started := time.Now()
	input, err := s.validateCorpusInput(input, true)
	if err != nil {
		return ArtifactCorpusIndexResult{}, err
	}
	files := make(map[string]string, len(input.Paths))
	for _, raw := range input.Paths {
		rel, absolute, exists, err := s.resolveCorpusFile(raw)
		if err != nil {
			return ArtifactCorpusIndexResult{}, err
		}
		if exists {
			files[rel] = absolute
		} else {
			files[rel] = ""
		}
	}
	result, err := s.indexMarkdownPaths(input, files, false)
	result.Mode, result.ScannedFiles = "targeted", len(files)
	result.ElapsedMillis = time.Since(started).Milliseconds()
	return result, err
}

func (s *Store) validateCorpusInput(input IndexArtifactCorpusInput, targeted bool) (IndexArtifactCorpusInput, error) {
	input.WorkstreamID, input.RelativeRoot, input.Actor = strings.TrimSpace(input.WorkstreamID), strings.TrimSpace(input.RelativeRoot), strings.TrimSpace(input.Actor)
	if !strings.HasPrefix(input.WorkstreamID, "ws_") || input.Actor == "" || len(input.Actor) > 200 {
		return input, errors.New("artifact corpus indexing requires a valid Workstream and bounded actor")
	}
	if targeted {
		input.Paths = uniqueStrings(input.Paths)
		if len(input.Paths) == 0 || len(input.Paths) > 1000 {
			return input, errors.New("targeted artifact indexing requires 1-1000 repository-relative paths")
		}
		for _, path := range input.Paths {
			if strings.ToLower(filepath.Ext(path)) != ".md" {
				return input, fmt.Errorf("targeted corpus path %q is not Markdown", path)
			}
		}
		return input, nil
	}
	if input.RelativeRoot == "" {
		input.RelativeRoot = "."
	}
	rel, absolute, exists, err := s.resolveCorpusPath(input.RelativeRoot, true)
	if err != nil {
		return input, err
	}
	if !exists {
		return input, fmt.Errorf("artifact corpus root %q not found", input.RelativeRoot)
	}
	info, err := os.Stat(absolute)
	if err != nil || !info.IsDir() {
		return input, fmt.Errorf("artifact corpus root %q is not a directory", input.RelativeRoot)
	}
	input.RelativeRoot = rel
	return input, nil
}

func (s *Store) discoverMarkdownCorpus(relativeRoot string) (map[string]string, error) {
	_, absoluteRoot, _, err := s.resolveCorpusPath(relativeRoot, true)
	if err != nil {
		return nil, err
	}
	realRoot, err := filepath.EvalSymlinks(s.root)
	if err != nil {
		return nil, fmt.Errorf("resolve artifact corpus repository root: %w", err)
	}
	result := map[string]string{}
	err = filepath.WalkDir(absoluteRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			if path != absoluteRoot && (entry.Name() == StateDirName || entry.Name() == ".git") {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.ToLower(filepath.Ext(entry.Name())) != ".md" {
			return nil
		}
		rel, err := filepath.Rel(realRoot, path)
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return errors.New("artifact corpus discovery escaped the repository")
		}
		result[filepath.ToSlash(rel)] = path
		if len(result) > maxCorpusFiles {
			return fmt.Errorf("artifact corpus exceeds the %d-file validation bound", maxCorpusFiles)
		}
		return nil
	})
	return result, err
}

func (s *Store) resolveCorpusFile(raw string) (string, string, bool, error) {
	rel, absolute, exists, err := s.resolveCorpusPath(raw, false)
	if err != nil || !exists {
		return rel, absolute, exists, err
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return rel, absolute, false, err
	}
	if !info.Mode().IsRegular() {
		return rel, absolute, false, fmt.Errorf("artifact corpus path %q is not a regular file", raw)
	}
	return rel, absolute, true, nil
}

func (s *Store) resolveCorpusPath(raw string, requireExisting bool) (string, string, bool, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || filepath.IsAbs(raw) {
		return "", "", false, errors.New("artifact corpus paths must be repository-relative")
	}
	clean := filepath.Clean(raw)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || clean == StateDirName || strings.HasPrefix(clean, StateDirName+string(filepath.Separator)) {
		return "", "", false, errors.New("artifact corpus path escapes or targets private state")
	}
	realRoot, err := filepath.EvalSymlinks(s.root)
	if err != nil {
		return "", "", false, fmt.Errorf("resolve artifact corpus repository root: %w", err)
	}
	absolute := filepath.Join(realRoot, clean)
	_, err = os.Lstat(absolute)
	if errors.Is(err, os.ErrNotExist) && !requireExisting {
		// Resolve existing ancestors before accepting a deletion path, so an
		// intermediate symlink cannot redirect the target outside the repository.
		parts := strings.Split(clean, string(filepath.Separator))
		resolved := realRoot
		for index, part := range parts {
			candidate := filepath.Join(resolved, part)
			if _, statErr := os.Lstat(candidate); errors.Is(statErr, os.ErrNotExist) {
				resolved = filepath.Join(append([]string{resolved}, parts[index:]...)...)
				break
			} else if statErr != nil {
				return "", "", false, statErr
			}
			resolved, err = filepath.EvalSymlinks(candidate)
			if err != nil {
				return "", "", false, err
			}
		}
		inside, err := filepath.Rel(realRoot, resolved)
		if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
			return "", "", false, errors.New("artifact corpus path resolves outside the repository")
		}
		if inside == StateDirName || strings.HasPrefix(inside, StateDirName+string(filepath.Separator)) {
			return "", "", false, errors.New("artifact corpus path resolves into private state")
		}
		return filepath.ToSlash(inside), resolved, false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	real, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", "", false, err
	}
	inside, err := filepath.Rel(realRoot, real)
	if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		return "", "", false, errors.New("artifact corpus path resolves outside the repository")
	}
	if inside == StateDirName || strings.HasPrefix(inside, StateDirName+string(filepath.Separator)) {
		return "", "", false, errors.New("artifact corpus path resolves into private state")
	}
	return filepath.ToSlash(inside), real, true, nil
}

func (s *Store) indexMarkdownPaths(input IndexArtifactCorpusInput, files map[string]string, reconcile bool) (ArtifactCorpusIndexResult, error) {
	result := ArtifactCorpusIndexResult{WorkstreamID: input.WorkstreamID, InferenceCalls: 0}
	if err := s.ensureCorpusFTSSynced(input.WorkstreamID); err != nil {
		return result, err
	}
	existing, err := s.corpusSourceStates(input.WorkstreamID)
	if err != nil {
		return result, err
	}
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	changes := make([]corpusChange, 0, corpusBatchSize)
	flush := func() error {
		if len(changes) == 0 {
			return nil
		}
		generation, err := s.persistCorpusChanges(input, changes)
		if err != nil {
			return err
		}
		if err := s.applyCorpusFTSChanges(input.WorkstreamID, generation, changes); err != nil {
			return err
		}
		result.Generation = generation
		changes = changes[:0]
		return nil
	}
	seen := make(map[string]bool, len(paths))
	for _, path := range paths {
		seen[path] = true
		absolute := files[path]
		prior, hadPrior := existing[path]
		if absolute == "" {
			if hadPrior {
				changes = append(changes, corpusChange{Source: ArtifactSource{ID: prior.ID, Path: path, WorkstreamID: input.WorkstreamID}, Delete: true})
				result.RemovedSources++
			}
			if len(changes) >= corpusBatchSize {
				if err := flush(); err != nil {
					return result, err
				}
			}
			continue
		}
		info, err := os.Stat(absolute)
		if err != nil {
			return result, err
		}
		data, err := os.ReadFile(absolute)
		if err != nil {
			return result, fmt.Errorf("read artifact corpus source %q: %w", path, err)
		}
		if len(data) > maxImportedArtifactBytes || !utf8.Valid(data) {
			return result, fmt.Errorf("artifact corpus source %q must be UTF-8 Markdown no larger than %d bytes", path, maxImportedArtifactBytes)
		}
		digestBytes := sha256.Sum256(data)
		digest := hex.EncodeToString(digestBytes[:])
		if hadPrior && prior.Digest == digest && prior.ParserVersion == ArtifactCorpusParserVersion {
			result.UnchangedSources++
			continue
		}
		artifact, err := s.putArtifactBytes("markdown-source", "text/markdown; charset=utf-8", data)
		if err != nil {
			return result, err
		}
		sourceID := corpusSourceID(input.WorkstreamID, path)
		source := ArtifactSource{ID: sourceID, WorkstreamID: input.WorkstreamID, Path: path,
			SourceURI: corpusSourceURI(path), ContentSHA256: "sha256:" + digest,
			ParserVersion: ArtifactCorpusParserVersion, ByteCount: int64(len(data)), ModifiedNS: info.ModTime().UnixNano()}
		blocks := parseMarkdownArtifactBlocks(sourceID, artifact.ID, data)
		changes = append(changes, corpusChange{Source: source, Artifact: artifact, Blocks: blocks, Created: !hadPrior})
		result.ParsedFiles++
		result.ParsedBlocks += len(blocks)
		if hadPrior {
			result.UpdatedSources++
		} else {
			result.CreatedSources++
		}
		if len(changes) >= corpusBatchSize {
			if err := flush(); err != nil {
				return result, err
			}
		}
	}
	if reconcile {
		prefix := input.RelativeRoot
		for path, prior := range existing {
			inScope := prefix == "." || path == prefix || strings.HasPrefix(path, strings.TrimSuffix(prefix, "/")+"/")
			if inScope && !seen[path] {
				changes = append(changes, corpusChange{Source: ArtifactSource{ID: prior.ID, Path: path, WorkstreamID: input.WorkstreamID}, Delete: true})
				result.RemovedSources++
				if len(changes) >= corpusBatchSize {
					if err := flush(); err != nil {
						return result, err
					}
				}
			}
		}
	}
	if err := flush(); err != nil {
		return result, err
	}
	if result.Generation == 0 {
		result.Generation, err = s.corpusGeneration(input.WorkstreamID)
		if err != nil {
			return result, err
		}
	}
	result.ExactDuplicateSources, err = s.exactDuplicateSourceCount(input.WorkstreamID)
	return result, err
}

func (s *Store) corpusSourceStates(workstreamID string) (map[string]corpusSourceState, error) {
	rows, err := s.db.Query(`SELECT id, path, artifact_id, content_sha256, parser_version FROM artifact_sources WHERE workstream_id = ?`, workstreamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]corpusSourceState{}
	for rows.Next() {
		var value corpusSourceState
		if err := rows.Scan(&value.ID, &value.Path, &value.ArtifactID, &value.Digest, &value.ParserVersion); err != nil {
			return nil, err
		}
		value.Digest = strings.TrimPrefix(value.Digest, "sha256:")
		result[value.Path] = value
	}
	return result, rows.Err()
}

func (s *Store) persistCorpusChanges(input IndexArtifactCorpusInput, changes []corpusChange) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := requireWorkstreamTx(tx, input.WorkstreamID); err != nil {
		return 0, err
	}
	nowMs := time.Now().UTC().Truncate(time.Millisecond).UnixMilli()
	for index := range changes {
		change := &changes[index]
		if change.Delete {
			if _, err := tx.Exec(`DELETE FROM artifact_sources WHERE id = ? AND workstream_id = ?`, change.Source.ID, input.WorkstreamID); err != nil {
				return 0, err
			}
			continue
		}
		artifact, err := ensureArtifactTx(tx, change.Artifact)
		if err != nil {
			return 0, err
		}
		change.Artifact, change.Source.ArtifactID = artifact, artifact.ID
		if _, err := tx.Exec(`INSERT INTO artifact_sources(id, workstream_id, path, source_uri, artifact_id,
			content_sha256, parser_version, byte_count, modified_ns, indexed_at)
			VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(workstream_id, path) DO UPDATE SET source_uri=excluded.source_uri,
			artifact_id=excluded.artifact_id, content_sha256=excluded.content_sha256,
			parser_version=excluded.parser_version, byte_count=excluded.byte_count,
			modified_ns=excluded.modified_ns, indexed_at=excluded.indexed_at`,
			change.Source.ID, input.WorkstreamID, change.Source.Path, change.Source.SourceURI, artifact.ID,
			change.Source.ContentSHA256, change.Source.ParserVersion, change.Source.ByteCount,
			change.Source.ModifiedNS, nowMs); err != nil {
			return 0, err
		}
		if _, err := tx.Exec(`DELETE FROM artifact_blocks WHERE source_id = ?`, change.Source.ID); err != nil {
			return 0, err
		}
		for blockIndex := range change.Blocks {
			block := &change.Blocks[blockIndex]
			block.ArtifactID = artifact.ID
			if _, err := tx.Exec(`INSERT INTO artifact_blocks(id, source_id, artifact_id, ordinal, kind,
				byte_start, byte_end, content, content_sha256, ast_path, indexed_at)
				VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, block.ID, block.SourceID, block.ArtifactID,
				block.Ordinal, block.Kind, block.ByteStart, block.ByteEnd, block.Content,
				block.ContentSHA256, block.ASTPath, nowMs); err != nil {
				return 0, err
			}
		}
	}
	if _, err := tx.Exec(`INSERT INTO artifact_corpus_generations(workstream_id, generation, updated_at)
		VALUES(?, 1, ?) ON CONFLICT(workstream_id) DO UPDATE SET generation=generation+1, updated_at=excluded.updated_at`,
		input.WorkstreamID, nowMs); err != nil {
		return 0, err
	}
	var generation int64
	if err := tx.QueryRow(`SELECT generation FROM artifact_corpus_generations WHERE workstream_id = ?`, input.WorkstreamID).Scan(&generation); err != nil {
		return 0, err
	}
	created, updated, removed, blocks := 0, 0, 0, 0
	for _, change := range changes {
		if change.Delete {
			removed++
		} else {
			blocks += len(change.Blocks)
			if change.Created {
				created++
			} else {
				updated++
			}
		}
	}
	if _, err := appendEvent(tx, Event{Type: "artifact.corpus.indexed", WorkstreamID: input.WorkstreamID}, nowMs,
		map[string]any{"actor": input.Actor, "generation": generation, "mutated_sources": created + updated,
			"removed_sources": removed, "parsed_blocks": blocks, "inference_calls": 0, "created_sources": created,
			"parser_version": ArtifactCorpusParserVersion}); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return generation, nil
}

func (s *Store) applyCorpusFTSChanges(workstreamID string, generation int64, changes []corpusChange) error {
	s.historyMu.Lock()
	defer s.historyMu.Unlock()
	db, err := s.openHistoryDB()
	if err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, change := range changes {
		// A newly created authority source cannot already have an FTS projection.
		// Skipping its former source_id scan is what keeps initial corpus indexing
		// linear at the documented 100k-file validation bound.
		if !change.Created || change.Delete {
			if err := deleteCorpusFTSSourceTx(tx, change.Source.ID); err != nil {
				return err
			}
		}
		if change.Delete {
			continue
		}
		var firstRowID, lastRowID int64
		for _, block := range change.Blocks {
			inserted, err := tx.Exec(`INSERT INTO artifact_blocks_fts(block_id, workstream_id, source_id,
				artifact_id, source_uri, byte_start, byte_end, content) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
				block.ID, workstreamID, change.Source.ID, change.Source.ArtifactID, change.Source.SourceURI,
				block.ByteStart, block.ByteEnd, block.Content)
			if err != nil {
				return err
			}
			rowID, err := inserted.LastInsertId()
			if err != nil {
				return fmt.Errorf("record artifact FTS rowid: %w", err)
			}
			if firstRowID == 0 {
				firstRowID = rowID
			}
			lastRowID = rowID
		}
		if firstRowID != 0 {
			if _, err := tx.Exec(`INSERT INTO artifact_fts_sources(source_id, workstream_id, first_rowid, last_rowid)
				VALUES(?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET workstream_id=excluded.workstream_id,
				first_rowid=excluded.first_rowid, last_rowid=excluded.last_rowid`, change.Source.ID,
				workstreamID, firstRowID, lastRowID); err != nil {
				return err
			}
		}
	}
	if _, err := tx.Exec(`INSERT INTO artifact_fts_generations(workstream_id, generation) VALUES(?, ?)
		ON CONFLICT(workstream_id) DO UPDATE SET generation=excluded.generation`, workstreamID, generation); err != nil {
		return err
	}
	return tx.Commit()
}

func deleteCorpusFTSSourceTx(tx *sql.Tx, sourceID string) error {
	var firstRowID, lastRowID int64
	err := tx.QueryRow(`SELECT first_rowid, last_rowid FROM artifact_fts_sources WHERE source_id = ?`, sourceID).
		Scan(&firstRowID, &lastRowID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM artifact_blocks_fts WHERE rowid BETWEEN ? AND ?`, firstRowID, lastRowID); err != nil {
		return err
	}
	_, err = tx.Exec(`DELETE FROM artifact_fts_sources WHERE source_id = ?`, sourceID)
	return err
}

func deleteCorpusFTSWorkstreamTx(tx *sql.Tx, workstreamID string) error {
	rows, err := tx.Query(`SELECT source_id FROM artifact_fts_sources WHERE workstream_id = ? ORDER BY source_id`, workstreamID)
	if err != nil {
		return err
	}
	sourceIDs := []string{}
	for rows.Next() {
		var sourceID string
		if err := rows.Scan(&sourceID); err != nil {
			_ = rows.Close()
			return err
		}
		sourceIDs = append(sourceIDs, sourceID)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, sourceID := range sourceIDs {
		if err := deleteCorpusFTSSourceTx(tx, sourceID); err != nil {
			return err
		}
	}
	if len(sourceIDs) == 0 {
		// Defensive compatibility for a derived index whose legacy row-range
		// migration was interrupted. This slow path is never used by a healthy DB.
		if _, err := tx.Exec(`DELETE FROM artifact_blocks_fts WHERE workstream_id = ?`, workstreamID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) ensureCorpusFTSSynced(workstreamID string) error {
	generation, err := s.corpusGeneration(workstreamID)
	if err != nil {
		return err
	}
	s.historyMu.Lock()
	defer s.historyMu.Unlock()
	db, err := s.openHistoryDB()
	if err != nil {
		return err
	}
	var indexed int64
	err = db.QueryRow(`SELECT generation FROM artifact_fts_generations WHERE workstream_id = ?`, workstreamID).Scan(&indexed)
	if errors.Is(err, sql.ErrNoRows) {
		indexed, err = 0, nil
	}
	if err != nil || indexed == generation {
		return err
	}
	return s.rebuildCorpusFTSLocked(db, workstreamID, generation)
}

func (s *Store) rebuildCorpusFTSLocked(db *sql.DB, workstreamID string, generation int64) error {
	rows, err := s.db.Query(`SELECT artifact_blocks.id, artifact_blocks.source_id, artifact_blocks.artifact_id,
		artifact_sources.source_uri, artifact_blocks.byte_start, artifact_blocks.byte_end, artifact_blocks.content
		FROM artifact_blocks JOIN artifact_sources ON artifact_sources.id = artifact_blocks.source_id
		WHERE artifact_sources.workstream_id = ? ORDER BY artifact_blocks.source_id, artifact_blocks.ordinal`, workstreamID)
	if err != nil {
		return err
	}
	defer rows.Close()
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := deleteCorpusFTSWorkstreamTx(tx, workstreamID); err != nil {
		return err
	}
	for rows.Next() {
		var blockID, sourceID, artifactID, sourceURI, content string
		var byteStart, byteEnd int64
		if err := rows.Scan(&blockID, &sourceID, &artifactID, &sourceURI, &byteStart, &byteEnd, &content); err != nil {
			return err
		}
		inserted, err := tx.Exec(`INSERT INTO artifact_blocks_fts(block_id, workstream_id, source_id, artifact_id,
			source_uri, byte_start, byte_end, content) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`, blockID, workstreamID,
			sourceID, artifactID, sourceURI, byteStart, byteEnd, content)
		if err != nil {
			return err
		}
		rowID, err := inserted.LastInsertId()
		if err != nil {
			return fmt.Errorf("record rebuilt artifact FTS rowid: %w", err)
		}
		if _, err := tx.Exec(`INSERT INTO artifact_fts_sources(source_id, workstream_id, first_rowid, last_rowid)
			VALUES(?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET
			last_rowid=excluded.last_rowid`, sourceID, workstreamID, rowID, rowID); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO artifact_fts_generations(workstream_id, generation) VALUES(?, ?)
		ON CONFLICT(workstream_id) DO UPDATE SET generation=excluded.generation`, workstreamID, generation); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) corpusGeneration(workstreamID string) (int64, error) {
	var generation int64
	err := s.db.QueryRow(`SELECT generation FROM artifact_corpus_generations WHERE workstream_id = ?`, workstreamID).Scan(&generation)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return generation, err
}

func (s *Store) exactDuplicateSourceCount(workstreamID string) (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COALESCE(SUM(source_count - 1), 0) FROM (
		SELECT COUNT(*) AS source_count FROM artifact_sources WHERE workstream_id = ? GROUP BY artifact_id HAVING COUNT(*) > 1
	)`, workstreamID).Scan(&count)
	return count, err
}

func (s *Store) SearchArtifactBlocks(input SearchArtifactBlocksInput) ([]ArtifactBlockHit, error) {
	input.WorkstreamID, input.Query = strings.TrimSpace(input.WorkstreamID), strings.TrimSpace(input.Query)
	if !strings.HasPrefix(input.WorkstreamID, "ws_") || input.Query == "" {
		return nil, errors.New("artifact block search requires a Workstream and query")
	}
	if input.Limit < 1 || input.Limit > 1000 {
		input.Limit = 20
	}
	if err := s.ensureCorpusFTSSynced(input.WorkstreamID); err != nil {
		return nil, err
	}
	s.historyMu.Lock()
	defer s.historyMu.Unlock()
	db, err := s.openHistoryDB()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(`SELECT block_id, workstream_id, source_id, artifact_id, source_uri,
		CAST(byte_start AS INTEGER), CAST(byte_end AS INTEGER),
		snippet(artifact_blocks_fts, 7, '<mark>', '</mark>', '…', 24)
		FROM artifact_blocks_fts WHERE artifact_blocks_fts MATCH ? AND workstream_id = ?
		ORDER BY bm25(artifact_blocks_fts), block_id LIMIT ?`, historyFTSQuery(input.Query), input.WorkstreamID, input.Limit)
	if err != nil {
		return nil, fmt.Errorf("search artifact corpus: %w", err)
	}
	defer rows.Close()
	result := []ArtifactBlockHit{}
	for rows.Next() {
		var hit ArtifactBlockHit
		if err := rows.Scan(&hit.BlockID, &hit.WorkstreamID, &hit.SourceID, &hit.ArtifactID, &hit.SourceURI,
			&hit.ByteStart, &hit.ByteEnd, &hit.Excerpt); err != nil {
			return nil, err
		}
		result = append(result, hit)
	}
	return result, rows.Err()
}

// ReadArtifactBlock revalidates a stored block against immutable CAS bytes;
// callers never have to trust the duplicated search/index text.
func (s *Store) ReadArtifactBlock(id string) (ArtifactBlock, error) {
	id = strings.TrimSpace(id)
	if !strings.HasPrefix(id, "ablk_") {
		return ArtifactBlock{}, errors.New("artifact block id is invalid")
	}
	var block ArtifactBlock
	var indexedAt int64
	err := s.db.QueryRow(`SELECT id, source_id, artifact_id, ordinal, kind, byte_start, byte_end,
		content, content_sha256, ast_path, indexed_at FROM artifact_blocks WHERE id = ?`, id).Scan(
		&block.ID, &block.SourceID, &block.ArtifactID, &block.Ordinal, &block.Kind, &block.ByteStart,
		&block.ByteEnd, &block.Content, &block.ContentSHA256, &block.ASTPath, &indexedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ArtifactBlock{}, fmt.Errorf("artifact block %q not found", id)
	}
	if err != nil {
		return ArtifactBlock{}, err
	}
	_, data, err := s.ReadArtifact(block.ArtifactID)
	if err != nil {
		return ArtifactBlock{}, err
	}
	if block.ByteStart < 0 || block.ByteEnd <= block.ByteStart || block.ByteEnd > int64(len(data)) ||
		!bytes.Equal(data[block.ByteStart:block.ByteEnd], []byte(block.Content)) {
		return ArtifactBlock{}, errors.New("artifact block no longer round-trips to its immutable source span")
	}
	digest := sha256.Sum256(data[block.ByteStart:block.ByteEnd])
	if "sha256:"+hex.EncodeToString(digest[:]) != block.ContentSHA256 {
		return ArtifactBlock{}, errors.New("artifact block span digest verification failed")
	}
	block.IndexedAt = formatMillis(indexedAt)
	return block, nil
}

func corpusSourceID(workstreamID, path string) string {
	digest := sha256.Sum256([]byte(workstreamID + "\x00" + filepath.ToSlash(path)))
	return "asrc_" + hex.EncodeToString(digest[:20])
}

func corpusSourceURI(path string) string {
	return (&url.URL{Scheme: "repo", Path: "/" + filepath.ToSlash(path)}).String()
}

func artifactBlockID(sourceID string, ordinal int, digest string) string {
	value := sha256.Sum256([]byte(sourceID + "\x00" + strconv.Itoa(ordinal) + "\x00" + digest))
	return "ablk_" + hex.EncodeToString(value[:20])
}

type markdownLine struct{ start, end, contentEnd int }

func markdownLines(data []byte) []markdownLine {
	lines := []markdownLine{}
	for start := 0; start < len(data); {
		relative := bytes.IndexByte(data[start:], '\n')
		end := len(data)
		if relative >= 0 {
			end = start + relative + 1
		}
		contentEnd := end
		for contentEnd > start && (data[contentEnd-1] == '\n' || data[contentEnd-1] == '\r') {
			contentEnd--
		}
		lines = append(lines, markdownLine{start: start, end: end, contentEnd: contentEnd})
		start = end
	}
	return lines
}

func parseMarkdownArtifactBlocks(sourceID, artifactID string, data []byte) []ArtifactBlock {
	lines := markdownLines(data)
	result := []ArtifactBlock{}
	for index := 0; index < len(lines); {
		line := lines[index]
		trimmed := strings.TrimSpace(string(data[line.start:line.contentEnd]))
		if trimmed == "" {
			index++
			continue
		}
		start, end, kind := line.start, line.end, markdownBlockKind(trimmed)
		if marker := markdownFenceMarker(trimmed); marker != "" {
			kind = "code"
			index++
			for index < len(lines) {
				end = lines[index].end
				candidate := strings.TrimSpace(string(data[lines[index].start:lines[index].contentEnd]))
				index++
				if strings.HasPrefix(candidate, marker) {
					break
				}
			}
		} else if kind == "heading" {
			index++
		} else {
			index++
			for index < len(lines) {
				candidate := strings.TrimSpace(string(data[lines[index].start:lines[index].contentEnd]))
				if candidate == "" || markdownBlockKind(candidate) == "heading" || markdownFenceMarker(candidate) != "" {
					break
				}
				end = lines[index].end
				index++
			}
		}
		content := data[start:end]
		digestBytes := sha256.Sum256(content)
		digest := hex.EncodeToString(digestBytes[:])
		ordinal := len(result)
		result = append(result, ArtifactBlock{ID: artifactBlockID(sourceID, ordinal, digest), SourceID: sourceID,
			ArtifactID: artifactID, Ordinal: ordinal, Kind: kind, ByteStart: int64(start), ByteEnd: int64(end),
			Content: string(content), ContentSHA256: "sha256:" + digest, ASTPath: "/blocks/" + strconv.Itoa(ordinal)})
	}
	return result
}

func markdownFenceMarker(trimmed string) string {
	if strings.HasPrefix(trimmed, "```") {
		return "```"
	}
	if strings.HasPrefix(trimmed, "~~~") {
		return "~~~"
	}
	return ""
}

func markdownBlockKind(trimmed string) string {
	if strings.HasPrefix(trimmed, "#") {
		for index := 0; index < len(trimmed) && trimmed[index] == '#'; index++ {
			if index < 6 && index+1 < len(trimmed) && (trimmed[index+1] == ' ' || trimmed[index+1] == '\t') {
				return "heading"
			}
		}
	}
	if strings.HasPrefix(trimmed, ">") {
		return "quote"
	}
	if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") || strings.HasPrefix(trimmed, "+ ") {
		return "list"
	}
	for index := 0; index < len(trimmed) && index < 12; index++ {
		if trimmed[index] == '.' && index > 0 && index+1 < len(trimmed) && trimmed[index+1] == ' ' {
			if _, err := strconv.Atoi(trimmed[:index]); err == nil {
				return "list"
			}
			break
		}
	}
	return "paragraph"
}
