// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package model

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	noemamarkdown "github.com/aaronhe/noema/kernel/noema/markdown"
	noemaplanning "github.com/aaronhe/noema/kernel/noema/planning"
	"github.com/siyuan-note/logging"
)

// MarkdownWorkspaceNote is the narrow note metadata needed to project
// planning rows. Rich refs/backlinks/DOM targets stay in MarkdownNoteSummary
// and are intentionally absent from the latency-sensitive Agenda path.
type MarkdownWorkspaceNote struct {
	Key        string   `json:"key"`
	ID         string   `json:"id"`
	Title      string   `json:"title"`
	File       string   `json:"file"`
	Path       string   `json:"path"`
	Kind       string   `json:"kind"`
	Date       string   `json:"date,omitempty"`
	Project    string   `json:"project,omitempty"`
	Tags       []string `json:"tags"`
	InlineTags []string `json:"inlineTags"`
	GroupKey   string   `json:"groupKey"`
	GroupLabel string   `json:"groupLabel"`
	MtimeMs    float64  `json:"mtimeMs"`
	Size       int64    `json:"size"`
}

func cloneMarkdownWorkspaceNote(note MarkdownWorkspaceNote) MarkdownWorkspaceNote {
	note.Tags = append([]string(nil), note.Tags...)
	note.InlineTags = append([]string(nil), note.InlineTags...)
	return note
}

func markdownWorkspaceNoteFromCatalogNote(note MarkdownNoteSummary) MarkdownWorkspaceNote {
	return MarkdownWorkspaceNote{
		Key: note.Key, ID: note.ID, Title: note.Title, File: note.File, Path: note.Path, Kind: note.Kind,
		Date: note.Date, Project: note.Project, Tags: append([]string(nil), note.Tags...),
		InlineTags: append([]string(nil), note.InlineTags...), GroupKey: note.GroupKey,
		GroupLabel: note.GroupLabel, MtimeMs: note.MtimeMs, Size: note.Size,
	}
}

func markdownWorkspaceNoteFromSnapshot(boxID, path string, snapshot *markdownSnapshot) MarkdownWorkspaceNote {
	source := string(snapshot.source)
	lines := markdownNoteLines(source)
	meta, metaFrom, metaTo := markdownNoteMetadata(source, lines)
	relative := strings.TrimPrefix(filepath.ToSlash(path), "/")
	title := noteMetaScalar(meta, "title")
	if title == "" {
		for _, line := range lines {
			if match := noteHeadingPattern.FindStringSubmatch(line.text); len(match) > 2 {
				title = strings.TrimSpace(match[2])
				break
			}
		}
	}
	if title == "" {
		title = strings.TrimSuffix(filepath.Base(relative), filepath.Ext(relative))
	}
	id := noteMetaScalar(meta, "id")
	if id == "" {
		id = relative
	}
	group := filepath.ToSlash(filepath.Dir(relative))
	if group == "." || group == "" {
		group = "Root"
	}
	return MarkdownWorkspaceNote{
		Key: id, ID: id, Title: title,
		File: filepath.Join(filesys.BoxRootPath(boxID), filepath.FromSlash(relative)), Path: relative,
		Kind: normalizeMarkdownNoteKind(noteMetaScalar(meta, "kind", "kinds")), Date: noteMetaScalar(meta, "date"),
		Project: noteMetaScalar(meta, "project", "proj"), Tags: normalizeMarkdownNoteTags(noteMetaList(meta, "tags")),
		InlineTags: markdownNoteInlineTags(lines, metaFrom, metaTo), GroupKey: group,
		GroupLabel: markdownNoteGroupLabel(group), MtimeMs: snapshot.mtimeMs, Size: snapshot.size,
	}
}

// MarkdownWorkspaceProjectionDocument joins the three immutable projections
// needed by Agenda/Attribute View. Keeping the join in the kernel avoids the
// historical Node walk + stat + read pass and avoids three HTTP round trips
// for catalog, planning nodes, and portable block properties.
type MarkdownWorkspaceProjectionDocument struct {
	Path                   string                     `json:"path"`
	Note                   MarkdownWorkspaceNote      `json:"note"`
	Nodes                  []noemaplanning.Node       `json:"nodes"`
	Blocks                 []noemamarkdown.Definition `json:"blocks,omitempty"`
	DuplicateDefinitionIDs []string                   `json:"duplicateDefinitionIds,omitempty"`
	Version                string                     `json:"version"`
	MtimeMs                float64                    `json:"mtimeMs"`
}

