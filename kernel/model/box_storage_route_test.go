// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org

package model

import (
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/util"
)

func TestBoxStorageRouteCacheTracksSaveAndDataDir(t *testing.T) {
	originalDataDir := util.DataDir
	t.Cleanup(func() { util.DataDir = originalDataDir })

	const boxID = "20260826123456-route01"
	firstDataDir := filepath.Join(t.TempDir(), "first-data")
	firstRoot := filepath.Join(t.TempDir(), "first-root")
	secondRoot := filepath.Join(t.TempDir(), "second-root")
	util.DataDir = firstDataDir
	box := &Box{ID: boxID}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Root = firstRoot
	if err := box.SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}
	if got := GetBoxRoot(boxID); filepath.Clean(firstRoot) != got {
		t.Fatalf("initial cached root mismatch: got %q want %q", got, firstRoot)
	}

	boxConf.Root = secondRoot
	if err := box.SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}
	if got := GetBoxRoot(boxID); filepath.Clean(secondRoot) != got {
		t.Fatalf("SaveConf did not refresh cached root: got %q want %q", got, secondRoot)
	}

	secondDataDir := filepath.Join(t.TempDir(), "second-data")
	util.DataDir = secondDataDir
	secondBoxConf := conf.NewBoxConf()
	if err := box.SaveConf(secondBoxConf); nil != err {
		t.Fatal(err)
	}
	if got := GetBoxRoot(boxID); "" != got {
		t.Fatalf("route leaked across DataDir values: got %q", got)
	}
	if got := GetBoxKind(boxID); conf.BoxKindSy != got {
		t.Fatalf("kind leaked across DataDir values: got %q", got)
	}

	util.DataDir = firstDataDir
	if got := GetBoxRoot(boxID); filepath.Clean(secondRoot) != got {
		t.Fatalf("first workspace route was lost: got %q want %q", got, secondRoot)
	}
}

func TestForgetBoxStorageRouteReloadsPersistedConfig(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	const boxID = "20260826123456-route02"
	root := filepath.Join(t.TempDir(), "root")
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Root = root
	if err := (&Box{ID: boxID}).SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}
	forgetBoxStorageRoute(boxID)
	if got := GetBoxRoot(boxID); filepath.Clean(root) != got {
		t.Fatalf("cold route reload mismatch: got %q want %q", got, root)
	}
}
