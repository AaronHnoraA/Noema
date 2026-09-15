// Copyright (c) 2026 Aaron He. AGPL-3.0-or-later.
package client

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func probeTestServer(calls *atomic.Int32, description string) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "probe-fixture", Version: "1"}, nil)
	server.AddTool(&mcp.Tool{Name: "inspect", Description: description,
		InputSchema: map[string]any{"type": "object"}},
		func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			calls.Add(1)
			return &mcp.CallToolResult{}, nil
		})
	return server
}

func TestProbeHTTPAndSSEListToolsWithoutCallingThem(t *testing.T) {
	for _, kind := range []string{"http", "sse"} {
		t.Run(kind, func(t *testing.T) {
			var calls, authenticated atomic.Int32
			server := probeTestServer(&calls, "Inspection fixture")
			var handler http.Handler
			if kind == "http" {
				handler = mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)
			} else {
				handler = mcp.NewSSEHandler(func(*http.Request) *mcp.Server { return server }, nil)
			}
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("X-Probe") == "yes" {
					authenticated.Add(1)
				}
				handler.ServeHTTP(w, r)
			}))
			defer endpoint.Close()
			result := ProbeMCP(context.Background(), t.TempDir(), ProbeConfig{
				Type: kind, URL: endpoint.URL, Headers: []ProbePair{{Name: "X-Probe", Value: "yes"}},
			})
			if result.State != "passed" || len(result.Tools) != 1 {
				t.Fatalf("probe failed: %+v", result)
			}
			if calls.Load() != 0 || authenticated.Load() == 0 {
				t.Fatal("unexpected tool call or missing headers")
			}
		})
	}
}

func TestProbeStdioUsesProjectDirectoryAndClosesProcess(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	result := ProbeMCP(context.Background(), root, ProbeConfig{
		Command: binary, Args: []string{"-test.run=^TestProbeServerHelper$"},
		Env: []ProbePair{{Name: "NOEMA_PROBE_TEST_HELPER", Value: "yes"}},
	})
	if result.State != "passed" || len(result.Tools) != 1 {
		t.Fatalf("probe failed: %+v", result)
	}
	// macOS canonicalizes /var to /private/var in subprocess getwd.
	if !strings.HasSuffix(result.Tools[0].Description, strings.TrimPrefix(root, "/private")) {
		t.Fatalf("wrong working directory: %s", result.Tools[0].Description)
	}
	if !strings.Contains(result.Stderr, "fixture stderr") {
		t.Fatal("missing stderr diagnostics")
	}
}

func TestProbeServerHelper(t *testing.T) {
	if os.Getenv("NOEMA_PROBE_TEST_HELPER") != "yes" {
		return
	}
	root, _ := os.Getwd()
	var calls atomic.Int32
	fmt.Fprintln(os.Stderr, "fixture stderr")
	server := probeTestServer(&calls, root)
	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		os.Exit(2)
	}
	if calls.Load() != 0 {
		os.Exit(3)
	}
	os.Exit(0)
}

func TestProbeCancellationAndBoundedDiagnostics(t *testing.T) {
	release := make(chan struct{})
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer endpoint.Close()
	defer close(release)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	result := ProbeMCP(ctx, t.TempDir(), ProbeConfig{Type: "http", URL: endpoint.URL})
	if result.State != "failed" || result.Error == "" || result.DurationMS > 3000 {
		t.Fatalf("probe did not terminate promptly: %+v", result)
	}
	log := &probeLog{}
	log.Write([]byte(strings.Repeat("x", 20000)))
	if len(log.String()) != 16384 {
		t.Fatal("unbounded stderr")
	}
}
