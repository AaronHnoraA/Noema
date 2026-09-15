// Noema research permission policy is Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package research

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"unicode"
)

// PermissionRule is a deliberately narrow, structured remembered decision.
// It is never a free-form shell allow-list: matching is limited to an action
// kind, exact project-relative paths, and an argv prefix.
type PermissionRule struct {
	ID        string         `json:"id"`
	Scope     string         `json:"scope"`
	ScopeID   string         `json:"scopeId"`
	Effect    string         `json:"effect"`
	Matcher   map[string]any `json:"matcher"`
	CreatedAt string         `json:"createdAt"`
	CreatedBy string         `json:"createdBy"`
	Enabled   bool           `json:"enabled"`
}

type policyDecision struct {
	OptionID  string
	DecidedBy string
	Reason    string
}

// policyDecisionForTx uses a deny-first ordering. Hard denials are derived in
// the kernel from the normalized action and target, so an untrusted worker
// cannot bypass them by merely labelling a callback as safe.  Remembered rules
// come next.  Work that stays inside the project is then approved
// automatically; anything reaching outside it or the network waits for a
// person in Attention.
func policyDecisionForTx(tx *sql.Tx, run Run, action map[string]any, options []map[string]any) (policyDecision, error) {
	if reason := hardDenyReason(action); reason != "" {
		return policyDecision{OptionID: matchingOption(options, "reject"), DecidedBy: "policy", Reason: reason}, nil
	}
	rules, err := matchingPermissionRulesTx(tx, run, action)
	if err != nil {
		return policyDecision{}, err
	}
	for _, rule := range rules {
		if rule.Effect == "reject" {
			return policyDecision{OptionID: matchingOption(options, "reject"), DecidedBy: "policy-rule:" + rule.ID, Reason: "matched reject rule"}, nil
		}
		if rule.Effect == "allow" {
			return policyDecision{OptionID: preferredAllowOption(options), DecidedBy: "policy-rule:" + rule.ID, Reason: "matched allow rule"}, nil
		}
	}
	if reason := projectAutoAllowReason(run.ExecutionTarget, action); reason != "" {
		if option := preferredAllowOption(options); option != "" {
			return policyDecision{OptionID: option, DecidedBy: "policy", Reason: reason}, nil
		}
	}
	return policyDecision{}, nil
}

func hardDenyReason(action map[string]any) string {
	kind := strings.ToLower(strings.TrimSpace(runtimeStringValue(action["kind"])))
	if kind == "credential" || kind == "elevate" || kind == "privilege" {
		return "credentials and privilege elevation are always denied"
	}
	argv := strings.ToLower(strings.Join(actionStringSlice(action["argv"]), " "))
	if argv == "" {
		argv = strings.ToLower(strings.Join(actionStringSlice(action["command"]), " "))
	}
	if strings.Contains(argv, "git push") || strings.Contains(argv, "git reset --hard") ||
		strings.Contains(argv, "git rebase") || strings.Contains(argv, "git filter-repo") ||
		strings.Contains(argv, "git branch -f") {
		return "remote push and git history rewriting are always denied"
	}
	if strings.HasPrefix(argv, "sudo ") || strings.HasPrefix(argv, "doas ") || strings.HasPrefix(argv, "su ") ||
		strings.Contains(argv, " sudo ") {
		return "privilege elevation is always denied"
	}
	return ""
}

// projectAutoAllowReason returns why ACTION may proceed without asking: it
// reads, edits or executes only inside TARGET and reaches no network.  An
// action it cannot place inside the project returns "" and waits for a person.
func projectAutoAllowReason(target string, action map[string]any) string {
	kind := strings.ToLower(strings.TrimSpace(runtimeStringValue(action["kind"])))
	if kind == "fetch" || kind == "network" || actionBool(action, "network") {
		return ""
	}
	for _, path := range actionStringSlice(action["paths"]) {
		if !pathInsideProject(target, path) {
			return ""
		}
	}
	argv := actionStringSlice(action["argv"])
	if len(argv) == 0 {
		argv = actionStringSlice(action["command"])
	}
	if commandLeavesProject(target, argv) {
		return ""
	}
	return "work inside the project is approved by the project default policy"
}

