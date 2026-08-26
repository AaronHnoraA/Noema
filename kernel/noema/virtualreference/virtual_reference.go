// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package virtualreference finds portable, unlinked Markdown title and alias
// mentions. It is the Go-owned equivalent of the historical Node workspace
// scanner, but compiles only the requested target's unambiguous labels and
// scans immutable Markdown snapshots in one Aho-Corasick pass.
package virtualreference

import (
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf16"

	"golang.org/x/text/unicode/norm"
)

const MaxDocumentRunes = 8 * 1024 * 1024

type Document struct {
	ID      string
	Title   string
	Aliases []string
	Refs    []string
	File    string
	Text    string
}

type Mention struct {
	SourceID    string   `json:"sourceId"`
	SourceTitle string   `json:"sourceTitle"`
	File        string   `json:"file"`
	Count       int      `json:"count"`
	Keywords    []string `json:"keywords"`
	Snippet     string   `json:"snippet"`
}

var (
	fencedCodePattern   = regexp.MustCompile("(?s)```.*?```|~~~.*?~~~")
	inlineCodePattern   = regexp.MustCompile("`[^`\\n]*`")
	markdownLinkPattern = regexp.MustCompile("!?\\[\\[[^]\\n]+\\]\\]|!?\\[[^]\\n]*\\]\\([^\\n)]*\\)")
	frontmatterPattern  = regexp.MustCompile("(?ms)^---[[:space:]]*$.*?^---[[:space:]]*$")
)

func normalize(value string, caseSensitive bool) string {
	value = norm.NFC.String(value)
	if !caseSensitive {
		value = strings.ToLower(value)
	}
	return value
}

func utf16Length(value string) int {
	ret := 0
	for _, r := range value {
		ret++
		if utf16.IsSurrogate(r) || r > 0xffff {
			ret++
		}
	}
	return ret
}

func cleanSearchText(markdown string) string {
	// regexp.ReplaceAllString still runs its backtracking engine over the whole
	// document when there cannot be a match. Most prose has no fence, code or
	// link marker, so guard each compatibility expression with its literal
	// opener. This keeps the exact historical cleaning grammar while avoiding
	// three full-document passes on the common path.
	if strings.Contains(markdown, "```") || strings.Contains(markdown, "~~~") {
		markdown = fencedCodePattern.ReplaceAllString(markdown, " ")
	}
	if strings.Contains(markdown, "`") {
		markdown = inlineCodePattern.ReplaceAllString(markdown, " ")
	}
	if strings.Contains(markdown, "[") {
		markdown = markdownLinkPattern.ReplaceAllString(markdown, " ")
	}
	if strings.Contains(markdown, "---") {
		markdown = frontmatterPattern.ReplaceAllString(markdown, " ")
	}
	return markdown
}

func snippetAt(text []rune, from, to, radius int) string {
	start, end := from-radius, to+radius
	if start < 0 {
		start = 0
	}
	if end > len(text) {
		end = len(text)
	}
	var builder strings.Builder
	space := false
	for _, r := range text[start:end] {
		if unicode.IsSpace(r) {
			space = builder.Len() > 0
			continue
		}
		if space {
			builder.WriteByte(' ')
			space = false
		}
		builder.WriteRune(r)
	}
	value := strings.TrimSpace(builder.String())
	if start > 0 {
		value = "…" + value
	}
	if end < len(text) {
		value += "…"
	}
	return value
}

type keyword struct {
	pattern []rune
	label   string
}

type matcherNode struct {
	next    map[rune]int
	fail    int
	outputs []int
}

type matcher struct {
	nodes    []matcherNode
	keywords []keyword
}

func newMatcher(keywords []keyword) *matcher {
	ret := &matcher{nodes: []matcherNode{{next: map[rune]int{}}}, keywords: keywords}
	for index, item := range keywords {
		state := 0
		for _, r := range item.pattern {
			next, exists := ret.nodes[state].next[r]
			if !exists {
				next = len(ret.nodes)
				ret.nodes[state].next[r] = next
				ret.nodes = append(ret.nodes, matcherNode{next: map[rune]int{}})
			}
			state = next
		}
		ret.nodes[state].outputs = append(ret.nodes[state].outputs, index)
	}
	queue := make([]int, 0, len(ret.nodes))
	for _, next := range ret.nodes[0].next {
		queue = append(queue, next)
	}
	for offset := 0; offset < len(queue); offset++ {
		current := queue[offset]
		for r, next := range ret.nodes[current].next {
			queue = append(queue, next)
			failure := ret.nodes[current].fail
			for failure != 0 {
				if _, exists := ret.nodes[failure].next[r]; exists {
					break
				}
				failure = ret.nodes[failure].fail
			}
			if target, exists := ret.nodes[failure].next[r]; exists && target != next {
				ret.nodes[next].fail = target
			}
			ret.nodes[next].outputs = append(ret.nodes[next].outputs, ret.nodes[ret.nodes[next].fail].outputs...)
		}
	}
	return ret
}

