// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema external markdown-box registry additions are Copyright (c) 2026
// Aaron He and distributed under the same AGPL-3.0-or-later terms.

package model

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/util"
)

const externalBoxRepositoryID = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68"

func writeExternalRepositoryFixture(t *testing.T, root, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0755); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "noema.toml"), []byte("schema = 1\nrepository_id = \""+externalBoxRepositoryID+"\"\n"), 0644); nil != err {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "notes"), 0755); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "notes", "page.md"), []byte(body), 0644); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "ignored.md"), []byte("must not be indexed"), 0644); nil != err {
		t.Fatal(err)
	}
}

func TestRegisterExternalMarkdownBoxKeepsRepositoryInPlace(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = filepath.Join(t.TempDir(), "data")
	t.Cleanup(func() { util.DataDir = originalDataDir })

	repositoryRoot := filepath.Join(t.TempDir(), "knowledge")
	const source = "#+begin meta\nid: 0198fc34-7b32-7a11-8cb4-6c40e3b33d69\n#+end meta\n\n# External\n"
	writeExternalRepositoryFixture(t, repositoryRoot, source)

	registration, err := RegisterExternalMarkdownBox("Knowledge", repositoryRoot, "")
	if nil != err {
		t.Fatal(err)
	}
	resolvedRoot, err := filepath.EvalSymlinks(repositoryRoot)
	if nil != err {
		t.Fatal(err)
	}
	if got := filesys.BoxRootPath(registration.ID); got != resolvedRoot {
		t.Fatalf("external root routing mismatch: got %s want %s", got, resolvedRoot)
	}
	if got := GetBoxKind(registration.ID); conf.BoxKindMarkdown != got {
		t.Fatalf("registered box kind mismatch: got %s", got)
	}
	shadowConf := filepath.Join(util.DataDir, registration.ID, ".siyuan", "conf.json")
	if _, err = os.Stat(shadowConf); nil != err {
		t.Fatalf("shadow configuration was not created: %v", err)
	}
	if _, err = os.Stat(filepath.Join(resolvedRoot, ".siyuan")); !os.IsNotExist(err) {
		t.Fatalf("registration must not create .siyuan in the repository, stat err=%v", err)
	}

	markdown, _, err := LoadMarkdownDoc(registration.ID, "/notes/page.md")
	if nil != err {
		t.Fatal(err)
	}
	if markdown != source {
		t.Fatalf("external Markdown load mismatch: got %q want %q", markdown, source)
	}
	docs, err := ListMarkdownDocs(registration.ID)
	if nil != err {
		t.Fatal(err)
	}
	if 1 != len(docs) || "/notes/page.md" != docs[0].Path {
		t.Fatalf("external document listing leaked metadata or missed the page: %#v", docs)
	}

	list, err := ListExternalMarkdownBoxes()
	if nil != err {
		t.Fatal(err)
	}
	if 1 != len(list) || list[0].ID != registration.ID || list[0].RepositoryID != externalBoxRepositoryID {
		t.Fatalf("unexpected external registry: %#v", list)
	}
}

