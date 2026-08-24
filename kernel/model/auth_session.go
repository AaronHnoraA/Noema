// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import "github.com/aaronhe/noema/kernel/util"

func IsAccessAuthRequired() bool {
	return Conf.AccessAuthCode != ""
}

func IsWorkspaceSessionAuthenticated(workspaceSession *util.WorkspaceSession) bool {
	return IsAccessCodeSessionAuthenticated(workspaceSession)
}

func IsAccessCodeSessionAuthenticated(workspaceSession *util.WorkspaceSession) bool {
	return workspaceSession != nil && Conf.AccessAuthCode != "" &&
		util.AuthCodeEquals(Conf.AccessAuthCode, workspaceSession.AccessAuthCode)
}
