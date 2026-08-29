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
	"sync"

	"github.com/88250/lute/ast"
	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/siyuan-note/logging"
)

var (
	repositoryManifestIDPattern  = regexp.MustCompile(`(?m)^\s*repository_id\s*=\s*["']([^"']+)["']\s*(?:#.*)?$`)
	externalRepositoryUUIDV7     = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	externalMarkdownRegistryLock sync.Mutex
	externalMarkdownDeactivating sync.Map
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
	return loadBoxStorageRoute(boxID).root
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
	externalMarkdownRegistryLock.Lock()
	defer externalMarkdownRegistryLock.Unlock()

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

// DeactivateMissingExternalMarkdownBox closes one open external Markdown
// registration after its physical root is proven absent. The shadow metadata
// remains in the workspace so a portable repository ID can rebind to a moved
// clone later; only the watcher, in-memory catalog and disposable indexes are
// retired. No external content is removed.
func DeactivateMissingExternalMarkdownBox(boxID string) (ret *ExternalMarkdownBox, deactivated bool, err error) {
	externalMarkdownRegistryLock.Lock()
	defer externalMarkdownRegistryLock.Unlock()

	box := (&Box{ID: boxID})
	boxConf := box.GetConf()
	root := strings.TrimSpace(boxConf.Root)
	if conf.BoxKindMarkdown != boxConf.Kind || "" == root || boxConf.Closed {
		return nil, false, nil
	}
	if _, statErr := os.Stat(root); nil == statErr || !errors.Is(statErr, os.ErrNotExist) {
		return nil, false, nil
	}

	// Persist the lifecycle transition before releasing runtime resources. If
	// the workspace metadata cannot be written, leaving the current runtime
	// state intact makes the failure visible and retryable on the next event.
	boxConf.Closed = true
	if err = box.SaveConf(boxConf); nil != err {
		return nil, false, fmt.Errorf("close missing external Markdown box [%s]: %w", boxID, err)
	}
	CloseWatchMarkdownBox(boxID)
	// Use the normal event-driven index queue. Its consumer is notified by the
	// append and removes both blocktree and SQL projections without introducing
	// a lifecycle poller.
	box.Unindex()

	evt := util.NewCmdResult("closeBox", 0, util.PushModeBroadcast)
	evt.Data = map[string]any{"box": boxID, "reason": "external-root-missing"}
	util.PushEvent(evt)
	return &ExternalMarkdownBox{
		ID: boxID, Name: boxConf.Name, Root: filepath.Clean(root), RepositoryID: boxConf.RepositoryID,
	}, true, nil
}

// DeactivateMissingExternalMarkdownBoxes is a one-shot lifecycle
// reconciliation used at kernel boot. It has no ticker: later disappearances
// are driven by fsnotify or by an actual Markdown access failure.
func DeactivateMissingExternalMarkdownBoxes() (ret []*ExternalMarkdownBox, err error) {
	boxes, err := ListExternalMarkdownBoxes()
	if nil != err {
		return nil, err
	}
	var deactivateErrors []error
	for _, box := range boxes {
		closed, deactivated, deactivateErr := DeactivateMissingExternalMarkdownBox(box.ID)
		if nil != deactivateErr {
			deactivateErrors = append(deactivateErrors, deactivateErr)
			continue
		}
		if deactivated {
			ret = append(ret, closed)
		}
	}
	return ret, errors.Join(deactivateErrors...)
}

// ScheduleMissingExternalMarkdownBoxDeactivation coalesces access/fsnotify
// signals. The worker re-stats the current registered root under the registry
// lock, so a repository rebound to a live path can never be closed by a stale
// event from its previous location.
func ScheduleMissingExternalMarkdownBoxDeactivation(boxID string) {
	if _, loaded := externalMarkdownDeactivating.LoadOrStore(boxID, struct{}{}); loaded {
		return
	}
	go func() {
		defer externalMarkdownDeactivating.Delete(boxID)
		box, deactivated, deactivateErr := DeactivateMissingExternalMarkdownBox(boxID)
		if nil != deactivateErr {
			logging.LogWarnf("deactivate missing external Markdown box [%s] failed: %s", boxID, deactivateErr)
			return
		}
		if deactivated {
			logging.LogInfof("closed external Markdown box [%s] after root disappeared [%s]", box.ID, box.Root)
		}
	}()
}

// ensureExternalMarkdownBoxRootAvailable guards write paths from silently
// recreating a deleted external repository root. The failed access itself is
// the lifecycle event; cleanup runs asynchronously so callers receive ENOENT
// immediately without blocking on index teardown.
func ensureExternalMarkdownBoxRootAvailable(boxID string) error {
	boxConf := (&Box{ID: boxID}).GetConf()
	root := strings.TrimSpace(boxConf.Root)
	if conf.BoxKindMarkdown != boxConf.Kind || "" == root {
		return nil
	}
	info, err := os.Stat(root)
	if nil == err {
		if !info.IsDir() {
			return fmt.Errorf("external Markdown root [%s] is not a directory", root)
		}
		return nil
	}
	if errors.Is(err, os.ErrNotExist) {
		ScheduleMissingExternalMarkdownBoxDeactivation(boxID)
	}
	return fmt.Errorf("external Markdown root [%s] is unavailable: %w", root, err)
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
