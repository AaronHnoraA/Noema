package research

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func setupSynthesisTest(t *testing.T) (*Store, string, Artifact) {
	t.Helper()
	store, root := openTestStore(t)
	writeTestNotebook(t, root, "research/synthesis.noema", "Synthesis", []testCell{
		{id: "c-q", meta: map[string]any{"kind": "question", "title": "Question"}, source: "What is true?"},
	})
	if _, err := store.IndexNotebook("research/synthesis.noema", IndexOptions{Actor: "test"}); err != nil {
		t.Fatal(err)
	}
	evidence := "prefix\nThe spectral route fails under assumption A.\nsuffix\n"
	artifact, err := store.ImportArtifact(ImportArtifactInput{
		Kind: "research-evidence", MediaType: "text/markdown; charset=utf-8",
		ContentBase64: base64.StdEncoding.EncodeToString([]byte(evidence)), WorkstreamID: "ws_test",
		SourceURI: "file:research/source.md",
	})
	if err != nil {
		t.Fatal(err)
	}
	return store, root, artifact
}

func findingProposalInput(requestID string, artifact Artifact) CreateProposalInput {
	statement := "The spectral route fails under assumption A."
	start := int64(len("prefix\n"))
	return CreateProposalInput{
		ClientRequestID: requestID, WorkstreamID: "ws_test", Kind: "finding.create",
		ProposedBy: "agent:magent:curator", SourceAdapter: "magent/gptel",
		Payload: map[string]any{"finding": map[string]any{
			"kind": "obstruction", "statement": statement, "status": "supported",
			"verification": map[string]any{"level": "agent_checked", "reviewers": []any{"agent:magent:curator"}},
			"scope":        map[string]any{"assumptions": []any{"A"}},
			"origin":       map[string]any{"actor": "agent:magent:curator"}, "disclosure": "project",
			"evidence": []any{map[string]any{"relation": "supports", "artifactId": artifact.ID,
				"byteStart": start, "byteEnd": start + int64(len(statement)), "astPath": "/paragraph[1]"}},
		}},
	}
}

