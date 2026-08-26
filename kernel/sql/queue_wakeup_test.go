package sql

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestQueueNotificationConsumerSleepsWhenIdleAndCoalesces(t *testing.T) {
	changed := make(chan struct{}, 1)
	stop := make(chan struct{})
	flushed := make(chan struct{}, 2)
	var calls atomic.Int32
	go consumeQueueNotifications(changed, 10*time.Millisecond, func() {
		calls.Add(1)
		flushed <- struct{}{}
	}, stop)
	t.Cleanup(func() { close(stop) })

	time.Sleep(25 * time.Millisecond)
	if got := calls.Load(); got != 0 {
		t.Fatalf("idle queue flushed %d times", got)
	}
	for range 8 {
		notifyQueueChanged(changed)
	}
	select {
	case <-flushed:
	case <-time.After(time.Second):
		t.Fatal("signaled queue did not flush")
	}
	time.Sleep(25 * time.Millisecond)
	if got := calls.Load(); got != 1 {
		t.Fatalf("coalesced queue flushed %d times, want 1", got)
	}
}
