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
	"slices"

	"github.com/gin-gonic/gin"
)

// Noema fork: SiYuan's Editor/Reader/Visitor RBAC roles existed to serve
// the (now-removed) public-publish feature's anonymous/scoped-down
// visitors. Noema is single-user; a request is either the owner
// (RoleAdministrator) or not yet authenticated (RoleUnauthenticated), which
// falls through CheckAuth's other auth methods (API token, access-code
// session) rather than being granted any standing access on its own.
type Role uint

const (
	RoleContextKey = "role"
)

const (
	RoleAdministrator Role = iota
	RoleUnauthenticated
)

func GetGinContextRole(c *gin.Context) Role {
	if role, exists := c.Get(RoleContextKey); exists {
		return role.(Role)
	}

	return RoleUnauthenticated
}

func IsAdminRoleContext(c *gin.Context) bool {
	return GetGinContextRole(c) == RoleAdministrator
}

func IsValidRole(role Role, roles []Role) bool {
	return slices.Contains(roles, role)
}

// IsReadOnlyRole/IsReadOnlyRoleContext always return false now: the roles
// that used to make a request read-only (RoleReader, RoleVisitor) existed
// only for the removed publish feature's scoped-down visitors, and every
// handler that reaches this check has already passed CheckAuth, which only
// grants RoleAdministrator. Kept (not deleted) because ~20 api/*.go call
// sites still call them alongside the publish-access filters in
// publish_access_stub.go.
func IsReadOnlyRole(Role) bool { return false }

func IsReadOnlyRoleContext(*gin.Context) bool { return false }
