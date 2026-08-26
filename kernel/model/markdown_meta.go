// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema portable metadata additions are Copyright (c) 2026 Aaron He and
// distributed under the same AGPL-3.0-or-later terms.

package model

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	noemaidentity "github.com/aaronhe/noema/kernel/noema/identity"
	noemametadata "github.com/aaronhe/noema/kernel/noema/metadata"
	"github.com/google/uuid"
)

var ErrMarkdownMetaVersionConflict = errors.New("metadata document version conflict")

var saveMarkdownMetaDoc = saveMarkdownDocUnlocked
var newMarkdownMetaID = func() (string, error) {
	id, err := uuid.NewV7()
	return id.String(), err
}
var markdownMetaToday = func() string { return time.Now().UTC().Format("2006-01-02") }

type MarkdownMetaMutationRequest struct {
	Notebook        string    `json:"notebook"`
	Path            string    `json:"path"`
	Action          string    `json:"action"`
	ExpectedVersion string    `json:"expectedVersion,omitempty"`
	Markdown        *string   `json:"markdown,omitempty"`
	Title           *string   `json:"title,omitempty"`
	Tags            *[]string `json:"tags,omitempty"`
	Kind            *string   `json:"kind,omitempty"`
	Project         *string   `json:"project,omitempty"`
}

type MarkdownMetaMutationResult struct {
	Path     string   `json:"path"`
	Changed  bool     `json:"changed"`
	Markdown string   `json:"markdown"`
	Version  string   `json:"version"`
	MtimeMs  float64  `json:"mtimeMs"`
	ID       string   `json:"id,omitempty"`
	Title    string   `json:"title,omitempty"`
	Tags     []string `json:"tags"`
	Kind     string   `json:"kind,omitempty"`
	Source   string   `json:"source"`
}

// MutateMarkdownMeta applies a field-level source patch under the same lock as
// planning and portable AV/property mutations. A supplied Markdown snapshot is
// treated as the editor's current source; persistence still goes through the
// canonical SaveMarkdownDoc parse/index/reload path.
func MutateMarkdownMeta(request MarkdownMetaMutationRequest) (ret *MarkdownMetaMutationResult, err error) {
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
	disk, readErr := os.ReadFile(absPath)
	if nil != readErr && !os.IsNotExist(readErr) {
		return nil, readErr
	}
	diskVersion := markdownPlanningVersion(disk)
	if request.ExpectedVersion != "" && request.ExpectedVersion != diskVersion {
		return nil, fmt.Errorf("%w: expected %s, found %s", ErrMarkdownMetaVersionConflict, request.ExpectedVersion, diskVersion)
	}
	source := string(disk)
	if request.Markdown != nil {
		source = *request.Markdown
	}

	patched, err := noemametadata.Patch(source, filepath.Base(path), noemametadata.Request{
		Action: request.Action, Title: request.Title, Tags: request.Tags,
		Kind: request.Kind, Project: request.Project,
	}, noemametadata.Options{
		Today: markdownMetaToday(),
		NewID: func() (string, error) {
			id, allocationErr := newMarkdownMetaID()
			if allocationErr != nil {
				return "", allocationErr
			}
			if !noemaidentity.IsUUIDv7(id) {
				return "", fmt.Errorf("metadata allocator returned a non-UUIDv7 identity")
			}
			return strings.ToLower(id), nil
		},
	})
	if nil != err {
		return nil, err
	}
	persistedChanged := patched.Changed || request.Markdown != nil && source != string(disk)
	if persistedChanged {
		if _, _, err = saveMarkdownMetaDoc(boxID, path, patched.Markdown); nil != err {
			return nil, err
		}
	}
	mtimeMs := float64(0)
	if info, statErr := os.Stat(absPath); nil == statErr {
		mtimeMs = float64(info.ModTime().UnixNano()) / 1e6
	}
	tags := patched.Tags
	if nil == tags {
		tags = []string{}
	}
	return &MarkdownMetaMutationResult{
		Path: path, Changed: persistedChanged, Markdown: patched.Markdown,
		Version: markdownPlanningVersion([]byte(patched.Markdown)), MtimeMs: mtimeMs,
		ID: patched.ID, Title: patched.Title, Tags: tags, Kind: patched.Kind,
		Source: "kernel-meta",
	}, nil
}
