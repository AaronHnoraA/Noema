// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema Markdown asset routing additions are Copyright (c) 2026 Aaron He and
// distributed under the same AGPL-3.0-or-later terms.

package model

import (
	"fmt"
	"io/fs"
	"mime"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"unicode"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/siyuan-note/filelock"
	"golang.org/x/text/unicode/norm"
)

// MarkdownAsset is the stable result consumed by Noema's existing paste/drop
// pipeline. The source file remains canonical Markdown; assets live beside the
// current note under images/<note>/ or attachments/<note>/.
type MarkdownAsset struct {
	OK           bool   `json:"ok"`
	File         string `json:"file"`
	Name         string `json:"name"`
	Type         string `json:"type"`
	IsImage      bool   `json:"isImage"`
	MarkdownPath string `json:"markdownPath"`
	Source       string `json:"source"`
}

type MarkdownUnusedAsset struct {
	File    string  `json:"file"`
	Path    string  `json:"path"`
	Name    string  `json:"name"`
	Type    string  `json:"type"`
	Size    int64   `json:"size"`
	MtimeMs float64 `json:"mtimeMs"`
	IsImage bool    `json:"isImage"`
}

var markdownImageExtensions = map[string]bool{
	".avif": true, ".bmp": true, ".gif": true, ".jpeg": true,
	".jpg": true, ".png": true, ".svg": true, ".webp": true,
}

var (
	markdownAssetHTMLAttrPattern = regexp.MustCompile(`(?i)\b(?:src|href|poster|data-src)\s*=\s*["']([^"']+)["']`)
	markdownAssetSrcsetPattern   = regexp.MustCompile(`(?i)\bsrcset\s*=\s*["']([^"']+)["']`)
	markdownAssetCSSURLPattern   = regexp.MustCompile(`(?i)\burl\(\s*["']?([^"')]+)["']?\s*\)`)
	markdownAssetOrgLinkPattern  = regexp.MustCompile(`(?im)\[\[(?:file:)?([^\]\n]+?)(?:\][^\]\n]*)?\]\]`)
	markdownAssetIncludePattern  = regexp.MustCompile(`(?im)^\s*#\+include:\s+["<]?([^">\n]+)[">]?`)
	markdownAssetProtocolPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*:`)
)

// Allocation and write are one transaction so simultaneous paste/drop events
// cannot both choose the same collision-free filename and overwrite each other.
var markdownAssetWriteMu sync.Mutex

func markdownAssetDirInsideRoot(root, targetDir string) error {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	probe := targetDir
	for {
		if _, statErr := os.Lstat(probe); statErr == nil {
			break
		} else if !os.IsNotExist(statErr) {
			return statErr
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return fmt.Errorf("cannot resolve asset directory [%s]", targetDir)
		}
		probe = parent
	}
	realProbe, err := filepath.EvalSymlinks(probe)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(realRoot, realProbe)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return fmt.Errorf("asset directory [%s] resolves outside Markdown box", targetDir)
	}
	return nil
}

func markdownAssetContentType(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".html", ".htm":
		return "text/html; charset=utf-8"
	case ".js", ".mjs":
		return "application/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".avif":
		return "image/avif"
	case ".bmp":
		return "image/bmp"
	case ".pdf":
		return "application/pdf"
	case ".txt":
		return "text/plain; charset=utf-8"
	case ".md", ".markdown":
		return "text/markdown; charset=utf-8"
	case ".drawio", ".dio":
		return "application/vnd.jgraph.mxfile"
	}
	if detected := mime.TypeByExtension(ext); detected != "" {
		return detected
	}
	return "application/octet-stream"
}

func sanitizeMarkdownAssetName(input, fallback string) string {
	name := filepath.Base(strings.TrimSpace(norm.NFKC.String(input)))
	if name == "" || name == "." || name == string(filepath.Separator) {
		name = fallback
	}
	var out strings.Builder
	lastDash := false
	for _, r := range name {
		invalid := unicode.IsControl(r) || strings.ContainsRune(`<>:"/\\|?*`, r)
		if invalid || unicode.IsSpace(r) {
			if !lastDash {
				out.WriteByte('-')
				lastDash = true
			}
			continue
		}
		out.WriteRune(r)
		lastDash = false
	}
	name = strings.TrimSpace(out.String())
	if name == "" || strings.Trim(name, ".") == "" {
		return fallback
	}
	return name
}

