package wikisearch

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// TestLive prints what a real workspace answers.  It runs only when
// NOEMA_WIKI_LIVE_ROOT names a workspace and NOEMA_WIKI_LIVE_QUERIES lists
// queries separated by "|"; it asserts nothing.
func TestLive(t *testing.T) {
	root := os.Getenv("NOEMA_WIKI_LIVE_ROOT")
	if root == "" {
		t.Skip("NOEMA_WIKI_LIVE_ROOT is not set")
	}
	for _, query := range strings.Split(os.Getenv("NOEMA_WIKI_LIVE_QUERIES"), "|") {
		started := time.Now()
		response, err := Search(root, Options{Query: query, Limit: 7})
		if err != nil {
			t.Fatalf("%q: %v", query, err)
		}
		fmt.Printf("\n%q  total %d  %s  %.1f ms  %v", query, response.Total, response.Match,
			float64(time.Since(started).Microseconds())/1000, response.Explain)
		if response.Corrected != nil {
			fmt.Printf("  corrected→%q", response.Corrected.To)
		}
		if response.Create != nil {
			fmt.Printf("  create %q", response.Create.Title)
		}
		fmt.Println()
		for _, item := range response.Items {
			via := ""
			if item.Via != "" {
				via = " via " + item.Via
			}
			fmt.Printf("   %-9s %s:%s%s\n", item.MatchKind, item.Namespace, item.Title, via)
		}
	}
}

// TestLiveReferences prints reference lookups for a real workspace, made
// from NOEMA_WIKI_LIVE_FILE; queries come from NOEMA_WIKI_LIVE_REFERENCES.
func TestLiveReferences(t *testing.T) {
	root := os.Getenv("NOEMA_WIKI_LIVE_ROOT")
	if root == "" || os.Getenv("NOEMA_WIKI_LIVE_REFERENCES") == "" {
		t.Skip("NOEMA_WIKI_LIVE_ROOT and NOEMA_WIKI_LIVE_REFERENCES are not set")
	}
	for _, query := range strings.Split(os.Getenv("NOEMA_WIKI_LIVE_REFERENCES"), "|") {
		started := time.Now()
		response, err := References(root, Options{Query: query, File: os.Getenv("NOEMA_WIKI_LIVE_FILE"), Limit: 6})
		if err != nil {
			t.Fatalf("%q: %v", query, err)
		}
		fmt.Printf("\n%q  scope %s  total %d  %.1f ms  %v\n", query, response.Scope, response.Total,
			float64(time.Since(started).Microseconds())/1000, response.Explain)
		for _, item := range response.Items {
			fmt.Printf("   %-8s %-34.34s %s\n", item.Kind, item.Label, item.Insert)
		}
	}
}
