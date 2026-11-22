package wikiindex

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestJsExtnameMatchesNode(t *testing.T) {
	for file, want := range map[string]string{"a/.gitignore": "", "a/b.MD": ".MD", "a/x.tar.gz": ".gz", "a/noext": "", "a/.lock": ""} {
		if got := jsExtname(file); got != want {
			t.Errorf("jsExtname(%q) = %q, want %q", file, got, want)
		}
	}
}

// A vault: one Git repository per partition directory, a non-Git folder
// reported and skipped, pages parsed and linked, dotfiles without extension.
func TestScanBuildsTheVault(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	root := t.TempDir()
	repo := filepath.Join(root, "private", "math")
	write := func(path, text string) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(repo, "noema.toml"), "schema = 1\nrepository_id = \"019fb6e9-5a90-779a-9784-63e211090ac7\"\n")
	write(filepath.Join(repo, "group.md"), "#+begin meta\nid: 019fb6e9-5a90-779a-9784-63e211090ac8\ntitle: Group\ndate: 2026-10-06\n#+end meta\n\nSee [[Ring]].\n")
	write(filepath.Join(repo, "ring.md"), "# Ring\n\n[[Group]] ![x](missing.png)\n")
	write(filepath.Join(repo, ".gitignore"), ".noema/\n")
	write(filepath.Join(root, "public", "loose", "note.md"), "# Loose\n")
	if out, err := exec.Command("git", "init", "-q", repo).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	idx, err := Scan(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(idx.Repositories) != 1 || idx.Repositories[0].IdentityStatus != "managed" || idx.Repositories[0].ID != "private/math" {
		t.Fatalf("repositories: %+v", idx.Repositories)
	}
	codes := map[string]bool{}
	for _, diagnostic := range idx.Diagnostics {
		codes[diagnostic.Code] = true
	}
	if !codes["non-git-directory"] {
		t.Fatalf("the non-Git folder must be reported: %+v", idx.Diagnostics)
	}
	if len(idx.Notes) != 2 {
		t.Fatalf("notes: %d", len(idx.Notes))
	}
	for _, file := range idx.Files {
		if filepath.Base(file.File) == ".gitignore" && file.Ext != "" {
			t.Fatalf(".gitignore has extension %q", file.Ext)
		}
	}
	var group, ring IndexNote
	for _, note := range idx.Notes {
		if note.Title == "Group" {
			group = note
		} else {
			ring = note
		}
	}
	if group.IdentityStatus != "managed" || group.CreatedMs == 0 || group.NamespaceSource != "repository" {
		t.Fatalf("group: %+v", group)
	}
	if ring.IdentityStatus != "provisional" || len(ring.Dependencies) != 1 || ring.Dependencies[0].Status != "missing" {
		t.Fatalf("ring: %+v", ring)
	}
	relations := Resolve([]Page{group.Page, ring.Page})
	if len(relations.Pages[0].Refs) != 1 || len(relations.Pages[1].Refs) != 1 {
		t.Fatalf("links: %+v", relations.Pages)
	}
}
