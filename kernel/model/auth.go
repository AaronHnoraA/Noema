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
	"crypto/rand"
	"net/http"
	"sync"

	"github.com/golang-jwt/jwt/v5"
	"github.com/siyuan-note/logging"
)

// Noema fork: the publish-service basic-auth accounts/visitor-session
// system (Account/AccountsMap/SessionsMap, InitPublishAccounts,
// refreshPublishJWT, GetBasicAuthAccount/GetBasicAuthUsernameBySessionID/
// GetNewSessionID/AddSession/DeleteSession, SessionIdCookieName,
// IsPublishServiceToken/IsValidPublishServiceToken) is removed along with
// server/proxy/publish.go, its only consumer. CreatePluginJWT is removed
// too (kernel/plugin, the goja plugin runtime it authenticated, is gone).
// The generic JWT infra below (ParseJWT/ParseXAuthToken/GetClaimRole) stays
// — it's still how MCP/API-token clients authenticate.

const (
	XAuthTokenKey = "X-Auth-Token"

	ClaimsContextKey = "claims"

	iss = "siyuan-kernel" // token 的发行者

	ClaimsKeyRole string = "role"
)

var (
	jwtKey     = make([]byte, 32)
	jwtKeyOnce sync.Once
)

func InitJwtKey() {
	jwtKeyOnce.Do(func() {
		err := refreshJwtKey()
		if err != nil {
			logging.LogFatalf(logging.ExitCodeFatal, "initialize JWT signing key failed: %s", err)
		}
	})
}

func refreshJwtKey() error {
	if _, err := rand.Read(jwtKey); err != nil {
		logging.LogErrorf("generate JWT signing key failed: %s", err)
		return err
	}
	return nil
}

func ParseJWT(tokenString string) (token *jwt.Token, err error) {
	// REF: https://golang-jwt.github.io/jwt/usage/parse/
	return jwt.Parse(
		tokenString,
		func(token *jwt.Token) (any, error) {
			return jwtKey, nil
		},
		jwt.WithIssuer(iss),
	)
}

func ParseXAuthToken(r *http.Request) *jwt.Token {
	tokenString := r.Header.Get(XAuthTokenKey)
	if tokenString != "" {
		if token, err := ParseJWT(tokenString); err != nil {
			logging.LogErrorf("JWT parse failed: %s", err)
		} else {
			return token
		}
	}
	return nil
}

func GetTokenClaims(token *jwt.Token) jwt.MapClaims {
	return token.Claims.(jwt.MapClaims)
}

func GetClaimRole(claims jwt.MapClaims) Role {
	if role := claims[ClaimsKeyRole]; role != nil {
		return Role(role.(float64))
	}
	return RoleUnauthenticated
}
