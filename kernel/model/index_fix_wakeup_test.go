// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org

package model

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestAutoFixIndexSchedulerHasNoIdleWakeAndCoalescesActivity(t *testing.T) {
	activity := make(chan struct{}, 1)
	stop := make(chan struct{})
	var fixes atomic.Int32
	fixed := make(chan struct{}, 1)
	go consumeAutoFixIndexActivity(activity, 20*time.Millisecond, 20*time.Millisecond, func() {
		fixes.Add(1)
		fixed <- struct{}{}
	}, func() bool { return false }, stop)
	t.Cleanup(func() { close(stop) })

	time.Sleep(30 * time.Millisecond)
	if got := fixes.Load(); 0 != got {
		t.Fatalf("idle scheduler ran %d index repairs", got)
	}
	for range 8 {
		select {
		case activity <- struct{}{}:
		default:
		}
	}
	select {
	case <-fixed:
	case <-time.After(time.Second):
		t.Fatal("coalesced activity did not schedule index repair")
	}
	if got := fixes.Load(); 1 != got {
		t.Fatalf("8 coalesced writes ran %d index repairs, want 1", got)
	}
}

func TestIndexMutatingRequestClassification(t *testing.T) {
	for _, requestPath := range []string{
		"/api/transactions", "/api/transactions/insert", "/api/noema/markdown/saveDoc", "/api/noema/markdown/mutatePlanning",
	} {
		if !isIndexMutatingRequest(requestPath) {
			t.Fatalf("write endpoint [%s] was not classified as index-mutating", requestPath)
		}
	}
	for _, requestPath := range []string{
		"/api/noema/markdown/loadDoc", "/api/noema/markdown/listDocs", "/api/noema/markdown/catalog",
		"/api/noema/markdown/workspaceProjection", "/api/noema/markdown/virtualReferences", "/api/ai/embeddingStat",
	} {
		if isIndexMutatingRequest(requestPath) {
			t.Fatalf("read endpoint [%s] was classified as index-mutating", requestPath)
		}
	}
}
