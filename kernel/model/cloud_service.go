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

package model

import (
	"errors"

	"github.com/88250/gulu"
	"github.com/aaronhe/noema/kernel/conf"
)

// Noema fork: the b3log cloud account/subscription/sync service is removed.
// This file keeps the exported signatures that model/api/mcp/cli callers
// still reference so those call sites need no further edits; every entry
// point now fails closed with ErrCloudServiceRemoved instead of reaching a
// network endpoint. IsSubscriber()/IsPaidUser() (model/conf.go) already
// return false whenever Conf.GetUser() is nil, which it always is here, so
// the IsSubscriber()-gated cloud paths (asset upload, cloud reminders) are
// unreachable in practice and were left untouched.
var (
	ErrFailedToConnectCloudServer = errors.New("failed to connect cloud server")
	ErrCloudServiceRemoved        = errors.New("cloud service is not available in this build")
)

func CloudChatGPT(msg string, contextMsgs []string) (ret string, stop bool, err error) {
	return "", true, ErrCloudServiceRemoved
}

func StartFreeTrial() (err error) {
	return ErrCloudServiceRemoved
}

func DeactivateUser() (err error) {
	return ErrCloudServiceRemoved
}

func SetCloudBlockReminder(id, data string, timed int64) (err error) {
	return ErrCloudServiceRemoved
}

// uploadToken is referenced by the dead (IsSubscriber()-gated) cloud asset
// upload path in model/assets.go; it is never populated because
// LoadUploadToken always fails.
var uploadToken string

func LoadUploadToken() (err error) {
	return ErrCloudServiceRemoved
}

// loadUserFromConf is referenced by model/conf.go behind a
// Conf.UserData != "" guard that can never be true, since Login/RefreshUser
// never populate it.
func loadUserFromConf() *conf.User {
	return nil
}

func RefreshCheckJob2H() {}

func RefreshCheckJob6H() {}

func RefreshUser(token string) {}

func RemoveCloudShorthands(ids []string) (err error) {
	return ErrCloudServiceRemoved
}

func GetCloudShorthand(id string) (ret map[string]any, err error) {
	return nil, ErrCloudServiceRemoved
}

func GetCloudShorthands(page int) (result map[string]any, err error) {
	return nil, ErrCloudServiceRemoved
}

func UseActivationcode(code string) (err error) {
	return ErrCloudServiceRemoved
}

func CheckActivationcode(code string) (retCode int, msg string) {
	return -1, ErrCloudServiceRemoved.Error()
}

func Login(userName, password, captcha string, cloudRegion int) (ret *gulu.Result) {
	return &gulu.Result{Code: -1, Msg: ErrCloudServiceRemoved.Error()}
}

func Login2fa(token, code string) (map[string]any, error) {
	return nil, ErrCloudServiceRemoved
}

func LogoutUser() {}
