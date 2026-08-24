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
	"errors"
	"sync"
)

// Noema fork: cloud/LAN sync (model/sync.go, lan_sync.go, sync_dedup.go,
// api/sync.go) and the local dejavu snapshot repository (model/repository.go,
// api/repo.go) are removed; version history is git, not a second
// sync/snapshot engine.
//
// IncSync is called pervasively throughout the write path (block, file,
// asset, and attribute-view mutations across ~20 files) as a "mark dirty,
// plan a sync tick" hook. Rather than edit every call site, it is kept as a
// no-op so those call sites need no changes.
func IncSync() {}

// ExitSyncSucc, lockSync/unlockSync, stopLANSyncManager, closeSyncWebSocket
// and syncData are unexported internals the deleted sync engine used to
// guard import/boot/shutdown critical sections. Conf.Sync.Enabled can never
// become true now (SetSyncEnable is gone), so the syncData(...) call in
// Close() is unreachable; the rest are unconditional lifecycle hooks kept
// as no-ops so model/conf.go and model/import.go need no edits.
var ExitSyncSucc = -1

func lockSync()                  {}
func unlockSync()                {}
func stopLANSyncManager()        {}
func closeSyncWebSocket()        {}
func syncData(exit, byHand bool) {}

// syncingFiles/waitForSyncingStorages/IsSyncingFile originally lived in
// repository.go, guarding attribute-view and asset writes against a
// concurrent sync/snapshot pass. The "in-flight write" bookkeeping
// (syncingFiles, IsSyncingFile, used by model/assets.go and
// api/filetree.go) is still meaningful without sync, so it is kept;
// waitForSyncingStorages polled a sync-only "is a sync running" flag that no
// longer exists, so it is now a no-op.
var syncingFiles = sync.Map{}

func waitForSyncingStorages() {}
func isSyncingStorages() bool { return false }

// cancelPurge is called unconditionally from Close() (model/conf.go); the
// deleted repository.go used it to cancel a background repo-purge goroutine.
func cancelPurge() {}

func IsSyncingFile(rootID string) (ret bool) {
	_, ret = syncingFiles.Load(rootID)
	return
}

// SyncDataBeforeEnableEncryptedNotebook is called by model/crypto.go, whose
// encrypted-notebook feature is being removed in a separate pass; stubbed
// here only to keep this commit's build green in the meantime.
func SyncDataBeforeEnableEncryptedNotebook() error { return nil }

// IndexRepo backed the dejavu local snapshot repo. kernel/agent/agent.go
// calls it before any write-capable tool action to take a pre-mutation
// safety snapshot (needsCapabilitySnapshot/needsLocalSnapshot); on error it
// aborts that tool call rather than proceeding unprotected. Deliberately
// fails closed (not a silent no-op success) so the agent's write actions
// stay blocked until this is re-wired onto git (Phase 3 vaultgit), rather
// than quietly losing the safety net.
var ErrRepoSnapshotRemoved = errors.New("local snapshot repo is not available in this build; agent write actions are blocked until this is re-wired onto git")

func IndexRepo(memo string) (id string, err error) {
	return "", ErrRepoSnapshotRemoved
}
