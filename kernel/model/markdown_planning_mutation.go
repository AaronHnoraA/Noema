// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema planning additions are Copyright (c) 2026 Aaron He and distributed
// under the same AGPL-3.0-or-later terms.

package model

import (
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	noemaplanning "github.com/aaronhe/noema/kernel/noema/planning"
	"github.com/google/uuid"
)

var ErrMarkdownPlanningVersionConflict = errors.New("planning document version conflict")

var markdownPlanningMutationLocks sync.Map
var markdownPlanningTodoIDLock sync.Mutex
var saveMarkdownPlanningDoc = saveMarkdownDocUnlocked
var newMarkdownPlanningTodoID = randomMarkdownPlanningTodoID
var newMarkdownPlanningDocumentID = func() (string, error) {
	id, err := uuid.NewV7()
	return id.String(), err
}

type MarkdownPlanningSelector = noemaplanning.Selector
type MarkdownPlanningMutation = noemaplanning.Mutation

type MarkdownPlanningMutationRequest struct {
	Notebook        string                   `json:"notebook"`
	Path            string                   `json:"path"`
	ExpectedVersion string                   `json:"expectedVersion,omitempty"`
	Selector        MarkdownPlanningSelector `json:"selector"`
	Mutation        MarkdownPlanningMutation `json:"mutation"`
}

type MarkdownPlanningMutationResult struct {
	Path       string              `json:"path"`
	Changed    bool                `json:"changed"`
	From       int                 `json:"from"`
	To         int                 `json:"to"`
	Source     string              `json:"source"`
	NextSource string              `json:"nextSource"`
	Version    string              `json:"version"`
	MtimeMs    float64             `json:"mtimeMs"`
	Node       *noemaplanning.Node `json:"node,omitempty"`
}

func MutateMarkdownPlanning(request MarkdownPlanningMutationRequest) (ret *MarkdownPlanningMutationResult, err error) {
	boxID, path := strings.TrimSpace(request.Notebook), strings.TrimSpace(request.Path)
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return nil, fmt.Errorf("box [%s] is not a markdown box", boxID)
	}
	if path, err = normalizedMarkdownDocPath(boxID, path); nil != err {
		return nil, err
	}
	mutationType := strings.ToLower(strings.TrimSpace(request.Mutation.Type))
	if mutationType != "replace" && mutationType != "insert-after" && mutationType != "append" && mutationType != "append-todo" &&
		mutationType != "patch-todo" && mutationType != "patch-node" && mutationType != "insert-clock" {
		return nil, fmt.Errorf("unsupported planning mutation [%s]", request.Mutation.Type)
	}
	if mutationType == "append-todo" && nil == request.Mutation.Create {
		return nil, fmt.Errorf("append-todo requires create semantics")
	}

	lockKey := boxID + "\x00" + path
	lockValue, _ := markdownPlanningMutationLocks.LoadOrStore(lockKey, &sync.Mutex{})
	lock := lockValue.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()
	if mutationType == "append-todo" {
		// Keep ID allocation and persistence in one global critical section.
		// Different inbox targets may be written concurrently, and the second
		// allocator must observe the first one's newly persisted ID.
		markdownPlanningTodoIDLock.Lock()
		defer markdownPlanningTodoIDLock.Unlock()
	}

	absPath := filepath.Join(filesys.BoxRootPath(boxID), path)
	raw, readErr := os.ReadFile(absPath)
	if nil != readErr && !os.IsNotExist(readErr) {
		return nil, readErr
	}
	content := string(raw)
	currentVersion := markdownPlanningVersion(raw)
	if request.ExpectedVersion != "" && request.ExpectedVersion != currentVersion {
		return nil, fmt.Errorf("%w: expected %s, found %s", ErrMarkdownPlanningVersionConflict, request.ExpectedVersion, currentVersion)
	}

	ret = &MarkdownPlanningMutationResult{Path: path, Version: currentVersion}
	// Allocate IDs and initial note metadata at the storage boundary.
	if mutationType == "append-todo" {
		request.Mutation.ID, err = mintMarkdownPlanningTodoID(boxID)
		if err != nil {
			return nil, err
		}
		if content == "" {
			request.Mutation.InitialContent, err = initialMarkdownPlanningTodoContent(path, *request.Mutation.Create)
			if err != nil {
				return nil, err
			}
		}
	}
	transformed, err := noemaplanning.TransformSource(content, request.Selector, request.Mutation)
	if err != nil {
		return nil, err
	}
	ret.From, ret.To = transformed.From, transformed.To
	ret.Source, ret.NextSource, ret.Node = transformed.Source, transformed.NextSource, transformed.Node
	nextContent := transformed.Content

	ret.Changed = nextContent != content
	if ret.Changed {
		if _, _, err = saveMarkdownPlanningDoc(boxID, path, nextContent); nil != err {
			return nil, err
		}
	}
	ret.Version = markdownPlanningVersion([]byte(nextContent))
	if info, statErr := os.Stat(absPath); nil == statErr {
		ret.MtimeMs = float64(info.ModTime().UnixNano()) / 1e6
	}
	return ret, nil
}

func mintMarkdownPlanningTodoID(boxID string) (string, error) {
	documents, err := ListMarkdownPlanning(boxID, "")
	if nil != err {
		return "", err
	}
	existing := map[string]bool{}
	for _, document := range documents {
		for _, node := range document.Nodes {
			if id := strings.TrimPrefix(strings.TrimSpace(node.Attrs["id"]), "#"); id != "" {
				existing[id] = true
			}
		}
	}
	for attempt := 0; attempt < 500; attempt++ {
		candidate, randomErr := newMarkdownPlanningTodoID()
		if nil != randomErr {
			return "", randomErr
		}
		candidate = strings.ToLower(strings.TrimSpace(candidate))
		if len(candidate) == 6 && !existing[candidate] {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("could not mint a unique planning ID")
}

func randomMarkdownPlanningTodoID() (string, error) {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	ret := make([]byte, 0, 6)
	buf := make([]byte, 12)
	for len(ret) < 6 {
		if _, err := rand.Read(buf); nil != err {
			return "", err
		}
		for _, value := range buf {
			// 252 is the largest multiple of 36 below 256, avoiding modulo bias.
			if value >= 252 {
				continue
			}
			ret = append(ret, alphabet[int(value)%len(alphabet)])
			if len(ret) == 6 {
				break
			}
		}
	}
	return string(ret), nil
}

func initialMarkdownPlanningTodoContent(path string, create noemaplanning.TodoCreate) (string, error) {
	title := defaultMarkdownPlanningTodoFileTitle(path)
	now := time.Now()
	if create.NowMs != 0 {
		now = time.UnixMilli(create.NowMs)
	}
	id, err := newMarkdownPlanningDocumentID()
	if nil != err {
		return "", err
	}
	return strings.Join([]string{
		"#+begin meta",
		"id: " + id,
		"title: " + title,
		"date: " + now.Format("2006-01-02"),
		"kind: default",
		"tags: ",
		"refs: ",
		"#+end meta",
		"",
		"# " + title,
		"",
	}, "\n"), nil
}

func defaultMarkdownPlanningTodoFileTitle(path string) string {
	name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	words := strings.Fields(strings.NewReplacer("-", " ", "_", " ").Replace(name))
	if len(words) == 0 {
		return "Inbox"
	}
	for i, word := range words {
		first, size := utf8.DecodeRuneInString(word)
		if first >= 'a' && first <= 'z' {
			words[i] = string(first-'a'+'A') + word[size:]
		}
	}
	return strings.Join(words, " ")
}
