package model

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/util"
)

func TestPrepareAndCleanupRichClipboardAssets(t *testing.T) {
	originalWorkspaceDir := util.WorkspaceDir
	originalDataDir := util.DataDir
	originalTempDir := util.TempDir
	root := t.TempDir()
	util.WorkspaceDir = root
	util.DataDir = filepath.Join(root, "data")
	util.TempDir = filepath.Join(root, "temp")
	defer func() {
		util.WorkspaceDir = originalWorkspaceDir
		util.DataDir = originalDataDir
		util.TempDir = originalTempDir
	}()

	sourcePath := filepath.Join(util.DataDir, "assets", "image.png")
	if err := os.MkdirAll(filepath.Dir(sourcePath), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sourcePath, []byte("image"), 0600); err != nil {
		t.Fatal(err)
	}

	prepared, err := PrepareRichClipboardAssets([]RichClipboardAsset{
		{Index: 0, Path: "assets/image.png"},
		{Index: 1, Path: "assets/image.png"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(prepared.Groups) != 1 || prepared.Groups[0] != richClipboardGlobalGroup {
		t.Fatalf("unexpected rich clipboard groups: %#v", prepared.Groups)
	}
	if len(prepared.Assets) != 2 || prepared.Assets[0].Path != prepared.Assets[1].Path {
		t.Fatalf("duplicated source should reuse one temporary file: %#v", prepared.Assets)
	}
	content, err := os.ReadFile(prepared.Assets[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "image" {
		t.Fatalf("unexpected temporary asset content: %q", content)
	}

	CleanupRichClipboardBatch(prepared.Batch, prepared.Groups)
	if _, err = os.Stat(prepared.Assets[0].Path); !os.IsNotExist(err) {
		t.Fatalf("rich clipboard batch should be removed: %v", err)
	}
}

func TestPrepareRichClipboardAssetsRejectsSVG(t *testing.T) {
	originalWorkspaceDir := util.WorkspaceDir
	originalDataDir := util.DataDir
	originalTempDir := util.TempDir
	root := t.TempDir()
	util.WorkspaceDir = root
	util.DataDir = filepath.Join(root, "data")
	util.TempDir = filepath.Join(root, "temp")
	defer func() {
		util.WorkspaceDir = originalWorkspaceDir
		util.DataDir = originalDataDir
		util.TempDir = originalTempDir
	}()

	sourcePath := filepath.Join(util.DataDir, "assets", "image.svg")
	if err := os.MkdirAll(filepath.Dir(sourcePath), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sourcePath, []byte("<svg></svg>"), 0600); err != nil {
		t.Fatal(err)
	}

	if _, err := PrepareRichClipboardAssets([]RichClipboardAsset{{Index: 0, Path: "assets/image.svg"}}); err == nil {
		t.Fatal("SVG should not be prepared for the rich clipboard")
	}
	if _, err := os.Stat(filepath.Join(util.TempDir, "clipboard")); !os.IsNotExist(err) {
		t.Fatalf("rejected rich clipboard assets should not leave temporary files: %v", err)
	}
}

func TestClearRichClipboardBox(t *testing.T) {
	originalTempDir := util.TempDir
	util.TempDir = t.TempDir()
	defer func() {
		util.TempDir = originalTempDir
	}()

	boxID := "20260726120000-abcdefg"
	boxAsset := filepath.Join(util.TempDir, "clipboard", boxID, "batch", "image.png")
	globalAsset := filepath.Join(util.TempDir, "clipboard", richClipboardGlobalGroup, "batch", "image.png")
	for _, asset := range []string{boxAsset, globalAsset} {
		if err := os.MkdirAll(filepath.Dir(asset), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(asset, []byte("image"), 0600); err != nil {
			t.Fatal(err)
		}
	}

	ClearRichClipboardBox(boxID)
	if _, err := os.Stat(boxAsset); !os.IsNotExist(err) {
		t.Fatalf("notebook rich clipboard files should be removed: %v", err)
	}
	if _, err := os.Stat(globalAsset); err != nil {
		t.Fatalf("global rich clipboard files should be preserved: %v", err)
	}
}
