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
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/88250/lute/ast"
	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/siyuan-note/filelock"
)

// Noema fork: notebook encryption (model/crypto.go, crypto_lifecycle.go,
// box_conf_crypto.go, ~3200 lines) is removed. Its API surface
// (api/notebook.go's 12 handlers) is already gone (no entry point can ever
// set BoxConf.Encrypted = true), and model/box.go's ListNotebooks/GetConf/
// SaveConf were simplified to drop the crypt-backup-recovery branches
// entirely rather than call into stubs.
//
// The functions below are still called — always inside an
// `if IsEncryptedBox(...)`-style gate, or as an unconditional predicate
// whose "not encrypted" answer is itself the correct behavior for every
// real box now — from ~60 files across model/ and api/. Rather than edit
// every call site, they are kept as permanent "nothing is ever encrypted"
// answers.
var ErrEncryptionRemoved = errors.New("notebook encryption is not available in this build")
var ErrEncryptedBoxNotUnlocked = errors.New("encrypted notebook is locked, please unlock it first")

// encryptedAssetMagic is the 4-byte header siyuan's encrypted asset format
// used to start with; nothing writes it anymore, so bytes.HasPrefix against
// it naturally always evaluates false for real (unencrypted) asset data —
// kept only so model/history.go's format-sniffing check keeps compiling.
var encryptedAssetMagic = []byte{'S', 'Y', 'A', 'E'}

func isEncryptedHistoryBoxDir(string) (bool, error) { return false, nil }

func IsEncryptedBox(string) bool          { return false }
func IsBoxUnlocked(string) bool           { return true }
func isBoxUnlockedForAccess(string) bool  { return true }
func IsEncryptedAssetPath(string) bool    { return false }
func IsEncryptedNotebookData([]byte) bool { return false }
func IsSameCryptoBoundary(srcBox, dstBox string) bool {
	return true // no box is ever encrypted, so there is no boundary to cross
}
func IsBlockRefCrossingBoundary(string, string) bool { return false }
func ListAllEncryptedBoxIDs() []string               { return []string{} }

func GetDEK(string) ([]byte, error) { return nil, ErrEncryptionRemoved }

// GetDEKIfUnlocked's (nil, nil) return means "this box is not encrypted" to
// its callers — most importantly kernel/filesys's DEKProvider callback
// (filesys/crypto_hook.go documents this contract explicitly), which
// treats a non-nil error as "encrypted but locked" and fails closed. Since
// every box is now unencrypted, (nil, nil) is the correct answer, not an
// error — every direct model-layer caller of this function is also always
// gated behind `if IsEncryptedBox(...)` first, so this path is otherwise
// unreachable in practice.
func GetDEKIfUnlocked(string) ([]byte, error) { return nil, nil }
func GetBoxEncryption(string) (*conf.BoxEncryption, error) {
	return nil, ErrEncryptionRemoved
}
func DeepCopyBoxEncryption(src *conf.BoxEncryption) *conf.BoxEncryption { return nil }
func ClearDEK(string)                                                   {}

func AcquireEncryptedBoxOperation(string) error { return nil }
func ReleaseEncryptedBoxOperation(string)       {}
func AcquireEncryptedBoxOperations(ctx context.Context, boxIDs []string) (release func(), err error) {
	return func() {}, nil
}
func WithEncryptedBoxOperationScope(ctx context.Context) (context.Context, func()) {
	return ctx, func() {}
}
func HoldBoxReadLock(string)    {}
func ReleaseBoxReadLock(string) {}

func NotebookCryptoMuLock()          {}
func NotebookCryptoMuUnlock()        {}
func TouchUnlockedEncryptedBoxes()   {}
func AutoLockIdleEncryptedBoxesJob() {}