type match struct {
	keyword int
	from    int
	to      int
}

func (matcher *matcher) search(text []rune, visit func(match) bool) {
	state := 0
	for offset, r := range text {
		for state != 0 {
			if _, exists := matcher.nodes[state].next[r]; exists {
				break
			}
			state = matcher.nodes[state].fail
		}
		if next, exists := matcher.nodes[state].next[r]; exists {
			state = next
		} else {
			state = 0
		}
		for _, keywordIndex := range matcher.nodes[state].outputs {
			length := len(matcher.keywords[keywordIndex].pattern)
			if !visit(match{keyword: keywordIndex, from: offset + 1 - length, to: offset + 1}) {
				return
			}
		}
	}
}

func wordRune(r rune) bool {
	return r == '_' || unicode.IsLetter(r) || unicode.IsNumber(r)
}

func validBoundary(text []rune, item match, pattern []rune) bool {
	if len(pattern) == 0 {
		return false
	}
	if wordRune(pattern[0]) && item.from > 0 && wordRune(text[item.from-1]) {
		return false
	}
	if wordRune(pattern[len(pattern)-1]) && item.to < len(text) && wordRune(text[item.to]) {
		return false
	}
	return true
}

// Find returns all unlinked mentions of targetID. Labels shared by more than
// one document are deliberately excluded, matching the portable Node
// contract. Documents are expected to have already been bounded by the model
// layer so this pure scanner has no filesystem access.
func Find(documents []Document, targetID string, caseSensitive bool) []Mention {
	targetID = strings.TrimSpace(targetID)
	if targetID == "" || len(documents) == 0 {
		return []Mention{}
	}
	owners := map[string]map[string]struct{}{}
	labels := map[string]string{}
	order := []string{}
	for _, document := range documents {
		for _, candidate := range append([]string{document.Title}, document.Aliases...) {
			label := strings.TrimSpace(candidate)
			key := normalize(label, caseSensitive)
			if utf16Length(key) < 2 || key == "*" {
				continue
			}
			if _, exists := owners[key]; !exists {
				owners[key] = map[string]struct{}{}
				labels[key] = label
				order = append(order, key)
			}
			owners[key][document.ID] = struct{}{}
		}
	}
	keywords := make([]keyword, 0)
	for _, key := range order {
		ids := owners[key]
		if len(ids) != 1 {
			continue
		}
		if _, ownsTarget := ids[targetID]; !ownsTarget {
			continue
		}
		keywords = append(keywords, keyword{pattern: []rune(key), label: labels[key]})
	}
	if len(keywords) == 0 {
		return []Mention{}
	}
	sort.SliceStable(keywords, func(i, j int) bool {
		if len(keywords[i].pattern) != len(keywords[j].pattern) {
			return len(keywords[i].pattern) > len(keywords[j].pattern)
		}
		return string(keywords[i].pattern) < string(keywords[j].pattern)
	})
	compiled := newMatcher(keywords)
	ret := make([]Mention, 0)
	for _, source := range documents {
		if source.ID == "" || source.ID == targetID {
			continue
		}
		linked := false
		for _, ref := range source.Refs {
			if ref == targetID {
				linked = true
				break
			}
		}
		if linked {
			continue
		}
		rawText := []rune(cleanSearchText(source.Text))
		if len(rawText) > MaxDocumentRunes {
			rawText = rawText[:MaxDocumentRunes]
		}
		searchText := []rune(normalize(string(rawText), caseSensitive))
		count, firstFrom, firstTo := 0, -1, -1
		seenKeywords := make([]bool, len(keywords))
		matchedKeywords := make([]string, 0, len(keywords))
		lastTo, containingFrom := -1, 0
		compiled.search(searchText, func(item match) bool {
			pattern := keywords[item.keyword].pattern
			if !validBoundary(searchText, item, pattern) {
				return true
			}
			if item.to == lastTo && item.from >= containingFrom {
				return true
			}
			lastTo, containingFrom = item.to, item.from
			count++
			if firstFrom < 0 {
				firstFrom, firstTo = item.from, item.to
			}
			if !seenKeywords[item.keyword] {
				seenKeywords[item.keyword] = true
				matchedKeywords = append(matchedKeywords, keywords[item.keyword].label)
			}
			return true
		})
		if count == 0 {
			continue
		}
		ret = append(ret, Mention{
			SourceID: source.ID, SourceTitle: source.Title, File: source.File,
			Count: count, Keywords: matchedKeywords, Snippet: snippetAt(rawText, firstFrom, firstTo, 72),
		})
	}
	sort.Slice(ret, func(i, j int) bool {
		if ret[i].Count != ret[j].Count {
			return ret[i].Count > ret[j].Count
		}
		return ret[i].SourceTitle < ret[j].SourceTitle
	})
	return ret
}
