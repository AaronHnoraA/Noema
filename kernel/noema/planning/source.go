// Copyright (c) 2026 Aaron He. AGPL-3.0-or-later.
package planning

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

type Selector struct {
	Kind   string `json:"kind"`
	Index  *int   `json:"index,omitempty"`
	Source string `json:"source,omitempty"`
	ID     string `json:"id,omitempty"`
	Title  string `json:"title,omitempty"`
	Open   bool   `json:"open,omitempty"`
}

type Mutation struct {
	ID             string             `json:"id,omitempty"`
	Type           string             `json:"type"`
	Source         string             `json:"source"`
	InitialContent string             `json:"initialContent,omitempty"`
	Create         *TodoCreate        `json:"create,omitempty"`
	Todo           *TodoPatch         `json:"todo,omitempty"`
	Attrs          map[string]*string `json:"attrs,omitempty"`
}

// SourceResult describes a pure native Markdown edit. It performs no file IO.
type SourceResult struct {
	Content    string `json:"content"`
	Changed    bool   `json:"changed"`
	From       int    `json:"from"`
	To         int    `json:"to"`
	Source     string `json:"source"`
	NextSource string `json:"nextSource"`
	Node       *Node  `json:"node,omitempty"`
}

// TransformSource shares source semantics between local and routed writers.
// The caller owns ID allocation, source revision checks and persistence.
func TransformSource(content string, selector Selector, mutation Mutation) (ret *SourceResult, err error) {
	mutationType := strings.ToLower(strings.TrimSpace(mutation.Type))
	if mutationType != "replace" && mutationType != "insert-after" && mutationType != "append" && mutationType != "append-todo" &&
		mutationType != "patch-todo" && mutationType != "patch-node" && mutationType != "insert-clock" {
		return nil, fmt.Errorf("unsupported planning mutation [%s]", mutation.Type)
	}
	if mutationType == "append-todo" && nil == mutation.Create {
		return nil, fmt.Errorf("append-todo requires create semantics")
	}

	ret = &SourceResult{}
	nextContent := content
	if mutationType == "append" || mutationType == "append-todo" {
		source := mutation.Source
		initialContent := mutation.InitialContent
		if mutationType == "append-todo" {
			id := mutation.ID
			if id == "" {
				return nil, fmt.Errorf("append-todo requires an allocated ID")
			}
			if source, err = CreateTodoSource(*mutation.Create, id); nil != err {
				return nil, err
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
		ret.From = utf16Length(base + prefix)
		ret.To = ret.From + utf16Length(source)
		ret.NextSource = source
		nextContent = base + prefix + source + "\n"
	} else {
		nodes := ScanDocument(content, "")
		node := locateNode(nodes, selector)
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
		nextSource := mutation.Source
		effectiveType := mutationType
		switch mutationType {
		case "patch-todo":
			if nil == mutation.Todo {
				return nil, fmt.Errorf("patch-todo requires todo semantics")
			}
			nextSource = PatchTodoSource(*node, *mutation.Todo)
			effectiveType = "replace"
		case "patch-node":
			nextSource = PatchNodeSource(*node, mutation.Attrs, nil)
			effectiveType = "replace"
		case "insert-clock":
			nextSource = ClockSourceForTodo(*node, mutation.Attrs)
			effectiveType = "insert-after"
		}
		if effectiveType == "replace" {
			ret.From = node.Span.From
			ret.To = node.Span.From + utf16Length(nextSource)
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
			ret.From = utf16Length(content[:insertByte])
			ret.To = ret.From + utf16Length(inserted)
			ret.Source = ""
			ret.NextSource = inserted
			nextContent = content[:insertByte] + inserted + content[insertByte:]
		}
	}

	ret.Changed = nextContent != content
	ret.Content = nextContent
	nodes := ScanDocument(nextContent, "")
	for _, candidate := range nodes {
		if candidate.Span.From == ret.From {
			candidate := candidate
			ret.Node = &candidate
			break
		}
	}
	// A capture or inserted clock must remain a live native command in its
	// surrounding document (for example, not inside an unclosed code fence).
	for _, proposed := range Scan(ret.NextSource, "") {
		found := false
		for _, candidate := range nodes {
			if candidate.Span.From == ret.From+proposed.Span.From && candidate.Raw == proposed.Raw {
				found = true
				if ret.Node == nil {
					candidate := candidate
					ret.Node = &candidate
				}
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("planning edit would place a command inside literal or excluded source; close its code block or choose another capture file")
		}
	}
	return ret, nil
}

func locateNode(nodes []Node, selector Selector) *Node {
	kind := strings.ToLower(strings.TrimSpace(selector.Kind))
	matchesKind := func(node Node) bool {
		if kind == "" {
			return true
		}
		if kind == "todo" {
			return node.Kind == "todo" || node.Kind == "itodo"
		}
		return node.Kind == kind
	}
	acceptHints := func(node Node) bool {
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
