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
	"time"

	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/task"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/siyuan-note/logging"
)

func StartCron(supervisorPID ...int) {
	task.StartQueueConsumer()
	sql.StartQueueConsumers()
	util.StartAssetsTextsSaver()
	model.StartAutoFixIndexScheduler()
	go every(2*time.Hour, model.StatJob)
	// No unattended call to SiYuan's cloud. This job fetched
	// <cloud>/apis/siyuan/version at every kernel start and every six hours
	// thereafter, which in a fork that removed the cloud is a phone-home and a
	// periodic radio wake for a result nothing was waiting on. The bazaar still
	// resolves the same value lazily through util.GetRhyBazaarHash when someone
	// actually opens it, so the capability is intact — only the timer is gone.
	go every(2*time.Hour, model.RefreshCheckJob2H)
	go every(6*time.Hour, model.RefreshCheckJob6H)
	go every(10*time.Minute, model.IndexEmbedBlockJob)
	go every(10*time.Minute, model.CacheVirtualBlockRefJob)
	go startOCRAssetsJob()
	if 0 == len(supervisorPID) || supervisorPID[0] <= 0 {
		// Legacy attached UIs have no owned host process to watch. Noema.app
		// passes a supervisor PID and uses the native process-exit event instead,
		// avoiding this compatibility poll entirely while idle.
		go every(30*time.Second, model.HookDesktopUIProcJob)
	}
	go every(30*time.Minute, model.AutoCheckMicrosoftDefenderJob)
	go every(24*time.Hour, model.ClearOutdatedHistoryDirJob)
	if util.IsMobileContainer() {
		go every(3*time.Second, model.AutoConsumeShorthandsJob)
	}

	model.StartPushQueueConsumer()
}

func startOCRAssetsJob() {
	util.WaitForTesseractInit()
	if !util.TesseractEnabled {
		return
	}
	every(30*time.Second, model.OCRAssetsJob)
}

func every(interval time.Duration, f func(), name ...string) {
	util.RandomSleep(50, 200)

	// 启动后立即执行一次
	func() {
		defer logging.Recover()
		f()
		if 0 < len(name) {
			logging.LogInfof("cron job [%s] executed", name)
		}
	}()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		func() {
			defer logging.Recover()
			f()
			if 0 < len(name) {
				logging.LogInfof("cron job [%s] executed", name)
			}
		}()
	}
}
