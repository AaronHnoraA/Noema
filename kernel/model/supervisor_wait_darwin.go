//go:build darwin

package model

import (
	"errors"
	"syscall"

	"golang.org/x/sys/unix"
)

// waitSupervisorProcessExit blocks in the Darwin kernel until the watched
// host exits. Unlike process-table polling it causes no periodic wakeups while
// the editor is idle.
func waitSupervisorProcessExit(pid int) (bool, error) {
	queue, err := unix.Kqueue()
	if nil != err {
		return false, err
	}
	defer unix.Close(queue)
	changes := []unix.Kevent_t{{
		Ident: uint64(pid), Filter: unix.EVFILT_PROC,
		Flags: unix.EV_ADD | unix.EV_ENABLE | unix.EV_ONESHOT, Fflags: unix.NOTE_EXIT,
	}}
	events := make([]unix.Kevent_t, 1)
	for {
		count, waitErr := unix.Kevent(queue, changes, events, nil)
		changes = nil
		if errors.Is(waitErr, syscall.EINTR) {
			continue
		}
		if errors.Is(waitErr, syscall.ESRCH) {
			return true, nil
		}
		if nil != waitErr {
			return false, waitErr
		}
		if 0 < count {
			return true, nil
		}
	}
}
