// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package bibliography

import (
	"crypto/sha1"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

var (
	metaLinePattern = regexp.MustCompile(`^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$`)
	yamlMetaPattern = regexp.MustCompile(`(?s)^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)`)
)

var inheritedMetaFields = map[string]struct{}{
	"bib": {}, "tags": {}, "kind": {}, "project": {}, "source": {},
	"summary": {}, "private": {}, "css": {},
}

const (
	bibCacheLimit = 32
	bibCacheBytes = 16 * 1024 * 1024
)

type bibCacheEntry struct {
	mtimeNs int64
	size    int64
	usedAt  time.Time
	parsed  ParseResult
}

var (
	bibCacheMu       sync.Mutex
	bibParsedCache   = map[string]*bibCacheEntry{}
	bibParsedBytes   int64
	bibParseRequests singleflight.Group
)

type LibraryFile struct {
	File           string   `json:"file"`
	Path           string   `json:"path"`
	Namespace      string   `json:"namespace"`
	ShortNamespace string   `json:"shortNamespace"`
	Entries        []Entry  `json:"entries"`
	Diagnostics    []string `json:"diagnostics"`
}

type Library struct {
	Files       []LibraryFile `json:"files"`
	Diagnostics []string      `json:"diagnostics"`
	Source      string        `json:"source"`
}

type bibSource struct {
	raw      string
	base     string
	origin   string
	optional bool
}

type effectiveMetadata struct {
	meta        map[string]string
	bibSources  []bibSource
	diagnostics []string
}

func parseMeta(content string) map[string]string {
	source := strings.TrimPrefix(content, "\ufeff")
	ret := map[string]string{}
	addLines := func(body string) {
		for _, line := range strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n") {
			match := metaLinePattern.FindStringSubmatch(line)
			if nil == match {
				continue
			}
			key := strings.ToLower(match[1])
			value := strings.TrimSpace(match[2])
			if "bib" != key && 2 <= len(value) && ('"' == value[0] || '\'' == value[0]) && value[len(value)-1] == value[0] {
				value = value[1 : len(value)-1]
			}
			ret[key] = value
		}
	}
	if match := yamlMetaPattern.FindStringSubmatch(source); nil != match {
		addLines(match[1])
	}
	lines := strings.Split(strings.ReplaceAll(source, "\r\n", "\n"), "\n")
	for index, line := range lines {
		if strings.EqualFold(strings.TrimSpace(line), "#+begin meta") {
			for end := index + 1; end < len(lines); end++ {
				if strings.EqualFold(strings.TrimSpace(lines[end]), "#+end meta") {
					addLines(strings.Join(lines[index+1:end], "\n"))
					return ret
				}
			}
			break
		}
	}
	return ret
}

func splitList(value string) []string {
	items := []string{}
	var current strings.Builder
	var quote rune
	runes := []rune(value)
	for index := 0; index < len(runes); index++ {
		char := runes[index]
		if '\\' == char {
			if index+1 < len(runes) && (',' == runes[index+1] || '\\' == runes[index+1] || '"' == runes[index+1] || '\'' == runes[index+1]) {
				current.WriteRune(runes[index+1])
				index++
			} else {
				current.WriteRune(char)
			}
			continue
		}
		if 0 != quote {
			if char == quote {
				quote = 0
			} else {
				current.WriteRune(char)
			}
			continue
		}
		if '"' == char || '\'' == char {
			quote = char
			continue
		}
		if ',' == char {
			if item := strings.TrimSpace(current.String()); "" != item {
				items = append(items, item)
			}
			current.Reset()
			continue
		}
		current.WriteRune(char)
	}
	if item := strings.TrimSpace(current.String()); "" != item {
		items = append(items, item)
	}
	return items
}

func canonicalPath(value string) string {
	abs, err := filepath.Abs(value)
	if nil != err {
		return filepath.Clean(value)
	}
	if resolved, resolveErr := filepath.EvalSymlinks(abs); nil == resolveErr {
		return filepath.Clean(resolved)
	}
	tail := []string{}
	for parent := abs; ; parent = filepath.Dir(parent) {
		next := filepath.Dir(parent)
		if next == parent {
			return filepath.Clean(abs)
		}
		tail = append([]string{filepath.Base(parent)}, tail...)
		if resolved, resolveErr := filepath.EvalSymlinks(next); nil == resolveErr {
			return filepath.Join(append([]string{resolved}, tail...)...)
		}
	}
}

func inside(path, root string) bool {
	rel, err := filepath.Rel(root, path)
	return nil == err && ("." == rel || (".." != rel && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)))
}

func rootRelative(path, root string) string {
	rel, err := filepath.Rel(root, path)
	if nil != err {
		return filepath.ToSlash(path)
	}
	return filepath.ToSlash(rel)
}

