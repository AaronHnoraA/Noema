// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema incremental Markdown catalog additions are Copyright (c) 2026 Aaron
// He and distributed under the same AGPL-3.0-or-later terms.

package model

import (
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/aaronhe/noema/kernel/filesys"
	noemamarkdown "github.com/aaronhe/noema/kernel/noema/markdown"
	noemaplanning "github.com/aaronhe/noema/kernel/noema/planning"
	"github.com/siyuan-note/logging"
)

// markdownBoxCatalog mirrors the Node host's incremental notes index. The
// directory tree is discovered once; fsnotify/save events then replace only
// the changed path. Whole-vault agenda and attribute-view reads therefore
// become O(number of returned rows) without an O(number of files) stat/read
// pass on every request.
type markdownBoxCatalog struct {
	mu                   sync.RWMutex
	initialized          bool
	docs                 map[string]MarkdownDocSummary
	docsOrdered          []MarkdownDocSummary
	planning             map[string]MarkdownPlanningDocument
	planOrdered          []MarkdownPlanningDocument
	properties           map[string]MarkdownPropertyDocument
	propOrdered          []MarkdownPropertyDocument
	notes                map[string]MarkdownNoteSummary
	noteOrdered          []MarkdownNoteSummary
	noteRefIndex         map[string]string
	noteDirectories      []MarkdownNoteDirectory
	workspaceNotes       map[string]MarkdownWorkspaceNote
	workspaceNoteOrdered []MarkdownWorkspaceNote
	virtualNotes         map[string]MarkdownVirtualReferenceNote
	virtualNoteOrdered   []MarkdownVirtualReferenceNote
	virtualReferences    map[string]markdownVirtualReferenceCacheEntry
	virtualReferenceLRU  []string
	generation           uint64
}

type markdownVirtualReferenceCacheEntry struct {
	payload   MarkdownVirtualReferences
	expiresAt time.Time
}

var markdownBoxCatalogs sync.Map // boxID -> *markdownBoxCatalog

func catalogForMarkdownBox(boxID string) *markdownBoxCatalog {
	value, _ := markdownBoxCatalogs.LoadOrStore(boxID, &markdownBoxCatalog{})
	return value.(*markdownBoxCatalog)
}

func ensureMarkdownBoxCatalog(boxID string) (*markdownBoxCatalog, error) {
	catalog := catalogForMarkdownBox(boxID)
	catalog.mu.Lock()
	defer catalog.mu.Unlock()
	if catalog.initialized {
		return catalog, nil
	}
	docs, err := scanMarkdownDocs(boxID)
	if nil != err {
		return nil, err
	}
	catalog.docs = make(map[string]MarkdownDocSummary, len(docs))
	for _, doc := range docs {
		catalog.docs[doc.Path] = doc
	}
	catalog.initialized = true
	catalog.generation = 1
	return catalog, nil
}

func resetMarkdownBoxCatalog(boxID string) {
	markdownBoxCatalogs.Delete(boxID)
	forgetMarkdownBoxSnapshots(boxID)
}

func markdownCatalogDocs(boxID string) ([]MarkdownDocSummary, error) {
	catalog, err := ensureMarkdownBoxCatalog(boxID)
	if nil != err {
		return nil, err
	}
	catalog.mu.RLock()
	ordered := catalog.docsOrdered
	catalog.mu.RUnlock()
	if nil != ordered {
		return append([]MarkdownDocSummary(nil), ordered...), nil
	}
	catalog.mu.Lock()
	if nil == catalog.docsOrdered {
		catalog.docsOrdered = make([]MarkdownDocSummary, 0, len(catalog.docs))
		for _, doc := range catalog.docs {
			catalog.docsOrdered = append(catalog.docsOrdered, doc)
		}
		sort.Slice(catalog.docsOrdered, func(i, j int) bool { return catalog.docsOrdered[i].Path < catalog.docsOrdered[j].Path })
	}
	ordered = append([]MarkdownDocSummary(nil), catalog.docsOrdered...)
	catalog.mu.Unlock()
	return ordered, nil
}

