import type { CursorPosition, GraphPayload, Inbound, SnippetSummary, UnusedAsset } from "./types.ts";
import type { CoreConnectionStatus, CoreReconnectReason } from "./active-core-reconnect.ts";

type OpenMsg = Extract<Inbound, { type: "open" }>;
type SavedMsg = Extract<Inbound, { type: "saved" }>;
type NotesMsg = Extract<Inbound, { type: "notes" }>;
type PositionsMsg = Extract<Inbound, { type: "positions" }>;
type SnippetsMsg = Extract<Inbound, { type: "snippets" }>;
type SaveBody = {
  file: string;
  content?: string;
  changes?: {
    length: number;
    newLength: number;
    changes: Array<{ from: number; to: number; insert: string }>;
  };
  mode: string;
  clientId: string;
  seq: number;
  baseMtimeMs?: number;
  baseVersion?: string;
  refresh?: string;
};
type AssetStoreMsg = {
  ok?: boolean;
  file?: string;
  name?: string;
  type?: string;
  isImage?: boolean;
  markdownPath?: string;
  message?: string;
};
type ProseCheckBody = {
  requestId?: string;
  file?: string;
  content?: string;
  ranges?: Array<{ from: number; to: number }>;
  segments?: Array<{ from: number; text: string }>;
  totalChars?: number;
  allowLocalFallback?: boolean;
  interactive?: boolean;
};
export type LanguageToolPerformanceProfile = "responsive" | "balanced" | "quiet";
export type LanguageToolSettings = {
  automaticEnabled: boolean;
  serverUrl: string;
  language: string;
  level: "default" | "picky";
  performanceProfile: LanguageToolPerformanceProfile;
  manualLocalFallback: boolean;
  remoteTimeoutMs: number;
  retryCooldownMs: number;
};
export type LanguageToolSettingsMsg = {
  ok?: boolean;
  settings?: LanguageToolSettings;
  defaults?: LanguageToolSettings;
  revision?: string;
  message?: string;
};
export type LanguageToolSettingsUpdate = Partial<LanguageToolSettings> & { revision?: string };
export type LanguageToolProbeBody = Partial<LanguageToolSettings> & { requestId?: string };
export type LanguageToolProbeMsg = {
  ok?: boolean;
  latencyMs?: number;
  serverUrl?: string;
  version?: string;
  message?: string;
};
export type NoemaAppTheme = {
  id: string;
  name: string;
  file: string;
  colorScheme: "dark" | "light";
  backgroundColor: string;
  description: string;
};
export type NoemaAppConfig = {
  schemaVersion: 2;
  appearance: { theme: string };
  workspace: { root: string; layout: "legacy" | "wiki" };
  wiki: {
    creation: {
      activeProfile: string;
      profiles: Array<{
        id: string;
        name: string;
        partition: "public" | "private";
        repository: string;
        directory: string;
        filenamePattern: string;
        kind: string;
      }>;
    };
  };
};
export type NoemaAppConfigMsg = {
  ok?: boolean;
  configFile: string;
  config: NoemaAppConfig;
  defaults: NoemaAppConfig;
  themes: NoemaAppTheme[];
  activeTheme: NoemaAppTheme;
  revision: string;
  diagnostics: Array<{ code: string; message: string }>;
  message?: string;
};
export type NoemaAppConfigUpdate = {
  appearance?: { theme?: string };
  workspace?: { root?: string; layout?: "legacy" | "wiki" };
  wiki?: { creation?: NoemaAppConfig["wiki"]["creation"] };
  revision?: string;
};
export type BlockReferenceLocation = {
  type: "block-reference-location";
  source: "kernel-block-index";
  id: string;
  file: string;
  path: string;
  line: number;
  blockType: string;
};
type ProseCheckMsg = {
  ok?: boolean;
  diagnostics?: Array<{
    source: "languagetool" | "browser";
    from: number;
    to: number;
    severity?: "info" | "warning" | "error";
    message: string;
    rule?: string;
    word?: string;
    suggestions?: string[];
  }>;
  tools?: Array<{ source?: string; ok?: boolean; message?: string; partial?: boolean; optional?: boolean }>;
  scope?: { checkedChars?: number; totalChars?: number; partial?: boolean };
};
export type JupyterCellOutput = {
  output_type?: string;
  name?: string;
  text?: string;
  execution_count?: number | null;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  transient?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
};
export type JupyterCellExecuteResult = {
  ok?: boolean;
  cellId?: string;
  kernel?: string;
  session?: string;
  status?: string;
  executionCount?: number | null;
  outputs?: JupyterCellOutput[];
  message?: string;
  stoppedAt?: string;
  autoRan?: boolean;
  results?: JupyterCellExecuteResult[];
  plan?: Array<{ cellId?: string; mode?: string; selected?: boolean }>;
  widgetMessages?: Array<Record<string, unknown>>;
  widgetMessagesTruncated?: boolean;
  live?: boolean;
  savedAt?: string;
  kernelRuntime?: {
    id?: string;
    name?: string;
    generation?: number;
  };
  widgetRuntime?: {
    id: string;
    name: string;
    generation?: number;
  };
  /** `execute_reply` payload from `%load`/`%recall`: rewrite this cell, or insert one below. */
  setNextInput?: { text: string; replace: boolean };
  /** `execute_reply` payload from `exit`/`quit` typed in a cell. */
  askExit?: { keepKernel: boolean };
};
/** The interesting half of `kernel_info_reply` — see describeKernelInfo in server/lib/jupyter-cell.mjs. */
export type JupyterKernelInfo = {
  implementation?: string;
  implementationVersion?: string;
  protocolVersion?: string;
  banner?: string;
  helpLinks?: Array<{ text?: string; url?: string }>;
  language?: {
    name?: string;
    version?: string;
    mimetype?: string;
    fileExtension?: string;
    pygmentsLexer?: string;
    codemirrorMode?: unknown;
  };
};
export type JupyterKernelSpec = {
  name: string;
  displayName?: string;
  language?: string;
  kind?: "none" | "start" | "connect";
  value?: string;
  group?: string;
  label?: string;
};
export type JupyterKernelListResult = {
  ok?: boolean;
  default?: string;
  kernels?: JupyterKernelSpec[];
  attachable?: JupyterKernelSpec[];
  choices?: JupyterKernelSpec[];
  selections?: JupyterKernelSpec[];
};
/**
 * `complete_reply`. `cursorStart`/`cursorEnd` are offsets into the submitted
 * code describing the span the matches replace — the kernel decides how much
 * of the token it is completing, so never assume a client-side word boundary.
 */
