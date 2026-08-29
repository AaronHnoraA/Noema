// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package model

import (
	"sync"
	"time"

	"github.com/88250/lute/parse"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/util"
)

// Markdown saves hand their document to this queue instead of indexing it
// inline. Indexing costs several milliseconds — parsing the source, reading the
// root's existing block-tree rows, rewriting the changed ones, invalidating
// caches — and none of it is needed to answer the save, which reports the bytes
// that were persisted and the blocks the document declares.
//
// Work is coalesced per document: a debounced editor sends a burst of saves
// while a paragraph is being typed, and only the last state of each document is
// worth indexing. Distinct documents keep their arrival order.
type markdownIndexJob struct {
	boxID    string
	path     string
	source   []byte
	tree     *parse.Tree
	snapshot *markdownSnapshot
	readyAt  time.Time
}

// markdownIndexDelay holds a document back briefly before indexing it. Parsing
// allocates megabytes, and running that concurrently with the save that
// scheduled it made the editor wait on the resulting collections — measured at
// roughly 300 µs on a 60 KB note. The pause also widens the window over which a
// burst of keystroke saves coalesces into one index update. Any barrier
// (WaitMarkdownIndex, or a database flush) cuts it short, so a reader never
// waits on it.
const markdownIndexDelay = 4 * time.Millisecond

var (
	markdownIndexMu      sync.Mutex
	markdownIndexPending = map[string]markdownIndexJob{}
	markdownIndexOrder   []string
	markdownIndexRunning int
	markdownIndexWaiters int
	markdownIndexOnce    sync.Once
	markdownIndexWake    = make(chan struct{}, 1)
	markdownIndexIdle    = closedMarkdownIndexIdleChannel()
)

func closedMarkdownIndexIdleChannel() chan struct{} {
	ret := make(chan struct{})
	close(ret)
	return ret
}

func wakeMarkdownIndexConsumer() {
	select {
	case markdownIndexWake <- struct{}{}:
	default:
	}
}

func init() {
	// Every existing "the index must be current now" barrier also settles this
	// queue, so moving indexing off the save path never makes a save invisible
	// to a reader that already synchronizes on the index.
	sql.RegisterPreFlushHook(WaitMarkdownIndex)
}

func startMarkdownIndexConsumer() {
	markdownIndexOnce.Do(func() { go markdownIndexConsumer() })
}

// enqueueMarkdownIndex schedules one saved document for indexing. Pass the tree
// when the response path already parsed it, otherwise pass nil and the consumer
// parses it off the request path — which is the point of the queue.
func enqueueMarkdownIndex(boxID, path string, source []byte, tree *parse.Tree, snapshot *markdownSnapshot) {
	startMarkdownIndexConsumer()
	key := markdownSnapshotKey(boxID, path)

	markdownIndexMu.Lock()
	if 0 == len(markdownIndexOrder) && 0 == markdownIndexRunning {
		markdownIndexIdle = make(chan struct{})
	}
	if _, queued := markdownIndexPending[key]; !queued {
		markdownIndexOrder = append(markdownIndexOrder, key)
	}
	markdownIndexPending[key] = markdownIndexJob{
		boxID: boxID, path: path, source: source, tree: tree, snapshot: snapshot,
		readyAt: time.Now().Add(markdownIndexDelay),
	}
	markdownIndexMu.Unlock()
	wakeMarkdownIndexConsumer()
}

func markdownIndexConsumer() {
	for {
		markdownIndexMu.Lock()
		if 0 == len(markdownIndexOrder) {
			markdownIndexMu.Unlock()
			<-markdownIndexWake
			continue
		}
		if 0 == markdownIndexWaiters {
			if remaining := time.Until(markdownIndexPending[markdownIndexOrder[0]].readyAt); 0 < remaining {
				markdownIndexMu.Unlock()
				timer := time.NewTimer(remaining)
				select {
				case <-timer.C:
				case <-markdownIndexWake:
					if !timer.Stop() {
						<-timer.C
					}
				}
				// Re-read the head after the pause: it may have absorbed newer
				// saves of the same document, another document may now lead, or a
				// strict reader barrier may have cut the idle delay short.
				continue
			}
		}
		key := markdownIndexOrder[0]
		markdownIndexOrder = markdownIndexOrder[1:]
		job := markdownIndexPending[key]
		delete(markdownIndexPending, key)
		markdownIndexRunning++
		markdownIndexMu.Unlock()

		indexMarkdownJob(job)

		markdownIndexMu.Lock()
		markdownIndexRunning--
		if 0 == len(markdownIndexOrder) && 0 == markdownIndexRunning {
			close(markdownIndexIdle)
		}
		markdownIndexMu.Unlock()
	}
}

func indexMarkdownJob(job markdownIndexJob) {
	tree, partial := job.tree, false
	if nil == tree {
		tree, partial = incrementalMarkdownTree(job)
	}
	if nil == tree {
		tree = filesys.LoadMarkdownTreeByData(job.source, job.boxID, job.path, util.NewLute())
	}
	if nil == tree || nil == tree.Root {
		return
	}
	if nil != job.snapshot && !partial {
		// The save response does not need a CommonMark tree. Once the worker has
		// paid for the parse needed by the indexes, retain that exact immutable
		// tree on the corresponding snapshot so a later load does not parse the
		// same source a second time.
		//
		// A partial tree is never retained: its unchanged blocks are identity-only
		// placeholders, so anything that reads content from it would see an empty
		// document.
		job.snapshot.treeOnce.Do(func() { job.snapshot.tree = tree })
	}
	upsertLoadedMarkdownTree(tree)
}

// incrementalMarkdownTree builds a tree in which only the blocks this save
// changed were handed to Lute.
//
// The index is the authority for what may be skipped: a block is represented by
// a placeholder only when its key — derived from its own source bytes — is
// already an indexed row, which is proof the row still describes it. So a
// placeholder can never introduce a row, only decline to rewrite one.
func incrementalMarkdownTree(job markdownIndexJob) (tree *parse.Tree, partial bool) {
	if 1 > len(job.source) {
		return nil, false
	}
	// Everything that can rule the incremental path out is decided from the
	// source alone, before the database is touched: the query below is only
	// worth its round trip once the document is known to be splittable.
	if _, ok := filesys.MarkdownBlockProjectionKeys(job.source, job.boxID, job.path); !ok {
		return nil, false
	}
	rootID := filesys.MarkdownProjectionID(job.source, job.boxID, job.path)
	indexed := sql.IndexedBlockTypes(rootID, job.boxID)
	if 1 > len(indexed) {
		return nil, false
	}
	ret, ok := filesys.MarkdownIncrementalTree(job.source, job.boxID, job.path, util.NewLute(), indexed)
	if !ok {
		return nil, false
	}
	return ret, true
}

// WaitMarkdownIndex blocks until every Markdown document queued so far has been
// committed to the block-tree and SQL indexes. Callers that must observe a save
// through the index — block-reference resolution, search, shutdown, tests — use
// this instead of assuming the save request already did the work.
func WaitMarkdownIndex() {
	markdownIndexMu.Lock()
	if 0 == len(markdownIndexOrder) && 0 == markdownIndexRunning {
		markdownIndexMu.Unlock()
		return
	}
	markdownIndexWaiters++
	idle := markdownIndexIdle
	markdownIndexMu.Unlock()
	// The consumer may be in its coalescing delay. Wake it immediately: a
	// caller asking for a current index is more important than idle batching.
	wakeMarkdownIndexConsumer()
	<-idle
	markdownIndexMu.Lock()
	markdownIndexWaiters--
	markdownIndexMu.Unlock()
}