func markdownAssetTarget(boxID, notePath, name, mediaType string) (target, relativePath string, isImage bool, err error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		err = fmt.Errorf("box [%s] is not a markdown box", boxID)
		return
	}
	notePath, err = filesys.ValidateBoxRelativePath(boxID, notePath)
	if err != nil {
		return
	}
	if !isMarkdownDocPath(notePath) {
		err = fmt.Errorf("path [%s] is not a Markdown document", notePath)
		return
	}
	fallback := "attachment"
	if strings.HasPrefix(strings.ToLower(mediaType), "image/") {
		fallback = "image.png"
	}
	name = sanitizeMarkdownAssetName(name, fallback)
	isImage = strings.HasPrefix(strings.ToLower(mediaType), "image/") || markdownImageExtensions[strings.ToLower(filepath.Ext(name))]
	noteStem := sanitizeMarkdownAssetName(strings.TrimSuffix(filepath.Base(notePath), filepath.Ext(notePath)), "note")
	kindDir := "attachments"
	if isImage {
		kindDir = "images"
	}
	relativeDir := filepath.Join(filepath.Dir(notePath), kindDir, noteStem)
	if _, err = filesys.ValidateBoxRelativePath(boxID, relativeDir); err != nil {
		return
	}
	absDir := filepath.Join(filesys.BoxRootPath(boxID), relativeDir)
	if err = markdownAssetDirInsideRoot(filesys.BoxRootPath(boxID), absDir); err != nil {
		return
	}
	if err = os.MkdirAll(absDir, 0755); err != nil {
		return
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	if stem == "" {
		stem = fallback
	}
	target = filepath.Join(absDir, name)
	for i := 2; ; i++ {
		_, statErr := os.Lstat(target)
		if os.IsNotExist(statErr) {
			break
		}
		if statErr != nil {
			err = statErr
			return
		}
		target = filepath.Join(absDir, fmt.Sprintf("%s-%d%s", stem, i, ext))
	}
	relativePath, err = filepath.Rel(filepath.Dir(filepath.Join(filesys.BoxRootPath(boxID), notePath)), target)
	if err != nil {
		return
	}
	relativePath = filepath.ToSlash(relativePath)
	if !strings.HasPrefix(relativePath, ".") && !strings.HasPrefix(relativePath, "/") {
		relativePath = "./" + relativePath
	}
	return
}

func markdownAssetResult(target, relativePath string, isImage bool) *MarkdownAsset {
	return &MarkdownAsset{
		OK: true, File: target, Name: filepath.Base(target), Type: markdownAssetContentType(target),
		IsImage: isImage, MarkdownPath: relativePath, Source: "kernel-assets",
	}
}

func markdownAssetEscapedAt(source string, at int) bool {
	count := 0
	for at--; at >= 0 && source[at] == '\\'; at-- {
		count++
	}
	return count%2 == 1
}

func markdownAssetLinkHrefs(source string) (ret []string) {
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
				continue
			}
			if source[i] == ']' {
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
		if cursor >= len(source) || source[cursor] != ')' {
			continue
		}
		ret = append(ret, source[start:end])
		open = cursor
	}
	return
}

func markdownAssetHrefs(source string) (ret []string) {
	ret = append(ret, markdownAssetLinkHrefs(source)...)
	appendMatches := func(pattern *regexp.Regexp) {
		for _, match := range pattern.FindAllStringSubmatch(source, -1) {
			if len(match) > 1 {
				ret = append(ret, match[1])
			}
		}
	}
	appendMatches(markdownAssetHTMLAttrPattern)
	for _, match := range markdownAssetSrcsetPattern.FindAllStringSubmatch(source, -1) {
		if len(match) < 2 {
			continue
		}
		for _, item := range strings.Split(match[1], ",") {
			if fields := strings.Fields(item); len(fields) > 0 {
				ret = append(ret, fields[0])
			}
		}
	}
	appendMatches(markdownAssetCSSURLPattern)
	appendMatches(markdownAssetOrgLinkPattern)
	appendMatches(markdownAssetIncludePattern)
	return
}