func markdownCatalogPlanning(boxID string) ([]MarkdownPlanningDocument, error) {
	catalog, err := ensureMarkdownBoxCatalog(boxID)
	if nil != err {
		return nil, err
	}
	catalog.mu.Lock()
	defer catalog.mu.Unlock()
	if nil == catalog.planning {
		catalog.planning = make(map[string]MarkdownPlanningDocument, len(catalog.docs))
		cacheLock := markdownIndexCacheLock(boxID)
		cacheLock.Lock()
		defer cacheLock.Unlock()
		persistent := loadMarkdownIndexCache(boxID, filesys.BoxRootPath(boxID))
		persistentDirty := false
		defer func() {
			if persistentDirty {
				if err := saveMarkdownIndexCache(boxID, persistent); nil != err {
					logging.LogWarnf("save Markdown planning cache failed: %s", err)
				}
			}
		}()
		for path := range catalog.docs {
			if entry, ok := persistent.Entries[path]; ok && entry.PlanningCached && "" != entry.SourceVersion {
				info, statErr := os.Stat(filepath.Join(filesys.BoxRootPath(boxID), path))
				if nil == statErr && entry.matchesSource(info) {
					nodes := entry.Planning
					if nil == nodes {
						nodes = []noemaplanning.Node{}
					}
					catalog.planning[path] = MarkdownPlanningDocument{
						Path: path, Nodes: nodes, Version: entry.SourceVersion, MtimeMs: float64(entry.MtimeNs) / 1e6,
					}
					continue
				}
			}
			snapshot, loadErr := loadMarkdownSnapshot(boxID, path)
			if nil != loadErr {
				if os.IsNotExist(loadErr) {
					continue
				}
				return nil, loadErr
			}
			document := planningDocumentFromSnapshot(path, snapshot)
			catalog.planning[path] = document
			entry, _ := markdownIndexEntryForSnapshot(persistent.Entries[path], snapshot)
			entry.SourceVersion = document.Version
			entry.PlanningCached = true
			entry.Planning = document.Nodes
			persistent.Entries[path] = entry
			persistentDirty = true
		}
	}
	if nil == catalog.planOrdered {
		catalog.planOrdered = make([]MarkdownPlanningDocument, 0, len(catalog.planning))
		for _, document := range catalog.planning {
			catalog.planOrdered = append(catalog.planOrdered, document)
		}
		sort.Slice(catalog.planOrdered, func(i, j int) bool { return catalog.planOrdered[i].Path < catalog.planOrdered[j].Path })
	}
	return append([]MarkdownPlanningDocument(nil), catalog.planOrdered...), nil
}

func markdownCatalogProperties(boxID string) ([]MarkdownPropertyDocument, error) {
	catalog, err := ensureMarkdownBoxCatalog(boxID)
	if nil != err {
		return nil, err
	}
	catalog.mu.Lock()
	defer catalog.mu.Unlock()
	if nil == catalog.properties {
		catalog.properties = make(map[string]MarkdownPropertyDocument, len(catalog.docs))
		cacheLock := markdownIndexCacheLock(boxID)
		cacheLock.Lock()
		defer cacheLock.Unlock()
		persistent := loadMarkdownIndexCache(boxID, filesys.BoxRootPath(boxID))
		persistentDirty := false
		defer func() {
			if persistentDirty {
				if err := saveMarkdownIndexCache(boxID, persistent); nil != err {
					logging.LogWarnf("save Markdown property cache failed: %s", err)
				}
			}
		}()
		for path := range catalog.docs {
			if entry, ok := persistent.Entries[path]; ok && entry.PropertiesCached && "" != entry.SourceVersion {
				info, statErr := os.Stat(filepath.Join(filesys.BoxRootPath(boxID), path))
				if nil == statErr && entry.matchesSource(info) {
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
					continue
				}
			}
			snapshot, loadErr := loadMarkdownSnapshot(boxID, path)
			if nil != loadErr {
				if os.IsNotExist(loadErr) {
					continue
				}
				return nil, loadErr
			}
			document := propertyDocumentFromSnapshot(path, snapshot)
			catalog.properties[path] = document
			entry, _ := markdownIndexEntryForSnapshot(persistent.Entries[path], snapshot)
			entry.SourceVersion = document.Version
			entry.PropertiesCached = true
			entry.Properties = document.Blocks
			entry.DuplicateDefinition = document.DuplicateDefinitionIDs
			persistent.Entries[path] = entry
			persistentDirty = true
		}
	}
	if nil == catalog.propOrdered {
		catalog.propOrdered = make([]MarkdownPropertyDocument, 0, len(catalog.properties))
		for _, document := range catalog.properties {
			catalog.propOrdered = append(catalog.propOrdered, document)
		}
		sort.Slice(catalog.propOrdered, func(i, j int) bool { return catalog.propOrdered[i].Path < catalog.propOrdered[j].Path })
	}
	return append([]MarkdownPropertyDocument(nil), catalog.propOrdered...), nil
}

