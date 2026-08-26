// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema vault Git API additions are Copyright (c) 2026 Aaron He and
// distributed under the same AGPL-3.0-or-later terms.

package api

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/88250/gulu"
	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/noema/vaultgit"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/gin-gonic/gin"
)

func noemaVaultGitRepository(notebook, repositoryPath string) (string, error) {
	if nil == model.Conf.Box(notebook) {
		return "", model.ErrBoxNotFound
	}
	if conf.BoxKindMarkdown != model.GetBoxKind(notebook) {
		return "", errors.New("not a Markdown notebook")
	}
	normalized, err := filesys.ValidateBoxRelativePath(notebook, repositoryPath)
	if nil != err {
		return "", err
	}
	repository := filepath.Join(filesys.BoxRootPath(notebook), strings.TrimPrefix(normalized, "/"))
	info, err := os.Stat(repository)
	if nil != err {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("Git repository path is not a directory")
	}
	if _, err = os.Lstat(filepath.Join(repository, ".git")); nil != err {
		return "", errors.New("Git repository has no local .git metadata")
	}
	return repository, nil
}

func noemaVaultGitStatus(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	request := struct {
		Notebook *string `json:"notebook"`
		Path     *string `json:"path"`
	}{}
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	if nil == request.Notebook || "" == strings.TrimSpace(*request.Notebook) {
		ret.Code, ret.Msg = -1, "notebook is required"
		return
	}
	if nil == request.Path {
		ret.Code, ret.Msg = -1, "path is required"
		return
	}
	repository, err := noemaVaultGitRepository(*request.Notebook, *request.Path)
	if nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	status, err := vaultgit.Status(c.Request.Context(), repository)
	if nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = status
}

func noemaVaultGitAction(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	request := struct {
		Notebook *string  `json:"notebook"`
		Path     *string  `json:"path"`
		Action   *string  `json:"action"`
		Message  string   `json:"message"`
		Paths    []string `json:"paths"`
	}{}
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	if nil == request.Notebook || "" == strings.TrimSpace(*request.Notebook) {
		ret.Code, ret.Msg = -1, "notebook is required"
		return
	}
	if nil == request.Path {
		ret.Code, ret.Msg = -1, "path is required"
		return
	}
	if nil == request.Action || "" == strings.TrimSpace(*request.Action) {
		ret.Code, ret.Msg = -1, "action is required"
		return
	}
	repository, err := noemaVaultGitRepository(*request.Notebook, *request.Path)
	if nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	result, err := vaultgit.Action(c.Request.Context(), repository, vaultgit.ActionRequest{
		Action: *request.Action, Message: request.Message, Paths: request.Paths,
	})
	if nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = result
}

func noemaVaultGitCheckpoint(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	request := struct {
		Notebook   *string `json:"notebook"`
		Path       *string `json:"path"`
		Branch     *string `json:"branch"`
		Message    string  `json:"message"`
		DeviceName *string `json:"deviceName"`
		DeviceID   *string `json:"deviceId"`
	}{}
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	if nil == request.Notebook || "" == strings.TrimSpace(*request.Notebook) {
		ret.Code, ret.Msg = -1, "notebook is required"
		return
	}
	if nil == request.Path {
		ret.Code, ret.Msg = -1, "path is required"
		return
	}
	if nil == request.Branch || "" == strings.TrimSpace(*request.Branch) {
		ret.Code, ret.Msg = -1, "branch is required"
		return
	}
	if nil == request.DeviceName || "" == strings.TrimSpace(*request.DeviceName) {
		ret.Code, ret.Msg = -1, "deviceName is required"
		return
	}
	if nil == request.DeviceID || "" == strings.TrimSpace(*request.DeviceID) {
		ret.Code, ret.Msg = -1, "deviceId is required"
		return
	}
	repository, err := noemaVaultGitRepository(*request.Notebook, *request.Path)
	if nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	result, err := vaultgit.Checkpoint(c.Request.Context(), repository, vaultgit.CheckpointRequest{
		Branch: *request.Branch, Message: request.Message,
		DeviceName: *request.DeviceName, DeviceID: *request.DeviceID,
	})
	if nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = result
}

func noemaVaultGitTransport(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	request := struct {
		Notebook *string `json:"notebook"`
		Path     *string `json:"path"`
		Action   *string `json:"action"`
		Commit   string  `json:"commit"`
	}{}
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	if nil == request.Notebook || "" == strings.TrimSpace(*request.Notebook) {
		ret.Code, ret.Msg = -1, "notebook is required"
		return
	}
	if nil == request.Path {
		ret.Code, ret.Msg = -1, "path is required"
		return
	}
	if nil == request.Action || "" == strings.TrimSpace(*request.Action) {
		ret.Code, ret.Msg = -1, "action is required"
		return
	}
	action := strings.TrimSpace(*request.Action)
	if ("ensure-main" == action || "push-main" == action) && "" == strings.TrimSpace(request.Commit) {
		ret.Code, ret.Msg = -1, "commit is required"
		return
	}
	if "fetch-main" == action && "" != strings.TrimSpace(request.Commit) {
		ret.Code, ret.Msg = -1, "commit must be empty for fetch-main"
		return
	}
	if "ensure-main" != action && "fetch-main" != action && "push-main" != action {
		ret.Code, ret.Msg = -1, "unsupported transport action"
		return
	}
	repository, err := noemaVaultGitRepository(*request.Notebook, *request.Path)
	if nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	var result vaultgit.TransportResult
	switch action {
	case "ensure-main":
		result, err = vaultgit.EnsureOriginMain(c.Request.Context(), repository, request.Commit)
	case "fetch-main":
		result, err = vaultgit.FetchOriginMain(c.Request.Context(), repository)
	case "push-main":
		result, err = vaultgit.PushOriginMain(c.Request.Context(), repository, request.Commit)
	}
	if nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = result
}

