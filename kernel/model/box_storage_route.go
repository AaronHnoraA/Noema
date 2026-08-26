// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema box-storage routing cache additions are Copyright (c) 2026
// Aaron He and distributed under the same AGPL-3.0-or-later terms.

package model

import (
	"path/filepath"
	"strings"
	"sync"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/util"
)

// boxStorageRoute contains only immutable routing scalars. BoxConf pointers are
// deliberately not cached because callers mutate the value returned by
// GetConf before persisting it with SaveConf.
type boxStorageRoute struct {
	kind string
	root string
}

var (
	boxStorageRouteMu     sync.RWMutex
	boxStorageRouteLoadMu sync.Mutex
	boxStorageRoutes      = map[string]boxStorageRoute{}
)

func boxStorageRouteKey(boxID string) string {
	// Tests and embedded hosts may switch DataDir within one process. Including
	// it in the key also prevents one workspace from inheriting another one's
	// external-repository route.
	return filepath.Clean(util.DataDir) + "\x00" + boxID
}

func routeFromBoxConf(boxConf *conf.BoxConf) boxStorageRoute {
	kind := boxConf.Kind
	if "" == kind {
		kind = conf.BoxKindSy
	}
	route := boxStorageRoute{kind: kind}
	if conf.BoxKindMarkdown != kind {
		return route
	}
	root := strings.TrimSpace(boxConf.Root)
	if "" != root && filepath.IsAbs(root) {
		route.root = filepath.Clean(root)
	}
	return route
}

func cachedBoxStorageRoute(boxID string) (boxStorageRoute, bool) {
	boxStorageRouteMu.RLock()
	route, ok := boxStorageRoutes[boxStorageRouteKey(boxID)]
	boxStorageRouteMu.RUnlock()
	return route, ok
}

func rememberBoxStorageRoute(boxID string, boxConf *conf.BoxConf) {
	if nil == boxConf {
		return
	}
	boxStorageRouteMu.Lock()
	boxStorageRoutes[boxStorageRouteKey(boxID)] = routeFromBoxConf(boxConf)
	boxStorageRouteMu.Unlock()
}

func forgetBoxStorageRoute(boxID string) {
	boxStorageRouteMu.Lock()
	delete(boxStorageRoutes, boxStorageRouteKey(boxID))
	boxStorageRouteMu.Unlock()
}

func loadBoxStorageRoute(boxID string) boxStorageRoute {
	if route, ok := cachedBoxStorageRoute(boxID); ok {
		return route
	}

	// Collapse simultaneous cold misses so a large indexing fan-out never
	// re-reads the same tiny JSON file once per goroutine.
	boxStorageRouteLoadMu.Lock()
	defer boxStorageRouteLoadMu.Unlock()
	if route, ok := cachedBoxStorageRoute(boxID); ok {
		return route
	}
	boxConf := (&Box{ID: boxID}).GetConf()
	route := routeFromBoxConf(boxConf)
	rememberBoxStorageRoute(boxID, boxConf)
	return route
}
