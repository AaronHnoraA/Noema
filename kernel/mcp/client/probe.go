// Copyright (c) 2026 Aaron He. AGPL-3.0-or-later.
package client

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// ProbeConfig is the same transport projection frozen into an ACP RunSpec.
type ProbeConfig struct {
	Name    string      `json:"name"`
	Type    string      `json:"type"`
	Command string      `json:"command"`
	Args    []string    `json:"args"`
	Env     []ProbePair `json:"env"`
	URL     string      `json:"url"`
	Headers []ProbePair `json:"headers"`
}
type ProbePair struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}
type ProbeResult struct {
	State      string      `json:"state"`
	CheckedAt  string      `json:"checkedAt"`
	DurationMS int64       `json:"durationMs"`
	Error      string      `json:"error,omitempty"`
	Tools      []*mcp.Tool `json:"tools"`
	Log        []string    `json:"log"`
	Stderr     string      `json:"stderr,omitempty"`
}

type probeLog struct {
	sync.Mutex
	text string
}

func (b *probeLog) Write(p []byte) (int, error) {
	b.Lock()
	defer b.Unlock()
	b.text += string(p)
	if len(b.text) > 16384 {
		b.text = b.text[len(b.text)-16384:]
	}
	return len(p), nil
}
func (b *probeLog) String() string { b.Lock(); defer b.Unlock(); return b.text }

type probeHeaders struct {
	ctx     context.Context
	origin  string
	headers []ProbePair
}

type probeBody struct {
	io.ReadCloser
	stop   func() bool
	cancel context.CancelFunc
}

func (b *probeBody) Close() error {
	err := b.ReadCloser.Close()
	b.stop()
	b.cancel()
	return err
}

func (h probeHeaders) RoundTrip(req *http.Request) (*http.Response, error) {
	ctx, cancel := context.WithCancel(req.Context())
	stop := context.AfterFunc(h.ctx, cancel)
	clone := req.Clone(ctx)
	if clone.URL.Scheme+"://"+clone.URL.Host != h.origin {
		stop()
		cancel()
		return nil, fmt.Errorf("MCP probe changed origin")
	}
	for _, pair := range h.headers {
		clone.Header.Set(pair.Name, pair.Value)
	}
	response, err := http.DefaultTransport.RoundTrip(clone)
	if err != nil {
		stop()
		cancel()
		return nil, err
	}
	response.Body = &probeBody{ReadCloser: response.Body, stop: stop, cancel: cancel}
	return response, nil
}

// ProbeMCP creates a bounded, temporary SDK session. It never registers tools,
// modifies global MCP connections, or invokes any advertised tool.
func ProbeMCP(parent context.Context, root string, config ProbeConfig) (result ProbeResult) {
	started := time.Now()
	result = ProbeResult{State: "failed", CheckedAt: started.UTC().Format(time.RFC3339), Tools: []*mcp.Tool{}, Log: []string{}}
	stderr := &probeLog{}
	defer func() { result.DurationMS = time.Since(started).Milliseconds(); result.Stderr = stderr.String() }()
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()
	var transport mcp.Transport
	kind := config.Type
	if kind == "" {
		kind = "stdio"
	}
	switch kind {
	case "stdio":
		if config.Command == "" {
			result.Error = "MCP command is empty"
			return
		}
		cmd := exec.CommandContext(ctx, config.Command, config.Args...)
		cmd.Dir, cmd.Stderr, cmd.WaitDelay = root, stderr, time.Second
		cmd.Env = os.Environ()
		for _, pair := range config.Env {
			if err := validateEnvironmentName(pair.Name); err != nil {
				result.Error = err.Error()
				return
			}
			if strings.ContainsRune(pair.Value, '\x00') {
				result.Error = "MCP environment contains NUL"
				return
			}
			cmd.Env = append(cmd.Env, pair.Name+"="+pair.Value)
		}
		transport = &mcp.CommandTransport{Command: cmd, TerminateDuration: time.Second}
	case "http", "sse":
		endpoint, err := url.Parse(config.URL)
		if err != nil || endpoint.Host == "" || (endpoint.Scheme != "http" && endpoint.Scheme != "https") {
			result.Error = "MCP URL must be HTTP or HTTPS"
			return
		}
		// The SDK detaches its connection lifecycle context. Keep all requests,
		// including session DELETE during Close, inside the probe deadline.
		client := &http.Client{Transport: probeHeaders{ctx: ctx, origin: endpoint.Scheme + "://" + endpoint.Host, headers: config.Headers}}
		if kind == "sse" {
			transport = &mcp.SSEClientTransport{Endpoint: config.URL, HTTPClient: client}
		} else {
			transport = &mcp.StreamableClientTransport{Endpoint: config.URL, HTTPClient: client}
		}
	default:
		result.Error = "Unsupported MCP transport: " + kind
		return
	}
	result.Log = append(result.Log, "Connecting via "+kind)
	sdk := mcp.NewClient(&mcp.Implementation{Name: "noema-probe", Version: "1"}, nil)
	session, err := sdk.Connect(ctx, transport, nil)
	if err != nil {
		result.Error = "initialize: " + err.Error()
		return
	}
	defer session.Close()
	result.Log = append(result.Log, "MCP initialization succeeded", "Listing tools")
	if session.InitializeResult().Capabilities.Tools != nil {
		result.Tools, err = listAllMCPTools(ctx, session.ListTools)
		if err != nil {
			result.Error = "tools/list: " + err.Error()
			return
		}
	}
	result.State = "passed"
	result.Log = append(result.Log, fmt.Sprintf("Discovered %d tools; closing test session", len(result.Tools)))
	return
}
