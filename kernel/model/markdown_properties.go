// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema portable block-property additions are Copyright (c) 2026 Aaron He
// and distributed under the same AGPL-3.0-or-later terms.

package model

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	noemamarkdown "github.com/aaronhe/noema/kernel/noema/markdown"
)

var ErrMarkdownPropertyVersionConflict = errors.New("block property document version conflict")
var saveMarkdownPropertyDoc = saveMarkdownDocUnlocked

// MarkdownPropertyDocument is a read-only projection of portable
// `{#UUIDv7 key=value}` anchors. Source indices use JavaScript UTF-16 units,
// matching CodeMirror and the planning API.
type MarkdownPropertyDocument struct {
	Path                   string                     `json:"path"`
	Blocks                 []noemamarkdown.Definition `json:"blocks"`
	DuplicateDefinitionIDs []string                   `json:"duplicateDefinitionIds"`
	Version                string                     `json:"version"`
	MtimeMs                float64                    `json:"mtimeMs"`
}

type MarkdownPropertyMutationRequest struct {
	Notebook        string  `json:"notebook"`
	Path            string  `json:"path"`
	ExpectedVersion string  `json:"expectedVersion"`
	ID              string  `json:"id"`
	Key             string  `json:"key"`
	Value           *string `json:"value"`
}

type MarkdownPropertyMutationResult struct {
	Path       string                   `json:"path"`
	Changed    bool                     `json:"changed"`
	From       int                      `json:"from"`
	To         int                      `json:"to"`
	Source     string                   `json:"source"`
	NextSource string                   `json:"nextSource"`
	Version    string                   `json:"version"`
	MtimeMs    float64                  `json:"mtimeMs"`
	Block      noemamarkdown.Definition `json:"block"`
}

// ListMarkdownPropertyBlocks scans one document or a whole external Markdown
// box without updating source, indexes, or shadow metadata.
func ListMarkdownPropertyBlocks(boxID, path string) (documents []MarkdownPropertyDocument, err error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return nil, fmt.Errorf("box [%s] is not a markdown box", boxID)
	}
	paths := []string{}
	if strings.TrimSpace(path) != "" {
		if path, err = normalizedMarkdownDocPath(boxID, path); nil != err {
			return nil, err
		}
		paths = append(paths, path)
	} else {
		return markdownCatalogProperties(boxID)
	}

	documents = make([]MarkdownPropertyDocument, 0, len(paths))
	for _, relativePath := range paths {
		snapshot, readErr := loadMarkdownSnapshot(boxID, relativePath)
		if nil != readErr {
			if os.IsNotExist(readErr) {
				documents = append(documents, MarkdownPropertyDocument{
					Path: relativePath, Blocks: []noemamarkdown.Definition{}, DuplicateDefinitionIDs: []string{},
				})
				continue
			}
			return nil, readErr
		}
		documents = append(documents, propertyDocumentFromSnapshot(relativePath, snapshot))
	}
	sort.Slice(documents, func(i, j int) bool { return documents[i].Path < documents[j].Path })
	return documents, nil
}

// MutateMarkdownProperty patches one property under the same per-file lock as
// planning mutations, so the two semantic writers cannot interleave.
func MutateMarkdownProperty(request MarkdownPropertyMutationRequest) (ret *MarkdownPropertyMutationResult, err error) {
	boxID, path := strings.TrimSpace(request.Notebook), strings.TrimSpace(request.Path)
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return nil, fmt.Errorf("box [%s] is not a markdown box", boxID)
	}
	if path, err = normalizedMarkdownDocPath(boxID, path); nil != err {
		return nil, err
	}

	lockKey := boxID + "\x00" + path
	lockValue, _ := markdownPlanningMutationLocks.LoadOrStore(lockKey, &sync.Mutex{})
	lock := lockValue.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()

	absPath := filepath.Join(filesys.BoxRootPath(boxID), path)
	raw, err := os.ReadFile(absPath)
	if nil != err {
		return nil, err
	}
	currentVersion := markdownPlanningVersion(raw)
	if request.ExpectedVersion != "" && request.ExpectedVersion != currentVersion {
		return nil, fmt.Errorf("%w: expected %s, found %s", ErrMarkdownPropertyVersionConflict, request.ExpectedVersion, currentVersion)
	}
	patch, err := noemamarkdown.PatchBlockProperty(string(raw), request.ID, request.Key, request.Value)
	if nil != err {
		return nil, err
	}
	changed := patch.Markdown != string(raw)
	if changed {
		if _, _, err = saveMarkdownPropertyDoc(boxID, path, patch.Markdown); nil != err {
			return nil, err
		}
	}
	version := markdownPlanningVersion([]byte(patch.Markdown))
	mtimeMs := float64(0)
	if info, statErr := os.Stat(absPath); nil == statErr {
		mtimeMs = float64(info.ModTime().UnixNano()) / 1e6
	}
	return &MarkdownPropertyMutationResult{
		Path: path, Changed: changed, From: patch.From, To: patch.To,
		Source: patch.Source, NextSource: patch.NextSource, Version: version,
		MtimeMs: mtimeMs, Block: patch.Definition,
	}, nil
}
