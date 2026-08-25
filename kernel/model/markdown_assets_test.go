package model

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/util"
)

func setupMarkdownAssetTest(t *testing.T) string {
	t.Helper()
	oldDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = oldDataDir })
	boxID := "20260825220000-assets01"
	box := &Box{ID: boxID}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	if err := box.SaveConf(boxConf); err != nil {
		t.Fatal(err)
	}
	return boxID
}

func TestStoreMarkdownAssetBytesUsesNoteLocalImageFolderAndUniqueName(t *testing.T) {
	boxID := setupMarkdownAssetTest(t)
	first, err := StoreMarkdownAssetBytes(boxID, "/project/My Note.md", "plot image.png", "image/png", []byte("one"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := StoreMarkdownAssetBytes(boxID, "/project/My Note.md", "plot image.png", "image/png", []byte("two"))
	if err != nil {
		t.Fatal(err)
	}
	if first.MarkdownPath != "./images/My-Note/plot-image.png" || second.MarkdownPath != "./images/My-Note/plot-image-2.png" {
		t.Fatalf("unexpected markdown paths: %#v %#v", first, second)
	}
	if first.Source != "kernel-assets" || !first.IsImage || first.Type != "image/png" {
		t.Fatalf("unexpected result: %#v", first)
	}
	if got, readErr := os.ReadFile(first.File); readErr != nil || string(got) != "one" {
		t.Fatalf("unexpected first asset bytes %q: %v", got, readErr)
	}
}

func TestStoreMarkdownAssetFromPathStreamsAttachment(t *testing.T) {
	boxID := setupMarkdownAssetTest(t)
	source := filepath.Join(t.TempDir(), "raw data.pdf")
	if err := os.WriteFile(source, []byte("PDF"), 0644); err != nil {
		t.Fatal(err)
	}
	asset, err := StoreMarkdownAssetFromPath(boxID, "/topic.md", source, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if asset.MarkdownPath != "./attachments/topic/raw-data.pdf" || asset.IsImage || asset.Type != "application/pdf" {
		t.Fatalf("unexpected asset: %#v", asset)
	}
	if got, readErr := os.ReadFile(asset.File); readErr != nil || string(got) != "PDF" {
		t.Fatalf("unexpected imported bytes %q: %v", got, readErr)
	}
}

func TestStoreMarkdownAssetRejectsEscapingAndNonMarkdownPaths(t *testing.T) {
	boxID := setupMarkdownAssetTest(t)
	if _, err := StoreMarkdownAssetBytes(boxID, "/../outside.md", "x.png", "image/png", []byte("x")); err == nil {
		t.Fatal("expected escaping note path rejection")
	}
	if _, err := StoreMarkdownAssetBytes(boxID, "/notes.txt", "x.png", "image/png", []byte("x")); err == nil {
		t.Fatal("expected non-Markdown note path rejection")
	}
}

func TestStoreMarkdownAssetRejectsSymlinkedDirectoryOutsideBox(t *testing.T) {
	boxID := setupMarkdownAssetTest(t)
	outside := t.TempDir()
	project := filepath.Join(util.DataDir, boxID, "project")
	if err := os.MkdirAll(project, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(project, "images")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := StoreMarkdownAssetBytes(boxID, "/project/topic.md", "x.png", "image/png", []byte("x")); err == nil {
		t.Fatal("expected symlink escape rejection")
	}
	if _, err := os.Stat(filepath.Join(outside, "topic", "x.png")); !os.IsNotExist(err) {
		t.Fatalf("asset escaped box through symlink: %v", err)
	}
}

func TestStoreMarkdownAssetConcurrentWritesUseUniqueNames(t *testing.T) {
	boxID := setupMarkdownAssetTest(t)
	const count = 8
	paths := make(chan string, count)
	errs := make(chan error, count)
	var wait sync.WaitGroup
	for i := 0; i < count; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			asset, err := StoreMarkdownAssetBytes(boxID, "/topic.md", "paste.png", "image/png", []byte("x"))
			if err != nil {
				errs <- err
				return
			}
			paths <- asset.MarkdownPath
		}()
	}
	wait.Wait()
	close(errs)
	close(paths)
	for err := range errs {
		t.Fatal(err)
	}
	got := []string{}
	for path := range paths {
		got = append(got, path)
	}
	sort.Strings(got)
	if len(got) != count {
		t.Fatalf("expected %d assets, got %v", count, got)
	}
	for i := 1; i < len(got); i++ {
		if got[i] == got[i-1] {
			t.Fatalf("concurrent writes collided: %v", got)
		}
	}
}

func TestListUnusedMarkdownAssetsFindsOnlyUnreferencedCandidates(t *testing.T) {
	boxID := setupMarkdownAssetTest(t)
	root := filepath.Join(util.DataDir, boxID)
	write := func(relative, content string) {
		t.Helper()
		path := filepath.Join(root, relative)
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	write("project/topic.md", strings.Join([]string{
		"![plot](./images/topic/used%20plot.png)",
		`<video poster="./attachments/topic/poster.jpg"></video>`,
		`<img srcset="./images/topic/small.png 1x, ./images/topic/large.png 2x">`,
		`<style>x{background:url('./images/topic/background.webp')}</style>`,
		`[[file:./attachments/topic/raw.pdf][raw]]`,
		`#+include: "./attachments/topic/included.txt"`,
		`![remote](https://example.com/remote.png)`,
	}, "\n"))
	for _, path := range []string{
		"project/images/topic/used plot.png",
		"project/attachments/topic/poster.jpg",
		"project/images/topic/small.png",
		"project/images/topic/large.png",
		"project/images/topic/background.webp",
		"project/attachments/topic/raw.pdf",
		"project/attachments/topic/included.txt",
	} {
		write(path, "used")
	}
	write("project/attachments/topic/orphan.pdf", "orphan")
	write("project/attachments/topic/draft.md", "# not an asset\n")
	write("project/attachments/topic/.hidden.bin", "hidden")
	write("unrelated/file.bin", "not in an asset directory")

	assets, err := ListUnusedMarkdownAssets(boxID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(assets) != 1 || assets[0].Path != "project/attachments/topic/orphan.pdf" || assets[0].Type != "application/pdf" {
		t.Fatalf("unexpected unused assets: %+v", assets)
	}
}

func TestListUnusedMarkdownAssetsPublicPartitionFollowsLayoutFlag(t *testing.T) {
	boxID := setupMarkdownAssetTest(t)
	path := filepath.Join(util.DataDir, boxID, "public", "Repo", "images", "topic", "orphan.png")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("orphan"), 0644); err != nil {
		t.Fatal(err)
	}
	legacy, err := ListUnusedMarkdownAssets(boxID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(legacy) != 0 {
		t.Fatalf("legacy generated public directory must be skipped: %+v", legacy)
	}
	wiki, err := ListUnusedMarkdownAssets(boxID, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(wiki) != 1 || wiki[0].Path != "public/Repo/images/topic/orphan.png" {
		t.Fatalf("wiki public partition must be scanned: %+v", wiki)
	}
}

func TestMarkdownAssetReferencesMatchSharedFixtures(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "shared", "asset-reference-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name     string   `json:"name"`
		Note     string   `json:"note"`
		Content  string   `json:"content"`
		Expected []string `json:"expected"`
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			seen := map[string]bool{}
			notePath := filepath.Join(root, filepath.FromSlash(fixture.Note))
			for _, href := range markdownAssetHrefs(fixture.Content) {
				resolved := resolveMarkdownAssetHref(root, notePath, href)
				if resolved == "" {
					continue
				}
				rel, relErr := filepath.Rel(root, resolved)
				if relErr != nil {
					t.Fatal(relErr)
				}
				seen[filepath.ToSlash(rel)] = true
			}
			got := make([]string, 0, len(seen))
			for path := range seen {
				got = append(got, path)
			}
			sort.Strings(got)
			if strings.Join(got, "\n") != strings.Join(fixture.Expected, "\n") {
				t.Fatalf("got %v, want %v", got, fixture.Expected)
			}
		})
	}
}