func noemaVaultGitHistory(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	request := struct {
		Notebook *string `json:"notebook"`
		Path     *string `json:"path"`
		FilePath *string `json:"filePath"`
		Limit    int     `json:"limit"`
	}{}
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	if nil == request.Notebook || "" == strings.TrimSpace(*request.Notebook) {
		ret.Code, ret.Msg = -1, "notebook is required"
		return
	}
	if nil == request.Path {
		ret.Code, ret.Msg = -1, "path is required"
		return
	}
	if nil == request.FilePath || "" == strings.TrimSpace(*request.FilePath) {
		ret.Code, ret.Msg = -1, "filePath is required"
		return
	}
	repository, err := noemaVaultGitRepository(*request.Notebook, *request.Path)
	if nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	limit := request.Limit
	if 0 == limit {
		limit = 50
	}
	result, err := vaultgit.History(c.Request.Context(), repository, *request.FilePath, limit)
	if nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = result
}

func noemaVaultGitDiff(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	request := struct {
		Notebook *string `json:"notebook"`
		Path     *string `json:"path"`
		FilePath *string `json:"filePath"`
		SHA      *string `json:"sha"`
	}{}
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	if nil == request.Notebook || "" == strings.TrimSpace(*request.Notebook) {
		ret.Code, ret.Msg = -1, "notebook is required"
		return
	}
	if nil == request.Path {
		ret.Code, ret.Msg = -1, "path is required"
		return
	}
	if nil == request.FilePath || "" == strings.TrimSpace(*request.FilePath) {
		ret.Code, ret.Msg = -1, "filePath is required"
		return
	}
	if nil == request.SHA || "" == strings.TrimSpace(*request.SHA) {
		ret.Code, ret.Msg = -1, "sha is required"
		return
	}
	repository, err := noemaVaultGitRepository(*request.Notebook, *request.Path)
	if nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	result, err := vaultgit.Diff(c.Request.Context(), repository, *request.FilePath, *request.SHA)
	if nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = result
}

func noemaVaultGitRestore(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	request := struct {
		Notebook *string `json:"notebook"`
		Path     *string `json:"path"`
		FilePath *string `json:"filePath"`
		SHA      *string `json:"sha"`
	}{}
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	if nil == request.Notebook || "" == strings.TrimSpace(*request.Notebook) {
		ret.Code, ret.Msg = -1, "notebook is required"
		return
	}
	if nil == request.Path {
		ret.Code, ret.Msg = -1, "path is required"
		return
	}
	if nil == request.FilePath || "" == strings.TrimSpace(*request.FilePath) {
		ret.Code, ret.Msg = -1, "filePath is required"
		return
	}
	if nil == request.SHA || "" == strings.TrimSpace(*request.SHA) {
		ret.Code, ret.Msg = -1, "sha is required"
		return
	}
	repository, err := noemaVaultGitRepository(*request.Notebook, *request.Path)
	if nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	version, err := vaultgit.ReadFileAtCommit(c.Request.Context(), repository, *request.FilePath, *request.SHA)
	if nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	repositoryRelative, err := filepath.Rel(filesys.BoxRootPath(*request.Notebook), repository)
	if nil != err || filepath.IsAbs(repositoryRelative) || ".." == repositoryRelative || strings.HasPrefix(repositoryRelative, ".."+string(filepath.Separator)) {
		ret.Code, ret.Msg = -1, "Git repository is outside the Markdown notebook"
		return
	}
	boxPath := "/" + filepath.ToSlash(filepath.Join(repositoryRelative, version.Path))
	if _, err = filesys.ValidateBoxRelativePath(*request.Notebook, boxPath); nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	saved, _, err := model.SaveMarkdownDoc(*request.Notebook, boxPath, version.Content)
	if nil != err {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	if saved != version.Content {
		ret.Code, ret.Msg = -1, "restored Markdown bytes changed while saving"
		return
	}
	// Restore is an explicit user action whose response is immediately followed
	// by page reopen/search in the Wiki UI. Do not leave its SQL/FTS projection
	// behind the normal asynchronous save queue.
	sql.FlushQueue()
	ret.Data = map[string]interface{}{
		"path": version.Path, "sha": version.SHA, "source": version.Source, "bytes": len([]byte(saved)),
	}
}
