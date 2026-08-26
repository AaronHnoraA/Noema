package bibliography

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type sharedFixture struct {
	Name                string   `json:"name"`
	Source              string   `json:"source"`
	ExpectedEntries     []Entry  `json:"expectedEntries"`
	ExpectedDiagnostics []string `json:"expectedDiagnostics"`
	DiagnosticsContain  []string `json:"diagnosticsContain"`
	DiagnosticsPrefix   []string `json:"diagnosticsPrefix"`
}

func TestSharedBibliographyFixtures(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "bibliography-fixtures.json"))
	if nil != err {
		t.Fatal(err)
	}
	fixtures := []sharedFixture{}
	if err = json.Unmarshal(raw, &fixtures); nil != err {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		fixture := fixture
		t.Run(fixture.Name, func(t *testing.T) {
			result := Parse(fixture.Source)
			entries := make([]Entry, len(result.Entries))
			for index, entry := range result.Entries {
				entry.Raw = ""
				entries[index] = entry
			}
			if !reflect.DeepEqual(entries, fixture.ExpectedEntries) {
				t.Fatalf("entries mismatch:\nresult=%+v\nexpected=%+v", entries, fixture.ExpectedEntries)
			}
			if nil != fixture.ExpectedDiagnostics && !reflect.DeepEqual(result.Diagnostics, fixture.ExpectedDiagnostics) {
				t.Fatalf("diagnostics mismatch:\nresult=%+v\nexpected=%+v", result.Diagnostics, fixture.ExpectedDiagnostics)
			}
			for _, expected := range fixture.DiagnosticsContain {
				if !contains(result.Diagnostics, expected) {
					t.Fatalf("missing diagnostic %q in %+v", expected, result.Diagnostics)
				}
			}
			for _, prefix := range fixture.DiagnosticsPrefix {
				matched := false
				for _, diagnostic := range result.Diagnostics {
					if strings.HasPrefix(diagnostic, prefix) {
						matched = true
						break
					}
				}
				if !matched {
					t.Fatalf("missing diagnostic prefix %q in %+v", prefix, result.Diagnostics)
				}
			}
		})
	}
}

func TestLoadResolvesDefaultDeclaredAndInheritedBibliographies(t *testing.T) {
	root := t.TempDir()
	noteDir := filepath.Join(root, "project", "chapters")
	if err := os.MkdirAll(filepath.Join(noteDir, "bib"), 0755); nil != err {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "project", "shared"), 0755); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(noteDir, "bib", "local.bib"), []byte("@book{Local, author={Author, L}, title={Local}, year={2026}}"), 0644); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "project", "shared", "refs.bib"), []byte("@book{Shared, author={Author, S}, title={Shared}, year={2025}}"), 0644); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "project", "base.md"), []byte("#+begin meta\nbib: ./shared\n#+end meta\n"), 0644); nil != err {
		t.Fatal(err)
	}
	metadata := "#+begin meta\nextend: ../base.md\n#+end meta\n"
	result, err := Load(root, "/project/chapters/note.md", metadata)
	if nil != err {
		t.Fatal(err)
	}
	if 2 != len(result.Files) || "project/chapters/bib/local.bib" != result.Files[0].Path || "project/shared/refs.bib" != result.Files[1].Path {
		t.Fatalf("unexpected visible bibliography files: %+v", result.Files)
	}
	if "kernel-bibliography" != result.Source || 0 != len(result.Diagnostics) {
		t.Fatalf("unexpected load metadata: %+v", result)
	}
	if "Local" != result.Files[0].Entries[0].Key || "Shared" != result.Files[1].Entries[0].Key {
		t.Fatalf("unexpected parsed entries: %+v", result.Files)
	}
}

