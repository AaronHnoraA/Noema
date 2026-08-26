// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema's portable Git repository operations are Copyright (c) 2026 Aaron He
// and distributed under the same AGPL-3.0-or-later terms.

// Package vaultgit owns bounded, repository-local Git data operations for
// Noema's Markdown vaults. Higher-level sync policy, conflict presentation,
// repository manifests, and UI process supervision remain in the shared Node
// host.
package vaultgit

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	maxGitOutput      = 8 * 1024 * 1024
	maxHistoryCommits = 200
)

var errGitOutputLimit = errors.New("Git command output exceeded 8 MiB")

type StatusResult struct {
	Branch string `json:"branch"`
	Remote string `json:"remote"`
	Clean  bool   `json:"clean"`
	Status string `json:"status"`
	Source string `json:"source"`
}

type ActionRequest struct {
	Action  string
	Message string
	Paths   []string
}

type ActionResult struct {
	StatusResult
	Action       string   `json:"action"`
	Phase        string   `json:"phase"`
	ChangedPaths []string `json:"changedPaths"`
	Message      string   `json:"message"`
}

type CheckpointRequest struct {
	Branch     string
	Message    string
	DeviceName string
	DeviceID   string
}

type CheckpointResult struct {
	Branch           string `json:"branch"`
	Head             string `json:"head"`
	Committed        bool   `json:"committed"`
	ChangedFiles     int    `json:"changedFiles"`
	IdentityFallback bool   `json:"identityFallback"`
	Source           string `json:"source"`
}

type TransportResult struct {
	Action       string `json:"action"`
	Commit       string `json:"commit"`
	RemoteHead   string `json:"remoteHead"`
	Bootstrapped bool   `json:"bootstrapped"`
	Source       string `json:"source"`
}

type Commit struct {
	SHA     string `json:"sha"`
	Date    string `json:"date"`
	Author  string `json:"author"`
	Email   string `json:"email"`
	Subject string `json:"subject"`
}

type HistoryResult struct {
	Path    string   `json:"path"`
	Commits []Commit `json:"commits"`
	Source  string   `json:"source"`
}

type DiffResult struct {
	Path   string `json:"path"`
	Diff   string `json:"diff"`
	Scope  string `json:"scope"`
	SHA    string `json:"sha"`
	Source string `json:"source"`
}

type FileVersion struct {
	Path    string `json:"path"`
	SHA     string `json:"sha"`
	Content string `json:"content"`
	Source  string `json:"source"`
}

type historyEntry struct {
	Commit Commit
	Path   string
}

type commandResult struct {
	Stdout string
	Stderr string
	Code   int
}

type limitedBuffer struct {
	buffer bytes.Buffer
	limit  int
}

func (b *limitedBuffer) Write(data []byte) (int, error) {
	remaining := b.limit - b.buffer.Len()
	if remaining <= 0 {
		return 0, errGitOutputLimit
	}
	if len(data) > remaining {
		_, _ = b.buffer.Write(data[:remaining])
		return remaining, errGitOutputLimit
	}
	return b.buffer.Write(data)
}

func (b *limitedBuffer) String() string { return b.buffer.String() }

func runGit(ctx context.Context, repository string, allowFailure bool, args ...string) (commandResult, error) {
	command := exec.CommandContext(ctx, "git", append([]string{"-C", repository}, args...)...)
	command.Env = append(os.Environ(), "LC_ALL=C", "LANG=C", "GIT_TERMINAL_PROMPT=0")
	stdout := &limitedBuffer{limit: maxGitOutput}
	stderr := &limitedBuffer{limit: maxGitOutput}
	command.Stdout, command.Stderr = stdout, stderr
	err := command.Run()
	result := commandResult{Stdout: stdout.String(), Stderr: stderr.String()}
	if err == nil {
		return result, nil
	}
	if contextErr := ctx.Err(); contextErr != nil {
		return result, contextErr
	}
	if errors.Is(err, errGitOutputLimit) {
		return result, errGitOutputLimit
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		result.Code = exitError.ExitCode()
		if allowFailure {
			return result, nil
		}
	}
	detail := strings.TrimSpace(result.Stderr)
	if detail == "" {
		detail = strings.TrimSpace(result.Stdout)
	}
	if detail == "" {
		detail = err.Error()
	}
	return result, errors.New(detail)
}

