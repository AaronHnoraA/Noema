// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org

package model

import (
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/util"
)

func TestDataIndexRecoveryMarkerLifecycle(t *testing.T) {
	originalQueueDir := util.QueueDir
	util.QueueDir = filepath.Join(t.TempDir(), "queue")
	t.Cleanup(func() { util.QueueDir = originalQueueDir })

	if dataIndexRecoveryMarkerExists() {
		t.Fatal("new queue unexpectedly has a recovery marker")
	}
	if err := persistDataIndexRecoveryMarker(); nil != err {
		t.Fatal(err)
	}
	if !dataIndexRecoveryMarkerExists() {
		t.Fatal("persisted recovery marker is missing")
	}
	clearDataIndexRecoveryMarker()
	if dataIndexRecoveryMarkerExists() {
		t.Fatal("recovery marker survived clear")
	}
}
