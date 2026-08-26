package util

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestUserConfigDirAndWorkspaceRegistryHonorNoemaOverride(t *testing.T) {
	configDir := filepath.Join(t.TempDir(), "noema-kernel-config")
	t.Setenv("NOEMA_KERNEL_CONFIG_DIR", configDir)

	if got := UserConfigDir(); got != configDir {
		t.Fatalf("UserConfigDir() = %q, want %q", got, configDir)
	}
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatalf("create config dir: %v", err)
	}

	want := []string{t.TempDir(), t.TempDir()}
	if err := WriteWorkspacePaths(want); err != nil {
		t.Fatalf("WriteWorkspacePaths: %v", err)
	}
	got, err := ReadWorkspacePaths()
	if err != nil {
		t.Fatalf("ReadWorkspacePaths: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ReadWorkspacePaths() = %#v, want %#v", got, want)
	}
	if _, err := os.Stat(filepath.Join(configDir, "workspace.json")); err != nil {
		t.Fatalf("Noema workspace registry missing: %v", err)
	}
}

func TestEnsureWorkspaceDirCreatesExplicitTargetWithoutFallback(t *testing.T) {
	base := t.TempDir()
	explicit := filepath.Join(base, "requested", "kernel-workspace")
	fallback := filepath.Join(base, "Library", "Application Support", "SiYuan")

	got, err := ensureWorkspaceDir(explicit, fallback, true)
	if err != nil {
		t.Fatalf("ensureWorkspaceDir: %v", err)
	}
	if got != explicit {
		t.Fatalf("ensureWorkspaceDir() = %q, want explicit %q", got, explicit)
	}
	if info, statErr := os.Stat(explicit); statErr != nil || !info.IsDir() {
		t.Fatalf("explicit workspace was not created: info=%v err=%v", info, statErr)
	}
	if _, statErr := os.Stat(fallback); !os.IsNotExist(statErr) {
		t.Fatalf("explicit workspace creation touched fallback %q: %v", fallback, statErr)
	}
}