func trimCommandOutput(value string) string {
	return strings.TrimSpace(strings.ReplaceAll(value, "\r\n", "\n"))
}

func validateRepository(repository string) (string, error) {
	repository, err := filepath.Abs(strings.TrimSpace(repository))
	if err != nil {
		return "", err
	}
	repository, err = filepath.EvalSymlinks(repository)
	if err != nil {
		return "", fmt.Errorf("resolve Git repository: %w", err)
	}
	info, err := os.Stat(repository)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("Git repository path is not a directory")
	}
	if _, err = os.Lstat(filepath.Join(repository, ".git")); err != nil {
		return "", errors.New("Git repository has no local .git metadata")
	}
	return repository, nil
}

func Status(ctx context.Context, repository string) (StatusResult, error) {
	repository, err := validateRepository(repository)
	if err != nil {
		return StatusResult{}, err
	}
	status, err := runGit(ctx, repository, false, "status", "--porcelain=v1", "--branch")
	if err != nil {
		return StatusResult{}, err
	}
	branch, err := runGit(ctx, repository, false, "branch", "--show-current")
	if err != nil {
		return StatusResult{}, err
	}
	remote, err := runGit(ctx, repository, true, "remote", "get-url", "origin")
	if err != nil {
		return StatusResult{}, err
	}
	statusText := strings.ReplaceAll(status.Stdout, "\r\n", "\n")
	clean := true
	for _, line := range strings.Split(statusText, "\n") {
		if line != "" && !strings.HasPrefix(line, "##") {
			clean = false
			break
		}
	}
	return StatusResult{
		Branch: trimCommandOutput(branch.Stdout),
		Remote: trimCommandOutput(remote.Stdout),
		Clean:  clean,
		Status: strings.TrimSpace(statusText),
		Source: "kernel-vaultgit",
	}, nil
}

var ignoredPathParts = map[string]bool{
	".git": true, ".direnv": true, ".lake": true, ".noema": true,
	".venv": true, "node_modules": true, "__pycache__": true,
	".ipynb_checkpoints": true, ".pytest_cache": true, ".mypy_cache": true,
	".ruff_cache": true,
}

var commitPattern = regexp.MustCompile(`^[0-9a-fA-F]{7,64}$`)

func cleanRelativePath(value string) (string, error) {
	raw := strings.TrimLeft(strings.ReplaceAll(strings.TrimSpace(value), "\\", "/"), "/")
	if raw == "" {
		return "", errors.New("empty repository-relative path")
	}
	parts := strings.Split(raw, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || ignoredPathParts[part] {
			return "", errors.New("invalid repository-relative path")
		}
	}
	return strings.Join(parts, "/"), nil
}

func cleanCommit(value string) (string, error) {
	sha := strings.TrimSpace(value)
	if !commitPattern.MatchString(sha) {
		return "", errors.New("Invalid Git commit")
	}
	return sha, nil
}

// cleanTrackedPath validates a repository-relative path supplied by Noema's
// own page catalog. Unlike commit pathspecs, tracked page names are byte-exact:
// leading/trailing spaces and hidden directories are legal Git names.
func cleanTrackedPath(value string) (string, error) {
	raw := strings.ReplaceAll(value, "\\", "/")
	if raw == "" || strings.HasPrefix(raw, "/") || filepath.IsAbs(filepath.FromSlash(raw)) {
		return "", errors.New("invalid repository-relative path")
	}
	for _, part := range strings.Split(raw, "/") {
		if part == "" || part == "." || part == ".." || part == ".git" {
			return "", errors.New("invalid repository-relative path")
		}
	}
	return raw, nil
}

func parseHistory(value string) ([]historyEntry, error) {
	entries := []historyEntry{}
	fields := strings.Split(value, "\x00")
	if len(fields) > 0 && fields[len(fields)-1] == "" {
		fields = fields[:len(fields)-1]
	}
	if len(fields)%7 != 0 {
		return nil, errors.New("Git returned malformed file history")
	}
	for index := 0; index < len(fields); index += 7 {
		if !commitPattern.MatchString(fields[index]) || fields[index+5] != "" || !strings.HasPrefix(fields[index+6], "\n") {
			return nil, errors.New("Git returned malformed file history")
		}
		// --name-only -z still writes one format/name separator newline.
		// Remove exactly that byte, preserving a filename that itself starts
		// with a newline or any other whitespace.
		historicalPath, err := cleanTrackedPath(strings.TrimPrefix(fields[index+6], "\n"))
		if err != nil {
			return nil, errors.New("Git returned an unsafe historical path")
		}
		entries = append(entries, historyEntry{
			Commit: Commit{
				SHA: fields[index], Date: fields[index+1], Author: fields[index+2], Email: fields[index+3], Subject: fields[index+4],
			},
			Path: historicalPath,
		})
	}
	return entries, nil
}