export type JupyterCompletionResult = {
  ok?: boolean;
  /** False when no kernel is running for this cell; nothing was asked. */
  supported?: boolean;
  matches?: string[];
  items?: Array<{ text: string; type?: string; signature?: string }>;
  cursorStart?: number;
  cursorEnd?: number;
  /** True when the kernel was busy and the bounded wait expired. */
  timedOut?: boolean;
};
export type JupyterInspectResult = {
  ok?: boolean;
  supported?: boolean;
  found?: boolean;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  timedOut?: boolean;
};
export type JupyterIsCompleteResult = {
  ok?: boolean;
  supported?: boolean;
  /** `unknown` means the kernel doesn't implement it — treat as complete. */
  status?: "complete" | "incomplete" | "invalid" | "unknown" | string;
  indent?: string;
  timedOut?: boolean;
};
export type JupyterHistoryResult = {
  ok?: boolean;
  supported?: boolean;
  history?: Array<{ session: number; lineNumber: number; source: string; output: string }>;
};
export type JupyterVariable = {
  name?: string;
  type?: string;
  summary?: string;
  shape?: unknown;
};
export type JupyterVariablesResult = {
  ok?: boolean;
  supported?: boolean;
  kernel?: string;
  session?: string;
  variables?: JupyterVariable[];
};
export type JupyterKernelTask = {
  key?: string;
  id?: string;
  file?: string;
  sourceFile?: string;
  kernel?: string;
  session?: string;
  language?: string;
  status?: string;
  running?: number;
  owned?: boolean;
  attached?: boolean;
  hostRuntimeId?: string;
  generation?: number;
  placement?: "target" | "client" | string;
  stateLost?: boolean;
  widgetGeneration?: number;
  createdAt?: number;
  createdAtIso?: string;
  lastUsedAt?: number;
  lastUsedAtIso?: string;
  lastActivityAt?: number;
  lastActivityAtIso?: string;
  idleMs?: number;
  runningMs?: number;
  totalRuns?: number;
  executionCount?: number | null;
  lastCellId?: string;
  lastError?: string;
  executedCells?: number;
  protected?: boolean;
  ttlMs?: number;
};
export type JupyterTasksResult = {
  ok?: boolean;
  server?: {
    status?: string;
    owned?: boolean;
    pid?: number | null;
    activeRequests?: number;
    startedAt?: number;
    startedAtIso?: string;
    lastUsedAt?: number;
    lastUsedAtIso?: string;
    idleMs?: number;
    idleTtlMs?: number;
  };
  cleanup?: {
    kernelIdleTtlMs?: number;
    serverIdleTtlMs?: number;
    cleanupIntervalMs?: number;
    execTimeoutMs?: number;
  };
  kernels?: JupyterKernelTask[];
  removed?: Array<{ key?: string; kernel?: string; session?: string; reason?: string }>;
  scheduled?: boolean;
};
export type TodoItem = Record<string, unknown> & {
  id?: string;
  file?: string;
  path?: string;
  note?: string;
  noteId?: string;
  noteTitle?: string;
  title?: string;
  text?: string;
  command?: "todo" | "itodo" | string;
  source?: string;
  status?: string;
  ddl?: string;
  deadline?: string;
  due?: string;
  line?: number;
  index?: number;
  tags?: string[];
  inlineTags?: string[];
  /** Canonical arg keys (ddl/sche/prio/repeat/warn/after/done/log) after alias normalization. */
  canon?: Record<string, string>;
  /** Ids of other todos this one depends on (resolved by text reference, no ids in source). */
  deps?: string[];
  /** Status as computed by dependency resolution: "blocked" when an unresolved dep is open. */
  effectiveStatus?: string;
  /** Ids of open dependencies causing a computed-blocked effectiveStatus. */
  blockedBy?: string[];
  /** Sort key from the urgency formula (priority + deadline proximity + doing/blocked adjustments). */
  urgency?: number;
};
export type TodosMsg = {
  type?: string;
  todos?: TodoItem[];
  root?: string;
};
export type TodoLint = {
  todoId?: string;
  file?: string;
  line?: number;
  kind?:
    | "broken-ref"
    | "ambiguous-ref"
    | "ambiguous-note"
    | "missing-gantt-date"
    | "missing-milestone-date"
    | "cycle"
    | "broken-clock-ref"
    | "ambiguous-clock-ref"
    | "duplicate-id";
  via?: "after" | "blocks";
  ref?: string;
  message?: string;
  candidates?: Array<{ id: string; text: string }>;
};
export type TodoRefCompletion = { label?: string; ref?: string; hasId?: boolean; file?: string; status?: string };
export type BibliographyCompletion = { key?: string; name?: string; body?: string; detail?: string; source?: string };
export type BibliographyEntry = {
  id?: string;
  key?: string;
  namespace?: string;
  shortNamespace?: string;
  type?: string;
  file?: string;
  path?: string;
  fields?: Record<string, string>;
};
export type BibliographyReference = {
  id?: string;
  number?: number;
  entry?: BibliographyEntry;
  text?: string;
  links?: Array<{ label?: string; href?: string }>;
};
export type BibliographyDiagnostic = string | {
  code?: string;
  severity?: "info" | "warning" | "error";
  message?: string;
  detail?: string;
  from?: number;
  to?: number;
  namespace?: string;
  key?: string;
};
export type BibliographyCitationItem = {
  id?: string;
  itemId?: string;
  key?: string;
  number?: number;
  from?: number;
  to?: number;
  locator?: string;
  prefix?: string;
  suffix?: string;
  duplicate?: boolean;
  entry?: BibliographyEntry;
  diagnostics?: BibliographyDiagnostic[];
};
export type BibliographyCompletionResult = {
  ok?: boolean;
  message?: string;
  items?: BibliographyCompletion[];
  diagnostics?: BibliographyDiagnostic[];
};
export type BibliographyCitation = {
  from?: number;
  to?: number;
  namespace?: string;
  namespaceFrom?: number;
  namespaceTo?: number;
  keys?: string[];
  args?: Record<string, string>;
  argsFrom?: number;
  argsTo?: number;
  items?: BibliographyCitationItem[];
  itemIds?: string[];
  numbers?: number[];
  diagnostics?: BibliographyDiagnostic[];
};
export type BibliographyDocument = {
  ok?: boolean;
  version?: number;
  hash?: string;
  namespaces?: Array<{ namespace?: string; shortNamespace?: string; file?: string; entries?: number }>;
  entries?: BibliographyEntry[];
  references?: BibliographyReference[];
  citations?: BibliographyCitation[];
  diagnostics?: BibliographyDiagnostic[];
  message?: string;
};
export type PlanningItem = Record<string, unknown> & {
  id?: string;
  kind?: "project" | "milestone" | "clock" | string;
  status?: string;
  title?: string;
  text?: string;
  args?: Record<string, string>;
  canon?: Record<string, string>;
  file?: string;
  path?: string;
  noteTitle?: string;
  line?: number;
  index?: number;
  source?: string;
};
export type GanttTask = {
  id?: string;
  name?: string;
  project?: string;
  status?: string;
  start?: string;
  end?: string;
  dependencies?: string[];
  progress?: number;
  source?: { file?: string; index?: number; line?: number; source?: string; text?: string };
};
export type GanttMilestone = {
  id?: string;
  name?: string;
  project?: string;
  date?: string;
  source?: { file?: string; index?: number; line?: number; source?: string; text?: string };
};
export type GanttLane = { id?: string; key?: string; name?: string; start?: string; end?: string; childTaskIds?: string[] };
export type GanttMsg = {
  tasks?: GanttTask[];
  backlog?: GanttTask[];
  milestones?: GanttMilestone[];
  lanes?: GanttLane[];
  lints?: TodoLint[];
};
export type ProjectRollup = {
  id?: string;
  key?: string;
  title?: string;
  status?: string;
  area?: string;
  phase?: string;
  file?: string;
  open?: number;
  doing?: number;
  done?: number;
  cancelled?: number;
  blocked?: number;
  total?: number;
  progress?: number;
  effortMinutes?: number;
  clockedMinutes?: number;
  childTodoIds?: string[];
};
export type AgendaEntry = {
  kind?: "deadline" | "warning" | "overdue" | "scheduled" | "sched-carry" | "log" | "repeat";
  label?: string;
  todoId?: string;
  date?: string;
  dateKey?: string;
  time?: string | null;
  urgency?: number;
  virtual?: boolean;
};
export type AgendaDay = { date?: string; entries?: AgendaEntry[] };
export type ClockTask = { todoId?: string; text?: string; file?: string; minutes?: number; effortMinutes?: number };
export type ClockModel = {
  tasks?: ClockTask[];
  byDay?: Record<string, number>;
  byProject?: Record<string, number>;
  running?: { todoId?: string; text?: string; file?: string; from?: string; minutesSoFar?: number } | null;
};
export type AgendaMsg = {
  type?: string;
  evaluationSource?: string;
  range?: { from?: string; to?: string; today?: string };
  days?: AgendaDay[];
  todos?: TodoItem[];
  projects?: PlanningItem[];
  milestones?: PlanningItem[];
  clocks?: PlanningItem[];
  clocktable?: ClockModel;
  projectModel?: ProjectRollup[];
  gantt?: GanttMsg;
  lints?: TodoLint[];
  logByDay?: Record<string, number>;
  stats?: { open?: number; doing?: number; done?: number; cancelled?: number; blocked?: number; overdue?: number };
};
type NativeApi = {
  connection?: {
    status?: () => CoreConnectionStatus;
    reconnect?: (reason?: string) => Promise<boolean>;
  };
  notes?: {
    bootstrap?: (file?: string) => Promise<unknown>;
    open?: (file: string) => Promise<unknown>;
    list?: (force?: boolean) => Promise<unknown>;
    pathSuggestions?: (file: string, prefix?: string) => Promise<unknown>;
    save?: (body: SaveBody) => Promise<unknown>;
    saveKeepalive?: (body: SaveBody) => void;
    deleteNote?: (file: string) => Promise<unknown>;
    deleteNode?: (file: string) => Promise<unknown>;
    snippets?: () => Promise<unknown>;
    metaAdd?: (body: Record<string, unknown>) => Promise<unknown>;
    notesIndex?: () => Promise<unknown>;
    graph?: () => Promise<unknown>;
    todos?: (file: string) => Promise<unknown>;
    updateTodo?: (body: Record<string, unknown>) => Promise<unknown>;
    agenda?: (body: Record<string, unknown>) => Promise<unknown>;
    resolveBlock?: (id: string) => Promise<unknown>;
    embedQuery?: (body: Record<string, unknown>) => Promise<unknown>;
    attributeView?: (body: Record<string, unknown>) => Promise<unknown>;
    attributeViewCellPatch?: (body: Record<string, unknown>) => Promise<unknown>;
    createTodo?: (body: Record<string, unknown>) => Promise<unknown>;
    patchTodo?: (body: Record<string, unknown>) => Promise<unknown>;
    clockIn?: (body: Record<string, unknown>) => Promise<unknown>;
    clockOut?: (body: Record<string, unknown>) => Promise<unknown>;
    todoDepRef?: (body: Record<string, unknown>) => Promise<unknown>;
  };
  completions?: {
    tags?: (prefix: string) => Promise<unknown>;
    roam?: (prefix: string) => Promise<unknown>;
    todoRefs?: (body: Record<string, unknown>) => Promise<unknown>;
    bibliography?: (body: Record<string, unknown>) => Promise<unknown>;
  };
  bibliography?: {
    document?: (body: Record<string, unknown>) => Promise<unknown>;
  };
  clipboard?: {
    read?: (body?: { file?: string }) => Promise<unknown>;
  };
  noteCode?: {
    readRegion?: (body?: unknown) => Promise<unknown>;
  };
  slides?: {
    mirror?: (body?: unknown) => Promise<unknown>;
  };
  jupyterCell?: {
    kernels?: (body?: unknown) => Promise<unknown>;
    documentSnapshot?: (body?: unknown) => Promise<unknown>;
    documentMutate?: (body?: unknown) => Promise<unknown>;
    documentExecute?: (body?: unknown) => Promise<unknown>;
    managerSnapshot?: () => Promise<unknown>;
    scriptSnapshot?: (body?: unknown) => Promise<unknown>;
    scriptAction?: (body?: unknown) => Promise<unknown>;
    sessionSelect?: (body?: unknown) => Promise<unknown>;
    kernelControl?: (body?: unknown) => Promise<unknown>;
    openBoard?: () => Promise<unknown>;
    execute?: (body?: unknown) => Promise<unknown>;
    openScript?: (body?: unknown) => Promise<unknown>;
    readScriptCell?: (body?: unknown) => Promise<unknown>;
    executeScriptCell?: (body?: unknown) => Promise<unknown>;
    clearScriptCellOutput?: (body?: unknown) => Promise<unknown>;
    deleteScriptCell?: (body?: unknown) => Promise<unknown>;
    saveScriptCellOutputUi?: (body?: unknown) => Promise<unknown>;
    clearAllOutputs?: (body?: unknown) => Promise<unknown>;
    variables?: (body?: unknown) => Promise<unknown>;
    inputReply?: (body?: unknown) => Promise<unknown>;
    complete?: (body?: unknown) => Promise<unknown>;
    inspect?: (body?: unknown) => Promise<unknown>;
    isComplete?: (body?: unknown) => Promise<unknown>;
    history?: (body?: unknown) => Promise<unknown>;
    commInfo?: (body?: unknown) => Promise<unknown>;
    kernelStatus?: (body?: unknown) => Promise<unknown>;
    restart?: (body?: unknown) => Promise<unknown>;
    interrupt?: (body?: unknown) => Promise<unknown>;
    shutdown?: (body?: unknown) => Promise<unknown>;
    tasks?: () => Promise<unknown>;
    cleanup?: (body?: unknown) => Promise<unknown>;
  };
  latex?: {
    defaults?: (body?: Record<string, unknown>) => Promise<unknown>;
    agentStatus?: () => Promise<unknown>;
    setAgent?: (body?: Record<string, unknown>) => Promise<unknown>;
    templates?: () => Promise<unknown>;
    chooseOutputPath?: (body?: Record<string, unknown>) => Promise<unknown>;
    export?: (body?: LatexExportRequest) => Promise<unknown>;
  };
  tasks?: {
    list?: (body?: Record<string, unknown>) => Promise<unknown>;
    get?: (body?: Record<string, unknown>) => Promise<unknown>;
    cancel?: (body?: Record<string, unknown>) => Promise<unknown>;
    retry?: (body?: Record<string, unknown>) => Promise<unknown>;
    close?: (body?: Record<string, unknown>) => Promise<unknown>;
  };
  meta?: {
    add?: (body: Record<string, unknown>) => Promise<unknown>;
    remove?: (body: Record<string, unknown>) => Promise<unknown>;
    tag?: (body: Record<string, unknown>) => Promise<unknown>;
    hideRoam?: (body: Record<string, unknown>) => Promise<unknown>;
    activateRoam?: (body: Record<string, unknown>) => Promise<unknown>;
  };
  emacs?: {
    open?: (body: { file: string; tag?: string; line?: number; col?: number }) => Promise<unknown>;
    currentFile?: (body: string | { file: string; client?: string }) => Promise<unknown>;
    uiState?: (body: Record<string, unknown>) => Promise<unknown>;
    key?: (body: string | { key: string; client?: string }) => Promise<unknown>;
    systemOpen?: (target: string, base?: string) => Promise<unknown>;
    zotero?: (body: Record<string, unknown>) => Promise<unknown>;
    zoteroImport?: (body: Record<string, unknown>) => Promise<unknown>;
    chooseNotePath?: (body: Record<string, unknown>) => Promise<unknown>;
  };
  roamTools?: {
    renameTag?: (body: Record<string, unknown>) => Promise<unknown>;
    deleteTag?: (body: Record<string, unknown>) => Promise<unknown>;
    tagOverlap?: () => Promise<unknown>;
    rewritePathRefs?: (body: Record<string, unknown>) => Promise<unknown>;
  };
  session?: {
    getPositions?: () => Promise<unknown>;
    savePosition?: (position: Partial<CursorPosition> & { file: string }) => Promise<unknown>;
    savePositionKeepalive?: (position: Partial<CursorPosition> & { file: string }) => void;
    closeClient?: (body: { clientId?: string; client?: string; file?: string }) => Promise<unknown>;
    closeClientKeepalive?: (body: { clientId?: string; client?: string; file?: string }) => void;
  };
  assets?: {
    upload?: (body: { file?: string; name?: string; type?: string; data?: string }) => Promise<unknown>;
    storeFromPath?: (body: { file?: string; path?: string; source?: string; name?: string; type?: string }) => Promise<unknown>;
    renderTikz?: (body: { file: string; id: string; timestamp: string; source: string }) => Promise<unknown>;
    scanOrphans?: () => Promise<unknown>;
    trashOrphans?: (files: string[]) => Promise<unknown>;
    inspect?: () => Promise<unknown>;
    rename?: (body: Record<string, unknown>) => Promise<unknown>;
    searchContent?: (body: Record<string, unknown>) => Promise<unknown>;
  };
  imports?: {
    obsidianAnalyze?: (body: Record<string, unknown>) => Promise<unknown>;
    obsidianTask?: (body: Record<string, unknown>) => Promise<unknown>;
    obsidianStart?: (body: Record<string, unknown>) => Promise<unknown>;
    obsidianCancel?: (body: Record<string, unknown>) => Promise<unknown>;
  };
  ime?: {
    vimMode?: (mode: string) => Promise<unknown>;
  };
  proseCheck?: {
    run?: (body: ProseCheckBody) => Promise<unknown>;
    acceptWord?: (word: string) => Promise<unknown>;
    cancel?: (requestId: string) => Promise<unknown>;
    settings?: () => Promise<unknown>;
    updateSettings?: (body: LanguageToolSettingsUpdate) => Promise<unknown>;
    probe?: (body: LanguageToolProbeBody) => Promise<unknown>;
    cancelKeepalive?: (requestId: string) => void;
  };
  config?: {
    katexMacros?: () => Promise<unknown>;
    app?: () => Promise<unknown>;
    updateApp?: (body: NoemaAppConfigUpdate) => Promise<unknown>;
  };
  wiki?: {
    bootstrap?: () => Promise<unknown>;
    environment?: () => Promise<unknown>;
    refresh?: () => Promise<unknown>;
    search?: (body: Record<string, unknown>) => Promise<unknown>;
    resolveLink?: (body: Record<string, unknown>) => Promise<unknown>;
    initWorkspace?: () => Promise<unknown>;
    initRepository?: (body: Record<string, unknown>) => Promise<unknown>;
    cloneRepository?: (body: Record<string, unknown>) => Promise<unknown>;
    adoptRepository?: (body: Record<string, unknown>) => Promise<unknown>;
    repositoryStatus?: (body: Record<string, unknown>) => Promise<unknown>;
    git?: (body: Record<string, unknown>) => Promise<unknown>;
    createPage?: (body: Record<string, unknown>) => Promise<unknown>;
    movePage?: (body: Record<string, unknown>) => Promise<unknown>;
    deletePage?: (body: Record<string, unknown>) => Promise<unknown>;
    copyPage?: (body: Record<string, unknown>) => Promise<unknown>;
    mergePages?: (body: Record<string, unknown>) => Promise<unknown>;
    tags?: () => Promise<unknown>;
    updateTag?: (body: Record<string, unknown>) => Promise<unknown>;
    updateNamespace?: (body: Record<string, unknown>) => Promise<unknown>;
    export?: (body: Record<string, unknown>) => Promise<unknown>;
    pageHistory?: (body: Record<string, unknown>) => Promise<unknown>;
    pageDiff?: (body: Record<string, unknown>) => Promise<unknown>;
    restorePage?: (body: Record<string, unknown>) => Promise<unknown>;
    syncStatus?: (body: Record<string, unknown>) => Promise<unknown>;
    checkpoint?: (body: Record<string, unknown>) => Promise<unknown>;
    sync?: (body: Record<string, unknown>) => Promise<unknown>;
    conflict?: (body: Record<string, unknown>) => Promise<unknown>;
    resolveConflict?: (body: Record<string, unknown>) => Promise<unknown>;
    abortConflict?: (body: Record<string, unknown>) => Promise<unknown>;
    gitUi?: (body: Record<string, unknown>) => Promise<unknown>;
  };
  knowledge?: {
    search?: (body: Record<string, unknown>) => Promise<unknown>;
    virtualReferences?: (body: Record<string, unknown>) => Promise<unknown>;
  };
};