func TestExternalMarkdownBoxInfoCountsMarkdownDocuments(t *testing.T) {
	originalDataDir := util.DataDir
	originalConf := Conf
	const testLang = "external-markdown-box-info-test"
	originalTimeLang, hadTimeLang := util.TimeLangs[testLang]
	util.TimeLangs[testLang] = map[string]any{
		"albl": "ago", "blbl": "from now", "now": "now", "1s": "1 second %s", "xs": "%d seconds %s",
		"1m": "1 minute %s", "xm": "%d minutes %s", "1h": "1 hour %s", "xh": "%d hours %s", "1d": "1 day %s",
		"xd": "%d days %s", "1w": "1 week %s", "xw": "%d weeks %s", "1M": "1 month %s", "xM": "%d months %s",
		"1y": "1 year %s", "2y": "2 years %s", "xy": "%d years %s", "max": "a long while %s",
	}
	util.DataDir = filepath.Join(t.TempDir(), "data")
	Conf = NewAppConf()
	Conf.Lang = testLang
	t.Cleanup(func() {
		util.DataDir = originalDataDir
		Conf = originalConf
		if hadTimeLang {
			util.TimeLangs[testLang] = originalTimeLang
		} else {
			delete(util.TimeLangs, testLang)
		}
	})

	repositoryRoot := filepath.Join(t.TempDir(), "knowledge")
	const pageSource = "# Page\n"
	writeExternalRepositoryFixture(t, repositoryRoot, pageSource)
	const appendixSource = "# Appendix\n\nPortable notes.\n"
	appendixPath := filepath.Join(repositoryRoot, "notes", "appendix.markdown")
	if err := os.WriteFile(appendixPath, []byte(appendixSource), 0644); nil != err {
		t.Fatal(err)
	}
	latest := time.Now().Add(time.Minute).Truncate(time.Second)
	if err := os.Chtimes(appendixPath, latest, latest); nil != err {
		t.Fatal(err)
	}
	hiddenPath := filepath.Join(repositoryRoot, ".git", "ignored.md")
	if err := os.Chtimes(hiddenPath, latest.Add(time.Hour), latest.Add(time.Hour)); nil != err {
		t.Fatal(err)
	}

	registration, err := RegisterExternalMarkdownBox("Knowledge", repositoryRoot, "")
	if nil != err {
		t.Fatal(err)
	}
	info := (&Box{ID: registration.ID, Name: registration.Name}).GetInfo()
	if 2 != info.DocCount {
		t.Fatalf("external Markdown document count mismatch: got %d want 2", info.DocCount)
	}
	wantSize := uint64(len(pageSource) + len(appendixSource))
	if wantSize != info.Size {
		t.Fatalf("external Markdown document size mismatch: got %d want %d", info.Size, wantSize)
	}
	if latest.Unix() != info.Mtime {
		t.Fatalf("external Markdown modification time mismatch: got %d want %d", info.Mtime, latest.Unix())
	}
}

func TestRegisterExternalMarkdownBoxReusesRepositoryIdentityAfterMove(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = filepath.Join(t.TempDir(), "data")
	t.Cleanup(func() { util.DataDir = originalDataDir })

	firstRoot := filepath.Join(t.TempDir(), "first")
	secondRoot := filepath.Join(t.TempDir(), "second")
	writeExternalRepositoryFixture(t, firstRoot, "# First\n")
	writeExternalRepositoryFixture(t, secondRoot, "# Second\n")

	first, err := RegisterExternalMarkdownBox("First", firstRoot, externalBoxRepositoryID)
	if nil != err {
		t.Fatal(err)
	}
	second, err := RegisterExternalMarkdownBox("Moved", secondRoot, externalBoxRepositoryID)
	if nil != err {
		t.Fatal(err)
	}
	if first.ID != second.ID {
		t.Fatalf("moved repository allocated a new internal box: first=%s second=%s", first.ID, second.ID)
	}
	resolvedSecondRoot, err := filepath.EvalSymlinks(secondRoot)
	if nil != err {
		t.Fatal(err)
	}
	if got := GetBoxRoot(first.ID); got != resolvedSecondRoot {
		t.Fatalf("repository move did not update routed root: got %s want %s", got, resolvedSecondRoot)
	}
	markdown, _, err := LoadMarkdownDoc(first.ID, "/notes/page.md")
	if nil != err {
		t.Fatal(err)
	}
	if !strings.Contains(markdown, "Second") {
		t.Fatalf("box still reads the old repository after move: %q", markdown)
	}
}

func TestRegisterExternalMarkdownBoxRejectsIdentityMismatch(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = filepath.Join(t.TempDir(), "data")
	t.Cleanup(func() { util.DataDir = originalDataDir })

	repositoryRoot := filepath.Join(t.TempDir(), "mismatch")
	writeExternalRepositoryFixture(t, repositoryRoot, "# Mismatch\n")
	_, err := RegisterExternalMarkdownBox("Mismatch", repositoryRoot, "0198fc34-7b32-7a11-8cb4-6c40e3b33d70")
	if nil == err || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("expected manifest/request identity mismatch, got %v", err)
	}
}
