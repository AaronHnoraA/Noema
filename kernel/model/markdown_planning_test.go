package model

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/util"
)

func TestListMarkdownPlanningScansDocumentsAndMasksMetaSummary(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260825000000-planbox1"
	setupMarkdownBoxForIndexTest(t, boxID)
	mustWrite := func(path, source string) {
		abs := filepath.Join(util.DataDir, boxID, path)
		if err := os.MkdirAll(filepath.Dir(abs), 0755); nil != err {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(source), 0644); nil != err {
			t.Fatal(err)
		}
	}
	mustWrite("/alpha.md", "#+begin meta\n#+begin summary\n@@todo [example]\n#+end summary\n#+end meta\n@@todo(doing) [live]\n")
	mustWrite("/notes/beta.markdown", "@@project(active) Beta {area: product}\n")

	documents, err := ListMarkdownPlanning(boxID, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(documents) != 2 || documents[0].Path != "/alpha.md" || documents[1].Path != "/notes/beta.markdown" {
		t.Fatalf("unexpected planning documents: %+v", documents)
	}
	if len(documents[0].Nodes) != 1 || documents[0].Nodes[0].Title != "live" {
		t.Fatalf("summary example leaked into live planning: %+v", documents[0].Nodes)
	}
	if len(documents[1].Nodes) != 1 || documents[1].Nodes[0].Kind != "project" {
		t.Fatalf(".markdown planning document was not scanned: %+v", documents[1].Nodes)
	}
}

func TestListMarkdownPlanningRejectsPathEscape(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })
	boxID := "20260825000000-planbox2"
	setupMarkdownBoxForIndexTest(t, boxID)
	if _, err := ListMarkdownPlanning(boxID, "/../../outside.md"); err == nil {
		t.Fatal("expected escaped planning path to be rejected")
	}
}