export type WikiRepository = {
  id: string;
  uid?: string;
  identityStatus?: "managed" | "legacy" | "provisional";
  name: string;
  namespace?: string;
  qualifiedNamespace?: string;
  namespaceAliases?: string[];
  partition: "public" | "private";
  path: string;
  public?: boolean;
};
export type WikiNote = {
  id: string;
  title: string;
  namespace?: string;
  qualifiedNamespace?: string;
  qualifiedTitle?: string;
  fullTitle?: string;
  namespaceSource?: "page" | "repository";
  namespaceAliases?: string[];
  kind?: string;
  redirectTo?: string;
  identityStatus?: "managed" | "legacy" | "provisional" | "duplicate";
  aliases: string[];
  tags: string[];
  private: boolean;
  file: string;
  path: string;
  repositoryPath: string;
  repository: string;
  repositoryId: string;
  partition: "public" | "private";
  mtimeMs: number;
  refs: string[];
  backlinks: string[];
  unresolvedLinks: string[];
  blocks?: Array<{ id: string; kind: string; envKind?: string; label?: string; offset: number }>;
  dependencies?: Array<{ kind: string; raw: string; path: string; status: string }>;
  excerpt?: string;
  score?: number;
  reasons?: string[];
  resultKind?: "note" | "tag" | "missing" | "attachment";
};
export type WikiFile = {
  repositoryId: string;
  partition: "public" | "private";
  file: string;
  path: string;
  repositoryPath: string;
  name: string;
  ext: string;
  kind: "note" | "file";
  size: number;
  mtimeMs: number;
  gitStatus: string;
};
export type WikiDirectory = {
  repositoryId: string;
  partition: "public" | "private";
  path: string;
  name: string;
  fileCount: number;
};
export type WikiSyncPhase = "idle" | "waiting" | "checkpointing" | "fetching" | "merging" | "conflicted" | "pushing" | "applying" | "error";
export type WikiSyncState = {
  repositoryId: string;
  repositoryUid?: string;
  phase: WikiSyncPhase;
  updatedAt?: string;
  lastSyncedAt?: string;
  checkpointedAt?: string;
  failedAt?: string;
  branch?: string;
  localOnly?: boolean;
  automatic?: boolean;
  committed?: boolean;
  changedFiles?: number;
  changedPaths?: string[];
  source?: "kernel-vaultgit" | "node-vaultgit";
  checkpointSource?: "kernel-vaultgit" | "node-vaultgit";
  transportSource?: "kernel-vaultgit" | "node-vaultgit";
  error?: string;
  message?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  nextRetryAt?: string;
  errorKind?: "busy" | "network" | "authentication" | "configuration" | "remote-race" | "workspace" | "conflict" | "internal";
  actionRequired?: string;
  operationId?: string;
  snapshotHead?: string;
  remoteHead?: string;
  integrationHead?: string;
  publishedHead?: string;
  integrationBranch?: string;
  integrationPath?: string;
  recoveryArtifacts?: Array<{
    kind: "working-files";
    source: "integration" | "primary";
    createdAt: string;
    path: string;
    files: string[];
  }>;
  recoveredGitLock?: {
    kind: "orphan-index-lock";
    recoveredAt: string;
    ageMs: number;
    size: number;
    backup: string;
    previousOwnerPid?: number;
  };
  conflicts?: Array<{
    path: string;
    kind: string;
    stages: number[];
    oursStage?: 2 | 3;
    theirsStage?: 2 | 3;
    oursLabel?: string;
    theirsLabel?: string;
  }>;
};
export type WikiIndex = {
  type: "wiki-index";
  generation?: string;
  root: string;
  layout: "legacy" | "wiki";
  dbFile: string;
  repositories: WikiRepository[];
  notes: WikiNote[];
  files: WikiFile[];
  directories: WikiDirectory[];
  diagnostics: Array<{ code: string; severity: string; message: string; path?: string }>;
  reports: {
    wanted: Array<{ title: string; namespace?: string; qualifiedTitle?: string; references: Array<{ sourceId: string; sourceTitle: string; sourceFile: string }> }>;
    ambiguous: Array<Record<string, unknown>>;
    duplicates: Array<Record<string, unknown>>;
    duplicateIds?: Array<Record<string, unknown>>;
    missingFragments?: Array<Record<string, unknown>>;
  };
};

