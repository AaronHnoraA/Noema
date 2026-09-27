// Noema research Run failure classification is Copyright (c) 2026 Aaron He
// and distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package research

import "regexp"

// Failure kinds, adopted from Pisper's stream-retry and team error
// classification (docs/pisper-agent-lifecycle-study.md).  A kind is a
// projection of the recorded reason, never stored, so improving the patterns
// reclassifies old Runs.  Only transient kinds are retryable; authentication,
// quota and context failures need the person, and "error" is an execution
// failure whose retry is a judgement, not a reflex.
const (
	RunFailureAuth      = "auth"
	RunFailureQuota     = "quota"
	RunFailureRateLimit = "rate_limit"
	RunFailureNetwork   = "network"
	RunFailureContext   = "context"
	RunFailureLease     = "lease"
	RunFailureError     = "error"
)

var runFailurePatterns = []struct {
	kind    string
	pattern *regexp.Regexp
}{
	// Authentication comes first: "401 ... connection closed" is still a
	// credential problem, and retrying it only hides that.
	{RunFailureAuth, regexp.MustCompile(`(?i)\b(401|403|unauthori[sz]ed|forbidden|invalid[\s_-]+(api[\s_-]*key|token|credential)s?|authentication[\s_-]+(failed|required|error)|not[\s_-]+logged[\s_-]+in|login[\s_-]+required)\b`)},
	{RunFailureQuota, regexp.MustCompile(`(?i)(insufficient[\s_-]+quota|quota[\s_-]+exceeded|billing|credit[\s_-]+balance|usage[\s_-]+limit[\s_-]+reached|out[\s_-]+of[\s_-]+credits)`)},
	{RunFailureContext, regexp.MustCompile(`(?i)(context[\s_-]+(length|window)[\s_-]+exceeded|maximum[\s_-]+context|prompt[\s_-]+is[\s_-]+too[\s_-]+long|too[\s_-]+many[\s_-]+tokens)`)},
	{RunFailureRateLimit, regexp.MustCompile(`(?i)(\b429\b|rate[\s_-]*limit|too[\s_-]+many[\s_-]+requests|overloaded|\b529\b|retry[\s_-]+later|server[\s_-]+busy)`)},
	{RunFailureLease, regexp.MustCompile(`(?i)(worker[\s_-]+lease[\s_-]+expired|lease[\s_-]+(expired|lost))`)},
	{RunFailureNetwork, regexp.MustCompile(`(?i)(econn(reset|refused|aborted)|etimedout|enotfound|socket[\s_-]+hang[\s_-]+up|stream[\s_-]*read[\s_-]*error|connection[\s_-]+(reset|closed|lost|refused)|premature(ly)?[\s_-]+clos|incomplete[\s_-]+stream|network[\s_-]+error|\b50[234]\b|bad[\s_-]+gateway|gateway[\s_-]+time-?out|service[\s_-]+unavailable|timed?[\s_-]*out)`)},
}

// ClassifyRunFailure returns the failure kind of REASON and whether a later
// identical attempt may succeed without anyone changing anything.
func ClassifyRunFailure(reason string) (kind string, retryable bool) {
	for _, candidate := range runFailurePatterns {
		if candidate.pattern.MatchString(reason) {
			kind = candidate.kind
			break
		}
	}
	if kind == "" {
		kind = RunFailureError
	}
	return kind, kind == RunFailureRateLimit || kind == RunFailureNetwork || kind == RunFailureLease
}
