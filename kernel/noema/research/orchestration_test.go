package research

import (
	"encoding/base64"
	"strings"
	"testing"
)

func orchestrationStore(t *testing.T) (*Store, Artifact) {
	t.Helper()
	store, root, _ := setupSynthesisTest(t)
	artifact, err := store.ImportArtifact(ImportArtifactInput{
		Kind: "worker-output", MediaType: "text/plain; charset=utf-8",
		ContentBase64: base64.StdEncoding.EncodeToString([]byte("verified output")),
		WorkstreamID:  "ws_test", SourceURI: "worker:test",
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = root
	return store, artifact
}

func createTestTask(t *testing.T, store *Store, requestID, title string) Task {
	t.Helper()
	task, err := store.CreateTask(CreateTaskInput{ClientRequestID: requestID, WorkstreamID: "ws_test",
		CreatedBy: "human:test", Task: TaskSpec{Title: title, Objective: "Prove the acceptance criteria.",
			AcceptanceCriteria: []any{"result is reproducible"}, Disclosure: "project"}})
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func testJobSpec(taskID, effect, inference string, attempts int) JobSpec {
	return JobSpec{TaskID: taskID, Kind: "tests.run", Inputs: map[string]any{"suite": "focused"},
		Requirements: map[string]any{"capabilities": []any{"tests.run"}},
		Inference:    InferenceSpec{Policy: inference, MinimumCapability: "general-semantic-reasoning"},
		Effects:      EffectSpec{Class: effect}, Budget: BudgetSpec{InputTokensMax: 1000, OutputTokensMax: 500,
			CostUSDMax: 1, WallTimeSecondsMax: 60, RemoteDisclosureBytesMax: 4096}, Retry: RetrySpec{Policy: "safe_only", AttemptsMax: attempts},
		CompletionCondition: map[string]any{"exitCode": 0}}
}

func TestTaskJobDelegationProposalsMaterializeAndPreserveArtifactProvenance(t *testing.T) {
	store, artifact := orchestrationStore(t)
	parentProposal, err := store.CreateProposal(CreateProposalInput{ClientRequestID: "task-parent-proposal",
		WorkstreamID: "ws_test", Kind: "task.create", ProposedBy: "agent:pi:orchestrator", SourceAdapter: "pi-rpc",
		Payload: map[string]any{"task": map[string]any{"title": "Synthesize", "objective": "Close the main gap",
			"acceptanceCriteria": []any{"child result is linked"}, "disclosure": "project"}}})
	if err != nil {
		t.Fatal(err)
	}
	parentReview, err := store.ReviewProposal(ReviewProposalInput{ProposalID: parentProposal.ID, Decision: "accept",
		ExpectedVersion: 1, ReviewedBy: "human:test"})
	if err != nil || parentReview.Task == nil || parentReview.Proposal.AcceptedRef != "task:"+parentReview.Task.ID {
		t.Fatalf("task Proposal did not materialize: %+v (%v)", parentReview, err)
	}
	parent := *parentReview.Task

	childProposal, err := store.CreateProposal(CreateProposalInput{ClientRequestID: "task-child-proposal",
		WorkstreamID: "ws_test", Kind: "task.create", ProposedBy: "agent:pi:orchestrator", SourceAdapter: "pi-rpc",
		Payload: map[string]any{"task": map[string]any{"parentTaskId": parent.ID, "title": "Run symbolic checks",
			"objective": "Test the candidate invariant", "acceptanceCriteria": []any{"tests pass"}, "disclosure": "project"}}})
	if err != nil {
		t.Fatal(err)
	}
	childReview, err := store.ReviewProposal(ReviewProposalInput{ProposalID: childProposal.ID, Decision: "accept",
		ExpectedVersion: 1, ReviewedBy: "human:test"})
	if err != nil || childReview.Task == nil {
		t.Fatalf("child Task Proposal did not materialize: %+v (%v)", childReview, err)
	}
	child := *childReview.Task

	jobProposal, err := store.CreateProposal(CreateProposalInput{ClientRequestID: "job-proposal",
		WorkstreamID: "ws_test", Kind: "job.create", ProposedBy: "agent:pi:orchestrator", SourceAdapter: "pi-rpc",
		Payload: map[string]any{"job": testJobSpec(child.ID, "pure", "forbidden", 2)}})
	if err != nil {
		t.Fatal(err)
	}
	jobReview, err := store.ReviewProposal(ReviewProposalInput{ProposalID: jobProposal.ID, Decision: "accept",
		ExpectedVersion: 1, ReviewedBy: "human:test"})
	if err != nil || jobReview.Job == nil {
		t.Fatalf("Job Proposal did not materialize: %+v (%v)", jobReview, err)
	}
	job := *jobReview.Job

	delegationProposal, err := store.CreateProposal(CreateProposalInput{ClientRequestID: "delegation-proposal",
		WorkstreamID: "ws_test", Kind: "delegation.create", ProposedBy: "agent:pi:orchestrator", SourceAdapter: "pi-rpc",
		Payload: map[string]any{"delegation": map[string]any{"parentTaskId": parent.ID,
			"requestedBy": map[string]any{"type": "agent", "id": "agent:pi:orchestrator"},
			"reason":      map[string]any{"summary": "A specialist should test the symbolic invariant."},
			"childTaskId": child.ID, "childJobIds": []any{job.ID},
			"target":      map[string]any{"preferredWorkerKind": "deterministic"},
			"constraints": map[string]any{"network": "deny"}}}})
	if err != nil {
		t.Fatal(err)
	}
	delegationReview, err := store.ReviewProposal(ReviewProposalInput{ProposalID: delegationProposal.ID, Decision: "accept",
		ExpectedVersion: 1, ReviewedBy: "human:test"})
	if err != nil || delegationReview.Delegation == nil {
		t.Fatalf("Delegation Proposal did not materialize: %+v (%v)", delegationReview, err)
	}

	worker, err := store.RegisterWorker(RegisterWorkerInput{ID: "worker:test:deterministic", Kind: "deterministic",
		Transport: "in-process", Capabilities: []string{"tests.run"}})
	if err != nil {
		t.Fatal(err)
	}
	claim, err := store.ClaimJob(ClaimJobInput{JobID: job.ID, WorkerID: worker.ID,
		ClaimRequestID: "claim-delegated-job", ExecutionMode: "deterministic"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartJob(JobLeaseInput{JobID: job.ID, InvocationID: claim.Invocation.ID,
		WorkerID: worker.ID, Token: claim.Lease.Token, Epoch: claim.Lease.Epoch}); err != nil {
		t.Fatal(err)
	}
	completed, err := store.CompleteJob(FinishJobInput{JobID: job.ID, InvocationID: claim.Invocation.ID,
		WorkerID: worker.ID, Token: claim.Lease.Token, Epoch: claim.Lease.Epoch,
		Result: map[string]any{"exitCode": 0}, ArtifactIDs: []string{artifact.ID}})
	if err != nil || completed.Job.State != "completed" {
		t.Fatalf("delegated job did not complete: %+v (%v)", completed, err)
	}
	delegation, err := store.GetDelegation(delegationReview.Delegation.ID)
	if err != nil || len(delegation.ChildJobIDs) != 1 || delegation.ChildJobIDs[0] != job.ID ||
		len(delegation.OutputArtifactIDs) != 1 || delegation.OutputArtifactIDs[0] != artifact.ID {
		t.Fatalf("parent-to-artifact provenance is incomplete: %+v (%v)", delegation, err)
	}
	events, err := store.Events("", 0, 1000)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(eventTypes(events), ",")
	for _, wanted := range []string{"task.created", "job.queued", "delegation.created", "job.claimed", "job.completed", "proposal.reviewed"} {
		if !strings.Contains(joined, wanted) {
			t.Fatalf("missing %s in events: %s", wanted, joined)
		}
	}
}

func TestOptionalInferenceRequiresDurableDeterministicUnresolvedAndAccountsUsage(t *testing.T) {
	store, disclosure := orchestrationStore(t)
	task := createTestTask(t, store, "task-optional", "Optional inference")
	job, err := store.CreateJob(CreateJobInput{ClientRequestID: "job-optional", WorkstreamID: "ws_test",
		CreatedBy: "human:test", Job: testJobSpec(task.ID, "pure", "optional", 3)})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.RegisterWorker(RegisterWorkerInput{ID: "worker:test:hybrid", Kind: "pi", Profile: "worker",
		Transport: "pi-rpc", Capabilities: []string{"tests.run", "general-semantic-reasoning"}, InferenceCapable: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimJob(ClaimJobInput{JobID: job.ID, WorkerID: "worker:test:hybrid",
		ClaimRequestID: "claim-too-early", ExecutionMode: "inference"}); err == nil || !strings.Contains(err.Error(), "deterministic") {
		t.Fatalf("optional inference skipped its deterministic stage: %v", err)
	}
	claim, err := store.ClaimJob(ClaimJobInput{JobID: job.ID, WorkerID: "worker:test:hybrid",
		ClaimRequestID: "claim-deterministic", ExecutionMode: "deterministic"})
	if err != nil {
		t.Fatal(err)
	}
	lease := JobLeaseInput{JobID: job.ID, InvocationID: claim.Invocation.ID, WorkerID: claim.Lease.WorkerID,
		Token: claim.Lease.Token, Epoch: claim.Lease.Epoch}
	if _, err := store.StartJob(lease); err != nil {
		t.Fatal(err)
	}
	unresolved, err := store.ReportJobUnresolved(FinishJobInput{JobID: job.ID, InvocationID: claim.Invocation.ID,
		WorkerID: claim.Lease.WorkerID, Token: claim.Lease.Token, Epoch: claim.Lease.Epoch,
		Reason: "deterministic handler lacks the semantic premise", Result: map[string]any{"missing": "premise"}})
	if err != nil || !unresolved.Requeued || unresolved.Job.DeterministicState != "unresolved" {
		t.Fatalf("unresolved bridge was not persisted: %+v (%v)", unresolved, err)
	}
	inference, err := store.ClaimJob(ClaimJobInput{JobID: job.ID, WorkerID: "worker:test:hybrid",
		ClaimRequestID: "claim-inference", ExecutionMode: "inference", DisclosureView: disclosure.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartJob(JobLeaseInput{JobID: job.ID, InvocationID: inference.Invocation.ID,
		WorkerID: inference.Lease.WorkerID, Token: inference.Lease.Token, Epoch: inference.Lease.Epoch}); err != nil {
		t.Fatal(err)
	}
	completed, err := store.CompleteJob(FinishJobInput{JobID: job.ID, InvocationID: inference.Invocation.ID,
		WorkerID: inference.Lease.WorkerID, Token: inference.Lease.Token, Epoch: inference.Lease.Epoch,
		Result: map[string]any{"answer": "premise established", "exitCode": 0}, Usage: JobUsage{InputTokens: 400,
			OutputTokens: 80, CostMicrousd: 125000, InferenceCalls: 1, ObservedWallMS: 2500}})
	if err != nil || completed.Invocation.Result == nil || completed.Invocation.Result.InputTokens != 400 {
		t.Fatalf("inference usage was not authoritatively recorded: %+v (%v)", completed, err)
	}
}

func TestClaimValidatesAndLinksContentAddressedContextAndDisclosure(t *testing.T) {
	store, resource := orchestrationStore(t)
	task := createTestTask(t, store, "task-disclosure", "Bound remote disclosure")
	worker, err := store.RegisterWorker(RegisterWorkerInput{ID: "worker:test:remote", Kind: "remote", Profile: "semantic",
		Transport: "remote-api", Capabilities: []string{"tests.run", "general-semantic-reasoning"}, InferenceCapable: true})
	if err != nil {
		t.Fatal(err)
	}
	jobSpec := testJobSpec(task.ID, "pure", "required", 1)
	job, err := store.CreateJob(CreateJobInput{ClientRequestID: "job-disclosure", WorkstreamID: "ws_test",
		CreatedBy: "human:test", Job: jobSpec})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimJob(ClaimJobInput{JobID: job.ID, WorkerID: worker.ID,
		ClaimRequestID: "claim-no-disclosure", ExecutionMode: "inference"}); err == nil || !strings.Contains(err.Error(), "DisclosureView") {
		t.Fatalf("inference claim crossed the boundary without a DisclosureView: %v", err)
	}
	if _, err := store.ClaimJob(ClaimJobInput{JobID: job.ID, WorkerID: worker.ID,
		ClaimRequestID: "claim-missing-context", ExecutionMode: "inference", ContextSnapshot: "art_missing",
		DisclosureView: resource.ID}); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("claim accepted a missing context artifact: %v", err)
	}

	context, err := store.ImportArtifact(ImportArtifactInput{Kind: "demo-context-snapshot", MediaType: "application/json",
		ContentBase64: base64.StdEncoding.EncodeToString([]byte(`{"schema":"noema.context-snapshot/1"}`)),
		WorkstreamID:  "ws_test", SourceURI: "test:context"})
	if err != nil {
		t.Fatal(err)
	}
	disclosure, err := store.ImportArtifact(ImportArtifactInput{Kind: "demo-disclosure-view", MediaType: "application/json",
		ContentBase64: base64.StdEncoding.EncodeToString([]byte(`{"schema":"noema.disclosure-view/1","items":[]}`)),
		WorkstreamID:  "ws_test", SourceURI: "test:disclosure"})
	if err != nil {
		t.Fatal(err)
	}
	claim, err := store.ClaimJob(ClaimJobInput{JobID: job.ID, WorkerID: worker.ID,
		ClaimRequestID: "claim-with-disclosure", ExecutionMode: "inference", ContextSnapshot: context.ID,
		DisclosureView: disclosure.ID, ResolvedResources: []any{map[string]any{"artifactId": resource.ID}}})
	if err != nil {
		t.Fatal(err)
	}
	var linked int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM job_artifacts WHERE job_id = ? AND invocation_id = ? AND role = 'input'`,
		job.ID, claim.Invocation.ID).Scan(&linked); err != nil || linked != 3 {
		t.Fatalf("claim input provenance is incomplete: count=%d err=%v", linked, err)
	}

	tinySpec := testJobSpec(task.ID, "pure", "required", 1)
	tinySpec.Budget.RemoteDisclosureBytesMax = 1
	tiny, err := store.CreateJob(CreateJobInput{ClientRequestID: "job-disclosure-tiny", WorkstreamID: "ws_test",
		CreatedBy: "human:test", Job: tinySpec})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimJob(ClaimJobInput{JobID: tiny.ID, WorkerID: worker.ID,
		ClaimRequestID: "claim-over-budget", ExecutionMode: "inference", DisclosureView: disclosure.ID}); err == nil ||
		!strings.Contains(err.Error(), "remote-disclosure budget") {
		t.Fatalf("claim ignored the frozen disclosure byte budget: %v", err)
	}
}

func TestInferenceForbiddenIsZeroUsageAndEffectClassControlsAutomaticReplay(t *testing.T) {
	store, _ := orchestrationStore(t)
	task := createTestTask(t, store, "task-retry", "Retry safety")
	worker, err := store.RegisterWorker(RegisterWorkerInput{ID: "worker:test:retry", Kind: "pi", Profile: "worker",
		Transport: "pi-rpc", Capabilities: []string{"tests.run"}, InferenceCapable: true})
	if err != nil {
		t.Fatal(err)
	}
	pure, err := store.CreateJob(CreateJobInput{ClientRequestID: "job-pure", WorkstreamID: "ws_test",
		CreatedBy: "human:test", Job: testJobSpec(task.ID, "pure", "forbidden", 2)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimJob(ClaimJobInput{JobID: pure.ID, WorkerID: worker.ID,
		ClaimRequestID: "forbidden-inference", ExecutionMode: "inference"}); err == nil || !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("inference-forbidden Job reached inference mode: %v", err)
	}
	pureClaim, err := store.ClaimJob(ClaimJobInput{JobID: pure.ID, WorkerID: worker.ID,
		ClaimRequestID: "pure-claim-1", ExecutionMode: "deterministic"})
	if err != nil {
		t.Fatal(err)
	}
	pureLease := JobLeaseInput{JobID: pure.ID, InvocationID: pureClaim.Invocation.ID, WorkerID: worker.ID,
		Token: pureClaim.Lease.Token, Epoch: pureClaim.Lease.Epoch}
	if _, err := store.StartJob(pureLease); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CompleteJob(FinishJobInput{JobID: pure.ID, InvocationID: pureClaim.Invocation.ID,
		WorkerID: worker.ID, Token: pureClaim.Lease.Token, Epoch: pureClaim.Lease.Epoch,
		Usage: JobUsage{InferenceCalls: 1}}); err == nil || !strings.Contains(err.Error(), "zero inference") {
		t.Fatalf("forbidden Job accepted inference usage: %v", err)
	}
	if _, err := store.db.Exec(`UPDATE worker_leases SET expires_at = 0 WHERE job_id = ?`, pure.ID); err != nil {
		t.Fatal(err)
	}
	changed, err := store.ExpireJobLeases()
	if err != nil || len(changed) != 1 || changed[0].State != "queued" {
		t.Fatalf("pure Job was not automatically requeued: %+v (%v)", changed, err)
	}
	if _, err := store.CompleteJob(FinishJobInput{JobID: pure.ID, InvocationID: pureClaim.Invocation.ID,
		WorkerID: worker.ID, Token: pureClaim.Lease.Token, Epoch: pureClaim.Lease.Epoch}); err == nil {
		t.Fatal("stale worker completed after lease expiry")
	}
	second, err := store.ClaimJob(ClaimJobInput{JobID: pure.ID, WorkerID: worker.ID,
		ClaimRequestID: "pure-claim-2", ExecutionMode: "deterministic"})
	if err != nil || second.Lease.Epoch <= pureClaim.Lease.Epoch {
		t.Fatalf("safe retry did not create a fenced Invocation: %+v (%v)", second, err)
	}

	unknown, err := store.CreateJob(CreateJobInput{ClientRequestID: "job-unknown", WorkstreamID: "ws_test",
		CreatedBy: "human:test", Job: testJobSpec(task.ID, "unknown", "forbidden", 2)})
	if err != nil {
		t.Fatal(err)
	}
	unknownClaim, err := store.ClaimJob(ClaimJobInput{JobID: unknown.ID, WorkerID: worker.ID,
		ClaimRequestID: "unknown-claim", ExecutionMode: "deterministic"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartJob(JobLeaseInput{JobID: unknown.ID, InvocationID: unknownClaim.Invocation.ID,
		WorkerID: worker.ID, Token: unknownClaim.Lease.Token, Epoch: unknownClaim.Lease.Epoch}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE worker_leases SET expires_at = 0 WHERE job_id = ?`, unknown.ID); err != nil {
		t.Fatal(err)
	}
	changed, err = store.ExpireJobLeases()
	if err != nil || len(changed) != 1 || changed[0].State != "orphaned" {
		t.Fatalf("unknown side effect was replayed automatically: %+v (%v)", changed, err)
	}
	retried, err := store.RetryJob(RetryJobInput{JobID: unknown.ID, ExpectedVersion: changed[0].Version,
		RequestedBy: "human:test", Reason: "external system confirms no mutation happened"})
	if err != nil || retried.State != "queued" {
		t.Fatalf("manual recovery did not requeue inspected Job: %+v (%v)", retried, err)
	}
}

func TestOrchestrationIdempotencyKeysAreBoundToCanonicalRequests(t *testing.T) {
	store, _ := orchestrationStore(t)
	taskInput := CreateTaskInput{ClientRequestID: "task-idempotent", WorkstreamID: "ws_test", CreatedBy: "human:test",
		Task: TaskSpec{Title: "Stable task", Objective: "Verify request binding", Disclosure: "project"}}
	firstTask, err := store.CreateTask(taskInput)
	if err != nil {
		t.Fatal(err)
	}
	secondTask, err := store.CreateTask(taskInput)
	if err != nil || secondTask.ID != firstTask.ID {
		t.Fatalf("identical Task retry was not idempotent: %+v (%v)", secondTask, err)
	}
	changedTask := taskInput
	changedTask.Task.Title = "Different task"
	if _, err := store.CreateTask(changedTask); err == nil || !strings.Contains(err.Error(), "different content") {
		t.Fatalf("Task request id accepted different content: %v", err)
	}

	child := createTestTask(t, store, "task-idempotent-child", "Stable child")
	jobInput := CreateJobInput{ClientRequestID: "job-idempotent", WorkstreamID: "ws_test", CreatedBy: "human:test",
		Job: testJobSpec(child.ID, "pure", "forbidden", 2)}
	firstJob, err := store.CreateJob(jobInput)
	if err != nil {
		t.Fatal(err)
	}
	secondJob, err := store.CreateJob(CreateJobInput{ClientRequestID: "job-idempotent", WorkstreamID: "ws_test",
		CreatedBy: "human:test", Job: testJobSpec(child.ID, "pure", "forbidden", 2)})
	if err != nil || secondJob.ID != firstJob.ID {
		t.Fatalf("identical Job retry was not idempotent: %+v (%v)", secondJob, err)
	}
	changedJob := testJobSpec(child.ID, "unknown", "forbidden", 2)
	if _, err := store.CreateJob(CreateJobInput{ClientRequestID: "job-idempotent", WorkstreamID: "ws_test",
		CreatedBy: "human:test", Job: changedJob}); err == nil || !strings.Contains(err.Error(), "different content") {
		t.Fatalf("Job request id accepted different content: %v", err)
	}

	delegationInput := CreateDelegationInput{ClientRequestID: "delegation-idempotent", WorkstreamID: "ws_test",
		Delegation: DelegationSpec{ParentTaskID: firstTask.ID, ChildTaskID: child.ID, ChildJobIDs: []string{firstJob.ID},
			RequestedBy: DelegationActor{Type: "human", ID: "human:test"},
			Reason:      map[string]any{"summary": "Bound child work"}}}
	firstDelegation, err := store.CreateDelegation(delegationInput)
	if err != nil {
		t.Fatal(err)
	}
	secondDelegation, err := store.CreateDelegation(delegationInput)
	if err != nil || secondDelegation.ID != firstDelegation.ID {
		t.Fatalf("identical Delegation retry was not idempotent: %+v (%v)", secondDelegation, err)
	}
	changedDelegation := delegationInput
	changedDelegation.Delegation.Reason = map[string]any{"summary": "Different reason"}
	if _, err := store.CreateDelegation(changedDelegation); err == nil || !strings.Contains(err.Error(), "different content") {
		t.Fatalf("Delegation request id accepted different content: %v", err)
	}

	worker, err := store.RegisterWorker(RegisterWorkerInput{ID: "worker:test:idempotency", Kind: "deterministic",
		Transport: "in-process", Capabilities: []string{"tests.run"}})
	if err != nil {
		t.Fatal(err)
	}
	claimInput := ClaimJobInput{JobID: firstJob.ID, WorkerID: worker.ID, ClaimRequestID: "claim-idempotent",
		ExecutionMode: "deterministic", Runtime: map[string]any{"adapter": "test"}}
	firstClaim, err := store.ClaimJob(claimInput)
	if err != nil {
		t.Fatal(err)
	}
	secondClaim, err := store.ClaimJob(claimInput)
	if err != nil || secondClaim.Invocation.ID != firstClaim.Invocation.ID || secondClaim.Lease.Token != firstClaim.Lease.Token {
		t.Fatalf("identical claim retry did not replay the live result: %+v (%v)", secondClaim, err)
	}
	claimInput.Runtime = map[string]any{"adapter": "different"}
	if _, err := store.ClaimJob(claimInput); err == nil || !strings.Contains(err.Error(), "different content") {
		t.Fatalf("claim request id accepted a different frozen context: %v", err)
	}
}

func TestJobDependenciesFenceClaimsUntilPrerequisitesComplete(t *testing.T) {
	store, _ := orchestrationStore(t)
	task := createTestTask(t, store, "task-job-dependencies", "Dependency scheduling")
	prerequisite, err := store.CreateJob(CreateJobInput{ClientRequestID: "job-prerequisite", WorkstreamID: "ws_test",
		CreatedBy: "human:test", Job: testJobSpec(task.ID, "pure", "forbidden", 1)})
	if err != nil {
		t.Fatal(err)
	}
	dependentSpec := testJobSpec(task.ID, "pure", "forbidden", 1)
	dependentSpec.Kind = "tests.after-prerequisite"
	dependentSpec.DependsOn = []string{prerequisite.ID}
	dependent, err := store.CreateJob(CreateJobInput{ClientRequestID: "job-dependent", WorkstreamID: "ws_test",
		CreatedBy: "human:test", Job: dependentSpec})
	if err != nil || len(dependent.DependsOn) != 1 || dependent.DependsOn[0] != prerequisite.ID {
		t.Fatalf("Job dependency was not stored: %+v (%v)", dependent, err)
	}
	worker, err := store.RegisterWorker(RegisterWorkerInput{ID: "worker:test:dependencies", Kind: "deterministic",
		Transport: "in-process", Capabilities: []string{"tests.run"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimJob(ClaimJobInput{JobID: dependent.ID, WorkerID: worker.ID,
		ClaimRequestID: "dependent-too-early", ExecutionMode: "deterministic"}); err == nil || !strings.Contains(err.Error(), "dependencies") {
		t.Fatalf("dependent Job was claimable before its prerequisite: %v", err)
	}
	claim, err := store.ClaimJob(ClaimJobInput{JobID: prerequisite.ID, WorkerID: worker.ID,
		ClaimRequestID: "prerequisite-claim", ExecutionMode: "deterministic"})
	if err != nil {
		t.Fatal(err)
	}
	lease := JobLeaseInput{JobID: prerequisite.ID, InvocationID: claim.Invocation.ID, WorkerID: worker.ID,
		Token: claim.Lease.Token, Epoch: claim.Lease.Epoch}
	if _, err := store.StartJob(lease); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CompleteJob(FinishJobInput{JobID: prerequisite.ID, InvocationID: claim.Invocation.ID,
		WorkerID: worker.ID, Token: claim.Lease.Token, Epoch: claim.Lease.Epoch,
		Result: map[string]any{"exitCode": 1}}); err == nil || !strings.Contains(err.Error(), "completion condition") {
		t.Fatalf("Job accepted a result that did not meet its completion condition: %v", err)
	}
	if _, err := store.CompleteJob(FinishJobInput{JobID: prerequisite.ID, InvocationID: claim.Invocation.ID,
		WorkerID: worker.ID, Token: claim.Lease.Token, Epoch: claim.Lease.Epoch,
		Result: map[string]any{"exitCode": 0}}); err != nil {
		t.Fatal(err)
	}
	ready, err := store.ClaimJob(ClaimJobInput{JobID: dependent.ID, WorkerID: worker.ID,
		ClaimRequestID: "dependent-ready", ExecutionMode: "deterministic"})
	if err != nil || len(ready.Job.DependsOn) != 1 || ready.Job.DependsOn[0] != prerequisite.ID {
		t.Fatalf("dependent Job did not become claimable with its edge attached: %+v (%v)", ready, err)
	}
}

func TestLeaseExpiryCanBeScopedToOneWorkstream(t *testing.T) {
	store, _ := orchestrationStore(t)
	if _, err := store.db.Exec(`INSERT INTO workstreams(id, title, created_at, updated_at) VALUES('ws_other', 'Other', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	targetTask := createTestTask(t, store, "task-expiry-target", "Target expiry")
	otherTask, err := store.CreateTask(CreateTaskInput{ClientRequestID: "task-expiry-other", WorkstreamID: "ws_other",
		CreatedBy: "human:test", Task: TaskSpec{Title: "Other expiry", Objective: "Remain untouched", Disclosure: "project"}})
	if err != nil {
		t.Fatal(err)
	}
	targetJob, err := store.CreateJob(CreateJobInput{ClientRequestID: "job-expiry-target", WorkstreamID: "ws_test",
		CreatedBy: "human:test", Job: testJobSpec(targetTask.ID, "pure", "forbidden", 2)})
	if err != nil {
		t.Fatal(err)
	}
	otherJob, err := store.CreateJob(CreateJobInput{ClientRequestID: "job-expiry-other", WorkstreamID: "ws_other",
		CreatedBy: "human:test", Job: testJobSpec(otherTask.ID, "pure", "forbidden", 2)})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := store.RegisterWorker(RegisterWorkerInput{ID: "worker:test:scoped-expiry", Kind: "deterministic",
		Transport: "in-process", Capabilities: []string{"tests.run"}})
	if err != nil {
		t.Fatal(err)
	}
	for index, job := range []Job{targetJob, otherJob} {
		claim, err := store.ClaimJob(ClaimJobInput{JobID: job.ID, WorkerID: worker.ID,
			ClaimRequestID: []string{"claim-expiry-target", "claim-expiry-other"}[index], ExecutionMode: "deterministic"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.StartJob(JobLeaseInput{JobID: job.ID, InvocationID: claim.Invocation.ID,
			WorkerID: worker.ID, Token: claim.Lease.Token, Epoch: claim.Lease.Epoch}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.db.Exec(`UPDATE worker_leases SET expires_at = 0`); err != nil {
		t.Fatal(err)
	}
	changed, err := store.ExpireJobLeases("ws_test")
	if err != nil || len(changed) != 1 || changed[0].ID != targetJob.ID || changed[0].State != "queued" {
		t.Fatalf("scoped expiry changed the wrong Jobs: %+v (%v)", changed, err)
	}
	untouched, err := store.GetJob(otherJob.ID)
	if err != nil || untouched.State != "running" {
		t.Fatalf("out-of-scope Job was changed by demo reaping: %+v (%v)", untouched, err)
	}
}
