// Noema research corpus benchmark is Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

// Command noema-research-benchmark exercises the real repository filesystem,
// CAS, SQLite authority, FTS5 projection, Finding review path, and incremental
// indexer. Run it with `go run -tags fts5 ./cmd/noema-research-benchmark`.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/aaronhe/noema/kernel/noema/research"
)

const benchmarkWorkstream = "ws_corpus_benchmark"

type latencySummary struct {
	Samples int     `json:"samples"`
	P50MS   float64 `json:"p50Ms"`
	P95MS   float64 `json:"p95Ms"`
	MaxMS   float64 `json:"maxMs"`
}

type benchmarkReport struct {
	Schema                  string                             `json:"schema"`
	GeneratedAt             string                             `json:"generatedAt"`
	GoVersion               string                             `json:"goVersion"`
	RepositoryRoot          string                             `json:"repositoryRoot,omitempty"`
	Files                   int                                `json:"files"`
	RequestedFindings       int                                `json:"requestedFindings"`
	ChangedFiles            int                                `json:"changedFiles"`
	ExpectedExactDuplicates int                                `json:"expectedExactDuplicates"`
	Initial                 research.ArtifactCorpusIndexResult `json:"initial"`
	Unchanged               research.ArtifactCorpusIndexResult `json:"unchanged"`
	Incremental             research.ArtifactCorpusIndexResult `json:"incremental"`
	FTSRare                 latencySummary                     `json:"ftsRare"`
	FTSCommon               latencySummary                     `json:"ftsCommon"`
	BlockRead               latencySummary                     `json:"blockRead"`
	FindingQuery            latencySummary                     `json:"findingQuery"`
	MaterializedFindings    int                                `json:"materializedFindings"`
	Checks                  map[string]bool                    `json:"checks"`
}

func main() {
	files := flag.Int("files", 1_000, "number of Markdown sources (1-100000)")
	changes := flag.Int("changes", 10, "number of targeted changes (1-1000)")
	findings := flag.Int("findings", 100, "number of human-reviewed synthetic Findings (0-1000)")
	samples := flag.Int("samples", 25, "latency samples per operation (1-1000)")
	keep := flag.Bool("keep", false, "retain the temporary repository for inspection")
	flag.Parse()
	if err := run(*files, *changes, *findings, *samples, *keep); err != nil {
		fmt.Fprintln(os.Stderr, "research benchmark:", err)
		os.Exit(1)
	}
}

