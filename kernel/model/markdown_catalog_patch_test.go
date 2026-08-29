// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package model

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/aaronhe/noema/kernel/util"
)

// catalogPatchBox writes a small vault whose notes reference each other in a
// ring, so every note has both a ref and a backlink to check.
func catalogPatchBox(t *testing.T, notes int) (boxID, boxDir string) {
	t.Helper()
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	boxID = "catalog-patch-test"
	t.Cleanup(func() {
		resetMarkdownBoxCatalog(boxID)
		util.DataDir = originalDataDir
	})
	boxDir = filepath.Join(util.DataDir, boxID)
	if err := os.MkdirAll(boxDir, 0o755); nil != err {
		t.Fatal(err)
	}
	for index := 0; index < notes; index++ {
		next := (index + 1) % notes
		source := fmt.Sprintf(
			"---\nid: note-%03d\ntitle: Note %03d\naliases: alias-%03d\ntags: graph\n---\n# Note %03d\n\nSee [next](roam://note-%03d).\n",
			index, index, index, index, next)
		if err := os.WriteFile(filepath.Join(boxDir, fmt.Sprintf("note-%03d.md", index)), []byte(source), 0o644); nil != err {
			t.Fatal(err)
		}
	}
	return boxID, boxDir
}

func catalogNotesOrFail(t *testing.T, boxID string) MarkdownNoteCatalog {
	t.Helper()
	catalog, err := markdownCatalogNotes(boxID)
	if nil != err {
		t.Fatalf("catalog read failed: %s", err)
	}
	return catalog
}

// TestMarkdownCatalogPatchMatchesFullResolve is the contract the incremental
// path has to hold: after an edit, a patched catalog must be indistinguishable
// from one resolved from scratch. Notes, refs, backlinks and directories all
// participate, because the patch touches all four.
func TestMarkdownCatalogPatchMatchesFullResolve(t *testing.T) {
	for _, edit := range []struct {
		name   string
		source string
	}{
		{
			// Body-only edit: the ref target is unchanged, so the fast path
			// must be taken and must change nothing but the note itself.
			name:   "prose only",
			source: "---\nid: note-002\ntitle: Note 002\naliases: alias-002\ntags: graph\n---\n# Note 002\n\nSee [next](roam://note-003).\n\nAn extra paragraph.\n",
		},
		{
			// Ref retargeted: note-003 loses a backlink, note-005 gains one.
			name:   "ref retargeted",
			source: "---\nid: note-002\ntitle: Note 002\naliases: alias-002\ntags: graph\n---\n# Note 002\n\nSee [other](roam://note-005).\n",
		},
		{
			name:   "ref removed",
			source: "---\nid: note-002\ntitle: Note 002\naliases: alias-002\ntags: graph\n---\n# Note 002\n\nNo links at all.\n",
		},
		{
			// Identity keys change, so the whole vault's ref index moves and the
			// patch has to decline. The result must still be correct.
			name:   "title changed",
			source: "---\nid: note-002\ntitle: Renamed 002\naliases: alias-002\ntags: graph\n---\n# Renamed 002\n\nSee [next](roam://note-003).\n",
		},
		{
			name:   "alias added",
			source: "---\nid: note-002\ntitle: Note 002\naliases: alias-002 extra-002\ntags: graph\n---\n# Note 002\n\nSee [next](roam://note-003).\n",
		},
	} {
		t.Run(edit.name, func(t *testing.T) {
			boxID, boxDir := catalogPatchBox(t, 8)
			catalogNotesOrFail(t, boxID)

			path := "/note-002.md"
			if err := os.WriteFile(filepath.Join(boxDir, "note-002.md"), []byte(edit.source), 0o644); nil != err {
				t.Fatal(err)
			}
			forgetMarkdownBoxSnapshots(boxID)
			updateMarkdownCatalogPath(boxID, path, false, nil)
			patched := catalogNotesOrFail(t, boxID)

			resetMarkdownBoxCatalog(boxID)
			full := catalogNotesOrFail(t, boxID)

			if !reflect.DeepEqual(patched.Notes, full.Notes) {
				for index := range full.Notes {
					if index < len(patched.Notes) && !reflect.DeepEqual(patched.Notes[index], full.Notes[index]) {
						t.Fatalf("note %d differs\n patched: %+v\n    full: %+v",
							index, patched.Notes[index], full.Notes[index])
					}
				}
				t.Fatalf("note count differs: patched %d, full %d", len(patched.Notes), len(full.Notes))
			}
			if !reflect.DeepEqual(patched.Directories, full.Directories) {
				t.Fatalf("directories differ\n patched: %+v\n    full: %+v", patched.Directories, full.Directories)
			}
		})
	}
}

// TestMarkdownCatalogPatchTakesFastPath locks in that an ordinary content edit
// actually uses the incremental path — a patch that silently always declined
// would still pass the equivalence test above while costing a full re-resolve
// per keystroke, which is the regression this exists to prevent.
func TestMarkdownCatalogPatchTakesFastPath(t *testing.T) {
	boxID, boxDir := catalogPatchBox(t, 8)
	catalogNotesOrFail(t, boxID)

	catalog := catalogForMarkdownBox(boxID)
	catalog.mu.RLock()
	before := catalog.noteOrdered
	catalog.mu.RUnlock()
	if nil == before {
		t.Fatal("expected a resolved catalog before the edit")
	}

	source := "---\nid: note-002\ntitle: Note 002\naliases: alias-002\ntags: graph\n---\n# Note 002\n\nSee [next](roam://note-003).\n\nMore prose.\n"
	if err := os.WriteFile(filepath.Join(boxDir, "note-002.md"), []byte(source), 0o644); nil != err {
		t.Fatal(err)
	}
	forgetMarkdownBoxSnapshots(boxID)
	updateMarkdownCatalogPath(boxID, "/note-002.md", false, nil)

	catalog.mu.RLock()
	after := catalog.noteOrdered
	catalog.mu.RUnlock()
	if nil == after {
		t.Fatal("a prose-only edit invalidated the resolved catalog instead of patching it")
	}
}

// TestMarkdownNoteRefIndexIsStable guards the determinism the patch relies on:
// two notes may claim the same canonical reference key, and the winner must not
// depend on Go's map iteration order.
func TestMarkdownNoteRefIndexIsStable(t *testing.T) {
	unique := map[string]MarkdownNoteSummary{
		"beta":  {ID: "beta", Key: "beta", Title: "Shared Title", Path: "beta.md", Link: "beta.md"},
		"alpha": {ID: "alpha", Key: "alpha", Title: "Shared Title", Path: "alpha.md", Link: "alpha.md"},
		"gamma": {ID: "gamma", Key: "gamma", Title: "Shared Title", Path: "gamma.md", Link: "gamma.md"},
	}
	first := markdownNoteRefIndex(unique)
	for i := 0; i < 32; i++ {
		if !reflect.DeepEqual(first, markdownNoteRefIndex(unique)) {
			t.Fatal("ref index winner changed between builds")
		}
	}
	key := canonicalMarkdownNoteRef("Shared Title")
	if got := first[key]; got != "alpha" {
		t.Fatalf("expected the lowest id to claim a contested key, got %q", got)
	}
}