func pathInsideProject(target, path string) bool {
	path = strings.Trim(strings.TrimSpace(path), `"'`)
	if path == "" {
		return true
	}
	if strings.HasPrefix(path, "~") || strings.HasPrefix(path, "$HOME") {
		return false
	}
	if filepath.IsAbs(path) {
		if strings.TrimSpace(target) == "" {
			return false
		}
		rel, err := filepath.Rel(filepath.Clean(target), filepath.Clean(path))
		return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
	}
	clean := filepath.Clean(path)
	return clean != ".." && !strings.HasPrefix(clean, ".."+string(filepath.Separator))
}

// networkCommands reach the network whatever their arguments.
var networkCommands = map[string]bool{
	"curl": true, "wget": true, "ssh": true, "scp": true, "sftp": true, "rsync": true,
	"nc": true, "ncat": true, "telnet": true, "ftp": true,
}

// networkSubcommands reach the network through these subcommands.
var networkSubcommands = map[string][]string{
	"git":  {"clone", "fetch", "pull", "ls-remote", "submodule"},
	"npm":  {"install", "i", "ci", "add", "update", "publish"},
	"pnpm": {"install", "i", "add", "update", "publish"},
	"yarn": {"install", "add", "upgrade", "publish"},
	"bun":  {"install", "add", "update", "publish"},
	"pip":  {"install", "download"}, "pip3": {"install", "download"},
	"uv":    {"add", "sync", "pip"},
	"brew":  {"install", "upgrade", "update", "tap"},
	"cargo": {"install", "add", "update", "fetch", "publish"},
	"go":    {"get", "install", "mod"},
	"gem":   {"install", "update"},
	"apt":   {"install", "update", "upgrade"}, "apt-get": {"install", "update", "upgrade"},
}

// commandLeavesProject reports whether ARGV, possibly one shell string, names
// a path outside TARGET or runs a command that reaches the network.
func commandLeavesProject(target string, argv []string) bool {
	tokens := []string{}
	for _, part := range argv {
		tokens = append(tokens, strings.FieldsFunc(part, func(r rune) bool {
			return unicode.IsSpace(r) || strings.ContainsRune(";&|()`<>\"'", r)
		})...)
	}
	for index, token := range tokens {
		lower := strings.ToLower(token)
		if strings.Contains(lower, "://") || strings.HasPrefix(lower, "git@") {
			return true
		}
		base := filepath.Base(lower)
		if networkCommands[base] {
			return true
		}
		if subcommands, ok := networkSubcommands[base]; ok && index+1 < len(tokens) {
			next := strings.ToLower(tokens[index+1])
			for _, subcommand := range subcommands {
				if next == subcommand {
					return true
				}
			}
		}
		if token == "/dev/null" || strings.HasPrefix(token, "-") {
			continue
		}
		if value := token; strings.HasPrefix(value, "/") || strings.HasPrefix(value, "~") ||
			strings.HasPrefix(value, "$HOME") || strings.Contains(value, "..") {
			if !pathInsideProject(target, value) {
				return true
			}
		}
	}
	return false
}

// preferredAllowOption picks a one-time approval when the agent offers one, so
// an automatic decision never silently remembers a broader rule.
func preferredAllowOption(options []map[string]any) string {
	for _, option := range options {
		for _, key := range []string{"optionId", "option_id", "id"} {
			if value := strings.TrimSpace(runtimeStringValue(option[key])); strings.EqualFold(value, "allow_once") {
				return value
			}
		}
	}
	return matchingOption(options, "allow")
}

func matchingOption(options []map[string]any, prefix string) string {
	prefix = strings.ToLower(prefix)
	for _, option := range options {
		for _, key := range []string{"optionId", "option_id", "id"} {
			value := strings.TrimSpace(runtimeStringValue(option[key]))
			if strings.HasPrefix(strings.ToLower(value), prefix+"_") || strings.EqualFold(value, prefix) {
				return value
			}
		}
	}
	return ""
}

