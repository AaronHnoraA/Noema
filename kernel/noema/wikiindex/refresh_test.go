package wikiindex

import (
	"database/sql"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
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

// The remembered-rows path ends exactly where a full build does, and a
// database changed by anyone else is compared row by row again.
func TestRefreshFromRememberedRowsMatchesAFullBuild(t *testing.T) {
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
	write := func(name, text string) {
		if err := os.WriteFile(filepath.Join(repo, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.md", "# Alpha\n\n[[Beta]] 中文段落\n")
	write("b.md", "# Beta\n\n[[Alpha]]\n")
	if _, err := Refresh(root, true); err != nil {
		t.Fatal(err)
	}
	write("a.md", "# Alpha renamed\n\n[[Gamma]] 新的中文\n")
	if err := os.Remove(filepath.Join(repo, "b.md")); err != nil {
		t.Fatal(err)
	}
	write("c.md", "# Gamma\n")
	if _, err := Refresh(root, false); err != nil {
		t.Fatal(err)
	}
	incremental := dumpFile(t, DatabaseFile(root))
	full := filepath.Join(t.TempDir(), "full.db")
	idx, err := Scan(root)
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite3", full)
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteDatabase(db, idx, "x"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	want := dumpFile(t, full)
	for _, table := range comparedTables {
		if table == "repository_index_state" {
			continue
		}
		if !reflect.DeepEqual(want[table], incremental[table]) {
			t.Errorf("%s differs\nwant %v\nhave %v", table, want[table], incremental[table])
		}
	}
	// Someone else writes the database: the next refresh compares it again.
	other, _ := sql.Open("sqlite3", DatabaseFile(root))
	if _, err := other.Exec("INSERT INTO tags VALUES ('stray', 'stray')"); err != nil {
		t.Fatal(err)
	}
	other.Close()
	if _, err := Refresh(root, false); err != nil {
		t.Fatal(err)
	}
	var stray int
	check, _ := sql.Open("sqlite3", DatabaseFile(root))
	defer check.Close()
	_ = check.QueryRow("SELECT count(*) FROM tags WHERE tag='stray'").Scan(&stray)
	if stray != 0 {
		t.Fatal("a row written by someone else survived the refresh")
	}
}

func dumpFile(t *testing.T, file string) map[string][]string {
	t.Helper()
	db, err := sql.Open("sqlite3", file)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	return dump(t, db)
}
