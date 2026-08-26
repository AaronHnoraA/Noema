// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package model

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	noemavirtualreference "github.com/aaronhe/noema/kernel/noema/virtualreference"
	"github.com/siyuan-note/logging"
)

// MarkdownVirtualReferenceNote is the narrow metadata needed by an unlinked
// mention scan. Keeping it separate from MarkdownNoteSummary avoids parsing
// summaries, DOM targets, blocks and backlinks on a first-ever mention query.
type MarkdownVirtualReferenceNote struct {
	ID      string   `json:"id"`
	Key     string   `json:"key"`
	Title   string   `json:"title"`
	File    string   `json:"file"`
	Path    string   `json:"path"`
	Source  string   `json:"source,omitempty"`
	Ext     string   `json:"ext"`
	Aliases []string `json:"aliases"`
	Refs    []string `json:"refs"`
	MtimeMs float64  `json:"mtimeMs"`
	Size    int64    `json:"size"`
}

func cloneMarkdownVirtualReferenceNote(note MarkdownVirtualReferenceNote) MarkdownVirtualReferenceNote {
	note.Aliases = append([]string(nil), note.Aliases...)
	note.Refs = append([]string(nil), note.Refs...)
	return note
}

func markdownVirtualReferenceNoteFromCatalogNote(note MarkdownNoteSummary) MarkdownVirtualReferenceNote {
	return MarkdownVirtualReferenceNote{
		ID: note.ID, Key: note.Key, Title: note.Title, File: note.File, Path: note.Path,
		Source: note.Source, Ext: note.Ext, Aliases: append([]string(nil), note.Aliases...),
		Refs: append([]string(nil), note.Refs...), MtimeMs: note.MtimeMs, Size: note.Size,
	}
}

func markdownVirtualReferenceNoteFromSnapshot(boxID, path string, snapshot *markdownSnapshot) MarkdownVirtualReferenceNote {
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
	visibleSource := source
	if metaTo > metaFrom {
		visibleSource = source[:metaFrom] + source[metaTo:]
	}
	return MarkdownVirtualReferenceNote{
		ID: id, Key: id, Title: title,
		File: filepath.Join(filesys.BoxRootPath(boxID), filepath.FromSlash(relative)), Path: relative,
		Source: noteMetaScalar(meta, "source"), Ext: strings.TrimPrefix(strings.ToLower(filepath.Ext(relative)), "."),
		Aliases: noteMetaList(meta, "aliases"), Refs: markdownNoteRefs(visibleSource, meta),
		MtimeMs: snapshot.mtimeMs, Size: snapshot.size,
	}
}

func markdownVirtualReferenceValues(note MarkdownVirtualReferenceNote) []string {
	return append([]string{
		note.ID, note.Key, note.Title, note.Path, note.Source, note.File, filepath.Base(note.File),
	}, note.Aliases...)
}

func resolveMarkdownVirtualReferenceNotes(raw []MarkdownVirtualReferenceNote) []MarkdownVirtualReferenceNote {
	sort.Slice(raw, func(i, j int) bool { return raw[i].Path < raw[j].Path })
	unique := map[string]MarkdownVirtualReferenceNote{}
	for _, note := range raw {
		current, exists := unique[note.ID]
		if !exists || note.Path == note.Source || current.Ext != "md" && note.Ext == "md" {
			unique[note.ID] = cloneMarkdownVirtualReferenceNote(note)
		}
	}
	index := map[string]string{}
	for id, note := range unique {
		for _, value := range markdownVirtualReferenceValues(note) {
			if key := canonicalMarkdownNoteRef(value); key != "" {
				if _, exists := index[key]; !exists {
					index[key] = id
				}
			}
		}
	}
	ret := make([]MarkdownVirtualReferenceNote, 0, len(unique))
	for id, note := range unique {
		resolved, seen := []string{}, map[string]bool{}
		for _, ref := range note.Refs {
			target := index[canonicalMarkdownNoteRef(ref)]
			if target == "" || target == id || seen[target] {
				continue
			}
			seen[target] = true
			resolved = append(resolved, target)
		}
		sort.Strings(resolved)
		note.Refs = resolved
		ret = append(ret, note)
	}
	sort.Slice(ret, func(i, j int) bool {
		if ret[i].Title == ret[j].Title {
			return ret[i].Path < ret[j].Path
		}
		return ret[i].Title < ret[j].Title
	})
	return ret
}