func TestProposalFindingReviewValidatesEvidenceAndDeduplicates(t *testing.T) {
	store, _, artifact := setupSynthesisTest(t)
	input := findingProposalInput("proposal-finding-1", artifact)
	proposal, err := store.CreateProposal(input)
	if err != nil {
		t.Fatal(err)
	}
	if proposal.Status != "pending" || proposal.Version != 1 || !strings.HasPrefix(proposal.PayloadSHA256, "sha256:") {
		t.Fatalf("unexpected Proposal: %+v", proposal)
	}
	retried, err := store.CreateProposal(input)
	if err != nil || retried.ID != proposal.ID {
		t.Fatalf("Proposal creation must be idempotent: %+v (%v)", retried, err)
	}
	changed := input
	changed.Payload = map[string]any{"statement": "changed"}
	if _, err := store.CreateProposal(changed); err == nil {
		t.Fatal("reusing a Proposal request id with different content must fail")
	}
	attention, err := store.ListAttention()
	if err != nil || len(attention.Proposals) != 1 || attention.Proposals[0].ID != proposal.ID {
		t.Fatalf("pending Proposal must appear in Attention: %+v (%v)", attention, err)
	}

	badPayload := cloneMap(input.Payload)
	badFinding := mapValue(badPayload["finding"])
	badEvidence := badFinding["evidence"].([]any)[0].(map[string]any)
	badEvidence["blockSha256"] = "sha256:" + strings.Repeat("0", 64)
	if _, err := store.ReviewProposal(ReviewProposalInput{ProposalID: proposal.ID, Decision: "accept",
		ExpectedVersion: 1, ReviewedBy: "human:test", EditedPayload: badPayload}); err == nil {
		t.Fatal("a mismatched evidence span hash must abort acceptance")
	}
	stillPending, err := store.GetProposal(proposal.ID)
	if err != nil || stillPending.Status != "pending" || stillPending.Version != 1 {
		t.Fatalf("failed validation must leave Proposal pending: %+v (%v)", stillPending, err)
	}

	accepted, err := store.ReviewProposal(ReviewProposalInput{ProposalID: proposal.ID, Decision: "accept",
		ExpectedVersion: 1, ReviewedBy: "human:test"})
	if err != nil {
		t.Fatal(err)
	}
	if accepted.Proposal.Status != "accepted" || accepted.Proposal.Version != 2 || accepted.Finding == nil {
		t.Fatalf("unexpected accepted Proposal: %+v", accepted)
	}
	finding := *accepted.Finding
	if finding.Status != "supported" || finding.VerificationLevel != "agent_checked" || len(finding.Evidence) != 1 {
		t.Fatalf("epistemic status, verification and evidence must remain separate: %+v", finding)
	}
	if !strings.HasPrefix(finding.Evidence[0].BlockSHA256, "sha256:") {
		t.Fatalf("evidence span digest missing: %+v", finding.Evidence[0])
	}
	if _, err := store.ReviewProposal(ReviewProposalInput{ProposalID: proposal.ID, Decision: "reject",
		ExpectedVersion: 1, ReviewedBy: "human:other", Reason: "race"}); err == nil {
		t.Fatal("a second reviewer must lose optimistic concurrency")
	}

	duplicateInput := findingProposalInput("proposal-finding-2", artifact)
	duplicate, err := store.CreateProposal(duplicateInput)
	if err != nil {
		t.Fatal(err)
	}
	duplicateResult, err := store.ReviewProposal(ReviewProposalInput{ProposalID: duplicate.ID, Decision: "accept",
		ExpectedVersion: 1, ReviewedBy: "human:test"})
	if err != nil || !duplicateResult.Deduplicated || duplicateResult.Finding.ID != finding.ID {
		t.Fatalf("exact semantic duplicate must resolve to the existing Finding: %+v (%v)", duplicateResult, err)
	}
	enrichedInput := findingProposalInput("proposal-finding-3", artifact)
	enrichedFinding := mapValue(enrichedInput.Payload["finding"])
	enrichedFinding["evidence"] = append(enrichedFinding["evidence"].([]any),
		map[string]any{"relation": "context", "artifactId": artifact.ID, "byteStart": int64(0), "byteEnd": int64(6)})
	enriched, err := store.CreateProposal(enrichedInput)
	if err != nil {
		t.Fatal(err)
	}
	enrichedResult, err := store.ReviewProposal(ReviewProposalInput{ProposalID: enriched.ID, Decision: "accept",
		ExpectedVersion: 1, ReviewedBy: "human:test"})
	if err != nil || !enrichedResult.Deduplicated || enrichedResult.Finding.Version != 2 || len(enrichedResult.Finding.Evidence) != 2 {
		t.Fatalf("new evidence on an exact Finding must advance its aggregate version: %+v (%v)", enrichedResult, err)
	}
	findings, err := store.ListFindings(FindingFilter{WorkstreamID: "ws_test", IncludeLocal: true})
	if err != nil || len(findings) != 1 {
		t.Fatalf("exact duplicate must not create a second Finding: %+v (%v)", findings, err)
	}
}