type MarkdownWorkspaceProjection struct {
	Documents    []MarkdownWorkspaceProjectionDocument `json:"documents"`
	IndexVersion uint64                                `json:"indexVersion"`
	Source       string                                `json:"source"`
}

// ListMarkdownWorkspaceProjection returns one coherent, read-only workspace
// projection. Every component is derived from the same per-file immutable
// snapshot cache; source bytes are read only on a cold/mutated path.
func ListMarkdownWorkspaceProjection(boxID string, includeProperties bool) (projection MarkdownWorkspaceProjection, err error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return projection, fmt.Errorf("box [%s] is not a markdown box", boxID)
	}
	return markdownCatalogWorkspaceProjection(boxID, includeProperties)
}

func markdownCatalogWorkspaceProjection(boxID string, includeProperties bool) (projection MarkdownWorkspaceProjection, err error) {
	catalog, err := ensureMarkdownBoxCatalog(boxID)
	if nil != err {
		return projection, err
	}
	catalog.mu.Lock()
	defer catalog.mu.Unlock()
	if nil == catalog.workspaceNotes {
		catalog.workspaceNotes = make(map[string]MarkdownWorkspaceNote, len(catalog.docs))
		catalog.workspaceNoteOrdered = nil
	}
	if nil == catalog.planning {
		catalog.planning = make(map[string]MarkdownPlanningDocument, len(catalog.docs))
		catalog.planOrdered = nil
	}
	if includeProperties && nil == catalog.properties {
		catalog.properties = make(map[string]MarkdownPropertyDocument, len(catalog.docs))
		catalog.propOrdered = nil
	}

	needsPopulation := len(catalog.workspaceNotes) != len(catalog.docs) || len(catalog.planning) != len(catalog.docs) ||
		includeProperties && len(catalog.properties) != len(catalog.docs)
	if needsPopulation {
		cacheLock := markdownIndexCacheLock(boxID)
		cacheLock.Lock()
		persistent := loadMarkdownIndexCache(boxID, filesys.BoxRootPath(boxID))
		persistentDirty := false
		for path := range catalog.docs {
			entry := persistent.Entries[path]
			info, statErr := os.Stat(filepath.Join(filesys.BoxRootPath(boxID), path))
			cacheMatches := nil == statErr && entry.matchesSource(info)
			_, hasNote := catalog.workspaceNotes[path]
			_, hasPlanning := catalog.planning[path]
			_, hasProperties := catalog.properties[path]
			cachedNote := cacheMatches && entry.WorkspaceNoteCached
			cachedCatalogNote := cacheMatches && entry.CatalogCached
			fullNote, hasFullNote := catalog.notes[path]
			cachedPlanning := cacheMatches && entry.PlanningCached && entry.SourceVersion != ""
			cachedProperties := cacheMatches && entry.PropertiesCached && entry.SourceVersion != ""
			needsSnapshot := !hasNote && !cachedNote && !cachedCatalogNote && !hasFullNote || !hasPlanning && !cachedPlanning ||
				includeProperties && !hasProperties && !cachedProperties
			var snapshot *markdownSnapshot
			if needsSnapshot {
				snapshot, err = loadMarkdownSnapshot(boxID, path)
				if nil != err {
					if os.IsNotExist(err) {
						continue
					}
					cacheLock.Unlock()
					return projection, err
				}
				entry, _ = markdownIndexEntryForSnapshot(entry, snapshot)
			}
			if !hasNote {
				if hasFullNote {
					catalog.workspaceNotes[path] = markdownWorkspaceNoteFromCatalogNote(fullNote)
				} else if cachedNote {
					catalog.workspaceNotes[path] = cloneMarkdownWorkspaceNote(entry.WorkspaceNote)
				} else if cachedCatalogNote {
					catalog.workspaceNotes[path] = markdownWorkspaceNoteFromCatalogNote(entry.Catalog)
				} else {
					note := snapshot.workspaceNoteSummary(boxID, path)
					catalog.workspaceNotes[path] = note
					entry.WorkspaceNoteCached = true
					entry.WorkspaceNote = cloneMarkdownWorkspaceNote(note)
					persistentDirty = true
				}
			}
			if !hasPlanning {
				if cachedPlanning {
					nodes := entry.Planning
					if nil == nodes {
						nodes = []noemaplanning.Node{}
					}
					catalog.planning[path] = MarkdownPlanningDocument{
						Path: path, Nodes: nodes, Version: entry.SourceVersion, MtimeMs: float64(entry.MtimeNs) / 1e6,
					}
				} else {
					document := planningDocumentFromSnapshot(path, snapshot)
					catalog.planning[path] = document
					entry.SourceVersion = document.Version
					entry.PlanningCached = true
					entry.Planning = document.Nodes
					persistentDirty = true
				}
			}
			if includeProperties && !hasProperties {
				if cachedProperties {
					blocks := entry.Properties
					if nil == blocks {
						blocks = []noemamarkdown.Definition{}
					}
					duplicates := entry.DuplicateDefinition
					if nil == duplicates {
						duplicates = []string{}
					}
					catalog.properties[path] = MarkdownPropertyDocument{
						Path: path, Blocks: blocks, DuplicateDefinitionIDs: duplicates,
						Version: entry.SourceVersion, MtimeMs: float64(entry.MtimeNs) / 1e6,
					}
				} else {
					document := propertyDocumentFromSnapshot(path, snapshot)
					catalog.properties[path] = document
					entry.SourceVersion = document.Version
					entry.PropertiesCached = true
					entry.Properties = document.Blocks
					entry.DuplicateDefinition = document.DuplicateDefinitionIDs
					persistentDirty = true
				}
			}
			if persistentDirty {
				persistent.Entries[path] = entry
			}
		}
		if persistentDirty {
			if saveErr := saveMarkdownIndexCache(boxID, persistent); nil != saveErr {
				logging.LogWarnf("save Markdown workspace projection cache failed: %s", saveErr)
			}
		}
		cacheLock.Unlock()
	}

	if nil == catalog.workspaceNoteOrdered {
		catalog.workspaceNoteOrdered = make([]MarkdownWorkspaceNote, 0, len(catalog.workspaceNotes))
		for _, note := range catalog.workspaceNotes {
			catalog.workspaceNoteOrdered = append(catalog.workspaceNoteOrdered, cloneMarkdownWorkspaceNote(note))
		}
		sort.Slice(catalog.workspaceNoteOrdered, func(i, j int) bool {
			if catalog.workspaceNoteOrdered[i].Title == catalog.workspaceNoteOrdered[j].Title {
				return catalog.workspaceNoteOrdered[i].Path < catalog.workspaceNoteOrdered[j].Path
			}
			return catalog.workspaceNoteOrdered[i].Title < catalog.workspaceNoteOrdered[j].Title
		})
	}
	projection.Documents = make([]MarkdownWorkspaceProjectionDocument, 0, len(catalog.workspaceNoteOrdered))
	for _, note := range catalog.workspaceNoteOrdered {
		path := "/" + note.Path
		planningDocument := catalog.planning[path]
		nodes := planningDocument.Nodes
		if nil == nodes {
			nodes = []noemaplanning.Node{}
		}
		document := MarkdownWorkspaceProjectionDocument{
			Path: path, Note: cloneMarkdownWorkspaceNote(note), Nodes: nodes,
			Version: planningDocument.Version, MtimeMs: planningDocument.MtimeMs,
		}
		if includeProperties {
			propertyDocument := catalog.properties[path]
			document.Blocks = propertyDocument.Blocks
			if nil == document.Blocks {
				document.Blocks = []noemamarkdown.Definition{}
			}
			document.DuplicateDefinitionIDs = propertyDocument.DuplicateDefinitionIDs
			if nil == document.DuplicateDefinitionIDs {
				document.DuplicateDefinitionIDs = []string{}
			}
			if document.Version == "" {
				document.Version = propertyDocument.Version
			}
			if document.MtimeMs == 0 {
				document.MtimeMs = propertyDocument.MtimeMs
			}
		}
		if document.MtimeMs == 0 {
			document.MtimeMs = note.MtimeMs
		}
		projection.Documents = append(projection.Documents, document)
	}
	projection.IndexVersion = catalog.generation
	projection.Source = "kernel-workspace-projection"
	return projection, nil
}