func markdownCatalogVirtualReferenceNotesLocked(boxID string, catalog *markdownBoxCatalog) error {
	if catalog.virtualNotes == nil {
		catalog.virtualNotes = make(map[string]MarkdownVirtualReferenceNote, len(catalog.docs))
		catalog.virtualNoteOrdered = nil
	}
	if len(catalog.virtualNotes) != len(catalog.docs) {
		cacheLock := markdownIndexCacheLock(boxID)
		cacheLock.Lock()
		persistent := loadMarkdownIndexCache(boxID, filesys.BoxRootPath(boxID))
		persistentDirty := false
		for path := range catalog.docs {
			if _, exists := catalog.virtualNotes[path]; exists {
				continue
			}
			entry := persistent.Entries[path]
			info, statErr := os.Stat(filepath.Join(filesys.BoxRootPath(boxID), path))
			cacheMatches := statErr == nil && entry.matchesSource(info)
			if fullNote, exists := catalog.notes[path]; exists {
				catalog.virtualNotes[path] = markdownVirtualReferenceNoteFromCatalogNote(fullNote)
				continue
			}
			if cacheMatches && entry.VirtualNoteCached {
				catalog.virtualNotes[path] = cloneMarkdownVirtualReferenceNote(entry.VirtualNote)
				continue
			}
			snapshot, loadErr := loadMarkdownSnapshot(boxID, path)
			if loadErr != nil {
				if os.IsNotExist(loadErr) {
					continue
				}
				cacheLock.Unlock()
				return loadErr
			}
			note := snapshot.virtualReferenceNoteSummary(boxID, path)
			catalog.virtualNotes[path] = note
			entry, _ = markdownIndexEntryForSnapshot(entry, snapshot)
			entry.VirtualNoteCached = true
			entry.VirtualNote = cloneMarkdownVirtualReferenceNote(note)
			persistent.Entries[path] = entry
			persistentDirty = true
		}
		if persistentDirty {
			if err := saveMarkdownIndexCache(boxID, persistent); err != nil {
				logging.LogWarnf("save Markdown virtual-reference cache failed: %s", err)
			}
		}
		cacheLock.Unlock()
	}
	if catalog.virtualNoteOrdered == nil {
		raw := make([]MarkdownVirtualReferenceNote, 0, len(catalog.virtualNotes))
		for _, note := range catalog.virtualNotes {
			raw = append(raw, cloneMarkdownVirtualReferenceNote(note))
		}
		catalog.virtualNoteOrdered = resolveMarkdownVirtualReferenceNotes(raw)
	}
	return nil
}

const (
	markdownVirtualReferenceTTL          = 10 * time.Minute
	markdownVirtualReferenceMaxEntries   = 16
	markdownVirtualReferenceMaxDocuments = 5_000
	markdownVirtualReferenceMaxDocBytes  = 8 * 1024 * 1024
	markdownVirtualReferenceMaxAllBytes  = 64 * 1024 * 1024
)

type MarkdownVirtualReferenceTarget struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	File  string `json:"file"`
	Path  string `json:"path"`
}

type MarkdownVirtualReferenceMention struct {
	SourceID    string   `json:"sourceId"`
	SourceTitle string   `json:"sourceTitle"`
	File        string   `json:"file"`
	Path        string   `json:"path"`
	Count       int      `json:"count"`
	Keywords    []string `json:"keywords"`
	Snippet     string   `json:"snippet"`
}

