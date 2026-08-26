// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema Markdown snapshot cache additions are Copyright (c) 2026 Aaron He
// and distributed under the same AGPL-3.0-or-later terms.

package model

import (
	"os"
	"path/filepath"
	"sync"

	"github.com/88250/lute/parse"
	"github.com/aaronhe/noema/kernel/filesys"
	noemamarkdown "github.com/aaronhe/noema/kernel/noema/markdown"
	noemaplanning "github.com/aaronhe/noema/kernel/noema/planning"
	"github.com/aaronhe/noema/kernel/util"
)

// markdownSnapshot is the Go equivalent of the Node host's immutable note
// snapshot: one source read fans out into planning, property and block-tree
// projections. The filesystem identity is checked before every lookup, so an
// Emacs/git write cannot be hidden by the cache.
type markdownSnapshot struct {
	source      []byte
	versionOnce sync.Once
	version     string
	mtimeNs     int64
	mtimeMs     float64
	size        int64

	planningOnce      sync.Once
	planning          []noemaplanning.Node
	propertyOnce      sync.Once
	property          noemamarkdown.Projection
	noteOnce          sync.Once
	note              MarkdownNoteSummary
	workspaceNoteOnce sync.Once
	workspaceNote     MarkdownWorkspaceNote
	virtualNoteOnce   sync.Once
	virtualNote       MarkdownVirtualReferenceNote
	treeOnce          sync.Once
	tree              *parse.Tree

	// blockRefs is the API-facing block list for this source. Carrying it on
	// the snapshot lets the next save reuse it when its signature shows the
	// document's anchors and anchored lines are unchanged, which is what keeps
	// the CommonMark parse off the save response path.
	blockRefSignature uint64
	blockRefs         []MarkdownBlockRef
}

var markdownSnapshots sync.Map // boxID\x00/path -> *markdownSnapshot

func markdownPlanningVersion(source []byte) string {
	return markdownDocVersion(source)
}

func markdownSnapshotKey(boxID, path string) string {
	return boxID + "\x00" + filepath.ToSlash(path)
}

func newMarkdownSnapshot(source []byte, info os.FileInfo) *markdownSnapshot {
	ret := &markdownSnapshot{
		source: source,
		size:   int64(len(source)),
	}
	if nil != info {
		ret.mtimeNs = info.ModTime().UnixNano()
		ret.mtimeMs = float64(ret.mtimeNs) / 1e6
		ret.size = info.Size()
	}
	return ret
}

func (snapshot *markdownSnapshot) sourceVersion() string {
	snapshot.versionOnce.Do(func() { snapshot.version = markdownPlanningVersion(snapshot.source) })
	return snapshot.version
}

func (snapshot *markdownSnapshot) workspaceNoteSummary(boxID, path string) MarkdownWorkspaceNote {
	snapshot.workspaceNoteOnce.Do(func() {
		snapshot.workspaceNote = markdownWorkspaceNoteFromSnapshot(boxID, path, snapshot)
	})
	return cloneMarkdownWorkspaceNote(snapshot.workspaceNote)
}

func (snapshot *markdownSnapshot) virtualReferenceNoteSummary(boxID, path string) MarkdownVirtualReferenceNote {
	snapshot.virtualNoteOnce.Do(func() {
		snapshot.virtualNote = markdownVirtualReferenceNoteFromSnapshot(boxID, path, snapshot)
	})
	return cloneMarkdownVirtualReferenceNote(snapshot.virtualNote)
}

func loadMarkdownSnapshot(boxID, path string) (*markdownSnapshot, error) {
	key := markdownSnapshotKey(boxID, path)
	absPath := filepath.Join(filesys.BoxRootPath(boxID), path)
	for attempt := 0; attempt < 2; attempt++ {
		before, err := os.Stat(absPath)
		if nil != err {
			markdownSnapshots.Delete(key)
			return nil, err
		}
		if cached, ok := markdownSnapshots.Load(key); ok {
			snapshot := cached.(*markdownSnapshot)
			if snapshot.mtimeNs == before.ModTime().UnixNano() && snapshot.size == before.Size() {
				return snapshot, nil
			}
		}

		source, err := os.ReadFile(absPath)
		if nil != err {
			return nil, err
		}
		after, err := os.Stat(absPath)
		if nil != err {
			return nil, err
		}
		if before.ModTime().UnixNano() != after.ModTime().UnixNano() || before.Size() != after.Size() {
			continue
		}
		snapshot := newMarkdownSnapshot(source, after)
		markdownSnapshots.Store(key, snapshot)
		return snapshot, nil
	}

	// The file changed during both optimistic reads. One final read returns a
	// coherent byte slice; the following lookup will revalidate its metadata.
	source, err := os.ReadFile(absPath)
	if nil != err {
		return nil, err
	}
	info, err := os.Stat(absPath)
	if nil != err {
		return nil, err
	}
	snapshot := newMarkdownSnapshot(source, info)
	markdownSnapshots.Store(key, snapshot)
	return snapshot, nil
}

func rememberMarkdownSnapshot(boxID, path string, source []byte, tree *parse.Tree) *markdownSnapshot {
	info, _ := os.Stat(filepath.Join(filesys.BoxRootPath(boxID), path))
	snapshot := newMarkdownSnapshot(source, info)
	if nil != tree {
		snapshot.treeOnce.Do(func() { snapshot.tree = tree })
	}
	markdownSnapshots.Store(markdownSnapshotKey(boxID, path), snapshot)
	return snapshot
}

func forgetMarkdownSnapshot(boxID, path string) {
	markdownSnapshots.Delete(markdownSnapshotKey(boxID, path))
}

func forgetMarkdownBoxSnapshots(boxID string) {
	prefix := boxID + "\x00"
	markdownSnapshots.Range(func(key, _ any) bool {
		if value, ok := key.(string); ok && len(value) >= len(prefix) && value[:len(prefix)] == prefix {
			markdownSnapshots.Delete(key)
		}
		return true
	})
}

func (snapshot *markdownSnapshot) planningNodes() []noemaplanning.Node {
	snapshot.planningOnce.Do(func() {
		snapshot.planning = noemaplanning.ScanDocument(string(snapshot.source), "")
	})
	return snapshot.planning
}

func (snapshot *markdownSnapshot) propertyProjection() noemamarkdown.Projection {
	snapshot.propertyOnce.Do(func() {
		snapshot.property = noemamarkdown.Scan(snapshot.source)
	})
	return snapshot.property
}

func (snapshot *markdownSnapshot) noteSummary(boxID, path string) MarkdownNoteSummary {
	snapshot.noteOnce.Do(func() {
		snapshot.note = markdownNoteFromSnapshot(boxID, path, snapshot)
	})
	return cloneMarkdownNoteSummary(snapshot.note)
}

func (snapshot *markdownSnapshot) blockTree(boxID, path string) *parse.Tree {
	snapshot.treeOnce.Do(func() {
		snapshot.tree = filesys.LoadMarkdownTreeByData(snapshot.source, boxID, path, util.NewLute())
	})
	return snapshot.tree
}
