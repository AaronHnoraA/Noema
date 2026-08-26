// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema Markdown path operations are Copyright (c) 2026 Aaron He and
// distributed under the same AGPL-3.0-or-later terms.

package model

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/88250/lute/parse"
	"github.com/aaronhe/noema/kernel/cache"
	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/siyuan-note/filelock"
)

type MarkdownDocMoveResult struct {
	Notebook string `json:"notebook"`
	FromPath string `json:"fromPath"`
	ToPath   string `json:"toPath"`
	ID       string `json:"id"`
}

type MarkdownPathMoveResult struct {
	Notebook  string                  `json:"notebook"`
	FromPath  string                  `json:"fromPath"`
	ToPath    string                  `json:"toPath"`
	Directory bool                    `json:"directory"`
	Documents []MarkdownDocMoveResult `json:"documents"`
}

func normalizedMarkdownPath(boxID, p string) (string, error) {
	normalized, err := filesys.ValidateBoxRelativePath(boxID, p)
	if nil != err {
		return "", err
	}
	normalized = "/" + strings.TrimPrefix(filepath.ToSlash(normalized), "/")
	if "/" == normalized {
		return "", errors.New("Markdown path must not be the repository root")
	}
	for _, part := range strings.Split(strings.TrimPrefix(normalized, "/"), "/") {
		if strings.HasPrefix(part, ".") {
			return "", errors.New("Markdown path must not enter a hidden directory")
		}
	}
	return normalized, nil
}

func normalizedMarkdownDocPath(boxID, p string) (string, error) {
	normalized, err := normalizedMarkdownPath(boxID, p)
	if nil != err {
		return "", err
	}
	if !isMarkdownDocPath(normalized) {
		return "", errors.New("Markdown document path must end in .md or .markdown")
	}
	return normalized, nil
}

type markdownPathMoveProjection struct {
	fromPath string
	toPath   string
	oldTree  *treenode.BlockTree
}

// MoveMarkdownDoc renames or moves one repository-native Markdown document.
// The source bytes and canonical meta.id are preserved; only the disposable
// blocktree/SQL path projection is replaced. Cross-notebook moves deliberately
// remain unsupported because a path-only request cannot safely rewrite links
// or choose identity semantics across repository boundaries.
func MoveMarkdownDoc(boxID, fromPath, toPath string) (ret *MarkdownDocMoveResult, err error) {
	fromPath, err = normalizedMarkdownDocPath(boxID, fromPath)
	if nil != err {
		return nil, fmt.Errorf("invalid source path: %w", err)
	}
	toPath, err = normalizedMarkdownDocPath(boxID, toPath)
	if nil != err {
		return nil, fmt.Errorf("invalid target path: %w", err)
	}
	result, err := moveMarkdownPath(boxID, fromPath, toPath, false)
	if nil != err {
		return nil, err
	}
	if 1 != len(result.Documents) {
		return nil, errors.New("Markdown document move did not produce one document projection")
	}
	ret = &result.Documents[0]
	return ret, nil
}

// MoveMarkdownPath atomically renames either one Markdown document or one
// real repository directory, then synchronously replaces every affected
// blocktree/SQL projection. It does not rewrite source links; that operation
// belongs to the shared web-host, which has the portable Markdown link parser
// and reports post-commit repair failures without retrying the path move.
func MoveMarkdownPath(boxID, fromPath, toPath string) (ret *MarkdownPathMoveResult, err error) {
	fromPath, err = normalizedMarkdownPath(boxID, fromPath)
	if nil != err {
		return nil, fmt.Errorf("invalid source path: %w", err)
	}
	toPath, err = normalizedMarkdownPath(boxID, toPath)
	if nil != err {
		return nil, fmt.Errorf("invalid target path: %w", err)
	}
	return moveMarkdownPath(boxID, fromPath, toPath, true)
}

