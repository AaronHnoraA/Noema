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
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
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

type MarkdownPlanningSelector struct {
	Kind   string `json:"kind"`
	Index  *int   `json:"index,omitempty"`
	Source string `json:"source,omitempty"`
	ID     string `json:"id,omitempty"`
	Title  string `json:"title,omitempty"`
	Open   bool   `json:"open,omitempty"`
}

type MarkdownPlanningMutation struct {
	Type           string                    `json:"type"`
	Source         string                    `json:"source"`
	InitialContent string                    `json:"initialContent,omitempty"`
	Create         *noemaplanning.TodoCreate `json:"create,omitempty"`
	Todo           *noemaplanning.TodoPatch  `json:"todo,omitempty"`
	Attrs          map[string]*string        `json:"attrs,omitempty"`
}

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
	nextContent := content
	if mutationType == "append" || mutationType == "append-todo" {
		source := request.Mutation.Source
		initialContent := request.Mutation.InitialContent
		if mutationType == "append-todo" {
			var id string
			if id, err = mintMarkdownPlanningTodoID(boxID); nil != err {
				return nil, err
			}
			if source, err = noemaplanning.CreateTodoSource(*request.Mutation.Create, id); nil != err {
				return nil, err
			}
			if content == "" {
				if initialContent, err = initialMarkdownPlanningTodoContent(path, *request.Mutation.Create); nil != err {
					return nil, err
				}
			}
		}
		baseContent := content
		if baseContent == "" && initialContent != "" {
			baseContent = initialContent
		}
		base := strings.TrimRightFunc(baseContent, unicode.IsSpace)
		prefix := ""
		if base != "" {
			prefix = "\n\n"
		}
		ret.From = utf16SourceLength(base + prefix)
		ret.To = ret.From + utf16SourceLength(source)
		ret.NextSource = source
		nextContent = base + prefix + source + "\n"
	} else {
		nodes := noemaplanning.ScanDocument(content, "")
		node := locateMarkdownPlanningNode(nodes, request.Selector)
		if nil == node {
			return nil, fmt.Errorf("planning source was not found")
		}
		fromByte, ok := utf16OffsetToByte(content, node.Span.From)
		if !ok {
			return nil, fmt.Errorf("invalid planning start offset [%d]", node.Span.From)
		}
		toByte, ok := utf16OffsetToByte(content, node.Span.To)
		if !ok {
			return nil, fmt.Errorf("invalid planning end offset [%d]", node.Span.To)
		}
		ret.Source = node.Raw
		nextSource := request.Mutation.Source
		effectiveType := mutationType
		switch mutationType {
		case "patch-todo":
			if nil == request.Mutation.Todo {
				return nil, fmt.Errorf("patch-todo requires todo semantics")
			}
			nextSource = noemaplanning.PatchTodoSource(*node, *request.Mutation.Todo)
			effectiveType = "replace"
		case "patch-node":
			nextSource = noemaplanning.PatchNodeSource(*node, request.Mutation.Attrs, nil)
			effectiveType = "replace"
		case "insert-clock":
			nextSource = noemaplanning.ClockSourceForTodo(*node, request.Mutation.Attrs)
			effectiveType = "insert-after"
		}
		if effectiveType == "replace" {
			ret.From = node.Span.From
			ret.To = node.Span.From + utf16SourceLength(nextSource)
			ret.NextSource = nextSource
			nextContent = content[:fromByte] + nextSource + content[toByte:]
		} else {
			insertByte := toByte
			if rel := strings.IndexByte(content[toByte:], '\n'); rel >= 0 {
				insertByte = toByte + rel + 1
			} else {
				insertByte = len(content)
			}
			inserted := nextSource
			if insertByte == len(content) && content != "" && !strings.HasSuffix(content, "\n") {
				inserted = "\n" + inserted
			}
			if !strings.HasSuffix(inserted, "\n") {
				inserted += "\n"
			}
			ret.From = utf16SourceLength(content[:insertByte])
			ret.To = ret.From + utf16SourceLength(inserted)
			ret.Source = ""
			ret.NextSource = inserted
			nextContent = content[:insertByte] + inserted + content[insertByte:]
		}
	}

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
	for _, candidate := range noemaplanning.ScanDocument(nextContent, "") {
		if candidate.Span.From == ret.From {
			candidate := candidate
			ret.Node = &candidate
			break
		}
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

func locateMarkdownPlanningNode(nodes []noemaplanning.Node, selector MarkdownPlanningSelector) *noemaplanning.Node {
	kind := strings.ToLower(strings.TrimSpace(selector.Kind))
	matchesKind := func(node noemaplanning.Node) bool {
		if kind == "" {
			return true
		}
		if kind == "todo" {
			return node.Kind == "todo" || node.Kind == "itodo"
		}
		return node.Kind == kind
	}
	acceptHints := func(node noemaplanning.Node) bool {
		if selector.Title != "" {
			return node.Title == selector.Title
		}
		return selector.Source == "" || node.Raw == selector.Source
	}
	if nil != selector.Index {
		for i := range nodes {
			if matchesKind(nodes[i]) && nodes[i].Span.From == *selector.Index && acceptHints(nodes[i]) {
				return &nodes[i]
			}
		}
	}
	wantedID := strings.TrimPrefix(strings.TrimSpace(selector.ID), "#")
	for i := range nodes {
		node := &nodes[i]
		if !matchesKind(*node) {
			continue
		}
		if wantedID != "" && (node.Attrs["id"] == wantedID || strings.HasSuffix(selector.ID, ":"+strconv.Itoa(node.Span.From))) {
			return node
		}
		if selector.Source != "" && node.Raw == selector.Source {
			return node
		}
		if selector.Title != "" && node.Title == selector.Title {
			return node
		}
		if selector.Open && node.Attrs["from"] != "" && node.Attrs["to"] == "" {
			return node
		}
	}
	return nil
}

func utf16SourceLength(source string) int {
	length := 0
	for _, r := range source {
		if r > 0xffff {
			length += 2
		} else {
			length++
		}
	}
	return length
}

func utf16OffsetToByte(source string, offset int) (int, bool) {
	if offset < 0 {
		return 0, false
	}
	units := 0
	for byteAt := 0; byteAt < len(source); {
		if units == offset {
			return byteAt, true
		}
		r, size := utf8.DecodeRuneInString(source[byteAt:])
		step := 1
		if r > 0xffff {
			step = 2
		}
		if units+step > offset {
			return 0, false
		}
		units += step
		byteAt += size
	}
	return len(source), units == offset
}
