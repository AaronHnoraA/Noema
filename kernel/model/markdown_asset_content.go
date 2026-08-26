// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema Markdown asset-content indexing additions are Copyright (c) 2026
// Aaron He and distributed under the same AGPL-3.0-or-later terms.

package model

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/88250/lute/ast"
	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/search"
	"github.com/aaronhe/noema/kernel/sql"
)

const maxMarkdownAssetContentDocuments = 5000

func markdownAssetContentPrefix(boxID string) string {
	return "noema-markdown/" + boxID + "/"
}

func markdownAssetContentPath(boxID, absPath string) (string, bool) {
	root := filesys.BoxRootPath(boxID)
	rel, err := filepath.Rel(root, absPath)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false
	}
	return markdownAssetContentPrefix(boxID) + filepath.ToSlash(rel), true
}

func indexMarkdownAssetContent(boxID, absPath string) {
	indexPath, ok := markdownAssetContentPath(boxID, absPath)
	if !ok {
		return
	}
	parser := assetContentSearcher.GetParser(filepath.Ext(absPath))
	if parser == nil {
		return
	}
	result := parser.Parse(absPath)
	if result == nil {
		return
	}
	info, err := os.Stat(absPath)
	if err != nil || !info.Mode().IsRegular() {
		return
	}
	sql.DeleteAssetContentsByPathQueue(indexPath)
	sql.IndexAssetContentsQueue([]*sql.AssetContent{{
		ID: ast.NewNodeID(), Name: filepath.Base(absPath), Ext: strings.ToLower(filepath.Ext(absPath)), Path: indexPath,
		Size: info.Size(), Updated: info.ModTime().Unix(), Content: result.Content,
	}})
}

func removeMarkdownAssetContent(boxID, absPath string) {
	if indexPath, ok := markdownAssetContentPath(boxID, absPath); ok {
		sql.DeleteAssetContentsByPathQueue(indexPath)
	}
}

func referencedMarkdownAssetFiles(boxID string) ([]string, error) {
	root := filesys.BoxRootPath(boxID)
	files := map[string]bool{}
	err := filepath.WalkDir(root, func(file string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, fs.ErrNotExist) {
				return nil
			}
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
		source, readErr := os.ReadFile(file)
		if readErr != nil {
			return nil
		}
		for _, href := range markdownAssetHrefs(string(source)) {
			resolved := resolveMarkdownAssetHref(root, file, href)
			if resolved == "" || !markdownAssetReferenceCandidate(href, resolved) || assetContentSearcher.GetParser(filepath.Ext(resolved)) == nil {
				continue
			}
			if info, statErr := os.Stat(resolved); statErr == nil && info.Mode().IsRegular() {
				files[resolved] = true
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	// Noema-created images/attachments are managed assets even before a note
	// references them (for example, between paste and the next CM6 save).
	_ = filepath.WalkDir(root, func(file string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || len(files) >= maxMarkdownAssetContentDocuments {
			return nil
		}
		if entry.IsDir() {
			if file != root && markdownAssetScanExcludedDir(entry.Name(), true) {
				return filepath.SkipDir
			}
			return nil
		}
		rel, relErr := filepath.Rel(root, file)
		if relErr == nil && entry.Type().IsRegular() && markdownAssetCandidate(rel) && assetContentSearcher.GetParser(filepath.Ext(file)) != nil {
			files[file] = true
		}
		return nil
	})
	ret := make([]string, 0, len(files))
	for file := range files {
		ret = append(ret, file)
	}
	sort.Strings(ret)
	if len(ret) > maxMarkdownAssetContentDocuments {
		ret = ret[:maxMarkdownAssetContentDocuments]
	}
	return ret, nil
}

func syncMarkdownAssetContent(boxID string) (int, error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return 0, fmt.Errorf("box [%s] is not a Markdown box", boxID)
	}
	files, err := referencedMarkdownAssetFiles(boxID)
	if err != nil {
		return 0, err
	}
	prefix := markdownAssetContentPrefix(boxID)
	rows, _ := sql.QueryAssetContentNoLimitArgs(
		"SELECT path, size, updated FROM asset_contents_fts_case_insensitive WHERE path GLOB ?", prefix+"*")
	existing := map[string]map[string]any{}
	for _, row := range rows {
		if p, ok := row["path"].(string); ok {
			existing[p] = row
		}
	}
	current := map[string]bool{}
	for _, file := range files {
		indexPath, ok := markdownAssetContentPath(boxID, file)
		if !ok {
			continue
		}
		current[indexPath] = true
		info, statErr := os.Stat(file)
		if statErr != nil {
			continue
		}
		row := existing[indexPath]
		if row != nil && numericInt64(row["size"]) == info.Size() && numericInt64(row["updated"]) == info.ModTime().Unix() {
			continue
		}
		indexMarkdownAssetContent(boxID, file)
	}
	for indexPath := range existing {
		if !current[indexPath] {
			sql.DeleteAssetContentsByPathQueue(indexPath)
		}
	}
	sql.FlushAssetContentQueue()
	return len(files), nil
}

func numericInt64(value any) int64 {
	switch typed := value.(type) {
	case int64:
		return typed
	case int:
		return int64(typed)
	case float64:
		return int64(typed)
	}
	return 0
}

func SearchMarkdownAssetContent(boxID, query string, limit int) (ret []*AssetContent, total, indexed int, err error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return []*AssetContent{}, 0, 0, nil
	}
	if limit < 1 {
		limit = 20
	} else if limit > 100 {
		limit = 100
	}
	if indexed, err = syncMarkdownAssetContent(boxID); err != nil {
		return nil, 0, 0, err
	}
	table := "asset_contents_fts_case_insensitive"
	match := buildAssetContentColumnFilter() + ":(" + stringQuery(filterQueryInvisibleChars(query)) + ")"
	prefix := markdownAssetContentPrefix(boxID)
	projection := "id, name, ext, path, size, updated, snippet(" + table + ", 6, '" +
		search.SearchMarkLeft + "', '" + search.SearchMarkRight + "', '...', 64) AS content"
	stmt := "SELECT " + projection + " FROM " + table + " WHERE " + table + " MATCH ? AND path GLOB ? ORDER BY rank DESC LIMIT ?"
	rows := sql.SelectAssetContentsRawStmtNoParseArgs(stmt, []any{match, prefix + "*", limit}, limit)
	ret = fromSQLAssetContents(&rows)
	countRows, _ := sql.QueryAssetContentNoLimitArgs(
		"SELECT COUNT(path) AS assets FROM "+table+" WHERE "+table+" MATCH ? AND path GLOB ?", match, prefix+"*")
	if len(countRows) > 0 {
		total = int(numericInt64(countRows[0]["assets"]))
	}
	for _, item := range ret {
		item.Path = strings.TrimPrefix(item.Path, prefix)
		item.File = filepath.Join(filesys.BoxRootPath(boxID), filepath.FromSlash(item.Path))
	}
	if ret == nil {
		ret = []*AssetContent{}
	}
	return ret, total, indexed, nil
}
