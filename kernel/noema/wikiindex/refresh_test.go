package wikiindex

import (
	"database/sql"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestRefreshBuildsThenUpdatesInPlace(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	root := t.TempDir()
	repo := filepath.Join(root, "private", "math")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("git", "init", "-q", repo).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	note := filepath.Join(repo, "a.md")
	if err := os.WriteFile(note, []byte("# Alpha\n\n[[Beta]]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	first, err := Refresh(root, false)
	if err != nil {
		t.Fatal(err)
	}
	if first.Mode != "full" || first.Reason != "no-db" || first.Pages != 1 {
		t.Fatalf("first refresh: %+v", first)
	}
	if err := os.WriteFile(filepath.Join(repo, "b.md"), []byte("# Beta\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	second, err := Refresh(root, false)
	if err != nil {
		t.Fatal(err)
	}
	if second.Mode != "incremental" || second.Pages != 2 || second.Changed == 0 {
		t.Fatalf("second refresh: %+v", second)
	}
	third, err := Refresh(root, false)
	if err != nil {
		t.Fatal(err)
	}
	if third.Changed != 0 {
		t.Fatalf("an unchanged vault changed %d rows", third.Changed)
	}
	db, err := sql.Open("sqlite3", DatabaseFile(root))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var status string
	if err := db.QueryRow("SELECT status FROM links WHERE raw_target='Beta'").Scan(&status); err != nil || status != "resolved" {
		t.Fatalf("the link to the new page: %q %v", status, err)
	}
	var check string
	_ = db.QueryRow("PRAGMA integrity_check").Scan(&check)
	if check != "ok" {
		t.Fatal(check)
	}
}
