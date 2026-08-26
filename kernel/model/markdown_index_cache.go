// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema persistent Markdown index-cache additions are Copyright (c) 2026
// Aaron He and distributed under the same AGPL-3.0-or-later terms.

package model

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	noemamarkdown "github.com/aaronhe/noema/kernel/noema/markdown"
	noemaplanning "github.com/aaronhe/noema/kernel/noema/planning"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/siyuan-note/logging"
)

const markdownIndexCacheSchema = 1

type markdownIndexCacheEntry struct {
	MtimeNs             int64                        `json:"mtimeNs"`
	Size                int64                        `json:"size"`
	RootID              string                       `json:"rootId,omitempty"`
	Hash                string                       `json:"hash,omitempty"`
	SourceVersion       string                       `json:"sourceVersion,omitempty"`
	PlanningCached      bool                         `json:"planningCached,omitempty"`
	Planning            []noemaplanning.Node         `json:"planning,omitempty"`
	PropertiesCached    bool                         `json:"propertiesCached,omitempty"`
	Properties          []noemamarkdown.Definition   `json:"properties,omitempty"`
	DuplicateDefinition []string                     `json:"duplicateDefinitionIds,omitempty"`
	CatalogCached       bool                         `json:"catalogCached,omitempty"`
	Catalog             MarkdownNoteSummary          `json:"catalog,omitempty"`
	WorkspaceNoteCached bool                         `json:"workspaceNoteCached,omitempty"`
	WorkspaceNote       MarkdownWorkspaceNote        `json:"workspaceNote,omitempty"`
	VirtualNoteCached   bool                         `json:"virtualNoteCached,omitempty"`
	VirtualNote         MarkdownVirtualReferenceNote `json:"virtualNote,omitempty"`
}

type markdownIndexCache struct {
	Schema  int                                `json:"schema"`
	Root    string                             `json:"root"`
	Entries map[string]markdownIndexCacheEntry `json:"entries"`
}

var markdownIndexCacheLocks sync.Map

func markdownIndexCacheLock(boxID string) *sync.Mutex {
	key := filepath.Clean(util.DataDir) + "\x00" + boxID
	value, _ := markdownIndexCacheLocks.LoadOrStore(key, &sync.Mutex{})
	return value.(*sync.Mutex)
}

func markdownIndexCachePath(boxID string) string {
	return filepath.Join(util.DataDir, boxID, ".siyuan", "noema-markdown-index-cache.json")
}

func newMarkdownIndexCache(root string) *markdownIndexCache {
	return &markdownIndexCache{
		Schema:  markdownIndexCacheSchema,
		Root:    filepath.Clean(root),
		Entries: map[string]markdownIndexCacheEntry{},
	}
}

func loadMarkdownIndexCache(boxID, root string) *markdownIndexCache {
	cache := newMarkdownIndexCache(root)
	raw, err := os.ReadFile(markdownIndexCachePath(boxID))
	if nil != err {
		if !os.IsNotExist(err) {
			logging.LogWarnf("read Markdown index cache failed: %s", err)
		}
		return cache
	}
	var persisted markdownIndexCache
	if err = json.Unmarshal(raw, &persisted); nil != err {
		logging.LogWarnf("parse Markdown index cache failed, rebuilding: %s", err)
		return cache
	}
	if markdownIndexCacheSchema != persisted.Schema || filepath.Clean(root) != filepath.Clean(persisted.Root) || nil == persisted.Entries {
		return cache
	}
	return &persisted
}

func saveMarkdownIndexCache(boxID string, cache *markdownIndexCache) error {
	target := markdownIndexCachePath(boxID)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); nil != err {
		return err
	}
	raw, err := json.Marshal(cache)
	if nil != err {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(target), ".noema-markdown-index-*.tmp")
	if nil != err {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err = temporary.Chmod(0o600); nil == err {
		_, err = temporary.Write(raw)
	}
	if closeErr := temporary.Close(); nil == err {
		err = closeErr
	}
	if nil != err {
		return err
	}
	return os.Rename(temporaryPath, target)
}

func (entry markdownIndexCacheEntry) matches(info os.FileInfo, rootID, persistedID, persistedHash string) bool {
	return entry.matchesSource(info) &&
		entry.RootID == rootID && entry.RootID == persistedID && entry.Hash == persistedHash
}

func (entry markdownIndexCacheEntry) matchesSource(info os.FileInfo) bool {
	return nil != info && entry.MtimeNs == info.ModTime().UnixNano() && entry.Size == info.Size()
}

func markdownIndexEntryForSnapshot(previous markdownIndexCacheEntry, snapshot *markdownSnapshot) (ret markdownIndexCacheEntry, sourceChanged bool) {
	if nil == snapshot {
		return previous, false
	}
	if previous.MtimeNs != snapshot.mtimeNs || previous.Size != snapshot.size {
		return markdownIndexCacheEntry{MtimeNs: snapshot.mtimeNs, Size: snapshot.size}, true
	}
	return previous, false
}