func moveMarkdownPath(boxID, fromPath, toPath string, allowDirectory bool) (ret *MarkdownPathMoveResult, err error) {
	box := Conf.Box(boxID)
	if nil == box {
		return nil, ErrBoxNotFound
	}
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return nil, errors.New("not a Markdown notebook")
	}
	if fromPath == toPath {
		return nil, errors.New("source and target paths are the same")
	}
	// Settle pending Markdown index work before taking the index lock. Waiting
	// for it afterwards would deadlock: the indexer needs this very lock.
	WaitMarkdownIndex()
	databaseIndexDataLock.Lock()
	defer databaseIndexDataLock.Unlock()

	root := filesys.BoxRootPath(boxID)
	fromAbs := filepath.Join(root, strings.TrimPrefix(fromPath, "/"))
	toAbs := filepath.Join(root, strings.TrimPrefix(toPath, "/"))
	info, statErr := os.Lstat(fromAbs)
	if nil != statErr {
		if errors.Is(statErr, os.ErrNotExist) {
			return nil, ErrBlockNotFound
		}
		return nil, statErr
	}
	if 0 != info.Mode()&os.ModeSymlink {
		return nil, errors.New("source Markdown path must not be a symbolic link")
	}
	directory := info.IsDir()
	if directory && !allowDirectory {
		return nil, errors.New("source Markdown path is not a regular file")
	}
	if !directory && !info.Mode().IsRegular() {
		return nil, errors.New("source Markdown path is not a regular file or directory")
	}
	if !directory && (!isMarkdownDocPath(fromPath) || !isMarkdownDocPath(toPath)) {
		return nil, errors.New("Markdown document path must end in .md or .markdown")
	}
	if directory {
		relativeTarget, relErr := filepath.Rel(fromAbs, toAbs)
		if nil == relErr && relativeTarget != ".." && !strings.HasPrefix(relativeTarget, ".."+string(filepath.Separator)) {
			return nil, errors.New("cannot move a Markdown directory into itself")
		}
	}
	if filelock.IsExist(toAbs) {
		return nil, errors.New("target Markdown path already exists")
	}
	if err = os.MkdirAll(filepath.Dir(toAbs), 0o755); nil != err {
		return nil, fmt.Errorf("create target directory: %w", err)
	}

	projections := []markdownPathMoveProjection{}
	if directory {
		walkErr := filepath.WalkDir(fromAbs, func(p string, d os.DirEntry, walkErr error) error {
			if nil != walkErr {
				return walkErr
			}
			if d.IsDir() {
				if p != fromAbs && strings.HasPrefix(d.Name(), ".") {
					return filepath.SkipDir
				}
				return nil
			}
			if !isMarkdownDocPath(p) {
				return nil
			}
			relative, relErr := filepath.Rel(fromAbs, p)
			if nil != relErr {
				return relErr
			}
			oldPath := fromPath + "/" + filepath.ToSlash(relative)
			newPath := toPath + "/" + filepath.ToSlash(relative)
			projections = append(projections, markdownPathMoveProjection{
				fromPath: oldPath, toPath: newPath,
				oldTree: treenode.GetBlockTreeRootByPath(boxID, oldPath),
			})
			return nil
		})
		if nil != walkErr {
			return nil, fmt.Errorf("scan Markdown directory: %w", walkErr)
		}
	} else {
		projections = append(projections, markdownPathMoveProjection{
			fromPath: fromPath, toPath: toPath,
			oldTree: treenode.GetBlockTreeRootByPath(boxID, fromPath),
		})
	}
	sort.Slice(projections, func(i, j int) bool { return projections[i].fromPath < projections[j].fromPath })

	if err = filelock.Rename(fromAbs, toAbs); nil != err {
		return nil, fmt.Errorf("move Markdown path: %w", err)
	}
	luteEngine := util.NewLute()
	trees := make([]*parse.Tree, 0, len(projections))
	for _, projection := range projections {
		tree, loadErr := filesys.LoadTree(boxID, projection.toPath, luteEngine)
		if nil == loadErr {
			trees = append(trees, tree)
			continue
		}
		// The index cannot safely point at a file that failed to parse. Restore
		// the original path before returning; no index mutation has happened yet.
		if rollbackErr := filelock.Rename(toAbs, fromAbs); nil != rollbackErr {
			return nil, fmt.Errorf("load moved Markdown path: %v (rollback failed: %v)", loadErr, rollbackErr)
		}
		return nil, fmt.Errorf("load moved Markdown path: %w", loadErr)
	}

	for _, projection := range projections {
		if nil == projection.oldTree {
			continue
		}
		sql.RemoveTreeQueue(boxID, projection.oldTree.RootID)
		treenode.RemoveBlockTreesByRootID(boxID, projection.oldTree.RootID)
	}
	for i, tree := range trees {
		cache.RemoveDocIAL(projections[i].fromPath)
		cache.RemoveDocIAL(projections[i].toPath)
		treenode.UpsertBlockTree(tree)
		sql.UpsertTreeQueue(tree)
	}
	sql.FlushQueue()
	ResetVirtualBlockRefCache()
	util.PushReloadFiletree()
	documents := make([]MarkdownDocMoveResult, 0, len(trees))
	for i, tree := range trees {
		util.PushReloadDoc(tree.ID)
		documents = append(documents, MarkdownDocMoveResult{
			Notebook: boxID, FromPath: projections[i].fromPath, ToPath: projections[i].toPath, ID: tree.ID,
		})
	}
	ret = &MarkdownPathMoveResult{
		Notebook: boxID, FromPath: fromPath, ToPath: toPath, Directory: directory, Documents: documents,
	}
	resetMarkdownBoxCatalog(boxID)
	return ret, nil
}
