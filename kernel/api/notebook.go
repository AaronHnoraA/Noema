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

package api

import (
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/88250/gulu"
	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/gin-gonic/gin"
)

func getNotebookInfo(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var boxID string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("notebook", &boxID, true, true)) {
		return
	}
	if util.InvalidIDPattern(boxID, ret) {
		return
	}

	box := model.Conf.Box(boxID)
	if nil == box {
		ret.Code = -1
		ret.Msg = "notebook [" + boxID + "] not found"
		return
	}
	if model.IsReadOnlyRoleContext(c) && !isNotebookVisibleByPublishAccess(box, model.GetPublishAccess()) {
		ret.Code = -1
		ret.Msg = "notebook [" + boxID + "] not found"
		return
	}
	if err := holdEncryptedBoxRequest(c, boxID); err != nil {
		ret.Code = -1
		ret.Msg = model.Conf.Language(314)
		return
	}

	boxInfo := box.GetInfo()
	ret.Data = map[string]any{
		"boxInfo": boxInfo,
	}
}

func setNotebookIcon(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var boxID, icon string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("notebook", &boxID, true, true),
		util.BindJsonArg("icon", &icon, true, false),
	) {
		return
	}
	if err := holdEncryptedBoxRequest(c, boxID); err != nil {
		ret.Code = -1
		ret.Msg = model.Conf.Language(314)
		return
	}
	model.SetBoxIcon(boxID, icon)
}

func changeSortNotebook(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	idsArg := arg["notebooks"].([]any)
	var ids []string
	for _, p := range idsArg {
		ids = append(ids, p.(string))
	}
	for _, id := range ids {
		if err := holdEncryptedBoxRequest(c, id); err != nil {
			ret.Code = -1
			ret.Msg = model.Conf.Language(314)
			return
		}
	}
	model.ChangeBoxSort(ids)
}

func renameNotebook(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var notebook, name string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("notebook", &notebook, true, true),
		util.BindJsonArg("name", &name, true, false),
	) {
		return
	}
	if util.InvalidIDPattern(notebook, ret) {
		return
	}
	if err := holdEncryptedBoxRequest(c, notebook); err != nil {
		ret.Code = -1
		ret.Msg = model.Conf.Language(314)
		return
	}
	err := model.RenameBox(notebook, name)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		ret.Data = map[string]any{"closeTimeout": 5000}
		return
	}

	evt := util.NewCmdResult("renamenotebook", 0, util.PushModeBroadcast)
	evt.Data = map[string]any{
		"box":  notebook,
		"name": name,
	}
	util.PushEvent(evt)
}

func removeNotebook(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var notebook string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("notebook", &notebook, true, true)) {
		return
	}
	if util.InvalidIDPattern(notebook, ret) {
		return
	}

	if util.ReadOnly && !model.IsUserGuide(notebook) {
		ret.Code = -1
		ret.Msg = model.Conf.Language(34)
		ret.Data = map[string]any{"closeTimeout": 5000}
		return
	}

	err := model.RemoveBox(notebook)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	evt := util.NewCmdResult("removeBox", 0, util.PushModeBroadcast)
	evt.Data = map[string]any{
		"box": notebook,
	}
	util.PushEvent(evt)
	model.TriggerOnboardingIfEmpty()
}

func createNotebook(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var name, kind string
	if !util.ParseJsonArgs(arg, ret,
		util.BindJsonArg("name", &name, true, false),
		util.BindJsonArg("kind", &kind, false, false), // 可选，缺省/"" = sy；"markdown" 建 markdown box
	) {
		return
	}

	var id string
	var err error
	if "markdown" == kind {
		id, err = model.CreateMarkdownBox(name)
	} else {
		id, err = model.CreateBox(name)
	}
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	existed, err := model.Mount(id)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	box := model.Conf.Box(id)
	if nil == box {
		ret.Code = -1
		ret.Msg = "opened notebook [" + id + "] not found"
		return
	}

	ret.Data = map[string]any{
		"notebook": box,
	}

	evt := util.NewCmdResult("createnotebook", 0, util.PushModeBroadcast)
	evt.Data = map[string]any{
		"box":     box,
		"existed": existed,
	}
	util.PushEvent(evt)
}

