// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package model

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/util"
)

func setupMarkdownVirtualReferenceBox(tb testing.TB, documentCount int) (string, string) {
	tb.Helper()
	originalDataDir := util.DataDir
	util.DataDir = tb.TempDir()
	boxID := "virtual-reference-test"
	tb.Cleanup(func() {
		resetMarkdownBoxCatalog(boxID)
		util.DataDir = originalDataDir
	})
	boxDir := filepath.Join(util.DataDir, boxID)
	if err := os.MkdirAll(boxDir, 0o755); err != nil {
		tb.Fatal(err)
	}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Virtual reference test"
	if err := (&Box{ID: boxID}).SaveConf(boxConf); err != nil {
		tb.Fatal(err)
	}
	for index := 0; index < documentCount; index++ {
		id := fmt.Sprintf("note-%03d", index)
		title := fmt.Sprintf("Reference %03d", index)
		body := strings.Repeat("ordinary prose around Reference 000 and Alias 000. ", 32)
		if index == 0 {
			body = "The target owns itself."
		}
		source := fmt.Sprintf("---\nid: %s\ntitle: %s\naliases: (\"Alias %03d\")\n---\n# %s\n\n%s\n", id, title, index, title, body)
		if err := os.WriteFile(filepath.Join(boxDir, fmt.Sprintf("note-%03d.md", index)), []byte(source), 0o644); err != nil {
			tb.Fatal(err)
		}
	}
	return boxID, boxDir
}

func TestListMarkdownVirtualReferencesUsesSnapshotsAndInvalidatesWithCatalog(t *testing.T) {
	boxID, boxDir := setupMarkdownVirtualReferenceBox(t, 4)
	if err := os.WriteFile(filepath.Join(boxDir, "note-003.md"), []byte("---\nid: note-003\ntitle: Reference 003\n---\n[Reference 000](note-000.md) is already linked.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := ListMarkdownVirtualReferences(boxID, "note-000", false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Target == nil || result.Target.ID != "note-000" || result.ScannedDocuments != 4 {
		t.Fatalf("result = %#v", result)
	}
	if len(result.Mentions) != 2 || result.Mentions[0].Count != 64 || result.Mentions[0].Path == "" {
		t.Fatalf("mentions = %#v", result.Mentions)
	}
	result.Mentions[0].Keywords[0] = "mutated-client-copy"
	warm, err := ListMarkdownVirtualReferences(boxID, "Reference 000", false)
	if err != nil {
		t.Fatal(err)
	}
	if warm.Mentions[0].Keywords[0] != "Reference 000" {
		t.Fatalf("cached result leaked caller mutation: %#v", warm.Mentions[0])
	}

	path := "/note-001.md"
	absPath := filepath.Join(boxDir, strings.TrimPrefix(path, "/"))
	if err := os.WriteFile(absPath, []byte("---\nid: note-001\ntitle: Reference 001\n---\nNo mention remains.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	snapshot, err := loadMarkdownSnapshot(boxID, path)
	if err != nil {
		t.Fatal(err)
	}
	updateMarkdownCatalogPath(boxID, path, false, snapshot)
	updated, err := ListMarkdownVirtualReferences(boxID, "note-000", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(updated.Mentions) != 1 {
		t.Fatalf("cache was not invalidated after catalog update: %#v", updated.Mentions)
	}
}

func TestListMarkdownVirtualReferencesReturnsBoundedEmptyPayload(t *testing.T) {
	boxID, _ := setupMarkdownVirtualReferenceBox(t, 1)
	result, err := ListMarkdownVirtualReferences(boxID, "missing", false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Target != nil || len(result.Mentions) != 0 || result.TTLms != 600_000 {
		t.Fatalf("result = %#v", result)
	}
}

func BenchmarkMarkdownVirtualReferences(b *testing.B) {
	boxID, _ := setupMarkdownVirtualReferenceBox(b, 500)
	if _, err := ListMarkdownVirtualReferences(boxID, "note-000", false); err != nil {
		b.Fatal(err)
	}
	b.Run("warm-target", func(b *testing.B) {
		b.ReportAllocs()
		for range b.N {
			if _, err := ListMarkdownVirtualReferences(boxID, "note-000", false); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("cold-target-scan", func(b *testing.B) {
		b.ReportAllocs()
		catalog := catalogForMarkdownBox(boxID)
		for range b.N {
			catalog.mu.Lock()
			catalog.virtualReferences = nil
			catalog.virtualReferenceLRU = nil
			catalog.mu.Unlock()
			if _, err := ListMarkdownVirtualReferences(boxID, "note-000", false); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("restart-persistent", func(b *testing.B) {
		b.ReportAllocs()
		for range b.N {
			resetMarkdownBoxCatalog(boxID)
			if _, err := ListMarkdownVirtualReferences(boxID, "note-000", false); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("cold-source", func(b *testing.B) {
		b.ReportAllocs()
		for range b.N {
			resetMarkdownBoxCatalog(boxID)
			if err := os.Remove(markdownIndexCachePath(boxID)); err != nil && !os.IsNotExist(err) {
				b.Fatal(err)
			}
			if _, err := ListMarkdownVirtualReferences(boxID, "note-000", false); err != nil {
				b.Fatal(err)
			}
		}
	})
}
