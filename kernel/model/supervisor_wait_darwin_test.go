//go:build darwin

package model

import (
	"os/exec"
	"testing"
	"time"
)

func TestWaitSupervisorProcessExitUsesDarwinEvent(t *testing.T) {
	process := exec.Command("sleep", "0.05")
	if err := process.Start(); nil != err {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		observed, err := waitSupervisorProcessExit(process.Process.Pid)
		if nil == err && !observed {
			err = exec.ErrNotFound
		}
		done <- err
	}()
	if err := process.Wait(); nil != err {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if nil != err {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Darwin process-exit watcher did not wake")
	}
}