func openNotebook(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	var notebook string
	if !util.ParseJsonArgs(arg, ret, util.BindJsonArg("notebook", &notebook, true, true)) {
		return
	}
	if util.InvalidIDPattern(notebook, ret) {
		return
	}

	isUserGuide := model.IsUserGuide(notebook)
	if util.ReadOnly && !isUserGuide {
		ret.Code = -1
		ret.Msg = model.Conf.Language(34)
		ret.Data = map[string]any{"closeTimeout": 5000}
		return
	}
	if err := holdEncryptedBoxRequest(c, notebook); err != nil {
		ret.Code = -1
		ret.Msg = model.Conf.Language(314)
		return
	}

	msgId := util.PushMsg(model.Conf.Language(45), 1000*60*15)
	defer util.PushClearMsg(msgId)
	existed, err := model.Mount(notebook)
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	box := model.Conf.Box(notebook)
	if nil == box {
		ret.Code = -1
		ret.Msg = "opened notebook [" + notebook + "] not found"
		return
	}

	evt := util.NewCmdResult("mount", 0, util.PushModeBroadcast)
	evt.Data = map[string]any{
		"box":     box,
		"existed": existed,
	}
	util.PushEvent(evt)

	if isUserGuide {
		appArg := arg["app"]
		app := ""
		if nil != appArg {
			app = appArg.(string)
		}

		go func() {
			var startID string
			i := 0
			for ; i < 70; i++ {
				time.Sleep(100 * time.Millisecond)
				guideStartID := map[string]string{
					"20210808180117-czj9bvb": "20200812220555-lj3enxa",
					"20211226090932-5lcq56f": "20211226115423-d5z1joq",
					"20210808180117-6v0mkxr": "20200923234011-ieuun1p",
					"20240530133126-axarxgx": "20240530101000-4qitucx",
				}
				startID = guideStartID[notebook]
				if treenode.ExistBlockTree(startID) {
					util.BroadcastByTypeAndApp("main", app, "openFileById", 0, "", map[string]any{
						"id": startID,
					})
					break
				}
			}
		}()
	}
}

func closeNotebook(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	notebook := arg["notebook"].(string)
	if util.InvalidIDPattern(notebook, ret) {
		return
	}
	model.Unmount(notebook)
}

func getNotebookConf(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	notebook := arg["notebook"].(string)
	if util.InvalidIDPattern(notebook, ret) {
		return
	}

	box := model.Conf.GetBox(notebook)
	if nil == box {
		ret.Code = -1
		ret.Msg = "notebook [" + notebook + "] not found"
		return
	}
	if model.IsReadOnlyRoleContext(c) && !isNotebookVisibleByPublishAccess(box, model.GetPublishAccess()) {
		ret.Code = -1
		ret.Msg = "notebook [" + notebook + "] not found"
		return
	}
	if model.IsBoxUnlocked(notebook) {
		if err := holdEncryptedBoxRequest(c, notebook); err != nil {
			ret.Code = -1
			ret.Msg = model.Conf.Language(314)
			return
		}
	}

	boxConf := box.GetConf()
	if !model.IsAdminRoleContext(c) {
		model.HideBoxConfSecret(boxConf)
	}
	ret.Data = map[string]any{
		"box":  box.ID,
		"name": box.Name,
		"conf": boxConf,
	}
}

