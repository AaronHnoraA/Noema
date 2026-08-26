// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package identity owns Noema's portable UUIDv7 checks and the deterministic,
// disposable SiYuan-shaped keys used by the inherited kernel indexes.
package identity

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	uuidV7Pattern       = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	legacyNodeIDPattern = regexp.MustCompile(`^[0-9]{14}-[0-9a-z]{7}$`)
)

func IsUUIDv7(value string) bool {
	return uuidV7Pattern.MatchString(strings.TrimSpace(value))
}

func IsLegacyNodeID(value string) bool {
	return legacyNodeIDPattern.MatchString(strings.TrimSpace(value))
}

// ProjectionID maps a portable identity to the shape required by inherited
// SiYuan indexes. The result is deterministic and disposable: callers must
// never serialize it into Markdown or expose it as Noema identity.
//
// fallbackSeed is used only when canonical is empty (for provisional pages).
func ProjectionID(canonical, fallbackSeed string) string {
	key := canonical + "\x00" + fallbackSeed
	if cached, ok := projectionIDs.Load(key); ok {
		return cached.(string)
	}
	ret := projectionID(canonical, fallbackSeed)
	// A vault has a bounded number of anchors, but a long-lived kernel can see
	// many provisional box/path seeds; drop the whole table rather than grow
	// without limit, since every entry is recomputable.
	if maxCachedProjectionIDs <= projectionIDCount.Add(1) {
		projectionIDs.Clear()
		projectionIDCount.Store(0)
	}
	projectionIDs.Store(key, ret)
	return ret
}

const maxCachedProjectionIDs = 1 << 16

var (
	projectionIDs     sync.Map
	projectionIDCount atomic.Int64
)

func projectionID(canonical, fallbackSeed string) string {
	canonical = strings.TrimSpace(canonical)
	seed := canonical
	stamp := "20000101000000"
	if "" == seed {
		seed = fallbackSeed
	} else if IsUUIDv7(canonical) {
		compact := strings.ReplaceAll(strings.ToLower(canonical), "-", "")
		if millis, err := strconv.ParseUint(compact[:12], 16, 64); nil == err {
			stamp = time.UnixMilli(int64(millis)).UTC().Format("20060102150405")
		}
	} else if IsLegacyNodeID(canonical) {
		stamp = canonical[:14]
	}
	digest := sha256.Sum256([]byte(seed))
	return stamp + "-" + hex.EncodeToString(digest[:4])[:7]
}
