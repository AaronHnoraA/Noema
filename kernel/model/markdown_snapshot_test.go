// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org

package model

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aaronhe/noema/kernel/util"
)

func TestMarkdownSnapshotReusesAndInvalidatesSourceProjections(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() {
		forgetMarkdownBoxSnapshots("snapshot-box")
		util.DataDir = originalDataDir
	})

	boxID, path := "snapshot-box", "/note.md"
	absPath := filepath.Join(util.DataDir, boxID, "note.md")
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(absPath, []byte("@@todo [First] {id=first}\n"), 0644); nil != err {
		t.Fatal(err)
	}
	first, err := loadMarkdownSnapshot(boxID, path)
	if nil != err {
		t.Fatal(err)
	}
	second, err := loadMarkdownSnapshot(boxID, path)
	if nil != err {
		t.Fatal(err)
	}
	if first != second {
		t.Fatal("unchanged source should reuse the immutable snapshot")
	}
	if nodes := first.planningNodes(); 1 != len(nodes) || "First" != nodes[0].Title {
		t.Fatalf("unexpected warm planning projection: %+v", nodes)
	}

	if err = os.WriteFile(absPath, []byte("@@todo [Externally changed] {id=second}\n"), 0644); nil != err {
		t.Fatal(err)
	}
	// Some filesystems have coarse write timestamps. Pin a distinct timestamp
	// so this test exercises the same stat-identity invalidation used in
	// production without relying on a sleep.
	nextTime := time.Now().Add(2 * time.Second)
	if err = os.Chtimes(absPath, nextTime, nextTime); nil != err {
		t.Fatal(err)
	}
	third, err := loadMarkdownSnapshot(boxID, path)
	if nil != err {
		t.Fatal(err)
	}
	if third == first {
		t.Fatal("external source change should invalidate the snapshot")
	}
	if nodes := third.planningNodes(); 1 != len(nodes) || "Externally changed" != nodes[0].Title {
		t.Fatalf("unexpected refreshed planning projection: %+v", nodes)
	}
}

func BenchmarkMarkdownCatalogPlanning(b *testing.B) {
	originalDataDir := util.DataDir
	util.DataDir = b.TempDir()
	boxID := "catalog-benchmark"
	b.Cleanup(func() {
		resetMarkdownBoxCatalog(boxID)
		util.DataDir = originalDataDir
	})
	boxDir := filepath.Join(util.DataDir, boxID)
	if err := os.MkdirAll(boxDir, 0755); nil != err {
		b.Fatal(err)
	}
	for index := 0; index < 200; index++ {
		source := fmt.Sprintf("# Note %d\n\n@@todo [Task %d] {id=task-%d, ddl=tomorrow}\n", index, index, index)
		if err := os.WriteFile(filepath.Join(boxDir, fmt.Sprintf("note-%03d.md", index)), []byte(source), 0644); nil != err {
			b.Fatal(err)
		}
	}
	if _, err := markdownCatalogPlanning(boxID); nil != err {
		b.Fatal(err)
	}

	b.Run("warm-incremental", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			if _, err := markdownCatalogPlanning(boxID); nil != err {
				b.Fatal(err)
			}
		}
	})
	b.Run("restart-persistent", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			resetMarkdownBoxCatalog(boxID)
			if _, err := markdownCatalogPlanning(boxID); nil != err {
				b.Fatal(err)
			}
		}
	})
	b.Run("cold-full-scan", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			resetMarkdownBoxCatalog(boxID)
			if err := os.Remove(markdownIndexCachePath(boxID)); nil != err && !os.IsNotExist(err) {
				b.Fatal(err)
			}
			if _, err := markdownCatalogPlanning(boxID); nil != err {
				b.Fatal(err)
			}
		}
	})
}

func TestMarkdownCatalogUpdatesOnlyChangedPath(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	boxID := "catalog-box"
	t.Cleanup(func() {
		resetMarkdownBoxCatalog(boxID)
		util.DataDir = originalDataDir
	})

	boxDir := filepath.Join(util.DataDir, boxID)
	if err := os.MkdirAll(boxDir, 0755); nil != err {
		t.Fatal(err)
	}
	firstPath, secondPath := "/first.md", "/second.md"
	firstAbs, secondAbs := filepath.Join(boxDir, "first.md"), filepath.Join(boxDir, "second.md")
	if err := os.WriteFile(firstAbs, []byte("@@todo [First]\n"), 0644); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(secondAbs, []byte("@@todo [Second]\n"), 0644); nil != err {
		t.Fatal(err)
	}

	documents, err := markdownCatalogPlanning(boxID)
	if nil != err || 2 != len(documents) {
		t.Fatalf("warm catalog failed: documents=%+v err=%v", documents, err)
	}
	persistent := loadMarkdownIndexCache(boxID, boxDir)
	entry := persistent.Entries[firstPath]
	if !entry.PlanningCached || 1 != len(entry.Planning) {
		t.Fatalf("planning projection was not persisted: %+v", entry)
	}
	entry.Planning[0].Title = "Persisted sentinel"
	persistent.Entries[firstPath] = entry
	if err = saveMarkdownIndexCache(boxID, persistent); nil != err {
		t.Fatal(err)
	}
	resetMarkdownBoxCatalog(boxID)
	documents, err = markdownCatalogPlanning(boxID)
	if nil != err {
		t.Fatal(err)
	}
	var persistedTitle string
	for _, document := range documents {
		if document.Path == firstPath && 1 == len(document.Nodes) {
			persistedTitle = document.Nodes[0].Title
		}
	}
	if "Persisted sentinel" != persistedTitle {
		t.Fatalf("catalog restart did not use the persisted projection: %q", persistedTitle)
	}
	if _, err = markdownCatalogProperties(boxID); nil != err {
		t.Fatal(err)
	}
	if propertyEntry := loadMarkdownIndexCache(boxID, boxDir).Entries[firstPath]; !propertyEntry.PropertiesCached {
		t.Fatalf("property projection was not persisted: %+v", propertyEntry)
	}
	if err = os.WriteFile(firstAbs, []byte("@@todo [First changed]\n"), 0644); nil != err {
		t.Fatal(err)
	}
	nextTime := time.Now().Add(2 * time.Second)
	if err = os.Chtimes(firstAbs, nextTime, nextTime); nil != err {
		t.Fatal(err)
	}
	forgetMarkdownSnapshot(boxID, firstPath)
	first, err := loadMarkdownSnapshot(boxID, firstPath)
	if nil != err {
		t.Fatal(err)
	}
	updateMarkdownCatalogPath(boxID, firstPath, false, first)
	if err = os.Remove(secondAbs); nil != err {
		t.Fatal(err)
	}
	forgetMarkdownSnapshot(boxID, secondPath)
	updateMarkdownCatalogPath(boxID, secondPath, true, nil)

	documents, err = markdownCatalogPlanning(boxID)
	if nil != err || 1 != len(documents) {
		t.Fatalf("incremental catalog failed: documents=%+v err=%v", documents, err)
	}
	if nodes := documents[0].Nodes; 1 != len(nodes) || "First changed" != nodes[0].Title {
		t.Fatalf("changed path was not refreshed: %+v", nodes)
	}
}