func markdownCatalogNotes(boxID string) (MarkdownNoteCatalog, error) {
	catalog, err := ensureMarkdownBoxCatalog(boxID)
	if nil != err {
		return MarkdownNoteCatalog{}, err
	}
	catalog.mu.Lock()
	defer catalog.mu.Unlock()
	if nil == catalog.notes {
		catalog.notes = make(map[string]MarkdownNoteSummary, len(catalog.docs))
		cacheLock := markdownIndexCacheLock(boxID)
		cacheLock.Lock()
		defer cacheLock.Unlock()
		persistent := loadMarkdownIndexCache(boxID, filesys.BoxRootPath(boxID))
		persistentDirty := false
		defer func() {
			if persistentDirty {
				if err := saveMarkdownIndexCache(boxID, persistent); nil != err {
					logging.LogWarnf("save Markdown note catalog cache failed: %s", err)
				}
			}
		}()
		for path := range catalog.docs {
			if entry, ok := persistent.Entries[path]; ok && entry.CatalogCached {
				info, statErr := os.Stat(filepath.Join(filesys.BoxRootPath(boxID), path))
				if nil == statErr && entry.matchesSource(info) {
					catalog.notes[path] = cloneMarkdownNoteSummary(entry.Catalog)
					continue
				}
			}
			snapshot, loadErr := loadMarkdownSnapshot(boxID, path)
			if nil != loadErr {
				if os.IsNotExist(loadErr) {
					continue
				}
				return MarkdownNoteCatalog{}, loadErr
			}
			note := snapshot.noteSummary(boxID, path)
			catalog.notes[path] = note
			entry, _ := markdownIndexEntryForSnapshot(persistent.Entries[path], snapshot)
			entry.CatalogCached = true
			entry.Catalog = cloneMarkdownNoteSummary(note)
			persistent.Entries[path] = entry
			persistentDirty = true
		}
	}
	if nil == catalog.noteOrdered {
		// resolveMarkdownNoteRelationships clones every note it keeps into its
		// own `unique` map, so cloning here as well copied the whole vault twice
		// per rebuild. It does sort the slice in place, which is why this is a
		// fresh slice rather than a reference to the map's values.
		raw := make([]MarkdownNoteSummary, 0, len(catalog.notes))
		for _, note := range catalog.notes {
			raw = append(raw, note)
		}
		catalog.noteOrdered = resolveMarkdownNoteRelationships(raw)
		catalog.noteRefIndex = nil
		catalog.noteDirectories = nil
	}
	if nil == catalog.noteDirectories {
		catalog.noteDirectories = markdownNoteDirectories(catalog.noteOrdered)
	}
	notes := make([]MarkdownNoteSummary, len(catalog.noteOrdered))
	for index, note := range catalog.noteOrdered {
		notes[index] = cloneMarkdownNoteSummary(note)
	}
	return MarkdownNoteCatalog{
		Notes:        notes,
		Directories:  append([]MarkdownNoteDirectory(nil), catalog.noteDirectories...),
		Files:        []any{},
		IndexVersion: catalog.generation,
		Source:       "kernel-note-catalog",
	}, nil
}