func matchingPermissionRulesTx(tx *sql.Tx, run Run, action map[string]any) ([]PermissionRule, error) {
	rows, err := tx.Query(`SELECT id, scope, scope_id, effect, matcher_json, created_at, created_by, enabled
		FROM permission_rules WHERE enabled = 1 AND ((scope = 'session' AND scope_id = ?) OR
		(scope = 'workstream' AND scope_id = ?) OR (scope = 'project' AND scope_id = ?))
		ORDER BY CASE scope WHEN 'session' THEN 0 WHEN 'workstream' THEN 1 ELSE 2 END, created_at DESC, id`,
		run.SessionID, run.WorkstreamID, run.ExecutionTarget)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rules := []PermissionRule{}
	for rows.Next() {
		var rule PermissionRule
		var matcher string
		var createdAt int64
		var enabled int
		if err := rows.Scan(&rule.ID, &rule.Scope, &rule.ScopeID, &rule.Effect, &matcher, &createdAt, &rule.CreatedBy, &enabled); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(matcher), &rule.Matcher); err != nil {
			continue // corrupted optional rule must never widen authority
		}
		if !permissionRuleMatches(rule.Matcher, action) {
			continue
		}
		rule.CreatedAt, rule.Enabled = formatMillis(createdAt), enabled != 0
		rules = append(rules, rule)
	}
	return rules, rows.Err()
}

func permissionRuleMatches(matcher, action map[string]any) bool {
	if kind := strings.TrimSpace(runtimeStringValue(matcher["kind"])); kind != "" && kind != runtimeStringValue(action["kind"]) {
		return false
	}
	if expected := actionStringSlice(matcher["paths"]); len(expected) > 0 && !sameStringSlice(expected, actionStringSlice(action["paths"])) {
		return false
	}
	if prefix := actionStringSlice(matcher["argv_prefix"]); len(prefix) > 0 {
		actual := actionStringSlice(action["argv"])
		if len(actual) < len(prefix) || !sameStringSlice(prefix, actual[:len(prefix)]) {
			return false
		}
	}
	return true
}

func sameStringSlice(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func actionStringSlice(value any) []string {
	switch values := value.(type) {
	case []string:
		return append([]string(nil), values...)
	case []any:
		result := make([]string, 0, len(values))
		for _, value := range values {
			if stringValue, ok := value.(string); ok {
				result = append(result, stringValue)
			}
		}
		return result
	case string:
		return strings.Fields(values)
	default:
		return nil
	}
}

func actionBool(action map[string]any, key string) bool {
	value, _ := action[key].(bool)
	return value
}

func createPermissionRuleTx(tx *sql.Tx, permission Permission, run Run, optionID, actor string, nowMs int64) (PermissionRule, error) {
	effect := "allow"
	if strings.HasPrefix(strings.ToLower(optionID), "reject_") {
		effect = "reject"
	}
	matcher := permissionMatcher(permission.Action)
	matcherJSON, err := json.Marshal(matcher)
	if err != nil {
		return PermissionRule{}, fmt.Errorf("encode permission rule: %w", err)
	}
	id, err := prefixedUUID("prule_")
	if err != nil {
		return PermissionRule{}, err
	}
	if _, err := tx.Exec(`INSERT INTO permission_rules(id, scope, scope_id, effect, matcher_json, created_at, created_by)
		VALUES(?, 'session', ?, ?, ?, ?, ?)`, id, permission.SessionID, effect, string(matcherJSON), nowMs, actor); err != nil {
		return PermissionRule{}, err
	}
	rule := PermissionRule{ID: id, Scope: "session", ScopeID: permission.SessionID, Effect: effect, Matcher: matcher,
		CreatedAt: formatMillis(nowMs), CreatedBy: actor, Enabled: true}
	if _, err := appendEvent(tx, Event{Type: "permission.rule.created", WorkstreamID: run.WorkstreamID, RunID: run.ID,
		SessionID: permission.SessionID}, nowMs, map[string]any{"permission_rule_id": id, "permission_id": permission.ID,
		"effect": effect, "scope": "session", "matcher": matcher}); err != nil {
		return PermissionRule{}, err
	}
	return rule, nil
}

func permissionMatcher(action map[string]any) map[string]any {
	matcher := map[string]any{}
	if kind := strings.TrimSpace(runtimeStringValue(action["kind"])); kind != "" {
		matcher["kind"] = kind
	}
	if paths := actionStringSlice(action["paths"]); len(paths) > 0 {
		matcher["paths"] = paths
	}
	if argv := actionStringSlice(action["argv"]); len(argv) > 0 {
		matcher["argv_prefix"] = argv
	}
	return matcher
}