func effectiveMeta(file, content, allowedRoot string, seen map[string]struct{}) effectiveMetadata {
	current := parseMeta(content)
	key := canonicalPath(file)
	if _, exists := seen[key]; exists {
		return effectiveMetadata{meta: current, bibSources: []bibSource{}, diagnostics: []string{"extend cycle at " + rootRelative(key, allowedRoot)}}
	}
	seen[key] = struct{}{}
	diagnostics := []string{}
	parent := effectiveMetadata{meta: map[string]string{}, bibSources: []bibSource{}, diagnostics: []string{}}
	if extend := strings.TrimSpace(current["extend"]); "" != extend {
		parentFile := canonicalPath(filepath.Join(filepath.Dir(key), extend))
		switch {
		case !inside(parentFile, allowedRoot):
			diagnostics = append(diagnostics, "extend is outside the allowed note root: "+extend)
		case ".md" != strings.ToLower(filepath.Ext(parentFile)) && ".markdown" != strings.ToLower(filepath.Ext(parentFile)):
			diagnostics = append(diagnostics, "extend source is not a Markdown file: "+extend)
		default:
			raw, err := os.ReadFile(parentFile)
			if nil != err {
				diagnostics = append(diagnostics, "extend source not found: "+extend)
			} else {
				parent = effectiveMeta(parentFile, string(raw), allowedRoot, seen)
			}
		}
	}
	diagnostics = append(diagnostics, parent.diagnostics...)
	merged := map[string]string{}
	for field, value := range parent.meta {
		if _, ok := inheritedMetaFields[field]; ok {
			merged[field] = value
		}
	}
	for field, value := range current {
		if "bib" == field && "" != merged["bib"] {
			merged[field] = value + ", " + merged[field]
		} else {
			merged[field] = value
		}
	}
	own := []bibSource{}
	for _, raw := range splitList(current["bib"]) {
		own = append(own, bibSource{raw: raw, base: filepath.Dir(key), origin: key})
	}
	return effectiveMetadata{meta: merged, bibSources: append(own, parent.bibSources...), diagnostics: diagnostics}
}

func visibleBibFiles(root, file, metadata string) ([]bibSource, []string) {
	meta := effectiveMeta(file, metadata, root, map[string]struct{}{})
	sources := append([]bibSource{{raw: "./bib", base: filepath.Dir(file), origin: file, optional: true}}, meta.bibSources...)
	files := []bibSource{}
	diagnostics := append([]string{}, meta.diagnostics...)
	seen := map[string]struct{}{}
	addFile := func(path string) {
		path = canonicalPath(path)
		if _, exists := seen[path]; exists {
			return
		}
		seen[path] = struct{}{}
		files = append(files, bibSource{raw: path})
	}
	for _, declaration := range sources {
		source := canonicalPath(filepath.Join(declaration.base, declaration.raw))
		if !inside(source, root) {
			diagnostics = append(diagnostics, "bib source is outside the allowed note root: "+declaration.raw)
			continue
		}
		info, err := os.Stat(source)
		if nil != err {
			if !declaration.optional {
				diagnostics = append(diagnostics, "bib source not found: "+declaration.raw)
			}
			continue
		}
		if !info.IsDir() {
			if info.Mode().IsRegular() && ".bib" == strings.ToLower(filepath.Ext(source)) {
				addFile(source)
			} else if info.Mode().IsRegular() {
				diagnostics = append(diagnostics, "bib source is not a .bib file: "+declaration.raw)
			} else {
				diagnostics = append(diagnostics, "bib source is neither a directory nor .bib file: "+declaration.raw)
			}
			continue
		}
		entries, readErr := os.ReadDir(source)
		if nil != readErr {
			if !declaration.optional {
				diagnostics = append(diagnostics, "bib source not found: "+declaration.raw)
			}
			continue
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, entry := range entries {
			if !entry.IsDir() && ".bib" == strings.ToLower(filepath.Ext(entry.Name())) {
				addFile(filepath.Join(source, entry.Name()))
			}
		}
	}
	return files, diagnostics
}

func Load(root, notePath, metadata string) (Library, error) {
	root = canonicalPath(root)
	if info, err := os.Stat(root); nil != err || !info.IsDir() {
		return Library{}, errors.New("bibliography root is not a directory")
	}
	file := canonicalPath(filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(notePath, "/"))))
	if !inside(file, root) {
		return Library{}, errors.New("bibliography note is outside the allowed root")
	}
	files, diagnostics := visibleBibFiles(root, file, metadata)
	ret := Library{Files: []LibraryFile{}, Diagnostics: diagnostics, Source: "kernel-bibliography"}
	for _, source := range files {
		parsed, err := parseBibFile(source.raw)
		if nil != err {
			ret.Diagnostics = append(ret.Diagnostics, fmt.Sprintf("failed to read bibliography %s: %s", rootRelative(source.raw, root), err))
			continue
		}
		path := rootRelative(source.raw, root)
		namespace := strings.TrimSuffix(path, filepath.Ext(path))
		shortNamespace := strings.TrimSuffix(filepath.Base(source.raw), filepath.Ext(source.raw))
		keyCounts := map[string]int{}
		for _, entry := range parsed.Entries {
			keyCounts[entry.Key]++
		}
		for key, count := range keyCounts {
			if 1 < count {
				ret.Diagnostics = append(ret.Diagnostics, path+": duplicate BibTeX key: "+key)
			}
		}
		entries := make([]Entry, len(parsed.Entries))
		for index, entry := range parsed.Entries {
			entry.Namespace = namespace
			entry.ShortNamespace = shortNamespace
			entry.File = source.raw
			entry.Path = path
			entry.ID = fmt.Sprintf("bib-%x", sha1.Sum([]byte(source.raw+"\x00"+entry.Key)))
			entries[index] = entry
		}
		for _, diagnostic := range parsed.Diagnostics {
			ret.Diagnostics = append(ret.Diagnostics, path+": "+diagnostic)
		}
		ret.Files = append(ret.Files, LibraryFile{
			File: source.raw, Path: path, Namespace: namespace, ShortNamespace: shortNamespace,
			Entries: entries, Diagnostics: parsed.Diagnostics,
		})
	}
	shortCounts := map[string]int{}
	for _, file := range ret.Files {
		shortCounts[file.ShortNamespace]++
	}
	for fileIndex := range ret.Files {
		if 1 < shortCounts[ret.Files[fileIndex].ShortNamespace] {
			for entryIndex := range ret.Files[fileIndex].Entries {
				ret.Files[fileIndex].Entries[entryIndex].ShortNamespace = ""
			}
		}
	}
	ret.Diagnostics = unique(ret.Diagnostics)
	return ret, nil
}

