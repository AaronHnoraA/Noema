// Research index transport.  The Go kernel owns `<repository>/.agent/state.sqlite`
// (index, events); the Node host owns research notebook files and asks the kernel
// to reindex after every write.
export function createKernelResearchProvider({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base || typeof fetchImpl !== "function") {
    throw new Error("Kernel research provider requires baseUrl and fetch");
  }

  async function post(endpoint, body) {
    const response = await fetchImpl(`${base}/api/noema/research/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload?.code) !== 0 || !payload?.data) {
      throw Object.assign(
        new Error(String(payload?.msg || `kernel research request failed with HTTP ${response.status}`)),
        { statusCode: response.ok ? 502 : response.status },
      );
    }
    return payload.data;
  }

  return {
    index({ root, path, actor = "node", reason = "" }) {
      return post("index", { root, path, actor, reason });
    },
    status({ root, path }) {
      return post("status", { root, path });
    },
    async events({ root, notebookId = "", after = 0, limit = 200 }) {
      const data = await post("events", { root, notebookId, after, limit });
      return Array.isArray(data.events) ? data.events : [];
    },
	resolveCell({ root, notebookId, cellId }) {
	  return post("cell/resolve", { root, notebookId, cellId });
	},

    promoteSession({ root, session }) {
	  return post("session/promote", { root, session });
	},
	async sessions({ root, workstreamId = "", adapter = "", limit = 200 }) {
	  const data = await post("session/list", { root, workstreamId, adapter, limit });
	  return Array.isArray(data.sessions) ? data.sessions : [];
	},
    session({ root, id }) {
      return post("session/get", { root, id });
    },
	beginManualIntervention({ root, intervention }) {
	  return post("session/manual/begin", { root, intervention });
	},
	endManualIntervention({ root, intervention }) {
	  return post("session/manual/end", { root, intervention });
	},
	manualIntervention({ root, id }) {
	  return post("session/manual/get", { root, id });
	},
    prepareRun({ root, run }) {
      return post("run/prepare", { root, run });
    },
    async runs({ root, workstreamId = "", sessionId = "", limit = 200 }) {
      const data = await post("run/list", { root, workstreamId, sessionId, limit });
      return Array.isArray(data.runs) ? data.runs : [];
    },
    run({ root, id }) {
      return post("run/get", { root, id });
    },
    liveRun({ root, id, after = 0, limit = 200 }) {
      return post("run/live", { root, id, after, limit });
    },
    requestRunCancellation({ root, cancellation }) {
      return post("run/cancel", { root, cancellation });
    },
    failPreparedRun({ root, failure }) {
      return post("run/fail-preparing", { root, failure });
    },
    artifact({ root, id }) {
      return post("artifact/get", { root, id });
    },
    readArtifact({ root, id }) {
      return post("artifact/read", { root, id });
    },
    importArtifact({ root, artifact }) {
      return post("artifact/import", { root, artifact });
    },
    async artifactLinks({ root, workstreamId = "", notebookId = "", workNodeId = "", runId = "", limit = 200 }) {
      const data = await post("artifact/link/list", { root, workstreamId, notebookId, workNodeId, runId, limit });
      return Array.isArray(data.links) ? data.links : [];
    },
	indexArtifactCorpus({ root, index }) {
	  return post("corpus/index", { root, index });
	},
	indexArtifactFiles({ root, index }) {
	  return post("corpus/index-files", { root, index });
	},
	async searchArtifactBlocks({ root, search }) {
	  const data = await post("corpus/search", { root, search });
	  return Array.isArray(data.hits) ? data.hits : [];
	},
	readArtifactBlock({ root, id }) {
	  return post("corpus/block/read", { root, id });
	},
    createCapture({ root, capture }) {
      return post("capture/create", { root, capture });
    },
    async captures({ root, limit = 200 }) {
      const data = await post("capture/list", { root, limit });
      return Array.isArray(data.captures) ? data.captures : [];
    },
    acquireLease({ root, lease }) {
      return post("worker/lease/acquire", { root, lease });
    },
    renewLease({ root, lease }) {
      return post("worker/lease/renew", { root, lease });
    },
    expireLeases({ root }) {
      return post("worker/lease/expire", { root });
    },
    attachRun({ root, attachment }) {
      return post("worker/attach", { root, attachment });
    },
    startRun({ root, start }) {
      return post("worker/start", { root, start });
    },
    async reportWorkerEvents({ root, events }) {
      const data = await post("worker/events", { root, events });
      return Array.isArray(data.events) ? data.events : [];
    },
    requestWorkerPermission({ root, permission }) {
      return post("worker/permission", { root, permission });
    },
	requestWorkerInput({ root, input }) {
	  return post("worker/input", { root, input });
	},
    permission({ root, id }) {
      return post("permission/get", { root, id });
    },
    decidePermission({ root, decision }) {
      return post("permission/decide", { root, decision });
    },
	inputRequest({ root, id }) {
	  return post("input/get", { root, id });
	},
	respondInput({ root, response }) {
	  return post("input/respond", { root, response });
	},
	async attention({ root }) {
	  const data = await post("attention/list", { root });
	  return {
	    permissions: Array.isArray(data.permissions) ? data.permissions : [],
	    inputRequests: Array.isArray(data.inputRequests) ? data.inputRequests : [],
	    inputRuns: Array.isArray(data.inputRuns) ? data.inputRuns : [],
	    proposals: Array.isArray(data.proposals) ? data.proposals : [],
	  };
	},
	createProposal({ root, proposal }) {
	  return post("proposal/create", { root, proposal });
	},
	proposal({ root, id }) {
	  return post("proposal/get", { root, id });
	},
	async proposals({ root, workstreamId = "", status = "", limit = 200 }) {
	  const data = await post("proposal/list", { root, workstreamId, status, limit });
	  return Array.isArray(data.proposals) ? data.proposals : [];
	},
	beginProposalAcceptance({ root, review }) {
	  return post("proposal/begin-accept", { root, review });
	},
	reviewProposal({ root, review }) {
	  return post("proposal/review", { root, review });
	},
	finding({ root, id }) {
	  return post("finding/get", { root, id });
	},
	async findings({ root, workstreamId = "", status = "", query = "", limit = 200, includeLocal = false }) {
	  const data = await post("finding/list", { root, workstreamId, status, query, limit, includeLocal });
	  return Array.isArray(data.findings) ? data.findings : [];
	},
	async researchIR({ root, workstreamId, limit = 100 }) {
	  const data = await post("research-ir/list", { root, workstreamId, limit });
	  return Array.isArray(data.versions) ? data.versions : [];
	},
	async problemModels({ root, workstreamId, limit = 100 }) {
	  const data = await post("problem-model/list", { root, workstreamId, limit });
	  return Array.isArray(data.versions) ? data.versions : [];
	},
	createWorkstreamExport({ root, export: exportRequest }) {
	  return post("export/create", { root, export: exportRequest });
	},
	createTask({ root, task }) {
	  return post("task/create", { root, task });
	},
	task({ root, id }) {
	  return post("task/get", { root, id });
	},
	async tasks({ root, workstreamId = "", state = "", limit = 200, includeLocal = false }) {
	  const data = await post("task/list", { root, workstreamId, state, limit, includeLocal });
	  return Array.isArray(data.tasks) ? data.tasks : [];
	},
	transitionTask({ root, transition }) {
	  return post("task/transition", { root, transition });
	},
	createJob({ root, job }) {
	  return post("job/create", { root, job });
	},
	job({ root, id }) {
	  return post("job/get", { root, id });
	},
	async jobs({ root, workstreamId = "", taskId = "", state = "", limit = 200 }) {
	  const data = await post("job/list", { root, workstreamId, taskId, state, limit });
	  return Array.isArray(data.jobs) ? data.jobs : [];
	},
	claimJob({ root, claim }) {
	  return post("job/claim", { root, claim });
	},
	startJob({ root, lease }) {
	  return post("job/start", { root, lease });
	},
	renewJobLease({ root, lease }) {
	  return post("job/lease/renew", { root, lease });
	},
	expireJobLeases({ root, workstreamId = "" }) {
	  return post("job/lease/expire", { root, workstreamId });
	},
	completeJob({ root, completion }) {
	  return post("job/complete", { root, completion });
	},
	failJob({ root, completion }) {
	  return post("job/fail", { root, completion });
	},
	reportJobUnresolved({ root, completion }) {
	  return post("job/unresolved", { root, completion });
	},
	retryJob({ root, retry }) {
	  return post("job/retry", { root, retry });
	},
	invocation({ root, id }) {
	  return post("invocation/get", { root, id });
	},
	async invocations({ root, jobId, limit = 100 }) {
	  const data = await post("invocation/list", { root, jobId, limit });
	  return Array.isArray(data.invocations) ? data.invocations : [];
	},
	registerSchedulerWorker({ root, worker }) {
	  return post("scheduler/worker/register", { root, worker });
	},
	schedulerWorker({ root, id }) {
	  return post("scheduler/worker/get", { root, id });
	},
	async schedulerWorkers({ root, state = "", limit = 200 }) {
	  const data = await post("scheduler/worker/list", { root, state, limit });
	  return Array.isArray(data.workers) ? data.workers : [];
	},
	createDelegation({ root, delegation }) {
	  return post("delegation/create", { root, delegation });
	},
	delegation({ root, id }) {
	  return post("delegation/get", { root, id });
	},
	async delegations({ root, workstreamId = "", parentTaskId = "", childTaskId = "", limit = 200 }) {
	  const data = await post("delegation/list", { root, workstreamId, parentTaskId, childTaskId, limit });
	  return Array.isArray(data.delegations) ? data.delegations : [];
	},
    indexHistory({ root, sources }) {
      return post("history/index", { root, sources });
    },
    async searchHistory({ root, query, projectRoot = "", source = "", limit = 20 }) {
      const data = await post("history/search", { root, query, projectRoot, source, limit });
      return Array.isArray(data.hits) ? data.hits : [];
    },
    peekHistory({ root, id, maxRunes = 1200 }) {
      return post("history/peek", { root, id, maxRunes });
    },
    readHistory({ root, id }) {
      return post("history/read", { root, id });
    },
  };
}