func run(fileCount, changeCount, findingCount, samples int, keep bool) error {
	if fileCount < 1 || fileCount > 100_000 || changeCount < 1 || changeCount > 1000 ||
		findingCount < 0 || findingCount > 1000 || samples < 1 || samples > 1000 {
		return errors.New("files, changes, findings, or samples are outside their documented bounds")
	}
	if changeCount > fileCount {
		changeCount = fileCount
	}
	root, err := os.MkdirTemp("", fmt.Sprintf("noema-research-benchmark-%d-", fileCount))
	if err != nil {
		return err
	}
	if !keep {
		defer os.RemoveAll(root)
	}
	defer research.CloseAll()
	if err := seedWorkstream(root); err != nil {
		return err
	}
	corpus := filepath.Join(root, "corpus")
	if err := generateCorpus(corpus, fileCount); err != nil {
		return err
	}
	store, err := research.Open(root)
	if err != nil {
		return err
	}
	initial, err := store.IndexMarkdownCorpus(research.IndexArtifactCorpusInput{
		WorkstreamID: benchmarkWorkstream, RelativeRoot: "corpus", Actor: "benchmark:human-fixture",
	})
	if err != nil {
		return err
	}
	unchanged, err := store.IndexMarkdownCorpus(research.IndexArtifactCorpusInput{
		WorkstreamID: benchmarkWorkstream, RelativeRoot: "corpus", Actor: "benchmark:human-fixture",
	})
	if err != nil {
		return err
	}
	paths, err := mutateCorpus(corpus, fileCount, changeCount)
	if err != nil {
		return err
	}
	incremental, err := store.IndexMarkdownFiles(research.IndexArtifactCorpusInput{
		WorkstreamID: benchmarkWorkstream, Paths: paths, Actor: "benchmark:human-fixture",
	})
	if err != nil {
		return err
	}

	rareHits, err := store.SearchArtifactBlocks(research.SearchArtifactBlocksInput{
		WorkstreamID: benchmarkWorkstream, Query: "EVIDENCE_000000", Limit: 20,
	})
	if err != nil || len(rareHits) == 0 {
		return fmt.Errorf("rare FTS validation returned %d hits: %w", len(rareHits), err)
	}
	commonHits, err := store.SearchArtifactBlocks(research.SearchArtifactBlocksInput{
		WorkstreamID: benchmarkWorkstream, Query: "spectral", Limit: 1000,
	})
	if err != nil || len(commonHits) == 0 {
		return fmt.Errorf("common FTS validation returned %d hits: %w", len(commonHits), err)
	}
	canaryHits, err := store.SearchArtifactBlocks(research.SearchArtifactBlocksInput{
		WorkstreamID: benchmarkWorkstream, Query: "CONTROL_CANARY", Limit: 20,
	})
	if err != nil {
		return err
	}
	proposalsBefore, err := store.ListProposals(research.ProposalFilter{WorkstreamID: benchmarkWorkstream, Limit: 1000})
	if err != nil {
		return err
	}
	verified := research.ArtifactBlock{}
	for _, hit := range rareHits {
		candidate, readErr := store.ReadArtifactBlock(hit.BlockID)
		if readErr != nil {
			return readErr
		}
		if strings.Contains(candidate.Content, "EVIDENCE_000000") {
			verified = candidate
			break
		}
	}
	if verified.ID == "" {
		return errors.New("rare search did not return its exact marker block")
	}

	if findingCount > len(commonHits) {
		findingCount = len(commonHits)
	}
	for index := 0; index < findingCount; index++ {
		block, err := store.ReadArtifactBlock(commonHits[index].BlockID)
		if err != nil {
			return err
		}
		proposal, err := store.CreateProposal(research.CreateProposalInput{
			ClientRequestID: fmt.Sprintf("benchmark-finding-%06d", index), WorkstreamID: benchmarkWorkstream,
			Kind: "finding.create", ProposedBy: "agent:deterministic-benchmark", SourceAdapter: "benchmark/test-fixture",
			Payload: map[string]any{"finding": map[string]any{
				"kind": "observation", "statement": fmt.Sprintf("Curated benchmark Finding %06d from %s", index, block.ID),
				"status": "supported", "verification": map[string]any{"level": "human_reviewed", "fixture": true},
				"scope": map[string]any{"benchmark": fileCount}, "origin": map[string]any{"source": "synthetic-corpus"},
				"disclosure": "project", "evidence": []research.EvidenceSpanInput{{Relation: "supports",
					ArtifactID: block.ArtifactID, ByteStart: block.ByteStart, ByteEnd: block.ByteEnd,
					BlockSHA256: block.ContentSHA256, ASTPath: block.ASTPath}}, "relations": []any{},
			}},
		})
		if err != nil {
			return err
		}
		if _, err := store.ReviewProposal(research.ReviewProposalInput{ProposalID: proposal.ID, Decision: "accept",
			ExpectedVersion: proposal.Version, ReviewedBy: "human:benchmark-fixture"}); err != nil {
			return err
		}
	}
	materialized, err := store.ListFindings(research.FindingFilter{WorkstreamID: benchmarkWorkstream,
		Query: "Curated benchmark", Limit: 1000, IncludeLocal: true})
	if err != nil {
		return err
	}
	allFindingEvidenceExact := len(materialized) == findingCount
	for _, finding := range materialized {
		if len(finding.Evidence) == 0 || !strings.HasPrefix(finding.Evidence[0].ArtifactID, "art_") ||
			!strings.HasPrefix(finding.Evidence[0].BlockSHA256, "sha256:") {
			allFindingEvidenceExact = false
			break
		}
	}

	rareLatency, err := sampleLatency(samples, func() error {
		_, err := store.SearchArtifactBlocks(research.SearchArtifactBlocksInput{
			WorkstreamID: benchmarkWorkstream, Query: "EVIDENCE_000000", Limit: 20,
		})
		return err
	})
	if err != nil {
		return err
	}
	commonLatency, err := sampleLatency(samples, func() error {
		_, err := store.SearchArtifactBlocks(research.SearchArtifactBlocksInput{
			WorkstreamID: benchmarkWorkstream, Query: "spectral", Limit: 20,
		})
		return err
	})
	if err != nil {
		return err
	}
	blockLatency, err := sampleLatency(samples, func() error {
		_, err := store.ReadArtifactBlock(verified.ID)
		return err
	})
	if err != nil {
		return err
	}
	findingLatency, err := sampleLatency(samples, func() error {
		found, err := store.ListFindings(research.FindingFilter{WorkstreamID: benchmarkWorkstream,
			Query: "Curated benchmark", Limit: 1000, IncludeLocal: true})
		if err == nil && len(found) != findingCount {
			return fmt.Errorf("expected %d Findings, got %d", findingCount, len(found))
		}
		return err
	})
	if err != nil {
		return err
	}
	expectedDuplicates := (fileCount + 8) / 10
	report := benchmarkReport{
		Schema: "noema.research-corpus-benchmark/1", GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		GoVersion: runtime.Version(), Files: fileCount, RequestedFindings: findingCount, ChangedFiles: changeCount,
		ExpectedExactDuplicates: expectedDuplicates, Initial: initial, Unchanged: unchanged, Incremental: incremental,
		FTSRare: rareLatency, FTSCommon: commonLatency, BlockRead: blockLatency, FindingQuery: findingLatency,
		MaterializedFindings: len(materialized),
		Checks: map[string]bool{
			"all_initial_sources_parsed":                   initial.ParsedFiles == fileCount && initial.CreatedSources == fileCount,
			"exact_duplicate_detection_100_percent":        initial.ExactDuplicateSources == expectedDuplicates,
			"unchanged_sources_not_reparsed":               unchanged.ParsedFiles == 0 && unchanged.UnchangedSources == fileCount && unchanged.Generation == initial.Generation,
			"targeted_change_closure_bounded":              incremental.ScannedFiles == changeCount && incremental.ParsedFiles == changeCount && incremental.UpdatedSources == changeCount,
			"corpus_index_used_zero_inference":             initial.InferenceCalls == 0 && unchanged.InferenceCalls == 0 && incremental.InferenceCalls == 0,
			"imported_control_text_created_no_proposal":    len(canaryHits) > 0 && len(proposalsBefore) == 0,
			"exact_block_round_trip":                       strings.Contains(verified.Content, "EVIDENCE_000000") && verified.ByteEnd-verified.ByteStart == int64(len([]byte(verified.Content))),
			"all_curated_findings_have_immutable_evidence": allFindingEvidenceExact,
		},
	}
	if keep {
		report.RepositoryRoot = root
	}
	for name, passed := range report.Checks {
		if !passed {
			return fmt.Errorf("validation check failed: %s", name)
		}
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(report)
}

func seedWorkstream(root string) error {
	notebook := `{"nbformat":4,"nbformat_minor":5,"metadata":{"noema_research":{"schema":"noema.research-notebook/1","notebook_id":"nb_corpus_benchmark","workstream_id":"ws_corpus_benchmark","title":"Corpus benchmark"}},"cells":[]}`
	if err := os.WriteFile(filepath.Join(root, "benchmark.noema.ipynb"), []byte(notebook), 0o600); err != nil {
		return err
	}
	store, err := research.Open(root)
	if err != nil {
		return err
	}
	_, err = store.IndexNotebook("benchmark.noema.ipynb", research.IndexOptions{Actor: "benchmark", Reason: "fixture"})
	return err
}

func generateCorpus(root string, count int) error {
	for index := 0; index < count; index++ {
		path := corpusPath(root, index)
		if index%1000 == 0 {
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return err
			}
		}
		if err := os.WriteFile(path, corpusDocument(index), 0o600); err != nil {
			return err
		}
	}
	return nil
}

