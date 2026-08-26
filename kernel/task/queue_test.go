// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package task

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func resetQueue() {
	queueLock.Lock()
	taskQueue = nil
	queueLock.Unlock()
	select {
	case <-taskQueueChanged:
	default:
	}
	select {
	case <-taskStatusChanged:
	default:
	}
}

func TestTaskStatusConsumerSleepsWhenIdleAndCoalesces(t *testing.T) {
	changed := make(chan struct{}, 1)
	stop := make(chan struct{})
	pushed := make(chan struct{}, 2)
	go consumeTaskStatus(changed, 10*time.Millisecond, func() { pushed <- struct{}{} }, stop)
	t.Cleanup(func() { close(stop) })

	time.Sleep(25 * time.Millisecond)
	select {
	case <-pushed:
		t.Fatal("idle task status consumer pushed")
	default:
	}
	for range 8 {
		select {
		case changed <- struct{}{}:
		default:
		}
	}
	select {
	case <-pushed:
	case <-time.After(time.Second):
		t.Fatal("task status change was not pushed")
	}
	time.Sleep(25 * time.Millisecond)
	select {
	case <-pushed:
		t.Fatal("task status changes were not coalesced")
	default:
	}
}

func TestQueueConsumerWakesForImmediateAndDelayedWork(t *testing.T) {
	resetQueue()
	defer resetQueue()

	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		consumeTaskQueue(stop)
		close(done)
	}()

	result := make(chan string, 2)
	AppendTask("test-consumer-immediate", func() { result <- "immediate" })
	AppendAsyncTaskWithDelay("test-consumer-delayed", 30*time.Millisecond, func() { result <- "delayed" })

	for _, want := range []string{"immediate", "delayed"} {
		select {
		case got := <-result:
			if got != want {
				t.Fatalf("expected %q, got %q", want, got)
			}
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for %s task", want)
		}
	}

	close(stop)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("task consumer did not stop")
	}
}

// TestQueuedTasksNeverRunWithoutConsumer 锁定这次修复的前提：入队本身不执行任何东西。
// 这正是 CLI 的原始 bug —— serve 模式靠 cron 的 ExecTaskJob 消费，CLI 没有 cron，
// 于是 Box.Index() 派发的索引任务永远躺在队列里，search/sql 静默返回空。
func TestQueuedTasksNeverRunWithoutConsumer(t *testing.T) {
	resetQueue()
	defer resetQueue()

	var ran atomic.Int32
	AppendTask("test-never-runs", func() { ran.Add(1) })

	time.Sleep(50 * time.Millisecond)

	if 0 != ran.Load() {
		t.Fatalf("task ran without a consumer, got %d", ran.Load())
	}
	if 1 != len(getCurrentTasks()) {
		t.Fatalf("expected 1 queued task, got %d", len(getCurrentTasks()))
	}
}

// TestExecSyncTasksUntilEmptyRunsAllInOrder 覆盖修复本身：一次调用把整条队列按入队顺序跑完。
// 顺序很重要——Box.Index() 依赖 removeBoxRefs → indexBox → IndexRefs 这个次序。
func TestExecSyncTasksUntilEmptyRunsAllInOrder(t *testing.T) {
	resetQueue()
	defer resetQueue()

	var mu sync.Mutex
	var order []string
	record := func(name string) {
		mu.Lock()
		order = append(order, name)
		mu.Unlock()
	}

	AppendTask("test-first", func() { record("first") })
	AppendTask("test-second", func() { record("second") })
	AppendTask("test-third", func() { record("third") })

	ExecSyncTasksUntilEmpty(30 * time.Second)

	mu.Lock()
	got := append([]string(nil), order...)
	mu.Unlock()

	want := []string{"first", "second", "third"}
	if len(got) != len(want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("expected %v, got %v", want, got)
		}
	}
	if 0 != len(getCurrentTasks()) {
		t.Fatalf("queue not drained, %d task(s) left", len(getCurrentTasks()))
	}
}

// TestExecSyncTasksUntilEmptyRunsTasksQueuedByTasks 覆盖真实索引路径的形状：
// indexBox 在执行过程中还会继续往队列里追加工作，排空必须跟进这些新任务而不是只跑首轮快照。
func TestExecSyncTasksUntilEmptyRunsTasksQueuedByTasks(t *testing.T) {
	resetQueue()
	defer resetQueue()

	var ran atomic.Int32
	AppendTask("test-outer", func() {
		ran.Add(1)
		AppendTask("test-inner", func() { ran.Add(1) })
	})

	ExecSyncTasksUntilEmpty(30 * time.Second)

	if 2 != ran.Load() {
		t.Fatalf("expected outer and inner task to run, got %d", ran.Load())
	}
}

// TestExecSyncTasksUntilEmptySkipsAsyncTasks 异步任务（如 PushMsg 状态推送）是给长驻 UI 的，
// 一次性命令不该为它们的 Delay 阻塞。popTask 本就跳过它们，这里锁定这个行为不被改坏。
func TestExecSyncTasksUntilEmptySkipsAsyncTasks(t *testing.T) {
	resetQueue()
	defer resetQueue()

	var ran atomic.Int32
	AppendAsyncTaskWithDelay("test-async", time.Hour, func() { ran.Add(1) })

	start := time.Now()
	ExecSyncTasksUntilEmpty(30 * time.Second)
	elapsed := time.Since(start)

	if 0 != ran.Load() {
		t.Fatalf("async task should not be executed by the sync drain, got %d", ran.Load())
	}
	if elapsed > 5*time.Second {
		t.Fatalf("sync drain blocked on a delayed async task for %s", elapsed)
	}
}

// TestExecSyncTasksUntilEmptyHonorsBudget 防止某个任务不断重新入队时把 CLI 挂死。
func TestExecSyncTasksUntilEmptyHonorsBudget(t *testing.T) {
	resetQueue()
	defer resetQueue()

	var ran atomic.Int32
	var requeue func()
	requeue = func() {
		ran.Add(1)
		AppendTask("test-requeue-"+time.Now().Format("150405.000000000"), requeue)
	}
	AppendTask("test-requeue-seed", requeue)

	start := time.Now()
	ExecSyncTasksUntilEmpty(300 * time.Millisecond)
	elapsed := time.Since(start)

	if elapsed > 10*time.Second {
		t.Fatalf("budget not honored, drain took %s", elapsed)
	}
	if 0 == ran.Load() {
		t.Fatal("expected at least one task to run before the budget expired")
	}
}