type MarkdownVirtualReferences struct {
	Type             string                            `json:"type"`
	EvaluationSource string                            `json:"evaluationSource"`
	Target           *MarkdownVirtualReferenceTarget   `json:"target"`
	Mentions         []MarkdownVirtualReferenceMention `json:"mentions"`
	ScannedDocuments int                               `json:"scannedDocuments,omitempty"`
	TTLms            int64                             `json:"ttlMs"`
}

func cloneMarkdownVirtualReferences(payload MarkdownVirtualReferences) MarkdownVirtualReferences {
	if payload.Target != nil {
		target := *payload.Target
		payload.Target = &target
	}
	payload.Mentions = append([]MarkdownVirtualReferenceMention(nil), payload.Mentions...)
	for index := range payload.Mentions {
		payload.Mentions[index].Keywords = append([]string(nil), payload.Mentions[index].Keywords...)
	}
	return payload
}

func emptyMarkdownVirtualReferences() MarkdownVirtualReferences {
	return MarkdownVirtualReferences{
		Type: "virtual-references", EvaluationSource: "noema-aho-corasick",
		Target: nil, Mentions: []MarkdownVirtualReferenceMention{}, TTLms: markdownVirtualReferenceTTL.Milliseconds(),
	}
}

func markdownVirtualReferenceTarget(notes []MarkdownVirtualReferenceNote, requested string) (MarkdownVirtualReferenceNote, bool) {
	requested = strings.TrimSpace(requested)
	for _, note := range notes {
		if requested == note.ID || requested == note.Key || requested == note.File || requested == note.Path ||
			requested == "/"+strings.TrimPrefix(note.Path, "/") || requested == note.Title {
			return note, true
		}
	}
	return MarkdownVirtualReferenceNote{}, false
}

func markdownVirtualReferenceCacheGet(catalog *markdownBoxCatalog, key string, now time.Time) (MarkdownVirtualReferences, bool) {
	entry, ok := catalog.virtualReferences[key]
	if !ok {
		return MarkdownVirtualReferences{}, false
	}
	if !now.Before(entry.expiresAt) {
		delete(catalog.virtualReferences, key)
		for index, candidate := range catalog.virtualReferenceLRU {
			if candidate == key {
				catalog.virtualReferenceLRU = append(catalog.virtualReferenceLRU[:index], catalog.virtualReferenceLRU[index+1:]...)
				break
			}
		}
		return MarkdownVirtualReferences{}, false
	}
	for index, candidate := range catalog.virtualReferenceLRU {
		if candidate == key {
			catalog.virtualReferenceLRU = append(catalog.virtualReferenceLRU[:index], catalog.virtualReferenceLRU[index+1:]...)
			break
		}
	}
	catalog.virtualReferenceLRU = append(catalog.virtualReferenceLRU, key)
	return cloneMarkdownVirtualReferences(entry.payload), true
}

func markdownVirtualReferenceCachePut(catalog *markdownBoxCatalog, key string, payload MarkdownVirtualReferences, now time.Time) {
	if catalog.virtualReferences == nil {
		catalog.virtualReferences = map[string]markdownVirtualReferenceCacheEntry{}
	}
	for index, candidate := range catalog.virtualReferenceLRU {
		if candidate == key {
			catalog.virtualReferenceLRU = append(catalog.virtualReferenceLRU[:index], catalog.virtualReferenceLRU[index+1:]...)
			break
		}
	}
	catalog.virtualReferenceLRU = append(catalog.virtualReferenceLRU, key)
	catalog.virtualReferences[key] = markdownVirtualReferenceCacheEntry{
		payload: cloneMarkdownVirtualReferences(payload), expiresAt: now.Add(markdownVirtualReferenceTTL),
	}
	for len(catalog.virtualReferenceLRU) > markdownVirtualReferenceMaxEntries {
		oldest := catalog.virtualReferenceLRU[0]
		catalog.virtualReferenceLRU = catalog.virtualReferenceLRU[1:]
		delete(catalog.virtualReferences, oldest)
	}
}

