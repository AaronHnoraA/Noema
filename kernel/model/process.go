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
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/aaronhe/noema/kernel/util"
	goPS "github.com/mitchellh/go-ps"
	"github.com/siyuan-note/logging"
)

func HandleSignal() {
	c := make(chan os.Signal, 1)
	signal.Notify(c, syscall.SIGINT, syscall.SIGQUIT, syscall.SIGTERM)
	s := <-c
	logging.LogInfof("received os signal [%s], exit kernel process now", s)
	Close(false, true, 1)
}

// WatchSupervisorProcess binds an owned kernel to the shared Node web host.
// Emacs launches that host, so the UI adapter does not need its own kernel
// lifecycle implementation. A short consecutive-miss threshold avoids
// turning a transient process-table read error into data loss.
func WatchSupervisorProcess(pid int) {
	if pid <= 0 || pid == os.Getpid() {
		logging.LogWarnf("ignore invalid kernel supervisor pid [%d]", pid)
		return
	}
	if observed, err := waitSupervisorProcessExit(pid); nil == err && observed {
		logging.LogWarnf("web-host supervisor [%d] exited, stop kernel gracefully", pid)
		Close(false, true, 1)
		return
	} else if nil != err {
		logging.LogWarnf("watch supervisor [%d] by process event failed, use compatibility polling: %s", pid, err)
	}
	const missingThreshold = 3
	missing := 0
	for !util.IsExiting.Load() {
		if !supervisorProcessAlive(pid) {
			missing++
			if missing >= missingThreshold {
				logging.LogWarnf("web-host supervisor [%d] exited, stop kernel gracefully", pid)
				Close(false, true, 1)
				return
			}
		} else {
			missing = 0
		}
		time.Sleep(2 * time.Second)
	}
}

func supervisorProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := goPS.FindProcess(pid)
	return nil == err && nil != proc
}