func fileHistory(ctx context.Context, repository, path string, limit int) ([]historyEntry, error) {
	args := []string{
		"log", "--follow", "--format=%H%x00%aI%x00%an%x00%ae%x00%s%x00", "--name-only", "-z",
	}
	if limit > 0 {
		args = append(args, "-n", strconv.Itoa(limit))
	}
	args = append(args, "--", path)
	result, err := runGit(ctx, repository, false, args...)
	if err != nil {
		return nil, err
	}
	return parseHistory(result.Stdout)
}

func historicalPathAtCommit(ctx context.Context, repository, path, commit string) (string, error) {
	resolved, err := runGit(ctx, repository, false, "rev-parse", "--verify", commit+"^{commit}")
	if err != nil {
		return "", err
	}
	canonical := trimCommandOutput(resolved.Stdout)
	entries, err := fileHistory(ctx, repository, path, maxHistoryCommits)
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		if strings.EqualFold(entry.Commit.SHA, canonical) {
			return entry.Path, nil
		}
	}
	return "", errors.New("Git commit is not in the page history")
}

func History(ctx context.Context, repository, path string, limit int) (HistoryResult, error) {
	repository, err := validateRepository(repository)
	if err != nil {
		return HistoryResult{}, err
	}
	path, err = cleanTrackedPath(path)
	if err != nil {
		return HistoryResult{}, err
	}
	if limit < 1 {
		limit = 1
	} else if limit > maxHistoryCommits {
		limit = maxHistoryCommits
	}
	entries, err := fileHistory(ctx, repository, path, limit)
	if err != nil {
		return HistoryResult{}, err
	}
	commits := []Commit{}
	for _, entry := range entries {
		commits = append(commits, entry.Commit)
	}
	return HistoryResult{Path: path, Commits: commits, Source: "kernel-vaultgit"}, nil
}

func Diff(ctx context.Context, repository, path, commit string) (DiffResult, error) {
	repository, err := validateRepository(repository)
	if err != nil {
		return DiffResult{}, err
	}
	path, err = cleanTrackedPath(path)
	if err != nil {
		return DiffResult{}, err
	}
	commit, err = cleanCommit(commit)
	if err != nil {
		return DiffResult{}, err
	}
	historicalPath, err := historicalPathAtCommit(ctx, repository, path, commit)
	if err != nil {
		return DiffResult{}, err
	}
	result, err := runGit(ctx, repository, false,
		"show", "--format=", "--no-ext-diff", "--unified=80", commit, "--", historicalPath)
	if err != nil {
		return DiffResult{}, err
	}
	return DiffResult{
		Path: path, Diff: strings.TrimSpace(result.Stdout), Scope: "commit", SHA: commit, Source: "kernel-vaultgit",
	}, nil
}

func ReadFileAtCommit(ctx context.Context, repository, path, commit string) (FileVersion, error) {
	repository, err := validateRepository(repository)
	if err != nil {
		return FileVersion{}, err
	}
	path, err = cleanTrackedPath(path)
	if err != nil {
		return FileVersion{}, err
	}
	commit, err = cleanCommit(commit)
	if err != nil {
		return FileVersion{}, err
	}
	historicalPath, err := historicalPathAtCommit(ctx, repository, path, commit)
	if err != nil {
		return FileVersion{}, err
	}
	result, err := runGit(ctx, repository, false, "show", commit+":"+historicalPath)
	if err != nil {
		return FileVersion{}, err
	}
	return FileVersion{Path: path, SHA: commit, Content: result.Stdout, Source: "kernel-vaultgit"}, nil
}

func changedPaths(value string) ([]string, error) {
	paths := []string{}
	for _, raw := range strings.Split(value, "\x00") {
		if raw == "" {
			continue
		}
		// Git's -z output is already repository-relative and byte-exact. Do not
		// reuse user pathspec normalization here: hidden paths and filenames with
		// leading/trailing spaces are valid tracked paths and must remain exact.
		if filepath.IsAbs(filepath.FromSlash(raw)) {
			return nil, errors.New("Git returned an absolute changed path")
		}
		for _, part := range strings.Split(raw, "/") {
			if part == "" || part == "." || part == ".." {
				return nil, errors.New("Git returned an unsafe changed path")
			}
		}
		paths = append(paths, raw)
	}
	return paths, nil
}