func TestLoadRejectsEscapingBibliographyAndSuppressesAmbiguousShortAlias(t *testing.T) {
	container := t.TempDir()
	root := filepath.Join(container, "root")
	outside := filepath.Join(container, "outside.bib")
	if err := os.MkdirAll(filepath.Join(root, "one"), 0755); nil != err {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "two"), 0755); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte("@book{Outside, title={Outside}}"), 0644); nil != err {
		t.Fatal(err)
	}
	for _, dir := range []string{"one", "two"} {
		if err := os.WriteFile(filepath.Join(root, dir, "refs.bib"), []byte("@book{"+dir+", title={"+dir+"}}"), 0644); nil != err {
			t.Fatal(err)
		}
	}
	metadata := "#+begin meta\nbib: ./one, ./two, ../outside.bib\n#+end meta\n"
	result, err := Load(root, "/note.md", metadata)
	if nil != err {
		t.Fatal(err)
	}
	if 2 != len(result.Files) {
		t.Fatalf("outside bibliography leaked or visible files were missed: %+v", result.Files)
	}
	for _, file := range result.Files {
		if "" != file.Entries[0].ShortNamespace {
			t.Fatalf("ambiguous short namespace was exposed: %+v", file.Entries[0])
		}
	}
	if !contains(result.Diagnostics, "bib source is outside the allowed note root: ../outside.bib") {
		t.Fatalf("missing path escape diagnostic: %+v", result.Diagnostics)
	}
}

func TestParseBibFileCacheReusesAndInvalidates(t *testing.T) {
	resetBibParsedCache()
	t.Cleanup(resetBibParsedCache)
	file := filepath.Join(t.TempDir(), "refs.bib")
	if err := os.WriteFile(file, []byte("@book{One, title={First}}"), 0644); nil != err {
		t.Fatal(err)
	}
	first, err := parseBibFile(file)
	if nil != err || 1 != len(first.Entries) || "First" != first.Entries[0].Fields["title"] {
		t.Fatalf("unexpected first parse: %+v, %v", first, err)
	}
	bibCacheMu.Lock()
	firstEntry := bibParsedCache[file]
	bibCacheMu.Unlock()
	if _, err = parseBibFile(file); nil != err {
		t.Fatal(err)
	}
	bibCacheMu.Lock()
	secondEntry := bibParsedCache[file]
	bibCacheMu.Unlock()
	if firstEntry != secondEntry {
		t.Fatal("unchanged bibliography should reuse its parsed cache entry")
	}

	if err = os.WriteFile(file, []byte("@book{Two, title={Second changed}}"), 0644); nil != err {
		t.Fatal(err)
	}
	nextTime := time.Now().Add(2 * time.Second)
	if err = os.Chtimes(file, nextTime, nextTime); nil != err {
		t.Fatal(err)
	}
	changed, err := parseBibFile(file)
	if nil != err || 1 != len(changed.Entries) || "Second changed" != changed.Entries[0].Fields["title"] {
		t.Fatalf("unexpected changed parse: %+v, %v", changed, err)
	}
	bibCacheMu.Lock()
	changedEntry := bibParsedCache[file]
	bibCacheMu.Unlock()
	if firstEntry == changedEntry {
		t.Fatal("changed bibliography should replace its parsed cache entry")
	}
}

func BenchmarkParseBibFileCache(b *testing.B) {
	file := filepath.Join(b.TempDir(), "large.bib")
	var source strings.Builder
	for index := 0; index < 1000; index++ {
		fmt.Fprintf(&source, "@article{Key%d, author={Author, %d}, title={Title %d}, year={2026}}\n", index, index, index)
	}
	if err := os.WriteFile(file, []byte(source.String()), 0644); nil != err {
		b.Fatal(err)
	}
	resetBibParsedCache()
	b.Cleanup(resetBibParsedCache)
	if _, err := parseBibFile(file); nil != err {
		b.Fatal(err)
	}

	b.Run("warm", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			if _, err := parseBibFile(file); nil != err {
				b.Fatal(err)
			}
		}
	})
	b.Run("cold", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			resetBibParsedCache()
			if _, err := parseBibFile(file); nil != err {
				b.Fatal(err)
			}
		}
	})
}
