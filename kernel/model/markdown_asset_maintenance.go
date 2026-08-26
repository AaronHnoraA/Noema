// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema Markdown asset-maintenance additions are Copyright (c) 2026 Aaron He
// and distributed under the same AGPL-3.0-or-later terms.

package model

import (
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/siyuan-note/filelock"
)

type MarkdownMissingAsset struct {
	File      string `json:"file"`
	Path      string `json:"path"`
	Reference string `json:"reference"`
	NoteFile  string `json:"noteFile"`
	NotePath  string `json:"notePath"`
}

type MarkdownAssetHealth struct {
	Unused  []MarkdownUnusedAsset  `json:"unused"`
	Missing []MarkdownMissingAsset `json:"missing"`
	Source  string                 `json:"source"`
}

type MarkdownAssetRenameResult struct {
	OldFile        string   `json:"oldFile"`
	NewFile        string   `json:"newFile"`
	OldPath        string   `json:"oldPath"`
	NewPath        string   `json:"newPath"`
	RewrittenNotes []string `json:"rewrittenNotes"`
	Source         string   `json:"source"`
}

type markdownAssetHrefSpan struct {
	Start int
	End   int
	Value string
}

func markdownLinkHrefSpans(source string) []markdownAssetHrefSpan {
	ret := []markdownAssetHrefSpan{}
	for open := 0; open < len(source); open++ {
		if source[open] != '[' || markdownAssetEscapedAt(source, open) {
			continue
		}
		depth, close := 0, -1
		for i := open + 1; i < len(source); i++ {
			if source[i] == '\\' && i+1 < len(source) {
				i++
				continue
			}
			if source[i] == '[' {
				depth++
			} else if source[i] == ']' {
				if depth == 0 {
					close = i
					break
				}
				depth--
			}
		}
		if close < 0 || close+1 >= len(source) || source[close+1] != '(' {
			continue
		}
		cursor := close + 2
		for cursor < len(source) && (source[cursor] == ' ' || source[cursor] == '\t') {
			cursor++
		}
		start, end := cursor, cursor
		if cursor < len(source) && source[cursor] == '<' {
			start = cursor + 1
			end = start
			for end < len(source) && source[end] != '\n' && source[end] != '\r' {
				if source[end] == '>' && !markdownAssetEscapedAt(source, end) {
					break
				}
				end++
			}
			if end >= len(source) || source[end] != '>' {
				continue
			}
			cursor = end + 1
		} else {
			parenDepth := 0
			for end < len(source) {
				ch := source[end]
				if ch == '\n' || ch == '\r' {
					break
				}
				if ch == '\\' && end+1 < len(source) {
					end += 2
					continue
				}
				if ch == '(' {
					parenDepth++
				} else if ch == ')' {
					if parenDepth == 0 {
						break
					}
					parenDepth--
				} else if parenDepth == 0 && (ch == ' ' || ch == '\t') {
					break
				}
				end++
			}
			cursor = end
		}
		for cursor < len(source) && (source[cursor] == ' ' || source[cursor] == '\t') {
			cursor++
		}
		if cursor < len(source) && source[cursor] == '"' {
			cursor++
			for cursor < len(source) && source[cursor] != '\n' && source[cursor] != '\r' {
				if source[cursor] == '\\' && cursor+1 < len(source) {
					cursor += 2
					continue
				}
				if source[cursor] == '"' {
					cursor++
					break
				}
				cursor++
			}
			for cursor < len(source) && (source[cursor] == ' ' || source[cursor] == '\t') {
				cursor++
			}
		}
		if cursor >= len(source) || source[cursor] != ')' || start >= end {
			continue
		}
		ret = append(ret, markdownAssetHrefSpan{Start: start, End: end, Value: source[start:end]})
		open = cursor
	}
	return ret
}

func regexpCaptureHrefSpans(source string, spans []markdownAssetHrefSpan, patterns ...interface{ FindAllStringSubmatchIndex(string, int) [][]int }) []markdownAssetHrefSpan {
	for _, pattern := range patterns {
		for _, match := range pattern.FindAllStringSubmatchIndex(source, -1) {
			if len(match) >= 4 && match[2] >= 0 && match[3] > match[2] {
				spans = append(spans, markdownAssetHrefSpan{Start: match[2], End: match[3], Value: source[match[2]:match[3]]})
			}
		}
	}
	return spans
}

