package model

import (
	"os"
	"testing"
)

func TestSupervisorProcessAlive(t *testing.T) {
	if !supervisorProcessAlive(os.Getpid()) {
		t.Fatal("current test process should be visible to the kernel supervisor watcher")
	}
	if supervisorProcessAlive(-1) {
		t.Fatal("invalid supervisor pid must not be reported alive")
	}
}
