import type { ResearchRuntimeProvider } from "./kernel-research-provider.mjs";

export function findResearchProjectRoot(start: string): Promise<string>;
export function parseResearchPrompt(text: string): {
  agent: string;
  context: string[];
  skills: string[];
  workstreamId: string;
  prompt: string;
};
export function defaultResearchHistorySources(
  projectRoot: string,
  options?: { userHome?: string; env?: Record<string, string | undefined> },
): Promise<Array<{ kind: string; path: string; projectRoot: string }>>;
export function manualTUICommand(session: Record<string, any>): string[];

type RuntimeMethod = (body?: Record<string, any>) => Promise<Record<string, any>>;

export type ResearchRuntimeService = {
  resolveCell: RuntimeMethod;
  prepareRun: RuntimeMethod;
  runs: RuntimeMethod;
  run: RuntimeMethod;
  liveRun: RuntimeMethod;
  cancelRun: RuntimeMethod;
  failPreparingRun: RuntimeMethod;
  readArtifact: RuntimeMethod;
  importArtifact: RuntimeMethod;
  artifactLinks: RuntimeMethod;
  indexArtifactCorpus: RuntimeMethod;
  indexArtifactFiles: RuntimeMethod;
  searchArtifactBlocks: RuntimeMethod;
  readArtifactBlock: RuntimeMethod;
  workerLease: RuntimeMethod;
  workerAttach: RuntimeMethod;
  workerStart: RuntimeMethod;
  workerEvents: RuntimeMethod;
  workerPermission: RuntimeMethod;
  workerInput: RuntimeMethod;
  permission: RuntimeMethod;
  decidePermission: RuntimeMethod;
  inputRequest: RuntimeMethod;
  respondInput: RuntimeMethod;
  attention: RuntimeMethod;
  createProposal: RuntimeMethod;
  supervisorProposal: RuntimeMethod;
  proposal: RuntimeMethod;
  proposals: RuntimeMethod;
  reviewProposal: RuntimeMethod;
  finding: RuntimeMethod;
  findings: RuntimeMethod;
  researchIR: RuntimeMethod;
  problemModels: RuntimeMethod;
  exportWorkstream: RuntimeMethod;
  createTask: RuntimeMethod;
  task: RuntimeMethod;
  tasks: RuntimeMethod;
  transitionTask: RuntimeMethod;
  createJob: RuntimeMethod;
  job: RuntimeMethod;
  jobs: RuntimeMethod;
  registerSchedulerWorker: RuntimeMethod;
  schedulerWorkers: RuntimeMethod;
  claimJob: RuntimeMethod;
  startJob: RuntimeMethod;
  renewJobLease: RuntimeMethod;
  expireJobLeases: RuntimeMethod;
  completeJob: RuntimeMethod;
  failJob: RuntimeMethod;
  unresolvedJob: RuntimeMethod;
  retryJob: RuntimeMethod;
  invocations: RuntimeMethod;
  createDelegation: RuntimeMethod;
  delegations: RuntimeMethod;
  orchestrationSnapshot: RuntimeMethod;
  promoteSession: RuntimeMethod;
  sessions: RuntimeMethod;
  session: RuntimeMethod;
  takeoverSession: RuntimeMethod;
  handbackSession: RuntimeMethod;
  indexHistory: RuntimeMethod;
  searchHistory: RuntimeMethod;
  peekHistory: RuntimeMethod;
  readHistory: RuntimeMethod;
};

export function createResearchRuntimeService(options?: {
  getProvider?: () => ResearchRuntimeProvider | null;
  getNotebookService?: () => {
	create?(body?: Record<string, any>): Promise<Record<string, any>>;
	snapshot?(body?: Record<string, any>): Promise<Record<string, any>>;
    writeRunResult(body?: Record<string, any>): Promise<Record<string, any>>;
    createCell?(body?: Record<string, any>): Promise<Record<string, any>>;
  } | null;
  getRuntimeDescriptor?: () => Record<string, any> | null;
  defaultRoot?: string;
  resolveKnowledgeNote?: ((id: string, root: string) => Promise<Record<string, any>>) | null;
  historySources?: (projectRoot: string) => Promise<Record<string, any>[]>;
  deliverWorkerCommand?: (command: Record<string, any>) => boolean;
}): ResearchRuntimeService;
