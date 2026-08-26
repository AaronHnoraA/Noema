package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/gin-gonic/gin"
)

func setupVaultGitAPITest(t *testing.T) string {
	t.Helper()
	setupMarkdownDocAPITest(t)
	boxID := "20260826023133-vaultgt"
	box := &model.Box{ID: boxID}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Vault Git API test"
	boxConf.Closed = false
	if err := box.SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}
	return boxID
}

func vaultGitExec(t *testing.T, repository string, args ...string) string {
	t.Helper()
	if _, err := exec.LookPath("git"); nil != err {
		t.Skip("git is unavailable")
	}
	command := exec.Command("git", append([]string{"-C", repository}, args...)...)
	command.Env = append(os.Environ(), "LC_ALL=C", "LANG=C", "GIT_TERMINAL_PROMPT=0")
	output, err := command.CombinedOutput()
	if nil != err {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

func vaultGitRequest(t *testing.T, handler gin.HandlerFunc, path, body string) markdownDocResponse {
	t.Helper()
	engine := gin.New()
	engine.POST(path, handler)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, request)
	var response markdownDocResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); nil != err {
		t.Fatal(err)
	}
	return response
}

func TestNoemaVaultGitStatusAndSelectedCommitAPI(t *testing.T) {
	boxID := setupVaultGitAPITest(t)
	repository := filepath.Join(util.DataDir, boxID, "public", "notes")
	if err := os.MkdirAll(repository, 0o755); nil != err {
		t.Fatal(err)
	}
	vaultGitExec(t, repository, "init", "--initial-branch=main")
	vaultGitExec(t, repository, "config", "user.name", "Noema Test")
	vaultGitExec(t, repository, "config", "user.email", "test@example.com")
	for _, name := range []string{"a.md", "b.md"} {
		if err := os.WriteFile(filepath.Join(repository, name), []byte("# "+name+"\n"), 0o644); nil != err {
			t.Fatal(err)
		}
	}
	vaultGitExec(t, repository, "add", ".")
	vaultGitExec(t, repository, "commit", "-m", "initial")
	for _, name := range []string{"a.md", "b.md"} {
		if err := os.WriteFile(filepath.Join(repository, name), []byte("# changed "+name+"\n"), 0o644); nil != err {
			t.Fatal(err)
		}
	}

	statusResponse := vaultGitRequest(t, noemaVaultGitStatus, "/status",
		`{"notebook":"`+boxID+`","path":"/public/notes"}`)
	if 0 != statusResponse.Code {
		t.Fatalf("status API failed: %s", statusResponse.Msg)
	}
	var status struct {
		Branch string `json:"branch"`
		Clean  bool   `json:"clean"`
		Status string `json:"status"`
		Source string `json:"source"`
	}
	if err := json.Unmarshal(statusResponse.Data, &status); nil != err {
		t.Fatal(err)
	}
	if "main" != status.Branch || status.Clean || "kernel-vaultgit" != status.Source ||
		!strings.Contains(status.Status, "a.md") || !strings.Contains(status.Status, "b.md") {
		t.Fatalf("unexpected status response: %+v", status)
	}

	actionResponse := vaultGitRequest(t, noemaVaultGitAction, "/action",
		`{"notebook":"`+boxID+`","path":"/public/notes","action":"commit","message":"selected","paths":["a.md"]}`)
	if 0 != actionResponse.Code {
		t.Fatalf("action API failed: %s", actionResponse.Msg)
	}
	var action struct {
		Action string `json:"action"`
		Phase  string `json:"phase"`
		Clean  bool   `json:"clean"`
		Status string `json:"status"`
		Source string `json:"source"`
	}
	if err := json.Unmarshal(actionResponse.Data, &action); nil != err {
		t.Fatal(err)
	}
	if "commit" != action.Action || "idle" != action.Phase || action.Clean ||
		"kernel-vaultgit" != action.Source || !strings.Contains(action.Status, "b.md") {
		t.Fatalf("unexpected action response: %+v", action)
	}
	if files := vaultGitExec(t, repository, "show", "--format=", "--name-only", "HEAD"); "a.md" != files {
		t.Fatalf("selected commit touched %q", files)
	}

	checkpointResponse := vaultGitRequest(t, noemaVaultGitCheckpoint, "/checkpoint",
		`{"notebook":"`+boxID+`","path":"/public/notes","branch":"main","message":"checkpoint remaining","deviceName":"api-test","deviceId":"01234567-test"}`)
	if 0 != checkpointResponse.Code {
		t.Fatalf("checkpoint API failed: %s", checkpointResponse.Msg)
	}
	var checkpoint struct {
		Branch           string `json:"branch"`
		Head             string `json:"head"`
		Committed        bool   `json:"committed"`
		ChangedFiles     int    `json:"changedFiles"`
		IdentityFallback bool   `json:"identityFallback"`
		Source           string `json:"source"`
	}
	if err := json.Unmarshal(checkpointResponse.Data, &checkpoint); nil != err {
		t.Fatal(err)
	}
	if checkpoint.Branch != "main" || checkpoint.Head == "" || !checkpoint.Committed || checkpoint.ChangedFiles != 1 ||
		checkpoint.IdentityFallback || checkpoint.Source != "kernel-vaultgit" {
		t.Fatalf("unexpected checkpoint response: %+v", checkpoint)
	}
	if subject := vaultGitExec(t, repository, "log", "-1", "--format=%s"); subject != "checkpoint remaining" {
		t.Fatalf("unexpected checkpoint subject: %q", subject)
	}
}

