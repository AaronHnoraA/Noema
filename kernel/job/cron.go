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

package job

import (
	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/task"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/siyuan-note/logging"
)

// StartCron starts the kernel's background work.
//
// Everything here is event-driven: a queue consumer parked on a channel, or a
// scheduler that arms a timer only after real activity. Noema deliberately runs
// no periodic polling. SiYuan's inherited ticker jobs each woke the machine on
// a fixed cadence for work that was either redundant, unreachable in Noema's
// Markdown model, or read by nobody:
//
//   - OCR assets, every 30s — the highest-frequency idle wake in the kernel. Its
//     text feeds SiYuan's own asset search; Noema searches through its own path.
//     On-demand OCR stays available at /api/asset/{ocr,setImageOCRText}.
//   - Index embed blocks, every 10m — serves SiYuan's {{...}} embed syntax, which
//     does not exist in Noema's Markdown. /api/search/updateEmbedBlock remains.
//   - Cache virtual block refs, every 10m — Conf.Editor.VirtualBlockRef defaults
//     to off, and eight event-driven sites already call ResetVirtualBlockRefCache
//     when indexing, mounting or settings actually change it.
//   - Stat, every 2h — walked the whole data directory to fill Conf.Stat, which
//     /api/system strips out of its response before anyone can read it.
//   - Refresh checks (2h/6h) and the Microsoft Defender check (30m) — already
//     no-op stubs here: cloud is gone, and the Defender check is Windows-only.
//   - Consume shorthands, every 3s — mobile containers only; Noema has none.
//   - Hook desktop UI proc, every 30s — a liveness poll for legacy attached UIs.
//     Noema passes a supervisor PID and uses the process-exit event instead, so
//     the poll was already switched off for every real Noema host.
//
// History pruning does still have to happen, since asset, attribute-view and
// bookmark edits write into the history directory. It runs once at startup
// rather than on a 24-hour ticker, which is the same guarantee for a kernel
// whose lifetime is the app's.
func StartCron(_ ...int) {
	task.StartQueueConsumer()
	sql.StartQueueConsumers()
	util.StartAssetsTextsSaver()
	model.StartAutoFixIndexScheduler()
	model.StartPushQueueConsumer()
	go clearOutdatedHistoryOnce()
}

func clearOutdatedHistoryOnce() {
	defer logging.Recover()
	util.RandomSleep(50, 200)
	model.ClearOutdatedHistoryDirJob()
}
