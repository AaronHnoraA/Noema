package research

import "testing"

func TestClassifyRunFailure(t *testing.T) {
	cases := []struct {
		reason    string
		kind      string
		retryable bool
	}{
		{"401 Unauthorized: connection closed", RunFailureAuth, false},
		{"Invalid API key provided", RunFailureAuth, false},
		{"You exceeded your current quota, check your billing", RunFailureQuota, false},
		{"prompt is too long: 210000 tokens > 200000 maximum", RunFailureContext, false},
		{"429 Too Many Requests", RunFailureRateLimit, true},
		{"Overloaded", RunFailureRateLimit, true},
		{"worker lease expired", RunFailureLease, true},
		{"stream_read_error: ECONNRESET", RunFailureNetwork, true},
		{"502 Bad Gateway", RunFailureNetwork, true},
		{"Project process exited with code 1", RunFailureError, false},
		{"", RunFailureError, false},
	}
	for _, c := range cases {
		kind, retryable := ClassifyRunFailure(c.reason)
		if kind != c.kind || retryable != c.retryable {
			t.Errorf("%q: got %s/%v, want %s/%v", c.reason, kind, retryable, c.kind, c.retryable)
		}
	}
}