export type WikiSearchResult = {
  type: "wiki-search" | "knowledge-search";
  generation: string;
  items: WikiNote[];
  total: number;
  nextCursor: number | null;
  query?: string;
  mode?: "suggest" | "results" | "related";
  facets?: {
    tags: Array<{ name: string; count: number }>;
    namespaces: Array<{ name: string; count: number }>;
    repositories: Array<{ name: string; count: number }>;
  };
};

export type VirtualReferenceMention = {
  sourceId: string;
  sourceTitle: string;
  file: string;
  path?: string;
  count: number;
  keywords: string[];
  snippet: string;
  note?: WikiNote | null;
};

export type VirtualReferencesResult = {
  type: "virtual-references";
  evaluationSource?: string;
  target?: { id?: string; title?: string; file?: string; path?: string } | null;
  mentions: VirtualReferenceMention[];
  scannedDocuments?: number;
  ttlMs?: number;
};

export type MissingAsset = {
  file: string;
  path: string;
  reference: string;
  noteFile: string;
  notePath: string;
};

export type AssetContentItem = {
  id?: string;
  name: string;
  ext: string;
  path: string;
  size: number;
  updated: number;
  content: string;
  file?: string;
};

export type ObsidianImportTask = {
  taskID: string;
  state: "queued" | "analyzing" | "ready" | "revalidating" | "staging" | "creating" | "writing" | "indexing" | "completed" | "failed" | "cancelled";
  progress: number;
  message: string;
  error?: string;
  detail?: string;
  analysis?: Record<string, unknown> & {
    vaultName?: string;
    notebookName?: string;
    markdownCount?: number;
    importableAssetCount?: number;
    missingCount?: number;
    ambiguousCount?: number;
    warnings?: string[];
  };
  result?: Record<string, unknown> & { destination?: string; markdownCount?: number; importedAttachmentCount?: number; source?: string };
};

export type LatexTemplateVar = {
  id: string;
  label: string;
  default: string;
  input?: "text" | "select";
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  placeholder?: string;
  description?: string;
  group?: string;
  escape?: "text" | "url" | "raw";
};
export type LatexTemplate = { key: string; file: string; name: string; engine: string; documentRole?: string; vars: LatexTemplateVar[] };
export type LatexTemplatesResult = { type?: string; ok?: boolean; templates?: LatexTemplate[]; root?: string };
export type LatexExportRequest = Record<string, unknown> & {
  file: string;
  /** The selected export scope. */
  content: string;
  /** The live complete note, used for bibliography/meta resolution. */
  documentContent: string;
  outputPath: string;
  title: string;
  scope: string;
  templatePath?: string;
  engine?: string;
  vars?: Record<string, string>;
};
export type LatexExportAgentStatus = {
  type?: string;
  ok?: boolean;
  agent?: string;
  engine?: string;
  agents?: Array<{ id: string; label?: string; current?: boolean; available?: boolean }>;
};
export type CoreTask = {
  id: string;
  kind: string;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  status: "queued" | "running" | "canceling" | "completed" | "failed" | "canceled" | string;
  phase?: string;
  message?: string;
  progress?: Array<{ at?: string; text?: string }>;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  result?: Record<string, unknown> | null;
  error?: string;
  cancellable?: boolean;
  retryable?: boolean;
  closeable?: boolean;
};
export type CoreTasksResult = { type?: string; ok?: boolean; tasks?: CoreTask[]; task?: CoreTask | null; message?: string };

export type KatexMacrosResult = {
  type?: string;
  dir?: string;
  source?: string;
  macros?: Record<string, string>;
  errors?: { file: string; message: string }[];
};

declare global {
  interface Window {
    aaronnoteApi?: NativeApi;
    aaronnoteOpenTaskManager?: () => void;
    __noemaAppConfig?: NoemaAppConfigMsg;
    __noemaKernelBase?: string;
    __noemaKernel?: { state: string; baseUrl: string; box: { id?: string; name?: string; root?: string } | null };
    __noemaRendererBuild?: string;
    AaronnotePrepareRendererReload?: (detail?: { generation?: string }) => Promise<boolean>;
    __noemaDesktopPrintDocument?: () => { html: string; title: string; defaultPath: string } | null;
    noemaDesktop?: {
      platform: string;
      filePath(file: File): string;
      openFiles(files: string[]): void;
      closeWindow(): Promise<void>;
      startWindowDrag(): Promise<void>;
      openTarget(target: { file?: string; url?: string; source?: string; disposition?: "" | "new" | "split-right" | "split-down" }): Promise<boolean>;
      updateWindowState(state: { kind?: string; file?: string; title?: string; dirty?: boolean; saveInFlight?: boolean; conflict?: boolean; busy?: boolean }): void;
      showMenu(kind: "actions" | "window", point?: { x: number; y: number }): Promise<boolean>;
      revealPath(file: string): Promise<boolean>;
      openPath(file: string): Promise<{ ok: boolean; message?: string }>;
      openExternal(url: string): Promise<{ ok: boolean; message?: string }>;
      chooseSavePath(options: { title?: string; defaultPath?: string; extension?: string }): Promise<{ canceled: boolean; path: string }>;
      exportPdf(options: { html: string; title?: string; defaultPath?: string }): Promise<{
        canceled: boolean;
        path: string;
        bytes?: number;
      }>;
      exportHtml(options: { html: string; title?: string; defaultPath?: string }): Promise<{
        canceled: boolean;
        path: string;
        bytes?: number;
      }>;
      readClipboard(): Promise<
        | { kind: "empty" }
        | { kind: "text"; text: string; html?: string }
        | { kind: "image"; type: "image/png"; data: string }
      >;
      chooseDirectory(options: { root: string; defaultPath?: string; title?: string }): Promise<{
        canceled: boolean;
        path: string;
        relativePath?: string;
        message?: string;
      }>;
      selectDirectory(options?: { defaultPath?: string; title?: string }): Promise<{
        canceled: boolean;
        path: string;
      }>;
      listPlugins(): Promise<NoemaDesktopPlugin[]>;
      setPluginEnabled(id: string, enabled: boolean): Promise<NoemaDesktopPlugin[]>;
      notifyAppConfigChanged(revision: string): void;
      reportSmoke?(report: Record<string, unknown>): Promise<boolean>;
      onCommand(callback: (detail: unknown) => void): () => void;
      onFileDrop?(callback: (event: {
        type: "enter" | "over" | "drop" | "leave";
        paths: string[];
        position?: { x: number; y: number };
      }) => void): () => void;
      readDroppedFiles?(paths: string[]): Promise<File[]>;
    };
  }
}

export type NoemaDesktopPlugin = {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  active: boolean;
  builtIn: boolean;
  configurable: boolean;
  locked: boolean;
};

