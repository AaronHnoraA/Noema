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

// Noema fork: the auto-updater (model/updater.go, updater_release.go,
// update_channel.go, /api/system/checkUpdate, /api/system/setUpdateChannel)
// is removed. Tauri has its own update mechanism.
//
// skipNewVerInstallPkg/getNewVerInstallPkgPath gate the "hand a downloaded
// installer path to the desktop host on exit" branches in Close()
// (model/conf.go); stubbed so no installer is ever reported ready and those
// branches stay inert, without editing Close()'s exit-code sequencing.
func skipNewVerInstallPkg() bool      { return true }
func getNewVerInstallPkgPath() string { return "" }

// loadGlobalUpdateChannel populated Conf.System.UpdateChannel at boot; with
// the updater gone the field just stays at its zero value (already how
// config export/snapshot clear it elsewhere, e.g. conf.go's
// snapshot.System.UpdateChannel = "").
func loadGlobalUpdateChannel() string { return "" }

// CheckUpdate was called (a) from the removed /api/system/checkUpdate
// handler and (b) as a 10s-delayed background check after opening the user
// guide (model/mount.go). No-op.
func CheckUpdate(showMsg bool) {}
