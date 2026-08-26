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

package model

import (
	"testing"
	"time"
)

func TestDoUpdateRejectsInvalidData(t *testing.T) {
	tests := []any{nil, 1, ""}
	for _, data := range tests {
		tx := &Transaction{}
		err := tx.doUpdate(&Operation{ID: "20260718000000-abcdefg", Data: data})
		if nil == err {
			t.Fatalf("expected invalid update data [%v] to be rejected", data)
		}
		if TxErrCodePushMsg != err.Code() {
			t.Fatalf("expected invalid update data [%v] to return code [%d], got [%d]", data, TxErrCodePushMsg, err.Code())
		}
	}
}

func TestTxErrFromPanic(t *testing.T) {
	if err := txErrFromPanic(1, "test"); nil == err {
		t.Fatal("expected an active transaction panic to return an error")
	}
	if err := txErrFromPanic(2, "test"); nil != err {
		t.Fatal("expected a committed transaction panic to preserve the committed result")
	}
}

func TestTransactionWaitForCommitUsesCompletionSignal(t *testing.T) {
	tx := &Transaction{}
	tx.prepareDone()
	returned := make(chan struct{})
	go func() {
		tx.WaitForCommit()
		close(returned)
	}()

	select {
	case <-returned:
		t.Fatal("WaitForCommit returned before the transaction completed")
	case <-time.After(20 * time.Millisecond):
	}

	tx.signalDone()
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("WaitForCommit did not wake from the completion signal")
	}
}

func TestRenameRefConsumerSleepsWhenIdleAndCoalesces(t *testing.T) {
	changed := make(chan struct{}, 1)
	stop := make(chan struct{})
	flushed := make(chan struct{}, 2)
	go consumeUpdateRefTextRenameDocs(changed, 10*time.Millisecond, func() {
		flushed <- struct{}{}
	}, stop)
	t.Cleanup(func() { close(stop) })

	time.Sleep(25 * time.Millisecond)
	select {
	case <-flushed:
		t.Fatal("idle rename-ref queue flushed")
	default:
	}
	for range 8 {
		select {
		case changed <- struct{}{}:
		default:
		}
	}
	select {
	case <-flushed:
	case <-time.After(time.Second):
		t.Fatal("signaled rename-ref queue did not flush")
	}
	time.Sleep(25 * time.Millisecond)
	select {
	case <-flushed:
		t.Fatal("rename-ref notifications were not coalesced")
	default:
	}
}