func cleanCheckpointIdentity(value, label string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 256 || strings.ContainsAny(value, "\x00\r\n") {
		return "", fmt.Errorf("invalid checkpoint %s", label)
	}
	return value, nil
}

// Checkpoint commits the complete working tree on a branch already selected by
// the shared host. Cross-process leases, collision quarantine, branch switching,
// and durable sync state remain host orchestration responsibilities.
func Checkpoint(ctx context.Context, repository string, request CheckpointRequest) (CheckpointResult, error) {
	repository, err := validateRepository(repository)
	if err != nil {
		return CheckpointResult{}, err
	}
	branch := strings.TrimSpace(request.Branch)
	if branch == "" || len(branch) > 255 || strings.ContainsAny(branch, "\x00\r\n") {
		return CheckpointResult{}, errors.New("checkpoint branch is required")
	}
	if _, err = runGit(ctx, repository, false, "check-ref-format", "--branch", branch); err != nil {
		return CheckpointResult{}, err
	}
	current, err := runGit(ctx, repository, false, "branch", "--show-current")
	if err != nil {
		return CheckpointResult{}, err
	}
	if trimCommandOutput(current.Stdout) != branch {
		return CheckpointResult{}, errors.New("checkpoint branch does not match the checked-out branch")
	}
	deviceName, err := cleanCheckpointIdentity(request.DeviceName, "device name")
	if err != nil {
		return CheckpointResult{}, err
	}
	deviceID, err := cleanCheckpointIdentity(request.DeviceID, "device ID")
	if err != nil {
		return CheckpointResult{}, err
	}
	if _, err = runGit(ctx, repository, false, "add", "-A", "--", "."); err != nil {
		return CheckpointResult{}, err
	}
	staged, err := runGit(ctx, repository, true, "diff", "--cached", "--quiet", "--")
	if err != nil {
		return CheckpointResult{}, err
	}
	if staged.Code != 0 && staged.Code != 1 {
		detail := trimCommandOutput(staged.Stderr)
		if detail == "" {
			detail = "unable to inspect staged checkpoint changes"
		}
		return CheckpointResult{}, errors.New(detail)
	}
	result := CheckpointResult{Branch: branch, Source: "kernel-vaultgit"}
	if staged.Code == 1 {
		files, runErr := runGit(ctx, repository, false, "diff", "--cached", "--name-only", "-z", "--")
		if runErr != nil {
			return CheckpointResult{}, runErr
		}
		changed, pathErr := changedPaths(files.Stdout)
		if pathErr != nil {
			return CheckpointResult{}, pathErr
		}
		result.ChangedFiles = len(changed)

		name, runErr := runGit(ctx, repository, true, "config", "--get", "user.name")
		if runErr != nil {
			return CheckpointResult{}, runErr
		}
		email, runErr := runGit(ctx, repository, true, "config", "--get", "user.email")
		if runErr != nil {
			return CheckpointResult{}, runErr
		}
		authorName, authorEmail := trimCommandOutput(name.Stdout), trimCommandOutput(email.Stdout)
		if authorName == "" || authorEmail == "" {
			shortID := deviceID
			if len(shortID) > 8 {
				shortID = shortID[:8]
			}
			authorName = "Noema (" + deviceName + ")"
			authorEmail = "noema-" + shortID + "@local"
			result.IdentityFallback = true
		}
		message := request.Message
		if strings.TrimSpace(message) == "" {
			at := time.Now().UTC().Format("2006-01-02T15:04:05Z")
			suffix := "s"
			if result.ChangedFiles == 1 {
				suffix = ""
			}
			message = fmt.Sprintf("noema: checkpoint %d file%s · %s", result.ChangedFiles, suffix, at)
		}
		if len(message) > 64*1024 || strings.ContainsRune(message, '\x00') {
			return CheckpointResult{}, errors.New("invalid checkpoint message")
		}
		if _, err = runGit(ctx, repository, false,
			"-c", "user.name="+authorName,
			"-c", "user.email="+authorEmail,
			"commit", "-m", message); err != nil {
			return CheckpointResult{}, err
		}
		result.Committed = true
	}
	head, err := runGit(ctx, repository, true, "rev-parse", "HEAD")
	if err != nil {
		return CheckpointResult{}, err
	}
	if head.Code != 0 && result.Committed {
		return CheckpointResult{}, errors.New("unable to resolve checkpoint HEAD")
	}
	result.Head = trimCommandOutput(head.Stdout)
	return result, nil
}