// patchMarkdownNoteRelationships replaces one note in the resolved catalog
// without re-resolving the vault, and reports whether it could.
//
// This is the Go port of the Node host's patchResolvedRelationships, which the
// kernel takeover dropped: updateMarkdownCatalogPath simply cleared
// noteOrdered, so a one-character edit made the next catalog read re-resolve
// every note's refs and backlinks and re-clone the whole vault — measured at
// 1.0 ms for 200 notes and 5.8 ms for 1000, once per autosave, growing linearly
// with the vault.
//
// The fast path is only safe while the vault-wide ref index is unaffected, so
// it is declined (leaving the caller to invalidate as before) whenever the note
// is new, its id changed, or the set of values it can be referenced by changed.
// Everything else — prose edits, ref edits, tag edits — patches in place: the
// note's own resolved refs are recomputed against the unchanged index, and the
// backlink lists of exactly the targets it gained or lost are adjusted.
//
// Caller must hold catalog.mu.
func (catalog *markdownBoxCatalog) patchMarkdownNoteRelationships(stored, next MarkdownNoteSummary) bool {
	if nil == catalog.noteOrdered || stored.ID == "" || stored.ID != next.ID {
		return false
	}
	position := -1
	for index, note := range catalog.noteOrdered {
		if note.ID != stored.ID {
			continue
		}
		if position >= 0 {
			// The id is claimed by more than one row; which one the resolver
			// keeps is its decision, not this patch's.
			return false
		}
		position = index
	}
	if position < 0 || catalog.noteOrdered[position].Path != stored.Path || stored.Path != next.Path {
		return false
	}
	previous := catalog.noteOrdered[position]
	if !sameMarkdownStringList(markdownNoteRefKeys(stored), markdownNoteRefKeys(next)) {
		return false
	}

	if nil == catalog.noteRefIndex {
		unique := make(map[string]MarkdownNoteSummary, len(catalog.noteOrdered))
		for _, note := range catalog.noteOrdered {
			unique[note.ID] = note
		}
		catalog.noteRefIndex = markdownNoteRefIndex(unique)
	}

	byID := make(map[string]int, len(catalog.noteOrdered))
	for index, note := range catalog.noteOrdered {
		byID[note.ID] = index
	}

	oldRefs := make(map[string]bool, len(previous.Refs))
	for _, ref := range previous.Refs {
		oldRefs[ref] = true
	}
	resolved, newRefs := []string{}, map[string]bool{}
	for _, ref := range next.Refs {
		target := catalog.noteRefIndex[canonicalMarkdownNoteRef(ref)]
		if target == "" || target == previous.ID || newRefs[target] {
			continue
		}
		newRefs[target] = true
		resolved = append(resolved, target)
	}
	sort.Strings(resolved)

	patched := append([]MarkdownNoteSummary(nil), catalog.noteOrdered...)
	for ref := range oldRefs {
		if newRefs[ref] {
			continue
		}
		index, ok := byID[ref]
		if !ok {
			continue
		}
		kept := make([]string, 0, len(patched[index].Backlinks))
		for _, backlink := range patched[index].Backlinks {
			if backlink != previous.ID {
				kept = append(kept, backlink)
			}
		}
		target := cloneMarkdownNoteSummary(patched[index])
		target.Backlinks = kept
		patched[index] = target
	}
	for ref := range newRefs {
		if oldRefs[ref] {
			continue
		}
		index, ok := byID[ref]
		if !ok {
			continue
		}
		target := cloneMarkdownNoteSummary(patched[index])
		target.Backlinks = sortedUniqueMarkdownStrings(append(target.Backlinks, previous.ID))
		patched[index] = target
	}

	replacement := cloneMarkdownNoteSummary(next)
	replacement.Refs = resolved
	// Backlinks point at this note from others, none of which changed.
	replacement.Backlinks = append([]string(nil), previous.Backlinks...)
	patched[position] = replacement

	sort.Slice(patched, func(i, j int) bool {
		if patched[i].Title == patched[j].Title {
			return patched[i].Path < patched[j].Path
		}
		return patched[i].Title < patched[j].Title
	})
	catalog.noteOrdered = patched
	// GroupKey is derived from the path, which this patch never changes.
	return true
}