func markdownCatalogVirtualReferences(boxID, requested string, caseSensitive bool) (MarkdownVirtualReferences, error) {
	catalog, err := ensureMarkdownBoxCatalog(boxID)
	if err != nil {
		return MarkdownVirtualReferences{}, err
	}
	catalog.mu.Lock()
	if err = markdownCatalogVirtualReferenceNotesLocked(boxID, catalog); err != nil {
		catalog.mu.Unlock()
		return MarkdownVirtualReferences{}, err
	}
	notes := catalog.virtualNoteOrdered
	if len(notes) > markdownVirtualReferenceMaxDocuments {
		notes = notes[:markdownVirtualReferenceMaxDocuments]
	}
	target, found := markdownVirtualReferenceTarget(notes, requested)
	if !found {
		catalog.mu.Unlock()
		return emptyMarkdownVirtualReferences(), nil
	}
	cacheKey := target.ID + "\x00"
	if caseSensitive {
		cacheKey += "case-sensitive"
	} else {
		cacheKey += "case-insensitive"
	}
	now := time.Now()
	if cached, ok := markdownVirtualReferenceCacheGet(catalog, cacheKey, now); ok {
		catalog.mu.Unlock()
		return cached, nil
	}

	documents := make([]noemavirtualreference.Document, 0, len(notes))
	noteByID := make(map[string]MarkdownVirtualReferenceNote, len(notes))
	var totalBytes int64
	for _, note := range notes {
		if note.Path == "" || note.Size > markdownVirtualReferenceMaxDocBytes {
			continue
		}
		snapshot, loadErr := loadMarkdownSnapshot(boxID, "/"+strings.TrimPrefix(note.Path, "/"))
		if loadErr != nil {
			continue
		}
		if snapshot.size > markdownVirtualReferenceMaxDocBytes || totalBytes+snapshot.size > markdownVirtualReferenceMaxAllBytes {
			continue
		}
		totalBytes += snapshot.size
		noteByID[note.ID] = note
		documents = append(documents, noemavirtualreference.Document{
			ID: note.ID, Title: note.Title, Aliases: note.Aliases, Refs: note.Refs,
			File: note.File, Text: string(snapshot.source),
		})
	}
	matches := noemavirtualreference.Find(documents, target.ID, caseSensitive)
	mentions := make([]MarkdownVirtualReferenceMention, 0, len(matches))
	for _, match := range matches {
		mention := MarkdownVirtualReferenceMention{
			SourceID: match.SourceID, SourceTitle: match.SourceTitle, File: match.File,
			Count: match.Count, Keywords: match.Keywords, Snippet: match.Snippet,
		}
		if note, ok := noteByID[match.SourceID]; ok {
			mention.Path = note.Path
		}
		mentions = append(mentions, mention)
	}
	payload := MarkdownVirtualReferences{
		Type: "virtual-references", EvaluationSource: "noema-aho-corasick",
		Target:   &MarkdownVirtualReferenceTarget{ID: target.ID, Title: target.Title, File: target.File, Path: target.Path},
		Mentions: mentions, ScannedDocuments: len(documents), TTLms: markdownVirtualReferenceTTL.Milliseconds(),
	}
	markdownVirtualReferenceCachePut(catalog, cacheKey, payload, now)
	catalog.mu.Unlock()
	return payload, nil
}

// ListMarkdownVirtualReferences returns the canonical unlinked-mention
// projection for one note without involving the Node host's filesystem scan.
func ListMarkdownVirtualReferences(boxID, requested string, caseSensitive bool) (MarkdownVirtualReferences, error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return MarkdownVirtualReferences{}, fmt.Errorf("box [%s] is not a markdown box", boxID)
	}
	return markdownCatalogVirtualReferences(boxID, requested, caseSensitive)
}