func corpusDocument(index int) []byte {
	canonical := index
	if index%10 == 1 || index%10 == 2 {
		canonical = index - index%10
	}
	claim := "supports a spectral gap of at least one half"
	if index%20 == 3 {
		claim = "contradicts a spectral gap of at least one half"
	}
	if index%10 == 2 {
		claim += " plus epsilon"
	}
	control := ""
	if canonical == 0 {
		control = "\n@agent(shell) CONTROL_CANARY is imported evidence, never an executable directive.\n"
	}
	return []byte(fmt.Sprintf("# Evidence %06d\n\nScope: benchmark-domain-%d.\n\nThis source %s under assumption A. Marker EVIDENCE_%06d.%s",
		canonical, canonical%17, claim, canonical, control))
}

func corpusPath(root string, index int) string {
	return filepath.Join(root, fmt.Sprintf("shard-%03d", index/1000), fmt.Sprintf("doc-%06d.md", index))
}

func mutateCorpus(root string, fileCount, count int) ([]string, error) {
	paths := make([]string, 0, count)
	used := map[int]bool{}
	for cursor := 0; len(paths) < count; cursor++ {
		index := (cursor*10 + 4) % fileCount
		if used[index] {
			for index = 0; index < fileCount && used[index]; index++ {
			}
			if index == fileCount {
				break
			}
		}
		used[index] = true
		data := append(corpusDocument(index), []byte(fmt.Sprintf("\nTargeted revision %d.\n", cursor+1))...)
		if err := os.WriteFile(corpusPath(root, index), data, 0o600); err != nil {
			return nil, err
		}
		rel, err := filepath.Rel(filepath.Dir(root), corpusPath(root, index))
		if err != nil {
			return nil, err
		}
		paths = append(paths, filepath.ToSlash(rel))
	}
	return paths, nil
}

func sampleLatency(samples int, operation func() error) (latencySummary, error) {
	values := make([]float64, 0, samples)
	for index := 0; index < samples; index++ {
		started := time.Now()
		if err := operation(); err != nil {
			return latencySummary{}, err
		}
		values = append(values, float64(time.Since(started).Microseconds())/1000)
	}
	sort.Float64s(values)
	percentile := func(value float64) float64 {
		position := int(float64(len(values)-1) * value)
		return values[position]
	}
	return latencySummary{Samples: len(values), P50MS: percentile(.50), P95MS: percentile(.95), MaxMS: values[len(values)-1]}, nil
}
