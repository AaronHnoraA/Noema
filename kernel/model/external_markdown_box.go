// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema external markdown-box registry additions are Copyright (c) 2026
// Aaron He and distributed under the same AGPL-3.0-or-later terms.

package model

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/88250/lute/ast"
	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/util"
)

var (
	repositoryManifestIDPattern = regexp.MustCompile(`(?m)^\s*repository_id\s*=\s*["']([^"']+)["']\s*(?:#.*)?$`)
	externalRepositoryUUIDV7    = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
)

// ExternalMarkdownBox describes a shadow registration. The physical
// repository contains no SiYuan configuration; Root and RepositoryID are
// persisted under <DataDir>/<internal box ID>/.siyuan/conf.json.
type ExternalMarkdownBox struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Root         string `json:"root"`
	RepositoryID string `json:"repositoryId,omitempty"`
}

// GetBoxRoot is injected into filesys.BoxRootProvider. Returning an empty
// string delegates normal boxes to filesys' <DataDir>/<boxID> fallback.
func GetBoxRoot(boxID string) string {
	boxConf := (&Box{ID: boxID}).GetConf()
	if conf.BoxKindMarkdown != boxConf.Kind || "" == strings.TrimSpace(boxConf.Root) {
		return ""
	}
	if !filepath.IsAbs(boxConf.Root) {
		return ""
	}
	return filepath.Clean(boxConf.Root)
}

func repositoryIdentityAtRoot(root string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(root, "noema.toml"))
	if nil != err {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		return "", fmt.Errorf("read noema.toml: %w", err)
	}
	match := repositoryManifestIDPattern.FindSubmatch(raw)
	if nil == match {
		return "", nil
	}
	id := strings.ToLower(strings.TrimSpace(string(match[1])))
	if !externalRepositoryUUIDV7.MatchString(id) {
		return "", fmt.Errorf("noema.toml repository_id must be a UUIDv7")
	}
	return id, nil
}

func normalizedExternalRoot(root string) (string, error) {
	root = strings.TrimSpace(root)
	if "" == root {
		return "", errors.New("external markdown root is required")
	}
	absRoot, err := filepath.Abs(root)
	if nil != err {
		return "", fmt.Errorf("resolve external markdown root: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(absRoot)
	if nil != err {
		return "", fmt.Errorf("resolve external markdown root: %w", err)
	}
	info, err := os.Stat(resolved)
	if nil != err {
		return "", fmt.Errorf("stat external markdown root: %w", err)
	}
	if !info.IsDir() {
		return "", errors.New("external markdown root must be a directory")
	}
	return filepath.Clean(resolved), nil
}

// RegisterExternalMarkdownBox registers a Git/wiki repository in place. It
// never copies content and never creates .siyuan inside root. If repositoryID
// is omitted, a managed noema.toml is consulted; an unmanaged repository is
// still allowed and is deduplicated by its resolved path.
//
// A matching portable repository UUID updates the existing registration's
// root, so moving a clone does not allocate a new internal box identity.
func RegisterExternalMarkdownBox(name, root, repositoryID string) (ret *ExternalMarkdownBox, err error) {
	root, err = normalizedExternalRoot(root)
	if nil != err {
		return nil, err
	}

	manifestID, err := repositoryIdentityAtRoot(root)
	if nil != err {
		return nil, err
	}
	repositoryID = strings.ToLower(strings.TrimSpace(repositoryID))
	if "" != repositoryID && !externalRepositoryUUIDV7.MatchString(repositoryID) {
		return nil, errors.New("repository ID must be a UUIDv7")
	}
	if "" != manifestID {
		if "" != repositoryID && repositoryID != manifestID {
			return nil, errors.New("repository ID does not match noema.toml")
		}
		repositoryID = manifestID
	}

	if "" == strings.TrimSpace(name) {
		name = filepath.Base(root)
	}
	name = normalizeBoxName(name)

	if err = os.MkdirAll(util.DataDir, 0755); nil != err {
		return nil, fmt.Errorf("create box registry root: %w", err)
	}
	boxes, listErr := ListNotebooks()
	if nil != listErr && !errors.Is(listErr, os.ErrNotExist) {
		return nil, listErr
	}
	for _, existing := range boxes {
		boxConf := existing.GetConf()
		if conf.BoxKindMarkdown != boxConf.Kind || "" == boxConf.Root {
			continue
		}
		sameRepository := "" != repositoryID && strings.EqualFold(repositoryID, boxConf.RepositoryID)
		sameRoot := filepath.Clean(boxConf.Root) == root
		if !sameRepository && !sameRoot {
			continue
		}
		boxConf.Name = name
		boxConf.Root = root
		boxConf.RepositoryID = repositoryID
		if err = existing.SaveConf(boxConf); nil != err {
			return nil, err
		}
		return &ExternalMarkdownBox{ID: existing.ID, Name: name, Root: root, RepositoryID: repositoryID}, nil
	}

	id := ast.NewNodeID()
	box := &Box{ID: id, Name: name}
	boxConf := conf.NewBoxConf()
	boxConf.Name = name
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Root = root
	boxConf.RepositoryID = repositoryID
	if err = box.SaveConf(boxConf); nil != err {
		_ = os.RemoveAll(filepath.Join(util.DataDir, id))
		return nil, err
	}
	return &ExternalMarkdownBox{ID: id, Name: name, Root: root, RepositoryID: repositoryID}, nil
}

// ListExternalMarkdownBoxes returns only shadow registrations and never scans
// or mutates the external repositories themselves.
func ListExternalMarkdownBoxes() (ret []*ExternalMarkdownBox, err error) {
	boxes, err := ListNotebooks()
	if nil != err {
		return nil, err
	}
	for _, box := range boxes {
		boxConf := box.GetConf()
		if conf.BoxKindMarkdown != boxConf.Kind || "" == strings.TrimSpace(boxConf.Root) {
			continue
		}
		ret = append(ret, &ExternalMarkdownBox{
			ID:           box.ID,
			Name:         boxConf.Name,
			Root:         filepath.Clean(boxConf.Root),
			RepositoryID: boxConf.RepositoryID,
		})
	}
	return ret, nil
}

// PruneMissingExternalMarkdownBoxes removes shadow registrations whose
// physical repository root no longer exists. Roots that merely fail with a
// permission or transient I/O error are retained: absence is the only safe
// automatic cleanup signal. keepIDs protects registrations that have just
// been rebound (for example, a portable repository moved to a new path).
//
// Removing a registration never removes the external repository. RemoveBox
// recognizes external Markdown shadows and deletes only their workspace
// metadata and indexes.
func PruneMissingExternalMarkdownBoxes(keepIDs ...string) (ret []*ExternalMarkdownBox, err error) {
	keep := make(map[string]struct{}, len(keepIDs))
	for _, id := range keepIDs {
		if id = strings.TrimSpace(id); "" != id {
			keep[id] = struct{}{}
		}
	}

	boxes, err := ListExternalMarkdownBoxes()
	if nil != err {
		return nil, err
	}
	var pruneErrors []error
	for _, box := range boxes {
		if _, ok := keep[box.ID]; ok {
			continue
		}
		if _, statErr := os.Stat(box.Root); nil == statErr || !errors.Is(statErr, os.ErrNotExist) {
			continue
		}
		if removeErr := RemoveBox(box.ID); nil != removeErr {
			pruneErrors = append(pruneErrors, fmt.Errorf("remove stale external Markdown box [%s]: %w", box.ID, removeErr))
			continue
		}
		ret = append(ret, box)
	}
	return ret, errors.Join(pruneErrors...)
}