func EncryptFile(boxID, relativePath string, dek, plaintext []byte) ([]byte, error) {
	return nil, ErrEncryptionRemoved
}
func DecryptFile(boxID, relativePath string, dek, ciphertext []byte) ([]byte, error) {
	return nil, ErrEncryptionRemoved
}
func EncryptAsset(boxID, diskName, originalName string, dek, plaintext []byte) ([]byte, error) {
	return nil, ErrEncryptionRemoved
}
func DecryptAsset(boxID, diskName string, dek, ciphertext []byte) ([]byte, error) {
	return nil, ErrEncryptionRemoved
}
func DecryptAssetName(boxID, diskName string, dek, ciphertext []byte) (string, error) {
	return "", ErrEncryptionRemoved
}
func DecryptAssetWithName(boxID, diskName string, dek, ciphertext []byte) ([]byte, string, error) {
	return nil, "", ErrEncryptionRemoved
}
func DecryptAssetToWriter(boxID, diskName string, dek []byte, reader io.Reader, writer io.Writer) (string, error) {
	return "", ErrEncryptionRemoved
}
func DecryptAssetNameFromReader(boxID, diskName string, dek []byte, reader io.Reader) (string, error) {
	return "", ErrEncryptionRemoved
}

func ChangeMasterPassword(string, string) error         { return ErrEncryptionRemoved }
func CreateEncryptedBox(string, string) (string, error) { return "", ErrEncryptionRemoved }
func EnableEncryptedNotebook(string) error              { return ErrEncryptionRemoved }
func DisableEncryptedNotebook() error                   { return ErrEncryptionRemoved }
func HasEncryptedNotebookHistory() bool                 { return false }
func LockBox(string)                                    {}
func UnlockBox(boxID, password string, boxEnc *conf.BoxEncryption) error {
	return ErrEncryptionRemoved
}
func UnlockAndMountBox(boxID, password string, boxEnc *conf.BoxEncryption) (bool, error) {
	return false, ErrEncryptionRemoved
}
func SetAutoLockMinutes(int)                          {}
func MasterPasswordMigrationStatus() (bool, []string) { return false, nil }
func ExportNotebookCryptoBackup() (string, error)     { return "", ErrEncryptionRemoved }
func ImportNotebookCryptoBackup([]byte, string) error { return ErrEncryptionRemoved }

// copyAssetDecryptIfEncrypted copied an asset file, transparently
// decrypting it if it belonged to an encrypted box. No box is ever
// encrypted now, so this is just a plain file copy — kept as real logic
// (not an error stub) since it's called unconditionally from ~9 sites in
// model/clipboard.go and model/export.go as part of normal asset export.
func copyAssetDecryptIfEncrypted(srcPath, destPath string) error {
	if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
		return err
	}
	return filelock.Copy(srcPath, destPath)
}

// ExtractBoxIDFromAssetsPath/ExtractBoxIDFromHistoryPath are pure path
// parsing (which box does this absolute path belong to), used well beyond
// encryption — kept as real logic, moved here from crypto.go verbatim.

// ExtractBoxIDFromAssetsPath 从 data 目录下的绝对路径（.sy 或 assets）反推 boxID。
// 路径形如 <DataDir>/<boxID>/...；若不在 DataDir 下或 boxID 非合法 ID 模式，返回空串。
func ExtractBoxIDFromAssetsPath(absPath string) string {
	absPath = filepath.ToSlash(absPath)
	dataDir := filepath.ToSlash(util.DataDir)
	rel, err := filepath.Rel(dataDir, absPath)
	if err != nil {
		return ""
	}
	rel = filepath.ToSlash(rel)
	if strings.HasPrefix(rel, "..") || rel == "." || rel == "" {
		return ""
	}
	parts := strings.SplitN(rel, "/", 2)
	boxID := parts[0]
	if !ast.IsNodeIDPattern(boxID) {
		return ""
	}
	return boxID
}

// ExtractBoxIDFromHistoryPath 从 history 目录下的绝对路径反推 boxID。
// 路径形如 <HistoryDir>/<timestamp-op>/<boxID>/...。
func ExtractBoxIDFromHistoryPath(absPath string) string {
	absPath = filepath.ToSlash(absPath)
	historyDir := filepath.ToSlash(util.HistoryDir)
	rel, err := filepath.Rel(historyDir, absPath)
	if err != nil {
		return ""
	}
	rel = filepath.ToSlash(rel)
	if strings.HasPrefix(rel, "..") || rel == "." || rel == "" {
		return ""
	}
	parts := strings.SplitN(rel, "/", 3)
	if len(parts) < 2 {
		return ""
	}
	boxID := parts[1]
	if !ast.IsNodeIDPattern(boxID) {
		return ""
	}
	return boxID
}