func TestNoemaVaultGitAPIRejectsInvalidBoundaries(t *testing.T) {
	boxID := setupVaultGitAPITest(t)
	for _, test := range []struct {
		handler gin.HandlerFunc
		path    string
		body    string
	}{
		{noemaVaultGitStatus, "/status", `{}`},
		{noemaVaultGitStatus, "/status", `{"notebook":"` + boxID + `","path":"/../outside"}`},
		{noemaVaultGitAction, "/action", `{"notebook":"` + boxID + `","path":"/public/notes"}`},
		{noemaVaultGitCheckpoint, "/checkpoint", `{"notebook":"` + boxID + `","path":"/public/notes"}`},
		{noemaVaultGitTransport, "/transport", `{"notebook":"` + boxID + `","path":"/public/notes"}`},
		{noemaVaultGitTransport, "/transport", `{"notebook":"` + boxID + `","path":"/public/notes","action":"fetch-main","commit":"0123456789abcdef"}`},
		{noemaVaultGitHistory, "/history", `{"notebook":"` + boxID + `","path":"/public/notes"}`},
		{noemaVaultGitDiff, "/diff", `{"notebook":"` + boxID + `","path":"/public/notes","filePath":"page.md"}`},
		{noemaVaultGitRestore, "/restore", `{"notebook":"` + boxID + `","path":"/public/notes","filePath":"page.md"}`},
	} {
		response := vaultGitRequest(t, test.handler, test.path, test.body)
		if 0 == response.Code {
			t.Fatalf("request unexpectedly succeeded: %s", test.body)
		}
	}
}

func TestNoemaVaultGitTransportAPI(t *testing.T) {
	boxID := setupVaultGitAPITest(t)
	repository := filepath.Join(util.DataDir, boxID, "private", "transport")
	if err := os.MkdirAll(repository, 0o755); nil != err {
		t.Fatal(err)
	}
	vaultGitExec(t, repository, "init", "--initial-branch=main")
	vaultGitExec(t, repository, "config", "user.name", "Transport Test")
	vaultGitExec(t, repository, "config", "user.email", "transport@example.com")
	if err := os.WriteFile(filepath.Join(repository, "page.md"), []byte("# Transport\n"), 0o644); nil != err {
		t.Fatal(err)
	}
	vaultGitExec(t, repository, "add", "page.md")
	vaultGitExec(t, repository, "commit", "-m", "transport baseline")
	head := vaultGitExec(t, repository, "rev-parse", "HEAD")
	remoteRoot := t.TempDir()
	remote := filepath.Join(remoteRoot, "remote.git")
	vaultGitExec(t, remoteRoot, "init", "--bare", "--initial-branch=main", remote)
	vaultGitExec(t, repository, "remote", "add", "origin", remote)

	tests := []struct {
		action       string
		commit       string
		bootstrapped bool
	}{
		{action: "ensure-main", commit: head, bootstrapped: true},
		{action: "fetch-main"},
		{action: "push-main", commit: head},
	}
	for _, test := range tests {
		body := `{"notebook":"` + boxID + `","path":"/private/transport","action":"` + test.action + `"`
		if "" != test.commit {
			body += `,"commit":"` + test.commit + `"`
		}
		body += `}`
		response := vaultGitRequest(t, noemaVaultGitTransport, "/transport", body)
		if 0 != response.Code {
			t.Fatalf("%s API failed: %s", test.action, response.Msg)
		}
		var result struct {
			Action       string `json:"action"`
			Commit       string `json:"commit"`
			RemoteHead   string `json:"remoteHead"`
			Bootstrapped bool   `json:"bootstrapped"`
			Source       string `json:"source"`
		}
		if err := json.Unmarshal(response.Data, &result); nil != err {
			t.Fatal(err)
		}
		if result.Action != test.action || result.RemoteHead != head || result.Bootstrapped != test.bootstrapped ||
			result.Source != "kernel-vaultgit" {
			t.Fatalf("unexpected %s response: %+v", test.action, result)
		}
		if test.action != "fetch-main" && result.Commit != head {
			t.Fatalf("unexpected %s commit: %+v", test.action, result)
		}
	}
}

