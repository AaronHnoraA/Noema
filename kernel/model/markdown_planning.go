// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema planning additions are Copyright (c) 2026 Aaron He and distributed
// under the same AGPL-3.0-or-later terms.

package model

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	noemaplanning "github.com/aaronhe/noema/kernel/noema/planning"
)

// MarkdownPlanningDocument is a read-only source projection. Node spans use
// JavaScript UTF-16 offsets so the Node compatibility host and CodeMirror can
// consume them without translating or reparsing Markdown.
type MarkdownPlanningDocument struct {
	Path    string               `json:"path"`
	Nodes   []noemaplanning.Node `json:"nodes"`
	Version string               `json:"version"`
	MtimeMs float64              `json:"mtimeMs"`
}

// ListMarkdownPlanning scans either one path or every Markdown document in a
// portable Markdown box. It never updates source, indexes, or box metadata.
func ListMarkdownPlanning(boxID, path string) (documents []MarkdownPlanningDocument, err error) {
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
		var docs []MarkdownDocSummary
		if docs, err = ListMarkdownDocs(boxID); nil != err {
			return nil, err
		}
		for _, doc := range docs {
			paths = append(paths, doc.Path)
		}
	}

	documents = make([]MarkdownPlanningDocument, 0, len(paths))
	for _, relativePath := range paths {
		raw, readErr := os.ReadFile(filepath.Join(filesys.BoxRootPath(boxID), relativePath))
		if nil != readErr {
			if os.IsNotExist(readErr) {
				documents = append(documents, MarkdownPlanningDocument{Path: relativePath, Nodes: []noemaplanning.Node{}, Version: markdownPlanningVersion(nil)})
				continue
			}
			return nil, readErr
		}
		info, _ := os.Stat(filepath.Join(filesys.BoxRootPath(boxID), relativePath))
		mtimeMs := float64(0)
		if nil != info {
			mtimeMs = float64(info.ModTime().UnixNano()) / 1e6
		}
		documents = append(documents, MarkdownPlanningDocument{
			Path: relativePath, Nodes: noemaplanning.ScanDocument(string(raw), ""),
			Version: markdownPlanningVersion(raw), MtimeMs: mtimeMs,
		})
	}
	sort.Slice(documents, func(i, j int) bool { return documents[i].Path < documents[j].Path })
	return documents, nil
}

func markdownPlanningVersion(source []byte) string {
	digest := sha256.Sum256(source)
	return fmt.Sprintf("%x", digest)
}

func isMarkdownDocPath(path string) bool {
	return filesys.IsMarkdownDocumentPath(path)
}
