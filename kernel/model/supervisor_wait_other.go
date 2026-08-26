//go:build !darwin

package model

// Non-Darwin builds retain the compatibility process-table watcher until
// their native process-exit primitive is wired in.
func waitSupervisorProcessExit(_ int) (bool, error) { return false, nil }
