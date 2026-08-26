// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org

package util

import (
	"testing"
)

func TestAssetsTextsChangesCoalesceWithoutIdleWake(t *testing.T) {
	originalNotify := assetsTextsNotify
	originalChanged := assetsTextsChanged.Load()
	assetsTextsNotify = make(chan struct{}, 1)
	assetsTextsChanged.Store(false)
	t.Cleanup(func() {
		assetsTextsNotify = originalNotify
		assetsTextsChanged.Store(originalChanged)
	})

	if got := len(assetsTextsNotify); 0 != got {
		t.Fatalf("idle OCR metadata queue has %d wakeups", got)
	}
	for range 8 {
		markAssetsTextsChanged()
	}
	if !assetsTextsChanged.Load() {
		t.Fatal("OCR metadata mutation was not marked dirty")
	}
	if got := len(assetsTextsNotify); 1 != got {
		t.Fatalf("8 OCR metadata mutations produced %d wakeups, want 1", got)
	}
}