func TestProposalRejectRequiresReasonAndPreservesOriginal(t *testing.T) {
	store, _, _ := setupSynthesisTest(t)
	proposal, err := store.CreateProposal(CreateProposalInput{
		ClientRequestID: "proposal-reject", WorkstreamID: "ws_test", Kind: "task.create",
		Payload: map[string]any{"title": "Investigate"}, ProposedBy: "agent:pi:supervisor", SourceAdapter: "pi-hook",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReviewProposal(ReviewProposalInput{ProposalID: proposal.ID, Decision: "reject",
		ExpectedVersion: 1, ReviewedBy: "human:test"}); err == nil {
		t.Fatal("a rejection must explain why")
	}
	result, err := store.ReviewProposal(ReviewProposalInput{ProposalID: proposal.ID, Decision: "reject",
		ExpectedVersion: 1, ReviewedBy: "human:test", Reason: "outside current scope",
		EditedPayload: map[string]any{"title": "Narrow investigation"}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Proposal.Status != "rejected" || result.Proposal.Payload["title"] != "Investigate" ||
		result.Proposal.ReviewedPayload["title"] != "Narrow investigation" {
		t.Fatalf("review must preserve original and edited payloads separately: %+v", result.Proposal)
	}
}

func TestResearchIRAndProblemModelsAreHumanAcceptedImmutableVersions(t *testing.T) {
	store, _, artifact := setupSynthesisTest(t)
	findingProposal, err := store.CreateProposal(findingProposalInput("proposal-ir-finding", artifact))
	if err != nil {
		t.Fatal(err)
	}
	findingReview, err := store.ReviewProposal(ReviewProposalInput{ProposalID: findingProposal.ID,
		Decision: "accept", ExpectedVersion: 1, ReviewedBy: "human:test"})
	if err != nil {
		t.Fatal(err)
	}
	findingID := findingReview.Finding.ID
	irDocument := map[string]any{
		"schema": "noema.research-ir/1",
		"nodes": []any{
			map[string]any{"id": findingID, "kind": "finding"},
			map[string]any{"id": "concept:route", "kind": "concept"},
		},
		"edges": []any{map[string]any{"from": findingID, "to": "concept:route", "type": "derived_from", "relationClass": "provenance"}},
	}
	irProposal, err := store.CreateProposal(CreateProposalInput{ClientRequestID: "proposal-ir", WorkstreamID: "ws_test",
		Kind: "research_ir.create", Payload: map[string]any{"researchIr": irDocument}, ProposedBy: "agent:pi:curator", SourceAdapter: "pi-hook"})
	if err != nil {
		t.Fatal(err)
	}
	irReview, err := store.ReviewProposal(ReviewProposalInput{ProposalID: irProposal.ID, Decision: "accept",
		ExpectedVersion: 1, ReviewedBy: "human:test"})
	if err != nil || irReview.ResearchIR == nil || irReview.ResearchIR.Version != 1 {
		t.Fatalf("ResearchIR acceptance failed: %+v (%v)", irReview, err)
	}

	badIR := cloneMap(irDocument)
	badIR["edges"] = []any{map[string]any{"from": findingID, "to": "concept:route", "type": "supports"}}
	badProposal, err := store.CreateProposal(CreateProposalInput{ClientRequestID: "proposal-ir-bad", WorkstreamID: "ws_test",
		Kind: "research_ir.create", Payload: badIR, ProposedBy: "agent:magent", SourceAdapter: "magent/gptel"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReviewProposal(ReviewProposalInput{ProposalID: badProposal.ID, Decision: "accept",
		ExpectedVersion: 1, ReviewedBy: "human:test"}); err == nil {
		t.Fatal("ResearchIR must distinguish semantic and provenance edges")
	}

	modelDocument := func(frontier string) map[string]any {
		return map[string]any{
			"schema": "noema.problem-model/1", "id": "pm_test", "question": map[string]any{"statement_finding": findingID},
			"frontier": []any{map[string]any{"finding_id": findingID, "reason": frontier}},
			"source_snapshot": map[string]any{"research_ir_version": 1,
				"artifact_set_hash": "sha256:" + strings.Repeat("a", 64), "policy_hash": "sha256:" + strings.Repeat("b", 64)},
		}
	}
	firstModelProposal, err := store.CreateProposal(CreateProposalInput{ClientRequestID: "proposal-pm-1", WorkstreamID: "ws_test",
		Kind: "problem_model.create", Payload: map[string]any{"problemModel": modelDocument("first")}, ProposedBy: "agent:pi:synthesizer", SourceAdapter: "pi-hook"})
	if err != nil {
		t.Fatal(err)
	}
	firstModel, err := store.ReviewProposal(ReviewProposalInput{ProposalID: firstModelProposal.ID, Decision: "accept",
		ExpectedVersion: 1, ReviewedBy: "human:test"})
	if err != nil || firstModel.ProblemModel == nil || firstModel.ProblemModel.Version != 1 || firstModel.ProblemModel.ID != "pm_test" {
		t.Fatalf("first Problem Model failed: %+v (%v)", firstModel, err)
	}
	secondModelProposal, err := store.CreateProposal(CreateProposalInput{ClientRequestID: "proposal-pm-2", WorkstreamID: "ws_test",
		Kind: "problem_model.create", Payload: map[string]any{"problemModel": modelDocument("second")}, ProposedBy: "agent:pi:synthesizer", SourceAdapter: "pi-hook"})
	if err != nil {
		t.Fatal(err)
	}
	secondModel, err := store.ReviewProposal(ReviewProposalInput{ProposalID: secondModelProposal.ID, Decision: "accept",
		ExpectedVersion: 1, ReviewedBy: "human:test"})
	if err != nil || secondModel.ProblemModel.Version != 2 || secondModel.ProblemModel.ID != firstModel.ProblemModel.ID {
		t.Fatalf("Problem Model edits must create a new immutable version: %+v (%v)", secondModel, err)
	}
	models, err := store.ListProblemModels("ws_test", 10)
	if err != nil || len(models) != 2 || models[0].Version != 2 || models[1].Version != 1 {
		t.Fatalf("immutable Problem Model history missing: %+v (%v)", models, err)
	}
}

func TestCellProposalCanOnlyFinalizeItsReviewedMaterializedIdentity(t *testing.T) {
	store, root, _ := setupSynthesisTest(t)
	proposal, err := store.CreateProposal(CreateProposalInput{ClientRequestID: "proposal-cell", WorkstreamID: "ws_test",
		Kind: "cell.create", ProposedBy: "agent:magent", SourceAdapter: "magent/gptel",
		Payload: map[string]any{"cell": map[string]any{"notebookId": "nb_test", "cellId": "c-ghost", "kind": "work",
			"title": "Ghost", "source": "Investigate", "lineageParent": "c-q"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReviewProposal(ReviewProposalInput{ProposalID: proposal.ID, Decision: "accept", ExpectedVersion: 1,
		ReviewedBy: "human:test", AcceptedRef: "noema://cell/nb_test/c-ghost"}); err == nil {
		t.Fatal("a cell Proposal must be reserved before the notebook is materialized")
	}
	reserved, err := store.BeginProposalAcceptance(BeginProposalAcceptanceInput{ProposalID: proposal.ID,
		ExpectedVersion: 1, ReviewedBy: "human:test"})
	if err != nil || reserved.Status != "accepting" || reserved.Version != 2 {
		t.Fatalf("cell Proposal reservation failed: %+v (%v)", reserved, err)
	}
	replayed, err := store.BeginProposalAcceptance(BeginProposalAcceptanceInput{ProposalID: proposal.ID,
		ExpectedVersion: 1, ReviewedBy: "human:recovery-interface"})
	if err != nil || replayed.Version != 2 {
		t.Fatalf("lost reservation response must be replayable: %+v (%v)", replayed, err)
	}
	attention, err := store.ListAttention()
	if err != nil || len(attention.Proposals) != 1 || attention.Proposals[0].Status != "accepting" {
		t.Fatalf("reserved Proposal must remain visible for recovery: %+v (%v)", attention, err)
	}
	if _, err := store.ReviewProposal(ReviewProposalInput{ProposalID: proposal.ID, Decision: "reject", ExpectedVersion: 2,
		ReviewedBy: "human:other", Reason: "race"}); err == nil {
		t.Fatal("a concurrent rejection must not cross an acceptance reservation")
	}
	if _, err := store.ReviewProposal(ReviewProposalInput{ProposalID: proposal.ID, Decision: "accept", ExpectedVersion: 2,
		ReviewedBy: "human:test", AcceptedRef: "noema://cell/nb_test/c-q"}); err == nil {
		t.Fatal("an existing but different cell must not satisfy the Proposal")
	}
	writeTestNotebook(t, root, "research/synthesis.noema", "Synthesis", []testCell{
		{id: "c-q", meta: map[string]any{"kind": "question"}, source: "What is true?"},
		{id: "c-ghost", meta: map[string]any{"kind": "work", "title": "Ghost", "lineage": []string{"c-q"}}, source: "Different"},
	})
	if _, err := store.IndexNotebook("research/synthesis.noema", IndexOptions{Actor: "node", Reason: "proposal.accept"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReviewProposal(ReviewProposalInput{ProposalID: proposal.ID, Decision: "accept", ExpectedVersion: 2,
		ReviewedBy: "human:test", AcceptedRef: "noema://cell/nb_test/c-ghost"}); err == nil {
		t.Fatal("a materialized cell with different content must not satisfy the Proposal")
	}
	writeTestNotebook(t, root, "research/synthesis.noema", "Synthesis", []testCell{
		{id: "c-q", meta: map[string]any{"kind": "question"}, source: "What is true?"},
		{id: "c-ghost", meta: map[string]any{"kind": "work", "title": "Ghost", "lineage": []string{"c-q"}}, source: "Investigate"},
	})
	if _, err := store.IndexNotebook("research/synthesis.noema", IndexOptions{Actor: "node", Reason: "proposal.accept.retry"}); err != nil {
		t.Fatal(err)
	}
	result, err := store.ReviewProposal(ReviewProposalInput{ProposalID: proposal.ID, Decision: "accept", ExpectedVersion: 2,
		ReviewedBy: "human:test", AcceptedRef: "noema://cell/nb_test/c-ghost"})
	if err != nil || result.Proposal.AcceptedRef != "noema://cell/nb_test/c-ghost" || result.Proposal.Version != 3 {
		t.Fatalf("materialized cell finalization failed: %+v (%v)", result, err)
	}
}

func TestWorkstreamExportIsDeterministicAndDisclosureSafe(t *testing.T) {
	store, root, artifact := setupSynthesisTest(t)
	publicProposal, err := store.CreateProposal(findingProposalInput("export-public", artifact))
	if err != nil {
		t.Fatal(err)
	}
	publicReview, err := store.ReviewProposal(ReviewProposalInput{ProposalID: publicProposal.ID, Decision: "accept",
		ExpectedVersion: 1, ReviewedBy: "human:test"})
	if err != nil {
		t.Fatal(err)
	}
	localInput := findingProposalInput("export-local", artifact)
	localFinding := mapValue(localInput.Payload["finding"])
	const canary = "NOEMA_LOCAL_EXPORT_CANARY_7c1d"
	localFinding["statement"] = canary
	localFinding["disclosure"] = "local_only"
	localProposal, err := store.CreateProposal(localInput)
	if err != nil {
		t.Fatal(err)
	}
	localReview, err := store.ReviewProposal(ReviewProposalInput{ProposalID: localProposal.ID, Decision: "accept",
		ExpectedVersion: 1, ReviewedBy: "human:test"})
	if err != nil {
		t.Fatal(err)
	}

	writeTestNotebook(t, root, "research/synthesis.noema", "Synthesis", []testCell{
		{id: "c-q", meta: map[string]any{"kind": "question"}, source: "What is true?"},
		{id: "c-private", meta: map[string]any{"kind": "work", "disclosure": "local_only", "lineage": []string{"c-q"}}, source: canary},
	})
	if _, err := store.IndexNotebook("research/synthesis.noema", IndexOptions{Actor: "test", Reason: "local cell"}); err != nil {
		t.Fatal(err)
	}
	irPayload := func(requestID string, ids ...string) {
		nodes := make([]any, 0, len(ids))
		for _, id := range ids {
			nodes = append(nodes, map[string]any{"id": id, "kind": "finding"})
		}
		proposal, err := store.CreateProposal(CreateProposalInput{ClientRequestID: requestID, WorkstreamID: "ws_test",
			Kind: "research_ir.create", ProposedBy: "agent:pi", SourceAdapter: "pi-hook",
			Payload: map[string]any{"schema": "noema.research-ir/1", "nodes": nodes, "edges": []any{}},
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.ReviewProposal(ReviewProposalInput{ProposalID: proposal.ID, Decision: "accept",
			ExpectedVersion: 1, ReviewedBy: "human:test"}); err != nil {
			t.Fatal(err)
		}
	}
	irPayload("export-ir-public", publicReview.Finding.ID)
	irPayload("export-ir-local", publicReview.Finding.ID, localReview.Finding.ID)
	publicTask := createTestTask(t, store, "export-task-public", "Public export task")
	localTask, err := store.CreateTask(CreateTaskInput{ClientRequestID: "export-task-local", WorkstreamID: "ws_test",
		CreatedBy: "human:test", Task: TaskSpec{Title: "Private export task", Objective: canary,
			Disclosure: "local_only"}})
	if err != nil {
		t.Fatal(err)
	}
	derivedTask, err := store.CreateTask(CreateTaskInput{ClientRequestID: "export-task-derived", WorkstreamID: "ws_test",
		CreatedBy: "human:test", Task: TaskSpec{ParentTaskID: localTask.ID, Title: "Structurally private child",
			Objective: "This project-marked child still depends on a withheld parent.", Disclosure: "project"}})
	if err != nil {
		t.Fatal(err)
	}
	publicJob, err := store.CreateJob(CreateJobInput{ClientRequestID: "export-job-public", WorkstreamID: "ws_test",
		CreatedBy: "human:test", Job: testJobSpec(publicTask.ID, "pure", "forbidden", 2)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateJob(CreateJobInput{ClientRequestID: "export-job-private", WorkstreamID: "ws_test",
		CreatedBy: "human:test", Job: testJobSpec(derivedTask.ID, "pure", "forbidden", 2)}); err != nil {
		t.Fatal(err)
	}
	worker, err := store.RegisterWorker(RegisterWorkerInput{ID: "worker:test:export", Kind: "deterministic",
		Transport: "in-process", Capabilities: []string{"tests.run"}})
	if err != nil {
		t.Fatal(err)
	}
	claim, err := store.ClaimJob(ClaimJobInput{JobID: publicJob.ID, WorkerID: worker.ID,
		ClaimRequestID: "export-claim", ExecutionMode: "deterministic"})
	if err != nil {
		t.Fatal(err)
	}

	first, err := store.CreateWorkstreamExport(CreateWorkstreamExportInput{WorkstreamID: "ws_test", ExportedBy: "human:test"})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.ExcludedCellIDs) != 1 || first.ExcludedCellIDs[0] != "c-private" {
		t.Fatalf("export result must surface omitted local cells: %+v", first)
	}
	_, firstBytes, err := store.ReadArtifact(first.Artifact.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(firstBytes), canary) {
		t.Fatal("default Workstream export leaked local_only content")
	}
	if strings.Contains(string(firstBytes), claim.Lease.Token) {
		t.Fatal("Workstream export leaked a live worker lease token")
	}
	var pkg map[string]any
	if err := json.Unmarshal(firstBytes, &pkg); err != nil {
		t.Fatal(err)
	}
	if pkg["schema"] != "noema.workstream-export/1" || len(pkg["findings"].([]any)) != 1 || len(pkg["researchIr"].([]any)) != 1 ||
		len(pkg["tasks"].([]any)) != 1 || len(pkg["jobs"].([]any)) != 1 || len(pkg["invocations"].([]any)) != 1 ||
		len(pkg["workers"].([]any)) != 1 || len(pkg["workerLeases"].([]any)) != 1 {
		t.Fatalf("unexpected disclosure-safe export: %s", firstBytes)
	}
	disclosure := pkg["disclosure"].(map[string]any)
	if len(disclosure["excludedCellIds"].([]any)) != 1 || len(disclosure["excludedFindingIds"].([]any)) != 1 ||
		len(disclosure["excludedVersions"].([]any)) != 1 || len(disclosure["excludedTaskIds"].([]any)) != 2 ||
		len(disclosure["excludedJobIds"].([]any)) != 1 {
		t.Fatalf("export must report every disclosure omission: %+v", disclosure)
	}
	second, err := store.CreateWorkstreamExport(CreateWorkstreamExportInput{WorkstreamID: "ws_test", ExportedBy: "human:test"})
	if err != nil {
		t.Fatal(err)
	}
	_, secondBytes, err := store.ReadArtifact(second.Artifact.ID)
	if err != nil {
		t.Fatal(err)
	}
	if string(firstBytes) != string(secondBytes) || first.Artifact.ID != second.Artifact.ID {
		t.Fatal("an unchanged Workstream must produce identical export bytes and CAS identity")
	}
	full, err := store.CreateWorkstreamExport(CreateWorkstreamExportInput{WorkstreamID: "ws_test", ExportedBy: "human:test", IncludeLocalOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	_, fullBytes, err := store.ReadArtifact(full.Artifact.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(fullBytes), canary) {
		t.Fatal("explicit full export must retain local_only content")
	}
}