func markdownAssetHrefSpans(source string) []markdownAssetHrefSpan {
	spans := markdownLinkHrefSpans(source)
	spans = regexpCaptureHrefSpans(source, spans, markdownAssetHTMLAttrPattern, markdownAssetCSSURLPattern,
		markdownAssetOrgLinkPattern, markdownAssetIncludePattern)
	for _, match := range markdownAssetSrcsetPattern.FindAllStringSubmatchIndex(source, -1) {
		if len(match) < 4 || match[2] < 0 {
			continue
		}
		capture := source[match[2]:match[3]]
		for offset := 0; offset < len(capture); {
			for offset < len(capture) && (capture[offset] == ' ' || capture[offset] == '\t' || capture[offset] == ',') {
				offset++
			}
			start := offset
			for offset < len(capture) && capture[offset] != ' ' && capture[offset] != '\t' && capture[offset] != ',' {
				offset++
			}
			if start < offset {
				spans = append(spans, markdownAssetHrefSpan{Start: match[2] + start, End: match[2] + offset, Value: capture[start:offset]})
			}
			for offset < len(capture) && capture[offset] != ',' {
				offset++
			}
		}
	}
	sort.Slice(spans, func(i, j int) bool {
		if spans[i].Start == spans[j].Start {
			return spans[i].End > spans[j].End
		}
		return spans[i].Start < spans[j].Start
	})
	ret := spans[:0]
	for _, span := range spans {
		if len(ret) > 0 && span.Start < ret[len(ret)-1].End {
			continue
		}
		ret = append(ret, span)
	}
	return ret
}

func markdownAssetReferenceCandidate(raw, resolved string) bool {
	clean := strings.ToLower(strings.SplitN(strings.SplitN(raw, "#", 2)[0], "?", 2)[0])
	ext := strings.ToLower(filepath.Ext(clean))
	if ext == ".md" || ext == ".markdown" || ext == ".typ" || ext == ".org" {
		return false
	}
	if ext != "" {
		return true
	}
	parts := strings.Split(strings.ToLower(filepath.ToSlash(resolved)), "/")
	for _, part := range parts {
		if part == "images" || part == "attachments" || part == "assets" {
			return true
		}
	}
	return false
}

func ListMissingMarkdownAssets(boxID string, includePublic bool) ([]MarkdownMissingAsset, error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return nil, fmt.Errorf("box [%s] is not a Markdown box", boxID)
	}
	root := filesys.BoxRootPath(boxID)
	ret := []MarkdownMissingAsset{}
	seen := map[string]bool{}
	err := filepath.WalkDir(root, func(file string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, fs.ErrNotExist) {
				return nil
			}
			return walkErr
		}
		if entry.IsDir() {
			if file != root && markdownAssetScanExcludedDir(entry.Name(), includePublic) {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() || !isMarkdownDocPath(file) {
			return nil
		}
		source, readErr := os.ReadFile(file)
		if readErr != nil {
			return nil
		}
		noteRel, _ := filepath.Rel(root, file)
		for _, href := range markdownAssetHrefs(string(source)) {
			resolved := resolveMarkdownAssetHref(root, file, href)
			if resolved == "" || !markdownAssetReferenceCandidate(href, resolved) {
				continue
			}
			if _, statErr := os.Stat(resolved); statErr == nil || !errors.Is(statErr, os.ErrNotExist) {
				continue
			}
			key := file + "\x00" + resolved
			if seen[key] {
				continue
			}
			seen[key] = true
			assetRel, _ := filepath.Rel(root, resolved)
			ret = append(ret, MarkdownMissingAsset{
				File: resolved, Path: filepath.ToSlash(assetRel), Reference: href,
				NoteFile: file, NotePath: filepath.ToSlash(noteRel),
			})
		}
		return nil
	})
	sort.Slice(ret, func(i, j int) bool {
		if ret[i].Path == ret[j].Path {
			return ret[i].NotePath < ret[j].NotePath
		}
		return ret[i].Path < ret[j].Path
	})
	return ret, err
}

func InspectMarkdownAssets(boxID string, includePublic bool) (*MarkdownAssetHealth, error) {
	unused, err := ListUnusedMarkdownAssets(boxID, includePublic)
	if err != nil {
		return nil, err
	}
	missing, err := ListMissingMarkdownAssets(boxID, includePublic)
	if err != nil {
		return nil, err
	}
	return &MarkdownAssetHealth{Unused: unused, Missing: missing, Source: "kernel-assets"}, nil
}

