// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org

package sql

import (
	"sync"
	"time"

	"github.com/aaronhe/noema/kernel/util"
)

const databaseQueueEditFlushDelay = 50 * time.Millisecond

var (
	queueConsumersOnce               sync.Once
	databaseQueueChanged             = make(chan struct{}, 1)
	historyDatabaseQueueChanged      = make(chan struct{}, 1)
	assetContentDatabaseQueueChanged = make(chan struct{}, 1)
)

// StartQueueConsumers replaces the former fixed-interval database cron jobs.
// An empty workspace has no queue timers and therefore no periodic wakeups.
// Editor writes get a short first-change coalescing window; bulk history and
// asset work retains the old three-second batching interval.
func StartQueueConsumers() {
	queueConsumersOnce.Do(func() {
		go consumeQueueNotifications(databaseQueueChanged, databaseQueueEditFlushDelay, FlushQueue, nil)
		go consumeQueueNotifications(historyDatabaseQueueChanged, util.SQLFlushInterval, FlushHistoryQueue, nil)
		go consumeQueueNotifications(assetContentDatabaseQueueChanged, util.SQLFlushInterval, FlushAssetContentQueue, nil)
		notifyPendingDatabaseQueues()
	})
}

func consumeQueueNotifications(ch <-chan struct{}, delay time.Duration, flush func(), stop <-chan struct{}) {
	for {
		select {
		case <-ch:
		case <-stop:
			return
		}

		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-stop:
			if !timer.Stop() {
				<-timer.C
			}
			return
		}
		// Changes inside the first-operation batching window are already in the
		// queue. Drain their edge notifications before flushing so they do not
		// schedule an empty follow-up batch.
		for {
			select {
			case <-ch:
				continue
			default:
			}
			break
		}
		flush()
	}
}

func notifyDatabaseQueueChanged() {
	notifyQueueChanged(databaseQueueChanged)
}

func notifyHistoryDatabaseQueueChanged() {
	notifyQueueChanged(historyDatabaseQueueChanged)
}

func notifyAssetContentDatabaseQueueChanged() {
	notifyQueueChanged(assetContentDatabaseQueueChanged)
}

func notifyQueueChanged(ch chan<- struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

func notifyPendingDatabaseQueues() {
	dbQueueLock.Lock()
	databasePending := 0 < len(operationQueue)
	dbQueueLock.Unlock()
	historyDBQueueLock.Lock()
	historyPending := 0 < len(historyOperationQueue)
	historyDBQueueLock.Unlock()
	assetContentDBQueueLock.Lock()
	assetPending := 0 < len(assetContentOperationQueue)
	assetContentDBQueueLock.Unlock()
	if databasePending {
		notifyDatabaseQueueChanged()
	}
	if historyPending {
		notifyHistoryDatabaseQueueChanged()
	}
	if assetPending {
		notifyAssetContentDatabaseQueueChanged()
	}
}