func decodeMarkdownAssetHref(raw string) string {
	decoded, err := url.PathUnescape(raw)
	if err != nil {
		decoded = raw
	}
	var ret strings.Builder
	for i := 0; i < len(decoded); i++ {
		if decoded[i] == '\\' && i+1 < len(decoded) && strings.ContainsRune("\\`*_[](){}#+.!<>-", rune(decoded[i+1])) {
			i++
		}
		ret.WriteByte(decoded[i])
	}
	return ret.String()
}

func resolveMarkdownAssetHref(root, notePath, href string) string {
	raw := strings.TrimSpace(href)
	if raw == "" || strings.HasPrefix(raw, "#") {
		return ""
	}
	fileScheme := false
	if strings.HasPrefix(strings.ToLower(raw), "file://") {
		parsed, err := url.Parse(raw)
		if err != nil {
			return ""
		}
		raw = parsed.Path
		fileScheme = true
	} else if strings.HasPrefix(strings.ToLower(raw), "file:") {
		raw = raw[len("file:"):]
		fileScheme = true
	} else if markdownAssetProtocolPattern.MatchString(raw) && !filepath.IsAbs(raw) {
		return ""
	}
	if index := strings.IndexAny(raw, "?#"); index >= 0 {
		raw = raw[:index]
	}
	raw = decodeMarkdownAssetHref(raw)
	if strings.HasPrefix(raw, "~/") || strings.HasPrefix(raw, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			raw = filepath.Join(home, raw[2:])
			fileScheme = true
		}
	}
	cleanSlash := strings.TrimLeft(strings.ReplaceAll(raw, "\\", "/"), "/")
	var resolved string
	if fileScheme || (filepath.IsAbs(raw) && !strings.HasPrefix(raw, "/")) {
		resolved = filepath.Clean(raw)
	} else if cleanSlash == "roam" {
		resolved = root
	} else if strings.HasPrefix(cleanSlash, "roam/") {
		resolved = filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(cleanSlash, "roam/")))
	} else if filepath.IsAbs(raw) || strings.HasPrefix(raw, "/") {
		resolved = filepath.Join(root, filepath.FromSlash(cleanSlash))
	} else {
		resolved = filepath.Join(filepath.Dir(notePath), filepath.FromSlash(raw))
	}
	resolved = filepath.Clean(resolved)
	rel, err := filepath.Rel(root, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return ""
	}
	return resolved
}

func markdownAssetScanExcludedDir(name string, includePublic bool) bool {
	if strings.HasPrefix(name, ".") && name != ".emacs.d" {
		return true
	}
	if name == "public" {
		return !includePublic
	}
	switch name {
	case "_typst", "var", ".git", ".lake", ".direnv", ".venv", "node_modules", "__pycache__", ".ipynb_checkpoints", ".jupyter", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".virtual_documents":
		return true
	}
	return false
}

func markdownAssetCandidate(relativePath string) bool {
	parts := strings.Split(strings.ToLower(filepath.ToSlash(relativePath)), "/")
	inAssetDir := false
	for _, part := range parts[:len(parts)-1] {
		if part == "images" || part == "attachments" {
			inAssetDir = true
			break
		}
	}
	if !inAssetDir || filepath.Base(relativePath) == ".aaronnote-keep" {
		return false
	}
	ext := strings.ToLower(filepath.Ext(relativePath))
	return ext != ".lean" && ext != ".typ" && ext != ".md" && ext != ".markdown"
}

