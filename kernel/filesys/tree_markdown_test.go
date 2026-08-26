// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package filesys

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	"github.com/aaronhe/noema/kernel/conf"
	noemamarkdown "github.com/aaronhe/noema/kernel/noema/markdown"
	"github.com/aaronhe/noema/kernel/util"
)

func withMarkdownBox(t *testing.T, boxID string) {
	t.Helper()
	originalProvider := BoxKindProvider
	BoxKindProvider = func(id string) string {
		if id == boxID {
			return conf.BoxKindMarkdown
		}
		return conf.BoxKindSy
	}
	t.Cleanup(func() {
		BoxKindProvider = originalProvider
	})
}

func TestBoxKindDefaultsToSyWhenUnset(t *testing.T) {
	originalProvider := BoxKindProvider
	BoxKindProvider = nil
	t.Cleanup(func() { BoxKindProvider = originalProvider })

	if isMarkdownBox("any-box") {
		t.Fatal("box kind must default to sy when no provider is injected")
	}
	if conf.BoxKindSy != boxKind("any-box") {
		t.Fatalf("unexpected default box kind [%s]", boxKind("any-box"))
	}
}

func TestBoxDocumentPathFollowsBoxKind(t *testing.T) {
	const markdownBox = "20260826120500-pathkind"
	withMarkdownBox(t, markdownBox)

	for _, test := range []struct {
		boxID string
		path  string
		want  bool
	}{
		{markdownBox, "/note.md", true},
		{markdownBox, "/note.MARKDOWN", true},
		{markdownBox, "/foreign.sy", false},
		{"native-box", "/20260826120501-native1.sy", true},
		{"native-box", "/note.md", false},
	} {
		if got := IsBoxDocumentPath(test.boxID, test.path); got != test.want {
			t.Fatalf("IsBoxDocumentPath(%q, %q) = %v, want %v", test.boxID, test.path, got, test.want)
		}
		if err := ValidateBoxDocumentPath(test.boxID, test.path); (nil == err) != test.want {
			t.Fatalf("ValidateBoxDocumentPath(%q, %q) = %v, want accepted=%v", test.boxID, test.path, err, test.want)
		}
	}
}

func TestLoadTreeRejectsForeignDocumentExtensionsBeforeRead(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	const markdownBox = "20260826120502-loadkind"
	withMarkdownBox(t, markdownBox)
	if _, err := LoadTree(markdownBox, "/foreign.sy", util.NewLute()); !errors.Is(err, ErrBoxDocumentPathKind) {
		t.Fatalf("Markdown box accepted .sy tree source: %v", err)
	}
}

func TestValidateBoxRelativePathRejectsSymlinkEscapeAndDanglingLink(t *testing.T) {
	root := filepath.Join(t.TempDir(), "box")
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.MkdirAll(filepath.Join(root, "real"), 0755); nil != err {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0755); nil != err {
		t.Fatal(err)
	}
	const boxID = "20260826013000-pathbox"
	originalProvider := BoxRootProvider
	BoxRootProvider = func(id string) string {
		if id == boxID {
			return root
		}
		return ""
	}
	t.Cleanup(func() { BoxRootProvider = originalProvider })

	if err := os.Symlink(outside, filepath.Join(root, "escape")); nil != err {
		t.Skipf("symbolic links unavailable: %v", err)
	}
	if err := os.Symlink(filepath.Join(outside, "missing.md"), filepath.Join(root, "dangling.md")); nil != err {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "real"), filepath.Join(root, "alias")); nil != err {
		t.Fatal(err)
	}

	if got, err := ValidateBoxRelativePath(boxID, "/nested/new.md"); nil != err || got != "nested/new.md" {
		t.Fatalf("safe missing path rejected: got=%q err=%v", got, err)
	}
	if got, err := ValidateBoxRelativePath(boxID, "/alias/inside.md"); nil != err || got != "alias/inside.md" {
		t.Fatalf("box-internal symlink rejected: got=%q err=%v", got, err)
	}
	for _, unsafe := range []string{"/escape/note.md", "/dangling.md"} {
		if _, err := ValidateBoxRelativePath(boxID, unsafe); nil == err {
			t.Fatalf("unsafe symbolic-link path accepted: %s", unsafe)
		}
	}
}