func sameMarkdownStringList(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func updateMarkdownCatalogPath(boxID, path string, removed bool, snapshot *markdownSnapshot) {
	value, exists := markdownBoxCatalogs.Load(boxID)
	if !exists {
		return
	}
	catalog := value.(*markdownBoxCatalog)
	catalog.mu.Lock()
	defer catalog.mu.Unlock()
	if !catalog.initialized {
		return
	}
	if removed {
		delete(catalog.docs, path)
		delete(catalog.planning, path)
		delete(catalog.properties, path)
		delete(catalog.notes, path)
		delete(catalog.workspaceNotes, path)
		delete(catalog.virtualNotes, path)
		catalog.docsOrdered = nil
		catalog.planOrdered = nil
		catalog.propOrdered = nil
		catalog.noteOrdered = nil
		catalog.noteRefIndex = nil
		catalog.noteDirectories = nil
		catalog.workspaceNoteOrdered = nil
		catalog.virtualNoteOrdered = nil
		catalog.virtualReferences = nil
		catalog.virtualReferenceLRU = nil
		catalog.generation++
		return
	}
	if nil == snapshot {
		var err error
		snapshot, err = loadMarkdownSnapshot(boxID, path)
		if nil != err {
			return
		}
	}
	catalog.docs[path] = MarkdownDocSummary{
		Path: path, Title: trimMarkdownDocExtension(filepath.Base(path)),
	}
	catalog.docsOrdered = nil
	if nil != catalog.planning {
		catalog.planning[path] = planningDocumentFromSnapshot(path, snapshot)
		catalog.planOrdered = nil
	}
	if nil != catalog.properties {
		catalog.properties[path] = propertyDocumentFromSnapshot(path, snapshot)
		catalog.propOrdered = nil
	}
	if nil != catalog.notes {
		stored, known := catalog.notes[path]
		note := snapshot.noteSummary(boxID, path)
		catalog.notes[path] = note
		if !known || !catalog.patchMarkdownNoteRelationships(stored, note) {
			catalog.noteOrdered = nil
			catalog.noteRefIndex = nil
			catalog.noteDirectories = nil
		}
	}
	if nil != catalog.workspaceNotes {
		catalog.workspaceNotes[path] = snapshot.workspaceNoteSummary(boxID, path)
		catalog.workspaceNoteOrdered = nil
	}
	if nil != catalog.virtualNotes {
		catalog.virtualNotes[path] = snapshot.virtualReferenceNoteSummary(boxID, path)
		catalog.virtualNoteOrdered = nil
	}
	catalog.virtualReferences = nil
	catalog.virtualReferenceLRU = nil
	catalog.generation++
}

func planningDocumentFromSnapshot(path string, snapshot *markdownSnapshot) MarkdownPlanningDocument {
	return MarkdownPlanningDocument{
		Path: path, Nodes: snapshot.planningNodes(), Version: snapshot.sourceVersion(), MtimeMs: snapshot.mtimeMs,
	}
}

func propertyDocumentFromSnapshot(path string, snapshot *markdownSnapshot) MarkdownPropertyDocument {
	projection := snapshot.propertyProjection()
	blocks := projection.Definitions
	if nil == blocks {
		blocks = []noemamarkdown.Definition{}
	}
	duplicates := projection.DuplicateDefinitionIDs
	if nil == duplicates {
		duplicates = []string{}
	}
	return MarkdownPropertyDocument{
		Path: path, Blocks: blocks, DuplicateDefinitionIDs: duplicates,
		Version: snapshot.sourceVersion(), MtimeMs: snapshot.mtimeMs,
	}
}

func trimMarkdownDocExtension(name string) string {
	return name[:len(name)-len(filepath.Ext(name))]
}