func setNotebookConf(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	arg, ok := util.JsonArg(c, ret)
	if !ok {
		return
	}

	notebook := arg["notebook"].(string)
	if util.InvalidIDPattern(notebook, ret) {
		return
	}

	box := model.Conf.GetBox(notebook)
	if nil == box {
		ret.Code = -1
		ret.Msg = "notebook [" + notebook + "] not found"
		return
	}
	if model.IsBoxUnlocked(notebook) {
		if err := holdEncryptedBoxRequest(c, notebook); err != nil {
			ret.Code = -1
			ret.Msg = model.Conf.Language(314)
			return
		}
	}

	param, err := gulu.JSON.MarshalJSON(arg["conf"])
	if err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}

	boxConf := box.GetConf()
	oldSortMode := boxConf.SortMode
	// 深拷贝加密相关字段，防止反序列化请求体时被覆盖
	// BoxCrypt 是指针，UnmarshalJSON 会修改同一指针对象，必须用 model 层辅助函数深拷贝
	savedBoxCrypt := model.DeepCopyBoxEncryption(boxConf.BoxCrypt)
	savedEncrypted := boxConf.Encrypted
	if err = gulu.JSON.UnmarshalJSON(param, boxConf); err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	boxConf.Encrypted = savedEncrypted
	boxConf.BoxCrypt = savedBoxCrypt

	boxConf.DocCreateSavePath = util.TrimSpaceInPath(boxConf.DocCreateSavePath)
	boxConf.DocCreateTemplatePath = util.NormalizeTemplatePath(boxConf.DocCreateTemplatePath)

	boxConf.RefCreateSavePath = util.TrimSpaceInPath(boxConf.RefCreateSavePath)

	boxConf.DailyNoteSavePath = util.TrimSpaceInPath(boxConf.DailyNoteSavePath)
	if "" != boxConf.DailyNoteSavePath {
		if !strings.HasPrefix(boxConf.DailyNoteSavePath, "/") {
			boxConf.DailyNoteSavePath = "/" + boxConf.DailyNoteSavePath
		}
	}
	if "/" == boxConf.DailyNoteSavePath {
		ret.Code = -1
		ret.Msg = model.Conf.Language(49)
		return
	}

	boxConf.DailyNoteTemplatePath = util.NormalizeTemplatePath(boxConf.DailyNoteTemplatePath)

	if err := box.SaveConf(boxConf); err != nil {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if oldSortMode != boxConf.SortMode {
		model.PushDocSortModeChanged("notebook", notebook, "", "/", &boxConf.SortMode)
	}
	ret.Data = boxConf
}

func lsNotebooks(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	flashcard := false

	// 兼容旧版接口，不能直接使用 util.JsonArg()
	arg := map[string]any{}
	if err := c.ShouldBindJSON(&arg); err == nil {
		if arg["flashcard"] != nil {
			flashcard = arg["flashcard"].(bool)
		}
	}

	var notebooks []*model.Box
	var publishAccess model.PublishAccess
	isReadOnlyRole := model.IsReadOnlyRoleContext(c)
	if flashcard {
		notebooks = model.GetFlashcardNotebooks()
	} else {
		for _, boxID := range model.ListAllEncryptedBoxIDs() {
			if !model.IsBoxUnlocked(boxID) {
				continue
			}
			if err := holdEncryptedBoxRequest(c, boxID); err != nil {
				ret.Code = -1
				ret.Msg = model.Conf.Language(314)
				return
			}
		}
		var err error
		notebooks, err = model.ListNotebooks()
		if err != nil {
			return
		}
		if isReadOnlyRole {
			publishAccess = model.GetPublishAccess()
			tempNotebooks := []*model.Box{}
			for _, notebook := range notebooks {
				if !isNotebookVisibleByPublishAccess(notebook, publishAccess) {
					continue
				}
				tempNotebooks = append(tempNotebooks, notebook)
			}
			notebooks = tempNotebooks
		}
	}

	boxDocEnabled := model.IsBoxDocEnabled()
	if !flashcard && boxDocEnabled {
		for _, notebook := range notebooks {
			if !notebook.Closed {
				if isReadOnlyRole {
					notebook.SubFileCount = model.BoxDocSubFileCountForPublish(notebook.ID, publishAccess)
				} else {
					notebook.SubFileCount = model.BoxDocSubFileCount(notebook.ID)
				}
			}
		}
		sortNotebooksBySubFileCount(notebooks, model.Conf.FileTree.Sort)
	}

	ret.Data = map[string]any{
		"notebooks":     notebooks,
		"boxDocEnabled": boxDocEnabled,
	}
}

func sortNotebooksBySubFileCount(notebooks []*model.Box, sortMode int) {
	switch sortMode {
	case util.SortModeSubDocCountASC:
		sort.SliceStable(notebooks, func(i, j int) bool {
			return notebooks[i].SubFileCount < notebooks[j].SubFileCount
		})
	case util.SortModeSubDocCountDESC:
		sort.SliceStable(notebooks, func(i, j int) bool {
			return notebooks[i].SubFileCount > notebooks[j].SubFileCount
		})
	}
}

func isNotebookVisibleByPublishAccess(notebook *model.Box, publishAccess model.PublishAccess) bool {
	if nil == notebook || notebook.Closed || notebook.Encrypted {
		return false
	}

	for _, item := range publishAccess {
		if item.ID == notebook.ID {
			return item.Visible
		}
	}
	return true
}

// enableEncryptedNotebooks 先同步数据，再恢复既有配置或启用加密笔记本并设置主密码。