func TestNoemaVaultGitHistoryAndDiffAPI(t *testing.T) {
	boxID := setupVaultGitAPITest(t)
	repository := filepath.Join(util.DataDir, boxID, "private", "history")
	if err := os.MkdirAll(repository, 0o755); nil != err {
		t.Fatal(err)
	}
	vaultGitExec(t, repository, "init", "--initial-branch=main")
	vaultGitExec(t, repository, "config", "user.name", "Historian")
	vaultGitExec(t, repository, "config", "user.email", "history@example.test")
	file := filepath.Join(repository, "page.md")
	first := "# Version one\n\n"
	if err := os.WriteFile(file, []byte(first), 0o644); nil != err {
		t.Fatal(err)
	}
	vaultGitExec(t, repository, "add", "page.md")
	vaultGitExec(t, repository, "commit", "-m", "first version")
	if err := os.WriteFile(file, []byte("# Version two\n\n"), 0o644); nil != err {
		t.Fatal(err)
	}
	vaultGitExec(t, repository, "add", "page.md")
	vaultGitExec(t, repository, "commit", "-m", "second version")
	secondSHA := vaultGitExec(t, repository, "rev-parse", "HEAD")
	renamedPath := "renamed page.md"
	vaultGitExec(t, repository, "mv", "page.md", renamedPath)
	vaultGitExec(t, repository, "commit", "-m", "rename page")
	renameSHA := vaultGitExec(t, repository, "rev-parse", "HEAD")

	historyResponse := vaultGitRequest(t, noemaVaultGitHistory, "/history",
		`{"notebook":"`+boxID+`","path":"/private/history","filePath":"`+renamedPath+`","limit":50}`)
	if 0 != historyResponse.Code {
		t.Fatalf("history API failed: %s", historyResponse.Msg)
	}
	var history struct {
		Path    string `json:"path"`
		Source  string `json:"source"`
		Commits []struct {
			SHA, Author, Subject string
		} `json:"commits"`
	}
	if err := json.Unmarshal(historyResponse.Data, &history); nil != err {
		t.Fatal(err)
	}
	if history.Path != renamedPath || history.Source != "kernel-vaultgit" || len(history.Commits) != 3 ||
		history.Commits[0].SHA != renameSHA || history.Commits[1].SHA != secondSHA ||
		history.Commits[1].Author != "Historian" || history.Commits[1].Subject != "second version" {
		t.Fatalf("unexpected history response: %+v", history)
	}

	diffResponse := vaultGitRequest(t, noemaVaultGitDiff, "/diff",
		`{"notebook":"`+boxID+`","path":"/private/history","filePath":"`+renamedPath+`","sha":"`+secondSHA+`"}`)
	if 0 != diffResponse.Code {
		t.Fatalf("diff API failed: %s", diffResponse.Msg)
	}
	var diff struct {
		Diff, Scope, SHA, Source string
	}
	if err := json.Unmarshal(diffResponse.Data, &diff); nil != err {
		t.Fatal(err)
	}
	if diff.Scope != "commit" || diff.SHA != secondSHA || diff.Source != "kernel-vaultgit" || !strings.Contains(diff.Diff, "+# Version two") {
		t.Fatalf("unexpected diff response: %+v", diff)
	}

}