// ListUnusedMarkdownAssets computes candidates from the external Markdown box
// itself. It is intentionally read-only; moving files to the platform trash is
// a host-adapter action and revalidates this list immediately before mutation.
func ListUnusedMarkdownAssets(boxID string, includePublic bool) ([]MarkdownUnusedAsset, error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return nil, fmt.Errorf("box [%s] is not a markdown box", boxID)
	}
	root := filesys.BoxRootPath(boxID)
	referenced := map[string]bool{}
	assets := []MarkdownUnusedAsset{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if os.IsNotExist(walkErr) {
				return nil
			}
			return walkErr
		}
		if path == root {
			return nil
		}
		if entry.IsDir() {
			if markdownAssetScanExcludedDir(entry.Name(), includePublic) {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(entry.Name(), ".") {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		if ext == ".md" || ext == ".markdown" || ext == ".typ" {
			source, readErr := os.ReadFile(path)
			if readErr != nil {
				return nil
			}
			for _, href := range markdownAssetHrefs(string(source)) {
				if resolved := resolveMarkdownAssetHref(root, path, href); resolved != "" {
					referenced[resolved] = true
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if os.IsNotExist(walkErr) {
				return nil
			}
			return walkErr
		}
		if path == root {
			return nil
		}
		if entry.IsDir() {
			if markdownAssetScanExcludedDir(entry.Name(), includePublic) {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(entry.Name(), ".") {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() {
			return nil
		}
		relativePath, relErr := filepath.Rel(root, path)
		if relErr != nil || !markdownAssetCandidate(relativePath) || referenced[filepath.Clean(path)] {
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return nil
		}
		assets = append(assets, MarkdownUnusedAsset{
			File: path, Path: filepath.ToSlash(relativePath), Name: filepath.Base(path),
			Type: markdownAssetContentType(path), Size: info.Size(),
			MtimeMs: float64(info.ModTime().UnixNano()) / float64(1e6),
			IsImage: markdownImageExtensions[strings.ToLower(filepath.Ext(path))],
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(assets, func(i, j int) bool { return assets[i].Path < assets[j].Path })
	return assets, nil
}

// StoreMarkdownAssetBytes atomically writes browser-provided bytes into the
// Markdown repository. filelock.WriteFile uses a temporary file + rename and
// avoids exposing a partially written paste to the editor or watcher.
func StoreMarkdownAssetBytes(boxID, notePath, name, mediaType string, data []byte) (*MarkdownAsset, error) {
	if len(data) == 0 {
		return nil, fmt.Errorf("missing asset data")
	}
	markdownAssetWriteMu.Lock()
	defer markdownAssetWriteMu.Unlock()
	target, relativePath, isImage, err := markdownAssetTarget(boxID, notePath, name, mediaType)
	if err != nil {
		return nil, err
	}
	if err = filelock.WriteFile(target, data); err != nil {
		return nil, err
	}
	return markdownAssetResult(target, relativePath, isImage), nil
}

// StoreMarkdownAssetFromPath imports a regular local file. It streams through
// filelock.Copy rather than base64-encoding the source in Node.
func StoreMarkdownAssetFromPath(boxID, notePath, sourcePath, name, mediaType string) (*MarkdownAsset, error) {
	sourcePath = filepath.Clean(strings.TrimSpace(sourcePath))
	if sourcePath == "" || !filepath.IsAbs(sourcePath) {
		return nil, fmt.Errorf("missing absolute asset source path")
	}
	info, err := os.Stat(sourcePath)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("asset source is not a regular file: %s", sourcePath)
	}
	if strings.TrimSpace(name) == "" {
		name = filepath.Base(sourcePath)
	}
	if strings.TrimSpace(mediaType) == "" {
		mediaType = markdownAssetContentType(sourcePath)
	}
	markdownAssetWriteMu.Lock()
	defer markdownAssetWriteMu.Unlock()
	target, relativePath, isImage, err := markdownAssetTarget(boxID, notePath, name, mediaType)
	if err != nil {
		return nil, err
	}
	if err = filelock.Copy(sourcePath, target); err != nil {
		return nil, err
	}
	return markdownAssetResult(target, relativePath, isImage), nil
}