// parseBibFile ports the Node bibliography parser cache into the Go backend.
// Parsing is cached by nanosecond mtime + size, bounded by both entry count and
// bytes, and concurrent requests for the same file collapse into one parse.
func parseBibFile(file string) (ParseResult, error) {
	info, err := os.Stat(file)
	if nil != err {
		return ParseResult{}, err
	}
	if parsed, ok := cachedBibParse(file, info); ok {
		return parsed, nil
	}
	value, err, _ := bibParseRequests.Do(file, func() (any, error) {
		info, statErr := os.Stat(file)
		if nil != statErr {
			return ParseResult{}, statErr
		}
		if parsed, ok := cachedBibParse(file, info); ok {
			return parsed, nil
		}

		raw, readErr := os.ReadFile(file)
		if nil != readErr {
			return ParseResult{}, readErr
		}
		after, statErr := os.Stat(file)
		if nil != statErr {
			return ParseResult{}, statErr
		}
		parsed := Parse(string(raw))
		entry := &bibCacheEntry{
			mtimeNs: after.ModTime().UnixNano(), size: after.Size(), usedAt: time.Now(), parsed: parsed,
		}
		bibCacheMu.Lock()
		if old := bibParsedCache[file]; nil != old {
			bibParsedBytes -= old.size
		}
		bibParsedCache[file] = entry
		bibParsedBytes += entry.size
		for len(bibParsedCache) > bibCacheLimit || bibParsedBytes > bibCacheBytes {
			victimPath := ""
			var victim *bibCacheEntry
			for path, candidate := range bibParsedCache {
				if nil == victim || candidate.usedAt.Before(victim.usedAt) {
					victimPath, victim = path, candidate
				}
			}
			if nil == victim {
				break
			}
			delete(bibParsedCache, victimPath)
			bibParsedBytes -= victim.size
		}
		bibCacheMu.Unlock()
		return parsed, nil
	})
	if nil != err {
		return ParseResult{}, err
	}
	return value.(ParseResult), nil
}

func cachedBibParse(file string, info os.FileInfo) (ParseResult, bool) {
	bibCacheMu.Lock()
	defer bibCacheMu.Unlock()
	cached := bibParsedCache[file]
	if nil == cached || cached.mtimeNs != info.ModTime().UnixNano() || cached.size != info.Size() {
		return ParseResult{}, false
	}
	cached.usedAt = time.Now()
	return cached.parsed, true
}

func resetBibParsedCache() {
	bibCacheMu.Lock()
	bibParsedCache = map[string]*bibCacheEntry{}
	bibParsedBytes = 0
	bibCacheMu.Unlock()
}

func unique(values []string) []string {
	ret := []string{}
	seen := map[string]struct{}{}
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		ret = append(ret, value)
	}
	return ret
}