func RenameMarkdownAsset(boxID, oldPath, newName string) (*MarkdownAssetRenameResult, error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return nil, fmt.Errorf("box [%s] is not a Markdown box", boxID)
	}
	root := filesys.BoxRootPath(boxID)
	oldAbs := oldPath
	if !filepath.IsAbs(oldAbs) {
		oldAbs = filepath.Join(root, strings.TrimPrefix(filepath.FromSlash(oldPath), string(filepath.Separator)))
	}
	oldRel, err := filepath.Rel(root, oldAbs)
	if err != nil {
		return nil, err
	}
	oldRel, err = filesys.ValidateBoxRelativePath(boxID, oldRel)
	if err != nil || !markdownAssetCandidate(oldRel) {
		return nil, errors.New("asset path is outside a managed images or attachments directory")
	}
	info, err := os.Lstat(oldAbs)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("asset source must be a regular non-symbolic file")
	}
	name := sanitizeMarkdownAssetName(newName, filepath.Base(oldAbs))
	if filepath.Ext(name) == "" {
		name += filepath.Ext(oldAbs)
	}
	newAbs := filepath.Join(filepath.Dir(oldAbs), name)
	if oldAbs == newAbs {
		return nil, errors.New("asset source and target names are the same")
	}
	if _, statErr := os.Lstat(newAbs); !errors.Is(statErr, os.ErrNotExist) {
		return nil, errors.New("asset target already exists")
	}
	if err = markdownAssetDirInsideRoot(root, filepath.Dir(newAbs)); err != nil {
		return nil, err
	}

	type rewrite struct {
		file     string
		path     string
		original []byte
		updated  []byte
	}
	rewrites := []rewrite{}
	err = filepath.WalkDir(root, func(file string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if file != root && markdownAssetScanExcludedDir(entry.Name(), true) {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() || !isMarkdownDocPath(file) {
			return nil
		}
		data, readErr := os.ReadFile(file)
		if readErr != nil {
			return readErr
		}
		updated := append([]byte(nil), data...)
		spans := markdownAssetHrefSpans(string(data))
		changed := false
		for index := len(spans) - 1; index >= 0; index-- {
			span := spans[index]
			if resolveMarkdownAssetHref(root, file, span.Value) != oldAbs {
				continue
			}
			replacement := markdownRenamedAssetHref(root, file, span.Value, newAbs)
			updated = append(append(append([]byte{}, updated[:span.Start]...), []byte(replacement)...), updated[span.End:]...)
			changed = true
		}
		if changed {
			rel, _ := filepath.Rel(root, file)
			rewrites = append(rewrites, rewrite{file: file, path: filepath.ToSlash(rel), original: data, updated: updated})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err = filelock.Rename(oldAbs, newAbs); err != nil {
		return nil, err
	}
	written := 0
	for index, item := range rewrites {
		if err = filelock.WriteFile(item.file, item.updated); err != nil {
			written = index
			break
		}
		written = index + 1
	}
	if err != nil {
		for index := 0; index < written; index++ {
			_ = filelock.WriteFile(rewrites[index].file, rewrites[index].original)
		}
		_ = filelock.Rename(newAbs, oldAbs)
		return nil, fmt.Errorf("rewrite asset references: %w", err)
	}
	paths := make([]string, 0, len(rewrites))
	rewritten := make([]string, 0, len(rewrites))
	for _, item := range rewrites {
		paths = append(paths, boxID+"/"+item.path)
		rewritten = append(rewritten, item.path)
	}
	if Conf != nil {
		UpsertIndexes(paths)
		util.PushReloadFiletree()
	}
	removeMarkdownAssetContent(boxID, oldAbs)
	indexMarkdownAssetContent(boxID, newAbs)
	newRel, _ := filepath.Rel(root, newAbs)
	return &MarkdownAssetRenameResult{
		OldFile: oldAbs, NewFile: newAbs, OldPath: filepath.ToSlash(oldRel), NewPath: filepath.ToSlash(newRel),
		RewrittenNotes: rewritten, Source: "kernel-assets",
	}, nil
}

func markdownRenamedAssetHref(root, noteFile, raw, newAbs string) string {
	suffix := ""
	base := raw
	if index := strings.IndexAny(base, "?#"); index >= 0 {
		suffix, base = base[index:], base[:index]
	}
	decoded := decodeMarkdownAssetHref(base)
	newRelRoot, _ := filepath.Rel(root, newAbs)
	newRelNote, _ := filepath.Rel(filepath.Dir(noteFile), newAbs)
	value := filepath.ToSlash(newRelNote)
	lower := strings.ToLower(strings.TrimSpace(decoded))
	if strings.HasPrefix(lower, "file://") {
		value = (&url.URL{Scheme: "file", Path: newAbs}).String()
	} else if strings.HasPrefix(lower, "file:") {
		value = "file:" + filepath.ToSlash(newAbs)
	} else if strings.HasPrefix(strings.ReplaceAll(decoded, "\\", "/"), "/") {
		value = "/" + filepath.ToSlash(newRelRoot)
	} else if strings.HasPrefix(strings.ToLower(strings.ReplaceAll(decoded, "\\", "/")), "roam/") {
		value = "roam/" + filepath.ToSlash(newRelRoot)
	} else if strings.HasPrefix(decoded, "./") && !strings.HasPrefix(value, ".") {
		value = "./" + value
	}
	return value + suffix
}