function requireMethod<T extends (...args: any[]) => unknown>(method: T | undefined, feature: string): T {
  if (!method) throw new Error(`${feature} is unavailable`);
  return method;
}

function nativeApi(): NativeApi {
  if (!window.aaronnoteApi) throw new Error("Noema host bridge is unavailable");
  return window.aaronnoteApi;
}

function ensureOk<T>(value: T, fallback: string, allowConflict = false): T {
  const result = value as T & { ok?: boolean; conflict?: boolean; message?: string };
  if (result?.ok === false && !(allowConflict && result.conflict)) {
    throw new Error(result.message || fallback);
  }
  return value;
}

async function callHttpApi<T>(channel: string, args: unknown[] = [], fallback = "API request failed"): Promise<T> {
  const response = await fetch("/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, args }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = value && typeof value === "object" && "message" in value
      ? String((value as { message?: unknown }).message || fallback)
      : fallback;
    throw new Error(message);
  }
  return ensureOk(value as T, fallback);
}

export const api = {
  connection: {
    supported(): boolean {
      const connection = window.aaronnoteApi?.connection;
      return typeof connection?.status === "function" && typeof connection?.reconnect === "function";
    },
    status(): CoreConnectionStatus {
      return window.aaronnoteApi?.connection?.status?.() ?? "connected";
    },
    async reconnect(reason: CoreReconnectReason): Promise<boolean> {
      const call = window.aaronnoteApi?.connection?.reconnect;
      if (!call) return false;
      return (await call(reason)) === true;
    },
  },
  notes: {
    async bootstrap(file?: string): Promise<OpenMsg> {
      const call = requireMethod(nativeApi().notes?.bootstrap, "Open");
      return ensureOk(await call(file) as OpenMsg, "Open failed");
    },
    async open(file: string): Promise<OpenMsg> {
      const call = requireMethod(nativeApi().notes?.open, "Open");
      return ensureOk(await call(file) as OpenMsg, "Open failed");
    },
    async list(force = false): Promise<NotesMsg> {
      const call = requireMethod(nativeApi().notes?.list, "Note index");
      return ensureOk(await call(force) as NotesMsg, "Note index failed");
    },
    async pathSuggestions(file: string, prefix = "./"): Promise<{ paths?: string[] }> {
      const call = requireMethod(nativeApi().notes?.pathSuggestions, "Path suggestions");
      return ensureOk(await call(file, prefix) as { paths?: string[] }, "Path suggestions failed");
    },
    async save(body: SaveBody): Promise<SavedMsg> {
      const call = requireMethod(nativeApi().notes?.save, "Save");
      return ensureOk(await call(body) as SavedMsg, "Save failed", true);
    },
    async trash(file: string): Promise<NotesMsg & { file?: string; trashedTo?: string }> {
      const call = requireMethod(
        nativeApi().notes?.deleteNote ?? nativeApi().notes?.deleteNode,
        "Move note to system trash",
      );
      return ensureOk(
        await call(file) as NotesMsg & { file?: string; trashedTo?: string },
        "Move note to system trash failed",
      );
    },
    async snippets(): Promise<SnippetsMsg & { snippets?: SnippetSummary[] }> {
      const call = requireMethod(nativeApi().notes?.snippets, "Snippet reload");
      return ensureOk(await call() as SnippetsMsg & { snippets?: SnippetSummary[] }, "Snippet reload failed");
    },
    async graph(): Promise<GraphPayload> {
      const call = requireMethod(nativeApi().notes?.graph, "Workspace graph");
      return ensureOk(await call() as GraphPayload, "Workspace graph failed");
    },
    async todos(file = ""): Promise<TodosMsg> {
      const call = requireMethod(nativeApi().notes?.todos, "Todo agenda");
      return ensureOk(await call(file) as TodosMsg, "Todo agenda failed");
    },
    saveKeepalive(body: SaveBody): void {
      const api = window.aaronnoteApi?.notes;
      if (!api) return;
      if (api.saveKeepalive) {
        api.saveKeepalive(body);
        return;
      }
      if (api.save) void api.save(body).catch(() => {});
    },
    async updateTodo(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().notes?.updateTodo, "Todo update");
      return ensureOk(await call(body) as Record<string, unknown>, "Todo update failed");
    },
    async agenda(body: Record<string, unknown> = {}): Promise<AgendaMsg> {
      const call = requireMethod(nativeApi().notes?.agenda, "Agenda");
      return ensureOk(await call(body) as AgendaMsg, "Agenda failed");
    },
    async resolveBlock(id: string): Promise<BlockReferenceLocation> {
      const call = requireMethod(nativeApi().notes?.resolveBlock, "Block navigation");
      return ensureOk(await call(id) as BlockReferenceLocation, "Block navigation failed");
    },
    async embedQuery(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().notes?.embedQuery, "Embed query");
      return ensureOk(await call(body) as Record<string, unknown>, "Embed query failed");
    },
    async attributeView(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().notes?.attributeView, "Attribute view");
      return ensureOk(await call(body) as Record<string, unknown>, "Attribute view failed");
    },
    async attributeViewCellPatch(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().notes?.attributeViewCellPatch, "Attribute view cell edit");
      return ensureOk(await call(body) as Record<string, unknown>, "Attribute view cell edit failed");
    },
    async createTodo(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().notes?.createTodo, "Todo create");
      return ensureOk(await call(body) as Record<string, unknown>, "Todo create failed");
    },
    async patchTodo(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().notes?.patchTodo, "Todo patch");
      return ensureOk(await call(body) as Record<string, unknown>, "Todo patch failed");
    },
    async clockIn(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().notes?.clockIn, "Clock in");
      return ensureOk(await call(body) as Record<string, unknown>, "Clock in failed");
    },
    async clockOut(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().notes?.clockOut, "Clock out");
      return ensureOk(await call(body) as Record<string, unknown>, "Clock out failed");
    },
    async todoDepRef(body: Record<string, unknown>): Promise<{ type?: string; ref?: string }> {
      const call = requireMethod(nativeApi().notes?.todoDepRef, "Todo dependency reference");
      return ensureOk(await call(body) as { type?: string; ref?: string }, "Todo dependency reference failed");
    },
  },
  noteCode: {
    async readRegion(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().noteCode?.readRegion, "Note code");
      return ensureOk(await call(body) as Record<string, unknown>, "Note code failed");
    },
  },
  jupyterCell: {
    async kernels(body: unknown = {}): Promise<JupyterKernelListResult> {
      const call = requireMethod(nativeApi().jupyterCell?.kernels, "Jupyter kernels");
      return ensureOk(await call(body) as JupyterKernelListResult, "Jupyter kernels failed");
    },
    async documentSnapshot(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.documentSnapshot, "Jupyter document");
      return ensureOk(await call(body) as Record<string, unknown>, "Jupyter document failed");
    },
    async documentMutate(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.documentMutate, "Jupyter document mutation");
      return ensureOk(await call(body) as Record<string, unknown>, "Jupyter document mutation failed");
    },
    async documentExecute(body: unknown): Promise<JupyterCellExecuteResult> {
      const call = requireMethod(nativeApi().jupyterCell?.documentExecute, "Jupyter document execution");
      return ensureOk(await call(body) as JupyterCellExecuteResult, "Jupyter document execution failed");
    },
    async managerSnapshot(): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.managerSnapshot, "Jupyter manager");
      return ensureOk(await call() as Record<string, unknown>, "Jupyter manager failed");
    },
    async scriptSnapshot(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.scriptSnapshot, "Jupyter script");
      return ensureOk(await call(body) as Record<string, unknown>, "Jupyter script failed");
    },
    async scriptAction(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.scriptAction, "Jupyter script action");
      return ensureOk(await call(body) as Record<string, unknown>, "Jupyter script action failed");
    },
    async sessionSelect(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.sessionSelect, "Jupyter session selection");
      return ensureOk(await call(body) as Record<string, unknown>, "Jupyter session selection failed");
    },
    async kernelControl(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.kernelControl, "Jupyter kernel control");
      return ensureOk(await call(body) as Record<string, unknown>, "Jupyter kernel control failed");
    },
    async openBoard(): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.openBoard, "Jupyter Board");
      return ensureOk(await call() as Record<string, unknown>, "Jupyter Board failed");
    },
    async execute(body: unknown): Promise<JupyterCellExecuteResult> {
      const call = requireMethod(nativeApi().jupyterCell?.execute, "Jupyter cell");
      return ensureOk(await call(body) as JupyterCellExecuteResult, "Jupyter cell failed");
    },
    async openScript(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.openScript, "Jupyter cell script");
      return ensureOk(await call(body) as Record<string, unknown>, "Jupyter cell script failed");
    },
    async readScriptCell(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.readScriptCell, "Jupyter cell script");
      return ensureOk(await call(body) as Record<string, unknown>, "Jupyter cell script failed");
    },
    async executeScriptCell(body: unknown): Promise<JupyterCellExecuteResult> {
      const call = requireMethod(nativeApi().jupyterCell?.executeScriptCell, "Jupyter cell");
      return ensureOk(await call(body) as JupyterCellExecuteResult, "Jupyter cell failed");
    },
    async clearScriptCellOutput(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.clearScriptCellOutput, "Jupyter cell output");
      return ensureOk(await call(body) as Record<string, unknown>, "Jupyter cell output failed");
    },
    async deleteScriptCell(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.deleteScriptCell, "Jupyter cell delete");
      return ensureOk(await call(body) as Record<string, unknown>, "Jupyter cell delete failed");
    },
    async saveScriptCellOutputUi(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.saveScriptCellOutputUi, "Jupyter cell output UI");
      return ensureOk(await call(body) as Record<string, unknown>, "Jupyter cell output UI save failed");
    },
    async clearAllOutputs(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.clearAllOutputs, "Jupyter outputs");
      return ensureOk(await call(body) as Record<string, unknown>, "Jupyter outputs failed");
    },
    async variables(body: unknown): Promise<JupyterVariablesResult> {
      const call = requireMethod(nativeApi().jupyterCell?.variables, "Jupyter variables");
      return ensureOk(await call(body) as JupyterVariablesResult, "Jupyter variables failed");
    },
    async inputReply(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.inputReply, "Jupyter input reply");
      return ensureOk(await call(body) as Record<string, unknown>, "Jupyter input reply failed");
    },
    async complete(body: unknown): Promise<JupyterCompletionResult> {
      const call = requireMethod(nativeApi().jupyterCell?.complete, "Jupyter completion");
      return ensureOk(await call(body) as JupyterCompletionResult, "Jupyter completion failed");
    },
    async inspect(body: unknown): Promise<JupyterInspectResult> {
      const call = requireMethod(nativeApi().jupyterCell?.inspect, "Jupyter inspect");
      return ensureOk(await call(body) as JupyterInspectResult, "Jupyter inspect failed");
    },
    async isComplete(body: unknown): Promise<JupyterIsCompleteResult> {
      const call = requireMethod(nativeApi().jupyterCell?.isComplete, "Jupyter is-complete");
      return ensureOk(await call(body) as JupyterIsCompleteResult, "Jupyter is-complete failed");
    },
    async history(body: unknown): Promise<JupyterHistoryResult> {
      const call = requireMethod(nativeApi().jupyterCell?.history, "Jupyter history");
      return ensureOk(await call(body) as JupyterHistoryResult, "Jupyter history failed");
    },
    async commInfo(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.commInfo, "Jupyter comm info");
      return ensureOk(await call(body) as Record<string, unknown>, "Jupyter comm info failed");
    },
    async kernelStatus(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.kernelStatus, "Jupyter kernel status");
      return ensureOk(await call(body) as Record<string, unknown>, "Jupyter kernel status failed");
    },
    async restart(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.restart, "Jupyter kernel restart");
      return ensureOk(await call(body) as Record<string, unknown>, "Jupyter kernel restart failed");
    },
    async interrupt(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.interrupt, "Jupyter kernel interrupt");
      return ensureOk(await call(body) as Record<string, unknown>, "Jupyter kernel interrupt failed");
    },
    async shutdown(body: unknown): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().jupyterCell?.shutdown, "Jupyter kernel shutdown");
      return ensureOk(await call(body) as Record<string, unknown>, "Jupyter kernel shutdown failed");
    },
    async tasks(): Promise<JupyterTasksResult> {
      const call = requireMethod(nativeApi().jupyterCell?.tasks, "Jupyter tasks");
      return ensureOk(await call() as JupyterTasksResult, "Jupyter tasks failed");
    },
    async cleanup(body: unknown = {}): Promise<JupyterTasksResult> {
      const call = requireMethod(nativeApi().jupyterCell?.cleanup, "Jupyter cleanup");
      return ensureOk(await call(body) as JupyterTasksResult, "Jupyter cleanup failed");
    },
  },
  latex: {
    async defaults(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().latex?.defaults, "LaTeX export defaults");
      return ensureOk(await call(body) as Record<string, unknown>, "LaTeX export defaults failed");
    },
    async agentStatus(): Promise<LatexExportAgentStatus> {
      const call = requireMethod(nativeApi().latex?.agentStatus, "LaTeX export agent status");
      return ensureOk(await call() as LatexExportAgentStatus, "LaTeX export agent status failed");
    },
    async setAgent(body: Record<string, unknown>): Promise<LatexExportAgentStatus> {
      const call = requireMethod(nativeApi().latex?.setAgent, "LaTeX export agent switch");
      return ensureOk(await call(body) as LatexExportAgentStatus, "LaTeX export agent switch failed");
    },
    async templates(): Promise<LatexTemplatesResult> {
      const call = requireMethod(nativeApi().latex?.templates, "LaTeX templates");
      return ensureOk(await call() as LatexTemplatesResult, "LaTeX templates failed");
    },
    async chooseOutputPath(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().latex?.chooseOutputPath, "LaTeX output path chooser");
      return await call(body) as Record<string, unknown>;
    },
    async export(body: LatexExportRequest): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().latex?.export, "LaTeX export");
      return ensureOk(await call(body) as Record<string, unknown>, "LaTeX export failed");
    },
  },
  tasks: {
    async list(body: Record<string, unknown> = {}): Promise<CoreTasksResult> {
      const call = requireMethod(nativeApi().tasks?.list, "Task manager");
      return ensureOk(await call(body) as CoreTasksResult, "Task list failed");
    },
    async get(id: string): Promise<CoreTasksResult> {
      const call = requireMethod(nativeApi().tasks?.get, "Task manager");
      return ensureOk(await call({ id }) as CoreTasksResult, "Task lookup failed");
    },
    async cancel(id: string): Promise<CoreTasksResult> {
      const call = requireMethod(nativeApi().tasks?.cancel, "Task manager");
      return ensureOk(await call({ id }) as CoreTasksResult, "Task cancellation failed");
    },
    async retry(id: string): Promise<CoreTasksResult> {
      const call = requireMethod(nativeApi().tasks?.retry, "Task manager");
      return ensureOk(await call({ id }) as CoreTasksResult, "Task rerun failed");
    },
    async close(id: string): Promise<CoreTasksResult> {
      const call = requireMethod(nativeApi().tasks?.close, "Task manager");
      return ensureOk(await call({ id }) as CoreTasksResult, "Task close failed");
    },
  },
  meta: {
    async add(body: Record<string, unknown>): Promise<OpenMsg> {
      const call = requireMethod(nativeApi().meta?.add ?? nativeApi().notes?.metaAdd, "Meta add");
      return ensureOk(await call(body) as OpenMsg, "Meta add failed");
    },
    async remove(body: Record<string, unknown>): Promise<OpenMsg> {
      const call = requireMethod(nativeApi().meta?.remove, "Meta remove");
      return ensureOk(await call(body) as OpenMsg, "Meta remove failed");
    },
    async tag(body: Record<string, unknown>): Promise<OpenMsg> {
      const call = requireMethod(nativeApi().meta?.tag, "Tag add");
      return ensureOk(await call(body) as OpenMsg, "Tag add failed");
    },
    async hideRoam(body: Record<string, unknown>): Promise<OpenMsg> {
      const call = requireMethod(nativeApi().meta?.hideRoam, "Roam hide");
      return ensureOk(await call(body) as OpenMsg, "Roam hide failed");
    },
    async activateRoam(body: Record<string, unknown>): Promise<OpenMsg> {
      const call = requireMethod(nativeApi().meta?.activateRoam, "Roam activate");
      return ensureOk(await call(body) as OpenMsg, "Roam activate failed");
    },
  },
  slides: {
    async mirror(body: { file: string }): Promise<{ ok: boolean; jsFile: string; cssFile: string; js: string; css: string }> {
      const call = requireMethod(nativeApi().slides?.mirror, "Slides mirror");
      return ensureOk(await call(body) as { ok: boolean; jsFile: string; cssFile: string; js: string; css: string }, "Slides mirror failed");
    },
  },
  emacs: {
    async chooseNotePath(body: Record<string, unknown>): Promise<{
      ok?: boolean;
      canceled: boolean;
      path: string;
      relativePath: string;
      message?: string;
    }> {
      const call = window.aaronnoteApi?.emacs?.chooseNotePath;
      const result = call
        ? await call(body)
        : await callHttpApi("aaronnote:api:emacs:choose-note-path", [body], "Choose note path failed");
      return result as {
        ok?: boolean;
        canceled: boolean;
        path: string;
        relativePath: string;
        message?: string;
      };
    },
    async open(body: { file: string; tag?: string; line?: number; col?: number }): Promise<void> {
      const call = window.aaronnoteApi?.emacs?.open;
      const result = call
        ? await call(body)
        : await callHttpApi("aaronnote:api:emacs:open", [body], "Open in Emacs failed");
      ensureOk(result, "Open in Emacs failed");
    },
    async currentFile(file: string, client = ""): Promise<void> {
      const call = window.aaronnoteApi?.emacs?.currentFile;
      if (!call) return;
      const body = client ? { file, client } : file;
      await call(body).catch(() => {});
    },
    async uiState(body: Record<string, unknown>): Promise<void> {
      const call = window.aaronnoteApi?.emacs?.uiState;
      if (!call) return;
      await call(body).catch(() => {});
    },
    async key(keyString: string, client = ""): Promise<void> {
      const call = window.aaronnoteApi?.emacs?.key;
      if (!call) return;
      const body = client ? { key: keyString, client } : keyString;
      await call(body).catch(() => {});
    },
    async systemOpen(target: string, base?: string): Promise<{ ok?: boolean; target?: string } | void> {
      const call = window.aaronnoteApi?.emacs?.systemOpen;
      if (!call) {
        const body = base ? { target, base } : target;
        return await callHttpApi("aaronnote:api:emacs:system-open", [body], "System open failed") as { ok?: boolean; target?: string };
      }
      return ensureOk(await call(target, base), "System open failed") as { ok?: boolean; target?: string };
    },
    async zotero(body: Record<string, unknown>): Promise<void> {
      const call = window.aaronnoteApi?.emacs?.zotero;
      const result = call
        ? await call(body)
        : await callHttpApi("aaronnote:api:emacs:zotero", [body], "Open in Zotero failed");
      ensureOk(result, "Open in Zotero failed");
    },
    async zoteroImport(body: Record<string, unknown>): Promise<void> {
      const call = window.aaronnoteApi?.emacs?.zoteroImport;
      const result = call
        ? await call(body)
        : await callHttpApi("aaronnote:api:emacs:zotero-import", [body], "Zotero BibTeX import failed");
      ensureOk(result, "Zotero BibTeX import failed");
    },
  },
  roamTools: {
    async renameTag(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().roamTools?.renameTag, "Rename tag");
      return ensureOk(await call(body) as Record<string, unknown>, "Rename tag failed");
    },
    async deleteTag(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().roamTools?.deleteTag, "Delete tag");
      return ensureOk(await call(body) as Record<string, unknown>, "Delete tag failed");
    },
    async tagOverlap(): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().roamTools?.tagOverlap, "Tag overlap");
      return ensureOk(await call() as Record<string, unknown>, "Tag overlap failed");
    },
    async rewritePathRefs(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().roamTools?.rewritePathRefs, "Rewrite path refs");
      return ensureOk(await call(body) as Record<string, unknown>, "Rewrite path refs failed");
    },
  },
  session: {
    async getPositions(): Promise<PositionsMsg> {
      const call = window.aaronnoteApi?.session?.getPositions;
      if (!call) return { type: "positions", positions: [] };
      return ensureOk(await call() as PositionsMsg, "Cursor positions failed");
    },
    async savePosition(position: Partial<CursorPosition> & { file: string }): Promise<PositionsMsg> {
      const call = window.aaronnoteApi?.session?.savePosition;
      if (!call) return { type: "positions", positions: [] };
      return ensureOk(await call(position) as PositionsMsg, "Cursor position save failed");
    },
    savePositionKeepalive(position: Partial<CursorPosition> & { file: string }): void {
      const session = window.aaronnoteApi?.session;
      if (session?.savePositionKeepalive) {
        session.savePositionKeepalive(position);
        return;
      }
      if (session?.savePosition) void session.savePosition(position).catch(() => {});
    },
    async closeClient(body: { clientId?: string; client?: string; file?: string }): Promise<void> {
      const call = window.aaronnoteApi?.session?.closeClient;
      if (!call) return;
      await call(body);
    },
    closeClientKeepalive(body: { clientId?: string; client?: string; file?: string }): void {
      const api = window.aaronnoteApi?.session;
      if (api?.closeClientKeepalive) {
        api.closeClientKeepalive(body);
        return;
      }
      if (api?.closeClient) void api.closeClient(body).catch(() => {});
    },
  },
  completions: {
    async tags(prefix = ""): Promise<{ tags?: string[] }> {
      const call = window.aaronnoteApi?.completions?.tags;
      if (!call) return { tags: [] };
      return await call(prefix) as { tags?: string[] };
    },
    async roam(prefix = ""): Promise<{ notes?: Array<{ id: string; key: string; title: string; path: string }> }> {
      const call = window.aaronnoteApi?.completions?.roam;
      if (!call) return { notes: [] };
      return await call(prefix) as { notes?: Array<{ id: string; key: string; title: string; path: string }> };
    },
    async todoRefs(body: { prefix?: string; file?: string; excludeId?: string; limit?: number } = {}): Promise<{ items?: TodoRefCompletion[] }> {
      const call = window.aaronnoteApi?.completions?.todoRefs;
      if (!call) return { items: [] };
      return await call(body) as { items?: TodoRefCompletion[] };
    },
    async bibliography(body: { file?: string; content?: string; kind?: string; namespace?: string; prefix?: string } = {}): Promise<BibliographyCompletionResult> {
      const call = window.aaronnoteApi?.completions?.bibliography;
      if (!call) {
        return await callHttpApi("aaronnote:api:completions:bibliography", [body], "Bibliography completion failed");
      }
      return ensureOk(await call(body) as BibliographyCompletionResult, "Bibliography completion failed");
    },
  },
  bibliography: {
    async document(body: { file?: string; content?: string } = {}): Promise<BibliographyDocument> {
      const call = window.aaronnoteApi?.bibliography?.document;
      if (!call) {
        return await callHttpApi("aaronnote:api:bibliography:document", [body], "Bibliography failed");
      }
      return ensureOk(await call(body) as BibliographyDocument, "Bibliography failed");
    },
  },
  clipboard: {
    async read(body: { file?: string } = {}): Promise<unknown> {
      const call = requireMethod(nativeApi().clipboard?.read, "Clipboard read");
      return await call(body);
    },
  },
  assets: {
    async upload(body: { file?: string; name?: string; type?: string; data?: string }): Promise<AssetStoreMsg> {
      const call = requireMethod(nativeApi().assets?.upload, "Asset upload");
      return ensureOk(await call(body) as AssetStoreMsg, "Asset upload failed");
    },
    async storeFromPath(body: { file?: string; path?: string; source?: string; name?: string; type?: string }): Promise<AssetStoreMsg> {
      const call = requireMethod(nativeApi().assets?.storeFromPath, "Asset import");
      return ensureOk(await call(body) as AssetStoreMsg, "Asset import failed");
    },
    async renderTikz(body: { file: string; id: string; timestamp: string; source: string }) {
      const call = requireMethod(nativeApi().assets?.renderTikz, "TikZ render");
      return ensureOk(await call(body) as { ok?: boolean; file?: string; markdownPath?: string; message?: string }, "TikZ render failed");
    },
    async scanOrphans(): Promise<Record<string, unknown> & { assets?: UnusedAsset[]; message?: string }> {
      const call = requireMethod(nativeApi().assets?.scanOrphans, "Asset scan");
      return ensureOk(await call() as Record<string, unknown> & { assets?: UnusedAsset[]; message?: string }, "Asset scan failed");
    },
    async trashOrphans(files: string[]): Promise<Record<string, unknown> & { assets?: UnusedAsset[]; trashed?: unknown[]; message?: string }> {
      const call = requireMethod(nativeApi().assets?.trashOrphans, "Asset trash");
      return ensureOk(await call(files) as Record<string, unknown> & { assets?: UnusedAsset[]; trashed?: unknown[]; message?: string }, "Asset trash failed");
    },
    async inspect(): Promise<{ unused: UnusedAsset[]; missing: MissingAsset[]; source?: string }> {
      const call = requireMethod(nativeApi().assets?.inspect, "Asset health");
      return ensureOk(await call() as { unused: UnusedAsset[]; missing: MissingAsset[]; source?: string }, "Asset health failed");
    },
    async rename(body: { oldPath: string; newName: string }): Promise<Record<string, unknown> & { newPath?: string; rewrittenNotes?: string[] }> {
      const call = requireMethod(nativeApi().assets?.rename, "Asset rename");
      return ensureOk(await call(body) as Record<string, unknown> & { newPath?: string; rewrittenNotes?: string[] }, "Asset rename failed");
    },
    async searchContent(body: { query: string; limit?: number }): Promise<{ assets: AssetContentItem[]; total: number; indexed: number; source?: string }> {
      const call = requireMethod(nativeApi().assets?.searchContent, "Attachment search");
      return ensureOk(await call(body) as { assets: AssetContentItem[]; total: number; indexed: number; source?: string }, "Attachment search failed");
    },
  },
  imports: {
    async obsidianAnalyze(localPath: string): Promise<ObsidianImportTask> {
      const call = requireMethod(nativeApi().imports?.obsidianAnalyze, "Obsidian analysis");
      return ensureOk(await call({ localPath }) as ObsidianImportTask, "Obsidian analysis failed");
    },
    async obsidianTask(taskID: string): Promise<ObsidianImportTask> {
      const call = requireMethod(nativeApi().imports?.obsidianTask, "Obsidian import status");
      return ensureOk(await call({ taskID }) as ObsidianImportTask, "Obsidian import status failed");
    },
    async obsidianStart(taskID: string, destination: string): Promise<ObsidianImportTask> {
      const call = requireMethod(nativeApi().imports?.obsidianStart, "Obsidian import");
      return ensureOk(await call({ taskID, destination }) as ObsidianImportTask, "Obsidian import failed");
    },
    async obsidianCancel(taskID: string): Promise<ObsidianImportTask> {
      const call = requireMethod(nativeApi().imports?.obsidianCancel, "Obsidian import cancellation");
      return ensureOk(await call({ taskID }) as ObsidianImportTask, "Obsidian import cancellation failed");
    },
  },
  ime: {
    async vimMode(mode: "normal" | "insert"): Promise<{ enabled?: boolean }> {
      const call = window.aaronnoteApi?.ime?.vimMode;
      if (!call) return { enabled: false };
      try {
        return (await call(mode)) as { enabled?: boolean } ?? { enabled: false };
      } catch (_) {
        return {};
      }
    },
  },
  proseCheck: {
    async run(body: ProseCheckBody): Promise<ProseCheckMsg> {
      const call = requireMethod(nativeApi().proseCheck?.run, "Prose check");
      return ensureOk(await call(body) as ProseCheckMsg, "Prose check failed");
    },
    async acceptWord(word: string): Promise<{ ok?: boolean; word?: string }> {
      const call = requireMethod(nativeApi().proseCheck?.acceptWord, "Prose dictionary");
      return ensureOk(await call(word) as { ok?: boolean; word?: string }, "Adding word failed");
    },
    async cancel(requestId: string): Promise<void> {
      const call = nativeApi().proseCheck?.cancel;
      if (!call) return;
      await call(requestId);
    },
    cancelKeepalive(requestId: string): void {
      const call = nativeApi().proseCheck?.cancelKeepalive;
      if (call) call(requestId);
      else {
        const fallback = nativeApi().proseCheck?.cancel;
        if (fallback) void fallback(requestId).catch(() => {});
      }
    },
    async settings(): Promise<LanguageToolSettingsMsg> {
      const call = requireMethod(nativeApi().proseCheck?.settings, "LanguageTool settings");
      return ensureOk(await call() as LanguageToolSettingsMsg, "Loading LanguageTool settings failed");
    },
    async updateSettings(body: LanguageToolSettingsUpdate): Promise<LanguageToolSettingsMsg> {
      const call = requireMethod(nativeApi().proseCheck?.updateSettings, "LanguageTool settings");
      return ensureOk(await call(body) as LanguageToolSettingsMsg, "Saving LanguageTool settings failed");
    },
    async probe(body: LanguageToolProbeBody): Promise<LanguageToolProbeMsg> {
      const call = requireMethod(nativeApi().proseCheck?.probe, "LanguageTool server test");
      return ensureOk(await call(body) as LanguageToolProbeMsg, "LanguageTool server test failed");
    },
  },
  config: {
    async katexMacros(): Promise<KatexMacrosResult> {
      const call = nativeApi().config?.katexMacros;
      if (!call) return {};
      return (await call()) as KatexMacrosResult;
    },
    async app(): Promise<NoemaAppConfigMsg> {
      const call = requireMethod(nativeApi().config?.app, "Noema settings");
      return ensureOk(await call() as NoemaAppConfigMsg, "Loading Noema settings failed");
    },
    async updateApp(body: NoemaAppConfigUpdate): Promise<NoemaAppConfigMsg> {
      const call = requireMethod(nativeApi().config?.updateApp, "Noema settings");
      return ensureOk(await call(body) as NoemaAppConfigMsg, "Saving Noema settings failed");
    },
  },
  wiki: {
    async bootstrap(): Promise<WikiIndex> {
      const call = requireMethod(nativeApi().wiki?.bootstrap, "Wiki");
      return ensureOk(await call() as WikiIndex, "Loading Wiki failed");
    },
    async refresh(): Promise<WikiIndex> {
      const call = requireMethod(nativeApi().wiki?.refresh, "Wiki refresh");
      return ensureOk(await call() as WikiIndex, "Refreshing Wiki failed");
    },
    async search(body: { query?: string; mode?: "suggest" | "results" | "related"; context?: Record<string, string>; repositoryId?: string; partition?: string; namespace?: string; sort?: "title" | "recent"; cursor?: number; limit?: number }): Promise<WikiSearchResult> {
      const call = requireMethod(nativeApi().wiki?.search, "Wiki search");
      return ensureOk(await call(body) as WikiSearchResult, "Searching Wiki failed");
    },
    async resolveLink(target: string, sourceFile = ""): Promise<{
      status: "resolved" | "ambiguous" | "missing" | "missing-fragment";
      fragment: string;
      targetBlockId: string;
      candidates: Array<{ id: string; title: string; namespace: string; qualifiedNamespace: string; qualifiedTitle: string; fullTitle: string; file: string; path: string }>;
    }> {
      const call = requireMethod(nativeApi().wiki?.resolveLink, "Wiki link");
      return ensureOk(await call({ target, sourceFile }) as {
        status: "resolved" | "ambiguous" | "missing" | "missing-fragment";
        fragment: string;
        targetBlockId: string;
        candidates: Array<{ id: string; title: string; namespace: string; qualifiedNamespace: string; qualifiedTitle: string; fullTitle: string; file: string; path: string }>;
      }, "Resolving Wiki link failed");
    },
    async initWorkspace(): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.initWorkspace, "Wiki workspace setup");
      return ensureOk(await call() as Record<string, unknown>, "Creating Wiki workspace failed");
    },
    async initRepository(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.initRepository, "Wiki repository setup");
      return ensureOk(await call(body) as Record<string, unknown>, "Creating Wiki repository failed");
    },
    async cloneRepository(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.cloneRepository, "Wiki repository clone");
      return ensureOk(await call(body) as Record<string, unknown>, "Cloning Wiki repository failed");
    },
    async adoptRepository(repositoryId: string): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.adoptRepository, "Wiki repository identity");
      return ensureOk(await call({ repositoryId }) as Record<string, unknown>, "Establishing repository identity failed");
    },
    async repositoryStatus(repositoryId: string): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.repositoryStatus, "Wiki repository status");
      return ensureOk(await call({ repositoryId }) as Record<string, unknown>, "Loading repository status failed");
    },
    async git(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.git, "Wiki Git action");
      return ensureOk(await call(body) as Record<string, unknown>, "Git action failed");
    },
    async createPage(body: Record<string, unknown>): Promise<{ ok?: boolean; file?: string; title?: string }> {
      const call = requireMethod(nativeApi().wiki?.createPage, "New Wiki page");
      return ensureOk(await call(body) as { ok?: boolean; file?: string; title?: string }, "Creating Wiki page failed");
    },
    async movePage(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.movePage, "Move Wiki page");
      return ensureOk(await call(body) as Record<string, unknown>, "Moving Wiki page failed");
    },
    async deletePage(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.deletePage, "Delete Wiki page");
      return ensureOk(await call(body) as Record<string, unknown>, "Deleting Wiki page failed");
    },
    async copyPage(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.copyPage, "Copy Wiki page");
      return ensureOk(await call(body) as Record<string, unknown>, "Copying Wiki page failed");
    },
    async mergePages(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.mergePages, "Merge Wiki pages");
      return ensureOk(await call(body) as Record<string, unknown>, "Merging Wiki pages failed");
    },
    async tags(): Promise<{ tags?: Array<Record<string, unknown>> }> {
      const call = requireMethod(nativeApi().wiki?.tags, "Wiki tags");
      return ensureOk(await call() as { tags?: Array<Record<string, unknown>> }, "Loading Wiki tags failed");
    },
    async updateTag(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.updateTag, "Update Wiki tag");
      return ensureOk(await call(body) as Record<string, unknown>, "Updating Wiki tag failed");
    },
    async updateNamespace(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.updateNamespace, "Update Wiki namespace");
      return ensureOk(await call(body) as Record<string, unknown>, "Updating Wiki namespace failed");
    },
    async export(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.export, "Export Wiki");
      return ensureOk(await call(body) as Record<string, unknown>, "Exporting Wiki failed");
    },
    async pageHistory(pageId: string, limit = 50): Promise<{ commits: Array<{ sha: string; date: string; author?: string; email?: string; subject: string }> }> {
      const call = requireMethod(nativeApi().wiki?.pageHistory, "Wiki page history");
      return ensureOk(await call({ pageId, limit }) as { commits: Array<{ sha: string; date: string; author?: string; email?: string; subject: string }> }, "Loading page history failed");
    },
    async pageDiff(pageId: string, sha: string): Promise<{ diff?: string }> {
      const call = requireMethod(nativeApi().wiki?.pageDiff, "Wiki page diff");
      return ensureOk(await call({ pageId, sha }) as { diff?: string }, "Loading page diff failed");
    },
    async restorePage(pageId: string, sha: string): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.restorePage, "Restore Wiki page");
      return ensureOk(await call({ pageId, sha }) as Record<string, unknown>, "Restoring page failed");
    },
    async syncStatus(repositoryId = ""): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.syncStatus, "Wiki sync status");
      return ensureOk(await call({ repositoryId }) as Record<string, unknown>, "Loading sync status failed");
    },
    async checkpoint(repositoryId: string, message = ""): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.checkpoint, "Wiki checkpoint");
      return ensureOk(await call({ repositoryId, message }) as Record<string, unknown>, "Checkpoint failed");
    },
    async sync(repositoryId: string): Promise<WikiSyncState> {
      const call = requireMethod(nativeApi().wiki?.sync, "Wiki sync");
      return ensureOk(await call({ repositoryId }) as WikiSyncState, "Wiki sync failed");
    },
    async conflict(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.conflict, "Wiki conflict");
      return ensureOk(await call(body) as Record<string, unknown>, "Loading conflict failed");
    },
    async resolveConflict(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.resolveConflict, "Wiki conflict resolution");
      return ensureOk(await call(body) as Record<string, unknown>, "Resolving conflict failed");
    },
    async abortConflict(repositoryId: string): Promise<Record<string, unknown>> {
      const call = requireMethod(nativeApi().wiki?.abortConflict, "Abort Wiki conflict");
      return ensureOk(await call({ repositoryId }) as Record<string, unknown>, "Aborting conflict failed");
    },
    async gitUi(repositoryId: string): Promise<{ ok?: boolean; repositoryId?: string; url?: string }> {
      const call = requireMethod(nativeApi().wiki?.gitUi, "Advanced Git");
      return ensureOk(await call({ repositoryId }) as { ok?: boolean; repositoryId?: string; url?: string }, "Starting Advanced Git failed");
    },
  },
  knowledge: {
    async search(body: { query?: string; mode?: "suggest" | "results" | "related"; context?: Record<string, string>; entityKinds?: string[]; cursor?: number; limit?: number }): Promise<WikiSearchResult> {
      const call = requireMethod(nativeApi().knowledge?.search || nativeApi().wiki?.search, "Knowledge search");
      return ensureOk(await call(body) as WikiSearchResult, "Knowledge search failed");
    },
    async virtualReferences(body: { targetId?: string; file?: string; title?: string; caseSensitive?: boolean }): Promise<VirtualReferencesResult> {
      const call = requireMethod(nativeApi().knowledge?.virtualReferences, "Virtual references");
      return ensureOk(await call(body) as VirtualReferencesResult, "Virtual references failed");
    },
  },
};