func resolveGitCommit(ctx context.Context, repository, revision string) (string, error) {
	resolved, err := runGit(ctx, repository, false, "rev-parse", "--verify", revision+"^{commit}")
	if err != nil {
		return "", err
	}
	canonical := trimCommandOutput(resolved.Stdout)
	if !commitPattern.MatchString(canonical) {
		return "", errors.New("Git returned an invalid commit")
	}
	return canonical, nil
}

func canonicalCommit(ctx context.Context, repository, commit string) (string, error) {
	commit, err := cleanCommit(commit)
	if err != nil {
		return "", err
	}
	return resolveGitCommit(ctx, repository, commit)
}

func parseRemoteHeads(value string) (map[string]string, error) {
	heads := map[string]string{}
	for _, line := range strings.Split(strings.ReplaceAll(value, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 || !commitPattern.MatchString(fields[0]) || !strings.HasPrefix(fields[1], "refs/heads/") {
			return nil, errors.New("Git returned malformed remote heads")
		}
		heads[fields[1]] = fields[0]
	}
	return heads, nil
}

func commandResultError(result commandResult, fallback string) error {
	detail := trimCommandOutput(result.Stderr)
	if detail == "" {
		detail = trimCommandOutput(result.Stdout)
	}
	if detail == "" {
		detail = fallback
	}
	return errors.New(detail)
}

// EnsureOriginMain bootstraps an empty/Noema-only origin without choosing sync
// policy. The caller remains responsible for retry and error classification.
func EnsureOriginMain(ctx context.Context, repository, localHead string) (TransportResult, error) {
	repository, err := validateRepository(repository)
	if err != nil {
		return TransportResult{}, err
	}
	localHead, err = canonicalCommit(ctx, repository, localHead)
	if err != nil {
		return TransportResult{}, err
	}
	listed, err := runGit(ctx, repository, false, "ls-remote", "--heads", "origin")
	if err != nil {
		return TransportResult{}, err
	}
	heads, err := parseRemoteHeads(listed.Stdout)
	if err != nil {
		return TransportResult{}, err
	}
	if remoteHead := heads["refs/heads/main"]; remoteHead != "" {
		return TransportResult{
			Action: "ensure-main", Commit: localHead, RemoteHead: remoteHead, Source: "kernel-vaultgit",
		}, nil
	}
	unexpected := []string{}
	for ref := range heads {
		if !strings.HasPrefix(ref, "refs/heads/noema/") {
			unexpected = append(unexpected, ref)
		}
	}
	if len(unexpected) > 0 {
		sort.Strings(unexpected)
		return TransportResult{}, fmt.Errorf(
			"origin has no main branch and contains unrelated branches: %s", strings.Join(unexpected, ", "),
		)
	}
	mainExists, err := runGit(ctx, repository, true, "show-ref", "--verify", "--quiet", "refs/heads/main")
	if err != nil {
		return TransportResult{}, err
	}
	if mainExists.Code != 0 && mainExists.Code != 1 {
		return TransportResult{}, commandResultError(mainExists, "unable to inspect local main branch")
	}
	if mainExists.Code == 1 {
		if _, err = runGit(ctx, repository, false, "branch", "main", localHead); err != nil {
			return TransportResult{}, err
		}
	}
	mainHead, err := resolveGitCommit(ctx, repository, "refs/heads/main")
	if err != nil {
		return TransportResult{}, err
	}
	pushed, err := runGit(ctx, repository, true, "push", "origin", mainHead+":refs/heads/main")
	if err != nil {
		return TransportResult{}, err
	}
	if pushed.Code == 0 {
		return TransportResult{
			Action: "ensure-main", Commit: mainHead, RemoteHead: mainHead,
			Bootstrapped: true, Source: "kernel-vaultgit",
		}, nil
	}
	raced, err := runGit(ctx, repository, true,
		"ls-remote", "--exit-code", "--heads", "origin", "refs/heads/main")
	if err != nil {
		return TransportResult{}, err
	}
	if raced.Code == 0 {
		racedHeads, parseErr := parseRemoteHeads(raced.Stdout)
		if parseErr != nil {
			return TransportResult{}, parseErr
		}
		return TransportResult{
			Action: "ensure-main", Commit: mainHead,
			RemoteHead: racedHeads["refs/heads/main"], Source: "kernel-vaultgit",
		}, nil
	}
	return TransportResult{}, commandResultError(pushed, "unable to bootstrap origin/main")
}

func FetchOriginMain(ctx context.Context, repository string) (TransportResult, error) {
	repository, err := validateRepository(repository)
	if err != nil {
		return TransportResult{}, err
	}
	if _, err = runGit(ctx, repository, false, "fetch", "--prune", "origin", "main"); err != nil {
		return TransportResult{}, err
	}
	remoteHead, err := resolveGitCommit(ctx, repository, "refs/remotes/origin/main")
	if err != nil {
		return TransportResult{}, err
	}
	return TransportResult{
		Action: "fetch-main", RemoteHead: remoteHead, Source: "kernel-vaultgit",
	}, nil
}

func PushOriginMain(ctx context.Context, repository, commit string) (TransportResult, error) {
	repository, err := validateRepository(repository)
	if err != nil {
		return TransportResult{}, err
	}
	commit, err = canonicalCommit(ctx, repository, commit)
	if err != nil {
		return TransportResult{}, err
	}
	if _, err = runGit(ctx, repository, false, "push", "origin", commit+":refs/heads/main"); err != nil {
		return TransportResult{}, err
	}
	return TransportResult{
		Action: "push-main", Commit: commit, RemoteHead: commit, Source: "kernel-vaultgit",
	}, nil
}

func Action(ctx context.Context, repository string, request ActionRequest) (ActionResult, error) {
	repository, err := validateRepository(repository)
	if err != nil {
		return ActionResult{}, err
	}
	action := strings.TrimSpace(request.Action)
	paths := make([]string, 0, len(request.Paths))
	for _, raw := range request.Paths {
		path, pathErr := cleanRelativePath(raw)
		if pathErr != nil {
			return ActionResult{}, pathErr
		}
		paths = append(paths, path)
	}
	changed := []string{}
	switch action {
	case "pull":
		before, runErr := runGit(ctx, repository, false, "rev-parse", "HEAD")
		if runErr != nil {
			return ActionResult{}, runErr
		}
		if _, runErr = runGit(ctx, repository, false, "pull", "--ff-only"); runErr != nil {
			return ActionResult{}, runErr
		}
		after, runErr := runGit(ctx, repository, false, "rev-parse", "HEAD")
		if runErr != nil {
			return ActionResult{}, runErr
		}
		beforeSHA, afterSHA := trimCommandOutput(before.Stdout), trimCommandOutput(after.Stdout)
		if beforeSHA != afterSHA {
			diff, diffErr := runGit(ctx, repository, false, "diff", "--name-only", "-z", beforeSHA, afterSHA, "--")
			if diffErr != nil {
				return ActionResult{}, diffErr
			}
			changed, err = changedPaths(diff.Stdout)
			if err != nil {
				return ActionResult{}, err
			}
		}
	case "push":
		if _, err = runGit(ctx, repository, false, "push"); err != nil {
			return ActionResult{}, err
		}
	case "commit":
		message := strings.TrimSpace(request.Message)
		if message == "" {
			return ActionResult{}, errors.New("Commit message is required")
		}
		if len(paths) == 0 {
			return ActionResult{}, errors.New("Select at least one repository-relative path to commit")
		}
		if _, err = runGit(ctx, repository, false, append([]string{"add", "--"}, paths...)...); err != nil {
			return ActionResult{}, err
		}
		args := append([]string{"commit", "-m", message, "--"}, paths...)
		if _, err = runGit(ctx, repository, false, args...); err != nil {
			return ActionResult{}, err
		}
	default:
		return ActionResult{}, fmt.Errorf("Unsupported Git action: %s", action)
	}
	status, err := Status(ctx, repository)
	if err != nil {
		return ActionResult{}, err
	}
	message := "Git " + action + " completed"
	if action == "pull" {
		message = "Repository refreshed"
	}
	return ActionResult{
		StatusResult: status,
		Action:       action,
		Phase:        "idle",
		ChangedPaths: changed,
		Message:      message,
	}, nil
}
