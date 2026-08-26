package vaultgit

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func gitTestCommand(t *testing.T, repository string, args ...string) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is unavailable")
	}
	command := exec.Command("git", append([]string{"-C", repository}, args...)...)
	command.Env = append(os.Environ(), "LC_ALL=C", "LANG=C", "GIT_TERMINAL_PROMPT=0")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

func setupGitRepository(t *testing.T) string {
	t.Helper()
	repository := t.TempDir()
	gitTestCommand(t, repository, "init", "--initial-branch=main")
	gitTestCommand(t, repository, "config", "user.name", "Noema Test")
	gitTestCommand(t, repository, "config", "user.email", "test@example.com")
	if err := os.WriteFile(filepath.Join(repository, "a.md"), []byte("# A\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repository, "b.md"), []byte("# B\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCommand(t, repository, "add", ".")
	gitTestCommand(t, repository, "commit", "-m", "initial")
	return repository
}

func TestStatusReportsPorcelainContract(t *testing.T) {
	repository := setupGitRepository(t)
	if err := os.WriteFile(filepath.Join(repository, "a.md"), []byte("# A\n\nChanged\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	status, err := Status(context.Background(), repository)
	if err != nil {
		t.Fatal(err)
	}
	if status.Branch != "main" || status.Remote != "" || status.Clean || !strings.Contains(status.Status, "M a.md") || status.Source != "kernel-vaultgit" {
		t.Fatalf("unexpected status: %+v", status)
	}
}

func TestCommitTouchesOnlySelectedPaths(t *testing.T) {
	repository := setupGitRepository(t)
	for _, name := range []string{"a.md", "b.md"} {
		if err := os.WriteFile(filepath.Join(repository, name), []byte("# changed "+name+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	result, err := Action(context.Background(), repository, ActionRequest{
		Action: "commit", Message: "selected", Paths: []string{"a.md"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "commit" || result.Phase != "idle" || result.Clean || !strings.Contains(result.Status, "b.md") {
		t.Fatalf("unexpected commit result: %+v", result)
	}
	if files := gitTestCommand(t, repository, "show", "--format=", "--name-only", "HEAD"); files != "a.md" {
		t.Fatalf("selected commit touched %q", files)
	}
}

func TestCheckpointStagesAllAndUsesRepositoryIdentity(t *testing.T) {
	repository := setupGitRepository(t)
	if err := os.WriteFile(filepath.Join(repository, "a.md"), []byte("# checkpointed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(repository, "b.md")); err != nil {
		t.Fatal(err)
	}
	result, err := Checkpoint(context.Background(), repository, CheckpointRequest{
		Branch: "main", Message: "checkpoint test", DeviceName: "test-device", DeviceID: "01234567-device",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Source != "kernel-vaultgit" || !result.Committed || result.ChangedFiles != 2 ||
		result.IdentityFallback || result.Head == "" || result.Branch != "main" {
		t.Fatalf("unexpected checkpoint: %+v", result)
	}
	if subject := gitTestCommand(t, repository, "log", "-1", "--format=%s"); subject != "checkpoint test" {
		t.Fatalf("unexpected checkpoint subject: %q", subject)
	}
	if author := gitTestCommand(t, repository, "log", "-1", "--format=%an <%ae>"); author != "Noema Test <test@example.com>" {
		t.Fatalf("unexpected checkpoint author: %q", author)
	}
	clean, err := Checkpoint(context.Background(), repository, CheckpointRequest{
		Branch: "main", DeviceName: "test-device", DeviceID: "01234567-device",
	})
	if err != nil {
		t.Fatal(err)
	}
	if clean.Committed || clean.ChangedFiles != 0 || clean.Head != result.Head {
		t.Fatalf("clean checkpoint changed repository: %+v", clean)
	}
}

func TestCheckpointUsesBoundedFallbackIdentityAndRejectsWrongBranch(t *testing.T) {
	repository := setupGitRepository(t)
	gitTestCommand(t, repository, "config", "user.name", "")
	gitTestCommand(t, repository, "config", "user.email", "")
	if err := os.WriteFile(filepath.Join(repository, "a.md"), []byte("# fallback identity\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := Checkpoint(context.Background(), repository, CheckpointRequest{
		Branch: "main", DeviceName: "workstation", DeviceID: "abcdef12-3456",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Committed || !result.IdentityFallback || result.ChangedFiles != 1 {
		t.Fatalf("unexpected fallback checkpoint: %+v", result)
	}
	if author := gitTestCommand(t, repository, "log", "-1", "--format=%an <%ae>"); author != "Noema (workstation) <noema-abcdef12@local>" {
		t.Fatalf("unexpected fallback author: %q", author)
	}
	if subject := gitTestCommand(t, repository, "log", "-1", "--format=%s"); !strings.HasPrefix(subject, "noema: checkpoint 1 file · ") {
		t.Fatalf("unexpected default checkpoint subject: %q", subject)
	}
	if _, err = Checkpoint(context.Background(), repository, CheckpointRequest{
		Branch: "other", DeviceName: "workstation", DeviceID: "abcdef12-3456",
	}); err == nil || !strings.Contains(err.Error(), "checked-out branch") {
		t.Fatalf("expected branch mismatch, got %v", err)
	}
}

func TestOriginMainTransportBootstrapFetchAndExactPush(t *testing.T) {
	repository := setupGitRepository(t)
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	gitTestCommand(t, root, "init", "--bare", "--initial-branch=main", remote)
	gitTestCommand(t, repository, "remote", "add", "origin", remote)
	initialHead := gitTestCommand(t, repository, "rev-parse", "HEAD")

	bootstrap, err := EnsureOriginMain(context.Background(), repository, initialHead)
	if err != nil {
		t.Fatal(err)
	}
	if bootstrap.Action != "ensure-main" || !bootstrap.Bootstrapped || bootstrap.Commit != initialHead ||
		bootstrap.RemoteHead != initialHead || bootstrap.Source != "kernel-vaultgit" {
		t.Fatalf("unexpected bootstrap result: %+v", bootstrap)
	}
	second, err := EnsureOriginMain(context.Background(), repository, initialHead)
	if err != nil {
		t.Fatal(err)
	}
	if second.Bootstrapped || second.RemoteHead != initialHead {
		t.Fatalf("existing main was not preserved: %+v", second)
	}

	collaborator := filepath.Join(root, "collaborator")
	gitTestCommand(t, root, "clone", remote, collaborator)
	gitTestCommand(t, collaborator, "config", "user.name", "Collaborator")
	gitTestCommand(t, collaborator, "config", "user.email", "collaborator@example.com")
	if err = os.WriteFile(filepath.Join(collaborator, "remote.md"), []byte("# Remote\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCommand(t, collaborator, "add", "remote.md")
	gitTestCommand(t, collaborator, "commit", "-m", "remote advance")
	gitTestCommand(t, collaborator, "push", "origin", "main")
	collaboratorHead := gitTestCommand(t, collaborator, "rev-parse", "HEAD")

	fetched, err := FetchOriginMain(context.Background(), repository)
	if err != nil {
		t.Fatal(err)
	}
	if fetched.Action != "fetch-main" || fetched.RemoteHead != collaboratorHead || fetched.Source != "kernel-vaultgit" {
		t.Fatalf("unexpected fetch result: %+v", fetched)
	}
	gitTestCommand(t, repository, "merge", "--ff-only", "refs/remotes/origin/main")
	if err = os.WriteFile(filepath.Join(repository, "local.md"), []byte("# Local\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCommand(t, repository, "add", "local.md")
	gitTestCommand(t, repository, "commit", "-m", "local advance")
	localHead := gitTestCommand(t, repository, "rev-parse", "HEAD")
	pushed, err := PushOriginMain(context.Background(), repository, localHead)
	if err != nil {
		t.Fatal(err)
	}
	if pushed.Action != "push-main" || pushed.Commit != localHead || pushed.RemoteHead != localHead ||
		pushed.Source != "kernel-vaultgit" {
		t.Fatalf("unexpected push result: %+v", pushed)
	}
	if remoteHead := gitTestCommand(t, repository, "ls-remote", "origin", "refs/heads/main"); !strings.HasPrefix(remoteHead, localHead+"\t") {
		t.Fatalf("origin/main does not contain exact pushed commit: %q", remoteHead)
	}

	gitTestCommand(t, collaborator, "pull", "--ff-only")
	if err = os.WriteFile(filepath.Join(collaborator, "race.md"), []byte("# Race\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCommand(t, collaborator, "add", "race.md")
	gitTestCommand(t, collaborator, "commit", "-m", "win remote race")
	gitTestCommand(t, collaborator, "push", "origin", "main")
	if _, err = PushOriginMain(context.Background(), repository, localHead); err == nil {
		t.Fatal("expected non-fast-forward push rejection")
	}
}

func TestOriginMainTransportRejectsUnrelatedBranchBootstrap(t *testing.T) {
	repository := setupGitRepository(t)
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	gitTestCommand(t, root, "init", "--bare", "--initial-branch=main", remote)
	gitTestCommand(t, repository, "remote", "add", "origin", remote)
	gitTestCommand(t, repository, "push", "origin", "HEAD:refs/heads/develop")
	head := gitTestCommand(t, repository, "rev-parse", "HEAD")

	if _, err := EnsureOriginMain(context.Background(), repository, head); err == nil ||
		!strings.Contains(err.Error(), "refs/heads/develop") {
		t.Fatalf("expected unrelated branch rejection, got %v", err)
	}
}

func TestPullReportsExactChangedPaths(t *testing.T) {
	seed := setupGitRepository(t)
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	gitTestCommand(t, seed, "clone", "--bare", ".", remote)
	local := filepath.Join(root, "local")
	collaborator := filepath.Join(root, "collaborator")
	command := exec.Command("git", "clone", remote, local)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("clone local: %v\n%s", err, output)
	}
	command = exec.Command("git", "clone", remote, collaborator)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("clone collaborator: %v\n%s", err, output)
	}
	gitTestCommand(t, collaborator, "config", "user.name", "Collaborator")
	gitTestCommand(t, collaborator, "config", "user.email", "collaborator@example.com")
	if err := os.WriteFile(filepath.Join(collaborator, "incoming.md"), []byte("# Incoming\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCommand(t, collaborator, "add", "incoming.md")
	gitTestCommand(t, collaborator, "commit", "-m", "incoming")
	gitTestCommand(t, collaborator, "push")

	result, err := Action(context.Background(), local, ActionRequest{Action: "pull"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.ChangedPaths) != 1 || result.ChangedPaths[0] != "incoming.md" || result.Message != "Repository refreshed" {
		t.Fatalf("unexpected pull result: %+v", result)
	}
}

func TestActionRejectsUnsafeOrUnsupportedRequests(t *testing.T) {
	repository := setupGitRepository(t)
	for _, request := range []ActionRequest{
		{Action: "commit", Message: "unsafe", Paths: []string{"../outside.md"}},
		{Action: "commit", Message: "unsafe", Paths: []string{".git/config"}},
		{Action: "reset"},
	} {
		if _, err := Action(context.Background(), repository, request); err == nil {
			t.Fatalf("expected request to fail: %+v", request)
		}
	}
}

func TestChangedPathsPreserveValidGitNames(t *testing.T) {
	paths, err := changedPaths(".noema/state.json\x00 leading-space.md\x00nested/file.md\x00")
	if err != nil {
		t.Fatal(err)
	}
	expected := []string{".noema/state.json", " leading-space.md", "nested/file.md"}
	if len(paths) != len(expected) {
		t.Fatalf("unexpected changed paths: %#v", paths)
	}
	for index := range expected {
		if paths[index] != expected[index] {
			t.Fatalf("changed path %d: got %q, want %q", index, paths[index], expected[index])
		}
	}
	for _, unsafe := range []string{"../outside.md\x00", "/absolute.md\x00", "nested/../outside.md\x00"} {
		if _, err = changedPaths(unsafe); nil == err {
			t.Fatalf("expected unsafe Git path rejection for %q", unsafe)
		}
	}
}

func TestHistoryDiffAndFileVersionPreserveCommitBytes(t *testing.T) {
	repository := setupGitRepository(t)
	second := "# A\n\nVersion two\n"
	if err := os.WriteFile(filepath.Join(repository, "a.md"), []byte(second), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCommand(t, repository, "add", "a.md")
	gitTestCommand(t, repository, "commit", "-m", "second version")

	history, err := History(context.Background(), repository, "a.md", 50)
	if err != nil {
		t.Fatal(err)
	}
	if history.Source != "kernel-vaultgit" || history.Path != "a.md" || len(history.Commits) != 2 ||
		history.Commits[0].Subject != "second version" || history.Commits[0].Author != "Noema Test" {
		t.Fatalf("unexpected history: %+v", history)
	}
	diff, err := Diff(context.Background(), repository, "a.md", history.Commits[0].SHA)
	if err != nil {
		t.Fatal(err)
	}
	if diff.Scope != "commit" || diff.Source != "kernel-vaultgit" || !strings.Contains(diff.Diff, "+Version two") {
		t.Fatalf("unexpected diff: %+v", diff)
	}
	version, err := ReadFileAtCommit(context.Background(), repository, "a.md", history.Commits[1].SHA)
	if err != nil {
		t.Fatal(err)
	}
	if version.Content != "# A\n" || version.Path != "a.md" || version.Source != "kernel-vaultgit" {
		t.Fatalf("historical bytes changed: %+v", version)
	}
	if _, err = Diff(context.Background(), repository, "a.md", "not-a-commit"); err == nil {
		t.Fatal("expected invalid commit rejection")
	}
}

func TestHistoryDiffAndFileVersionFollowRenames(t *testing.T) {
	repository := setupGitRepository(t)
	initialSHA := gitTestCommand(t, repository, "rev-parse", "HEAD")
	currentPath := " renamed.md"
	gitTestCommand(t, repository, "mv", "a.md", currentPath)
	gitTestCommand(t, repository, "commit", "-m", "rename page")
	renameSHA := gitTestCommand(t, repository, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(repository, currentPath), []byte("# Renamed\n\nAfter rename\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCommand(t, repository, "add", "--", currentPath)
	gitTestCommand(t, repository, "commit", "-m", "edit renamed page")

	history, err := History(context.Background(), repository, currentPath, 50)
	if err != nil {
		t.Fatal(err)
	}
	if history.Path != currentPath || len(history.Commits) != 3 ||
		history.Commits[1].SHA != renameSHA || history.Commits[2].SHA != initialSHA {
		t.Fatalf("unexpected rename-aware history: %+v", history)
	}
	diff, err := Diff(context.Background(), repository, currentPath, initialSHA[:12])
	if err != nil {
		t.Fatal(err)
	}
	if diff.Path != currentPath || !strings.Contains(diff.Diff, "+# A") {
		t.Fatalf("old-path diff was not resolved: %+v", diff)
	}
	version, err := ReadFileAtCommit(context.Background(), repository, currentPath, initialSHA)
	if err != nil {
		t.Fatal(err)
	}
	if version.Path != currentPath || version.Content != "# A\n" {
		t.Fatalf("old-path file version was not resolved: %+v", version)
	}
	if err = os.WriteFile(filepath.Join(repository, "b.md"), []byte("# unrelated\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCommand(t, repository, "add", "b.md")
	gitTestCommand(t, repository, "commit", "-m", "unrelated page")
	unrelatedSHA := gitTestCommand(t, repository, "rev-parse", "HEAD")
	if _, err = ReadFileAtCommit(context.Background(), repository, currentPath, unrelatedSHA); err == nil ||
		!strings.Contains(err.Error(), "not in the page history") {
		t.Fatalf("expected unrelated commit rejection, got %v", err)
	}
}