func TestLoadTreeProjectsNoemaIdentityWithoutWritingMarkdownBox(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260824230000-mdbox01"
	withMarkdownBox(t, boxID)

	const canonicalID = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68"
	const relPath = "/notes/hello.md"
	source := "#+begin meta\nid: " + canonicalID + "\ntitle: Title\n#+end meta\n\n# Title\n\nSee @@cmd(foo, bar) for details.\n\n#+begin note\nSome text.\n#+end note\n\n$$\nx^2 + y^2 = z^2\n$$\n"
	absPath := filepath.Join(util.DataDir, boxID, relPath)
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(absPath, []byte(source), 0644); nil != err {
		t.Fatal(err)
	}

	luteEngine := util.NewLute()
	tree, err := LoadTree(boxID, relPath, luteEngine)
	if nil != err {
		t.Fatalf("LoadTree failed: %s", err)
	}
	if !ast.IsNodeIDPattern(tree.ID) {
		t.Fatalf("projection ID is not a valid internal node key: %s", tree.ID)
	}
	if got := MarkdownCanonicalDocumentID(tree); canonicalID != got {
		t.Fatalf("canonical Noema ID mismatch: got %s want %s", got, canonicalID)
	}
	if tree.HPath != "/notes/hello.md" {
		t.Fatalf("unexpected markdown HPath [%s]", tree.HPath)
	}
	if _, err := WriteTree(tree); !errors.Is(err, ErrMarkdownTreeWriteUnsupported) {
		t.Fatalf("markdown WriteTree must be rejected, got %v", err)
	}
	raw, err := os.ReadFile(absPath)
	if nil != err {
		t.Fatal(err)
	}
	if string(raw) != source {
		t.Fatalf("LoadTree/WriteTree rejection changed source bytes:\n%s", raw)
	}
	if strings.Contains(string(raw), `type="doc"`) {
		t.Fatalf("source-authoritative load injected a document IAL:\n%s", raw)
	}

	reloaded, err := LoadTree(boxID, relPath, luteEngine)
	if nil != err {
		t.Fatal(err)
	}
	if reloaded.ID != tree.ID {
		t.Fatalf("projection ID is not deterministic: first=%s second=%s", tree.ID, reloaded.ID)
	}
}

func TestLoadTreeProjectsNoemaUUIDBlockAndReferenceWithoutWriting(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260825113000-uuidblk"
	withMarkdownBox(t, boxID)
	const blockID = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68"
	const orgBlockID = "0198fc34-7b32-7a11-8cb4-6c40e3b33d69"
	const relPath = "/notes/blocks.md"
	source := "Target paragraph {#" + blockID + " status=draft owner=\"Aaron He\"}\n\nSee ((" + blockID + " \"target\")).\n\n" +
		"#+begin note Result {#" + orgBlockID + " phase=proof}\nbody\n#+end note\n"
	absPath := filepath.Join(util.DataDir, boxID, relPath)
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); nil != err {
		t.Fatal(err)
	}
	if err := os.WriteFile(absPath, []byte(source), 0644); nil != err {
		t.Fatal(err)
	}

	tree, err := LoadTree(boxID, relPath, util.NewLute())
	if nil != err {
		t.Fatal(err)
	}
	projected := map[string]*ast.Node{}
	ast.Walk(tree.Root, func(n *ast.Node, entering bool) ast.WalkStatus {
		if entering {
			canonical := MarkdownCanonicalBlockID(n)
			if canonical == blockID || canonical == orgBlockID {
				projected[canonical] = n
			}
		}
		return ast.WalkContinue
	})
	for _, canonical := range []string{blockID, orgBlockID} {
		internal := projected[canonical]
		if nil == internal {
			var nodes []string
			ast.Walk(tree.Root, func(n *ast.Node, entering bool) ast.WalkStatus {
				if entering && n.IsBlock() {
					nodes = append(nodes, n.Type.String()+":"+n.Text()+":"+n.TokensStr())
				}
				return ast.WalkContinue
			})
			t.Fatalf("Noema UUIDv7 block definition %s was not mapped onto the Lute tree: %#v", canonical, nodes)
		}
		if internal.ID == canonical || !ast.IsNodeIDPattern(internal.ID) {
			t.Fatalf("block did not receive a disposable internal projection: canonical=%s internal=%s", canonical, internal.ID)
		}
	}
	projection := noemamarkdown.ProjectionFromTree(tree)
	if 1 != len(projection.References) || projection.References[0].CanonicalID != blockID || projection.References[0].ProjectionID != projected[blockID].ID {
		t.Fatalf("Noema reference projection mismatch: %#v", projection)
	}
	raw, err := os.ReadFile(absPath)
	if nil != err {
		t.Fatal(err)
	}
	if string(raw) != source {
		t.Fatalf("UUIDv7 projection changed source bytes: got %q want %q", raw, source)
	}
}

func TestWriteTreeStillWritesJSONForSyBox(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	originalProvider := BoxKindProvider
	BoxKindProvider = nil // no provider injected -> defaults to sy, matching production boot order before model.init runs
	t.Cleanup(func() { BoxKindProvider = originalProvider })

	boxID := "20260824230000-sybox01"
	rootID := "20260824230001-syroot1"
	luteEngine := util.NewLute()
	tree := parse.Parse(boxID, []byte("content"), luteEngine.ParseOptions)
	tree.Box = boxID
	tree.Path = "/" + rootID + ".sy"
	tree.Root.ID = rootID
	tree.ID = rootID
	tree.Root.SetIALAttr("id", rootID)

	if _, err := WriteTree(tree); nil != err {
		t.Fatalf("WriteTree failed: %s", err)
	}

	absPath := filepath.Join(util.DataDir, boxID, tree.Path)
	raw, err := os.ReadFile(absPath)
	if nil != err {
		t.Fatalf("read written file failed: %s", err)
	}
	if !strings.HasPrefix(strings.TrimSpace(string(raw)), "{") {
		t.Fatalf("sy box did not write JSON: %s", raw)
	}
}
