import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  AARONNOTE_ACCEPTED_WORDS,
  maskAaronnoteProse,
  rangeHasCheckedText,
} from "../../shared/prose-mask.mjs";
import {
  getLanguageToolSettings,
  normalizeLanguageToolSettings,
} from "./languagetool-config.mjs";

const LANGUAGETOOL_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 4 * 1024 * 1024;
const MAX_DIAGNOSTICS_PER_TOOL = 240;
const MAX_CHECK_CHARS = 180_000;
const CHUNK_TARGET_CHARS = 45_000;
const MAX_CHUNKS_PER_TOOL = 6;
const WORKSPACE_ROOT = process.env.AARONNOTE_WORKSPACE_ROOT || join(homedir(), ".config", "emacs");
const USER_WORDS_FILE = process.env.AARONNOTE_PROSE_WORDS
  || join(WORKSPACE_ROOT, "etc", "prose-accepted-words.txt");
const GUI_TOOL_PATHS = [
  join(homedir(), ".local", "bin"),
  join(homedir(), ".nix-profile", "bin"),
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/opt/homebrew/opt/node/bin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/run/current-system/sw/bin",
  "/nix/var/nix/profiles/default/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];
const TOOL_ENV = {
  ...process.env,
  PATH: [...new Set([...GUI_TOOL_PATHS, ...String(process.env.PATH || "").split(":").filter(Boolean)])].join(":"),
};
const activeChecks = new Map();
let userWordsCache = { expiresAt: 0, words: new Set() };
const USER_WORDS_CACHE_MS = 30_000;

function createSemaphore(limit) {
  let active = 0;
  let sequence = 0;
  const queue = [];
  const releaseFactory = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      pump();
    };
  };
  const pump = () => {
    while (active < limit && queue.length > 0) {
      const entry = queue.shift();
      entry.signal?.removeEventListener("abort", entry.onAbort);
      if (entry.signal?.aborted) {
        entry.reject(abortError(entry.signal));
        continue;
      }
      active += 1;
      entry.resolve(releaseFactory());
    }
  };
  return {
    async acquire(signal, priority = 0) {
      throwIfAborted(signal);
      if (active < limit) {
        active += 1;
        return releaseFactory();
      }
      return await new Promise((resolve, reject) => {
        const entry = {
          priority: Number(priority) || 0,
          sequence: sequence++,
          signal,
          resolve,
          reject,
          onAbort: () => {
            const index = queue.indexOf(entry);
            if (index >= 0) queue.splice(index, 1);
            reject(abortError(signal));
          },
        };
        signal?.addEventListener("abort", entry.onAbort, { once: true });
        queue.push(entry);
        queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
      });
    },
  };
}

const remoteSemaphore = createSemaphore(2);
const cliSemaphore = createSemaphore(1);

function execFileWithInput(file, args, input, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function combinedAbortSignal(...signals) {
  const active = signals.filter(Boolean);
  if (active.length === 1) return active[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(active);
  const controller = new AbortController();
  const abort = (event) => controller.abort(event?.target?.reason);
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("LanguageTool check cancelled"), { name: "AbortError" });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveTool(name, envVar) {
  const configured = String(process.env[envVar] || "").trim();
  if (configured && await executable(configured)) return configured;
  for (const dir of GUI_TOOL_PATHS) {
    const candidate = join(dir, name);
    if (await executable(candidate)) return candidate;
  }
  return name;
}

function clampRange(masked, from, to) {
  const start = Math.max(0, Math.min(masked.length, Number(from) || 0));
  const end = Math.max(start, Math.min(masked.length, Number(to) || start));
  return { from: start, to: end };
}

function lineStartAt(text, pos) {
  const index = Math.max(0, Math.min(text.length, Number(pos) || 0));
  return text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
}

function lineEndAt(text, pos) {
  const index = Math.max(0, Math.min(text.length, Number(pos) || 0));
  const newline = text.indexOf("\n", index);
  return newline < 0 ? text.length : newline;
}

function normalizeCheckRanges(masked, ranges) {
  const sourceRanges = Array.isArray(ranges) && ranges.length > 0
    ? ranges
    : [{ from: 0, to: masked.length }];
  const normalized = [];
  for (const range of sourceRanges) {
    const rawFrom = Number(range?.from);
    const rawTo = Number(range?.to);
    if (!Number.isFinite(rawFrom) || !Number.isFinite(rawTo)) continue;
    const clamped = clampRange(masked, Math.min(rawFrom, rawTo), Math.max(rawFrom, rawTo));
    if (clamped.to <= clamped.from) continue;
    normalized.push({
      from: lineStartAt(masked, clamped.from),
      to: lineEndAt(masked, clamped.to),
    });
  }
  normalized.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged = [];
  for (const range of normalized) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to + 1) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged.length > 0 ? merged : [{ from: 0, to: Math.min(masked.length, MAX_CHECK_CHARS) }];
}

function createCheckChunks(masked, ranges) {
  const normalized = normalizeCheckRanges(masked, ranges);
  const chunks = [];
  let checkedChars = 0;
  let partial = false;
  for (const range of normalized) {
    let from = range.from;
    while (from < range.to) {
      if (chunks.length >= MAX_CHUNKS_PER_TOOL || checkedChars >= MAX_CHECK_CHARS) {
        partial = true;
        break;
      }
      const remaining = MAX_CHECK_CHARS - checkedChars;
      const wantedTo = Math.min(range.to, from + CHUNK_TARGET_CHARS, from + remaining);
      let to = wantedTo >= range.to ? range.to : lineEndAt(masked, wantedTo);
      if (to <= from) to = Math.min(range.to, from + remaining);
      if (rangeHasCheckedText(masked, from, to)) {
        chunks.push({ index: chunks.length, from, to, text: masked.slice(from, to) });
        checkedChars += to - from;
      }
      from = Math.max(to, from + 1);
    }
    if (partial) break;
  }
  if (chunks.length === 0 && masked.length > 0) {
    const to = Math.min(masked.length, MAX_CHECK_CHARS);
    chunks.push({ index: 0, from: 0, to, text: masked.slice(0, to) });
    partial = to < masked.length;
    checkedChars = to;
  }
  return {
    chunks,
    checkedChars,
    totalChars: masked.length,
    partial: partial || normalized.some((range) => range.to - range.from > MAX_CHECK_CHARS),
  };
}

function normalizeCheckSegments(segments) {
  if (!Array.isArray(segments)) return [];
  const normalized = [];
  for (const segment of segments) {
    const from = Number(segment?.from);
    if (!Number.isFinite(from) || from < 0) continue;
    const text = String(segment?.text || "");
    if (!text) continue;
    normalized.push({
      from,
      to: from + text.length,
      text,
    });
  }
  return normalized.sort((a, b) => a.from - b.from || a.to - b.to);
}

function createCheckChunksFromSegments(segments, totalChars) {
  const normalized = normalizeCheckSegments(segments);
  const sourceLength = Number.isFinite(Number(totalChars)) && Number(totalChars) > 0
    ? Number(totalChars)
    : normalized.reduce((max, segment) => Math.max(max, segment.to), 0);
  const chunks = [];
  let checkedChars = 0;
  let partial = false;
  for (const segment of normalized) {
    if (chunks.length >= MAX_CHUNKS_PER_TOOL || checkedChars >= MAX_CHECK_CHARS) {
      partial = true;
      break;
    }
    const remaining = MAX_CHECK_CHARS - checkedChars;
    const masked = maskAaronnoteProse(segment.text);
    const info = createCheckChunks(masked, [{ from: 0, to: Math.min(masked.length, remaining) }]);
    for (const chunk of info.chunks) {
      if (chunks.length >= MAX_CHUNKS_PER_TOOL || checkedChars >= MAX_CHECK_CHARS) {
        partial = true;
        break;
      }
      chunks.push({
        index: chunks.length,
        from: segment.from + chunk.from,
        to: segment.from + chunk.to,
        text: chunk.text,
        sourceText: segment.text.slice(chunk.from, chunk.to),
      });
      checkedChars += chunk.to - chunk.from;
    }
    if (info.partial || masked.length > remaining) partial = true;
    if (partial) break;
  }
  return {
    chunks,
    checkedChars,
    totalChars: sourceLength,
    partial: partial || normalized.some((segment) => segment.text.length > MAX_CHECK_CHARS),
  };
}

function languageToolSeverity(item) {
  const issueType = String(item?.rule?.issueType || "").toLowerCase();
  const category = String(item?.rule?.category?.id || "").toUpperCase();
  if (issueType === "grammar" || category === "GRAMMAR") return "error";
  if (issueType === "misspelling" || category === "TYPOS") return "warning";
  return "info";
}

const CJK_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function diagnosticMatchesLanguage(masked, range, language) {
  if (!language || /^(?:zh|ja|ko)(?:-|$)/i.test(String(language))) return true;
  const matched = masked.slice(range.from, range.to);
  if (CJK_SCRIPT_RE.test(matched)) return false;
  if (/[A-Za-z0-9]/.test(matched)) return true;
  const context = masked.slice(Math.max(0, range.from - 12), Math.min(masked.length, range.to + 12));
  return !CJK_SCRIPT_RE.test(context);
}

export function parseLanguageToolDiagnostics(stdout, masked, language = "") {
  let parsed;
  try {
    parsed = JSON.parse(stdout || "{}");
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.matches)) return [];
  const items = parsed.matches;
  const diagnostics = [];
  for (const item of items) {
    const offset = Number(item?.offset);
    const length = Number(item?.length);
    if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) continue;
    const range = clampRange(masked, offset, offset + length);
    if (!rangeHasCheckedText(masked, range.from, range.to)) continue;
    if (!diagnosticMatchesLanguage(masked, range, language)) continue;
    const suggestions = Array.isArray(item?.replacements)
      ? item.replacements.map((entry) => String(entry?.value ?? "")).slice(0, 8)
      : [];
    diagnostics.push({
      source: "languagetool",
      from: range.from,
      to: range.to,
      severity: languageToolSeverity(item),
      message: String(item?.message || item?.shortMessage || "LanguageTool issue"),
      rule: String(item?.rule?.id || ""),
      word: masked.slice(range.from, range.to),
      suggestions,
    });
    if (diagnostics.length >= MAX_DIAGNOSTICS_PER_TOOL) break;
  }
  return diagnostics;
}

function normalizedAcceptedWord(value) {
  const word = String(value || "").trim();
  if (!/^[A-Za-z][A-Za-z'’-]{1,63}$/.test(word)) return "";
  return word.toLowerCase();
}

async function readUserWords() {
  if (Date.now() < userWordsCache.expiresAt) return new Set(userWordsCache.words);
  try {
    const words = new Set((await readFile(USER_WORDS_FILE, "utf8"))
      .split(/\r?\n/)
      .map(normalizedAcceptedWord)
      .filter(Boolean));
    userWordsCache = { expiresAt: Date.now() + USER_WORDS_CACHE_MS, words };
    return new Set(words);
  } catch {
    userWordsCache = { expiresAt: Date.now() + USER_WORDS_CACHE_MS, words: new Set() };
    return new Set();
  }
}

export async function acceptProseWord(value) {
  const word = normalizedAcceptedWord(value);
  if (!word) return { ok: false, message: "Word must contain 2-64 alphabetic characters" };
  let entries = [];
  try {
    entries = (await readFile(USER_WORDS_FILE, "utf8")).split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  } catch {
    // The vocabulary is created on first use.
  }
  if (!entries.some((entry) => normalizedAcceptedWord(entry) === word)) entries.push(String(value).trim());
  const sorted = entries.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  await mkdir(dirname(USER_WORDS_FILE), { recursive: true });
  const temporary = `${USER_WORDS_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${sorted.join("\n")}\n`, "utf8");
  await rename(temporary, USER_WORDS_FILE);
  userWordsCache = {
    expiresAt: Date.now() + USER_WORDS_CACHE_MS,
    words: new Set(sorted.map(normalizedAcceptedWord).filter(Boolean)),
  };
  return { ok: true, word };
}

function combineLanguageToolChunks(chunks) {
  let text = "";
  const mappings = [];
  const annotation = [];
  for (const chunk of chunks) {
    if (text) {
      text += "\n\n";
      annotation.push({ text: "\n\n" });
    }
    const combinedFrom = text.length;
    text += chunk.text;
    annotation.push(...languageToolAnnotations(chunk.sourceText || chunk.text, chunk.text));
    mappings.push({
      combinedFrom,
      combinedTo: text.length,
      sourceFrom: chunk.from,
    });
  }
  return { text, mappings, data: JSON.stringify({ annotation }) };
}

function languageToolAnnotations(source, masked) {
  const ignored = Array.from({ length: source.length }, (_, index) => source[index] !== masked[index]);
  for (let i = 0; i < ignored.length;) {
    if (ignored[i] || !/\s/.test(source[i] || "")) {
      i += 1;
      continue;
    }
    const from = i;
    while (i < ignored.length && /\s/.test(source[i] || "") && !ignored[i]) i += 1;
    if (from > 0 && i < ignored.length && ignored[from - 1] && ignored[i]) {
      for (let j = from; j < i; j++) ignored[j] = true;
    }
  }

  const annotation = [];
  for (let from = 0; from < source.length;) {
    const isMarkup = ignored[from];
    let to = from + 1;
    while (to < source.length && ignored[to] === isMarkup) to += 1;
    const value = source.slice(from, to);
    if (!isMarkup) annotation.push({ text: value });
    else {
      const trimmed = value.trimStart();
      const isMath = /^(?:\$\$|\\\[|\\\(|\\begin\{(?:align|aligned|array|equation|gather|math|multline|pmatrix|bmatrix|matrix)\*?\})/i
        .test(trimmed);
      const interpretAs = isMath
        ? "term"
        : /\r?\n/.test(value) ? "\n\n" : /[\p{L}\p{N}]/u.test(value) ? "term" : " ";
      annotation.push({ markup: value, interpretAs });
    }
    from = to;
  }
  return annotation;
}

function mapLanguageToolDiagnostics(diagnostics, mappings, sourceLength) {
  return diagnostics.flatMap((diagnostic) => {
    const mapping = mappings.find((entry) => (
      diagnostic.from >= entry.combinedFrom && diagnostic.to <= entry.combinedTo
    ));
    if (!mapping) return [];
    const from = mapping.sourceFrom + diagnostic.from - mapping.combinedFrom;
    const to = mapping.sourceFrom + diagnostic.to - mapping.combinedFrom;
    if (from < 0 || to <= from || to > sourceLength) return [];
    return [{ ...diagnostic, from, to }];
  });
}

function languageToolResult(stdout, combined, sourceLength, language) {
  const diagnostics = mapLanguageToolDiagnostics(
    parseLanguageToolDiagnostics(stdout, combined.text, language),
    combined.mappings,
    sourceLength,
  );
  const partial = diagnostics.length >= MAX_DIAGNOSTICS_PER_TOOL;
  return {
    source: "languagetool",
    ok: true,
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS_PER_TOOL),
    message: partial ? "LanguageTool diagnostics were capped to stay responsive" : "",
    partial,
  };
}

async function postLanguageTool(settings, text, signal, priority = 0, data = "") {
  const endpoint = `${settings.serverUrl.replace(/\/+$/, "")}/v2/check`;
  const body = new URLSearchParams({
    language: settings.language,
    level: settings.level,
    ...(data ? { data } : { text }),
  });
  const operationSignal = combinedAbortSignal(signal, AbortSignal.timeout(settings.remoteTimeoutMs));
  const release = await remoteSemaphore.acquire(operationSignal, priority);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: operationSignal,
    });
    if (!response.ok) throw new Error(`NAS LanguageTool returned HTTP ${response.status}`);
    const raw = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("NAS LanguageTool returned invalid JSON");
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.matches)) {
      throw new Error("NAS LanguageTool response did not contain matches");
    }
    return { raw, parsed };
  } finally {
    release();
  }
}

async function runLanguageToolRemote(combined, sourceLength, settings, signal, priority) {
  const response = await postLanguageTool(settings, combined.text, signal, priority, combined.data);
  return languageToolResult(response.raw, combined, sourceLength, settings.language);
}

async function runLanguageToolCli(combined, sourceLength, settings, signal) {
  const bin = await resolveTool("languagetool", "AARONNOTE_LANGUAGETOOL_BIN");
  const args = [
    "--encoding", "utf8",
    "--json",
    "--language", settings.language,
    "--level", settings.level.toUpperCase(),
    "--clean-overlapping",
    "-",
  ];
  const operationSignal = combinedAbortSignal(signal, AbortSignal.timeout(LANGUAGETOOL_TIMEOUT_MS));
  const release = await cliSemaphore.acquire(operationSignal);
  try {
    throwIfAborted(signal);
    const { stdout } = await execFileWithInput(bin, args, combined.text, {
      timeout: LANGUAGETOOL_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: TOOL_ENV,
      signal: operationSignal,
    });
    return languageToolResult(stdout, combined, sourceLength, settings.language);
  } catch (err) {
    throwIfAborted(signal);
    if (err?.code === "ENOENT") {
      return {
        source: "languagetool",
        ok: false,
        diagnostics: [],
        message: "LanguageTool is not installed or not on PATH",
      };
    }
    const diagnostics = mapLanguageToolDiagnostics(
      parseLanguageToolDiagnostics(err?.stdout || "", combined.text, settings.language),
      combined.mappings,
      sourceLength,
    );
    return {
      source: "languagetool",
      ok: diagnostics.length > 0,
      diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS_PER_TOOL),
      message: String(err?.stderr || err?.message || "LanguageTool failed").trim(),
      partial: !!err?.killed,
    };
  } finally {
    release();
  }
}

async function runLanguageTool(chunks, sourceLength, allowLocalFallback, interactive, settings, signal) {
  const combined = combineLanguageToolChunks(chunks);
  try {
    throwIfAborted(signal);
    return await runLanguageToolRemote(combined, sourceLength, settings, signal, interactive ? 1 : 0);
  } catch (remoteError) {
    throwIfAborted(signal);
    const reason = remoteError instanceof Error ? remoteError.message : String(remoteError);
    if (!allowLocalFallback || !settings.manualLocalFallback) {
      return {
        source: "languagetool",
        ok: false,
        diagnostics: [],
        message: `NAS LanguageTool unavailable (${reason})`,
        partial: false,
      };
    }
    const result = await runLanguageToolCli(combined, sourceLength, settings, signal);
    return {
      ...result,
      message: result.ok
        ? `NAS LanguageTool unavailable; used local CLI (${reason})`
        : `${reason}; ${result.message}`,
    };
  }
}

export function cancelExternalProseCheck(requestId) {
  const key = String(requestId || "").trim();
  const controller = key ? activeChecks.get(key) : null;
  if (controller) controller.abort(Object.assign(new Error("LanguageTool check cancelled"), { name: "AbortError" }));
  return { ok: true, cancelled: !!controller, requestId: key };
}

export function cancelAllExternalProseChecks(reason = "server-shutdown") {
  const error = Object.assign(new Error(`LanguageTool checks cancelled: ${reason}`), { name: "AbortError" });
  const controllers = [...new Set(activeChecks.values())];
  for (const controller of controllers) controller.abort(error);
  return { ok: true, cancelled: controllers.length };
}

export function cancelExternalProseChecksForClient(clientId, reason = "client-closed") {
  const prefix = `${String(clientId || "").trim()}:prose:`;
  if (prefix === ":prose:") return { ok: true, cancelled: 0 };
  const controllers = new Set();
  for (const [key, controller] of activeChecks) {
    if (key.startsWith(prefix)) controllers.add(controller);
  }
  const error = Object.assign(new Error(`LanguageTool checks cancelled: ${reason}`), { name: "AbortError" });
  for (const controller of controllers) controller.abort(error);
  return { ok: true, cancelled: controllers.size };
}

function validateProbeServerUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) throw new Error();
  } catch {
    throw Object.assign(new Error("LanguageTool server URL must use http or https"), { statusCode: 400 });
  }
}

export async function probeLanguageTool(candidate = {}) {
  const key = String(candidate.requestId || "").trim();
  if (key) cancelExternalProseCheck(key);
  const controller = new AbortController();
  if (key) activeChecks.set(key, controller);
  try {
    const current = await getLanguageToolSettings();
    if (Object.prototype.hasOwnProperty.call(candidate, "serverUrl")) validateProbeServerUrl(candidate.serverUrl);
    const settings = normalizeLanguageToolSettings({ ...current, ...candidate }, current);
    const startedAt = performance.now();
    const { parsed } = await postLanguageTool(settings, "LanguageTool connection test.", controller.signal, 2);
    return {
      ok: true,
      serverUrl: settings.serverUrl,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      version: String(parsed?.software?.version || ""),
    };
  } finally {
    if (key && activeChecks.get(key) === controller) activeChecks.delete(key);
  }
}

export async function runExternalProseChecks({
  requestId = "",
  file = "",
  content = "",
  ranges = [],
  segments = [],
  totalChars = 0,
  allowLocalFallback = true,
  interactive = false,
} = {}) {
  void file;
  const key = String(requestId || "").trim();
  if (key) cancelExternalProseCheck(key);
  const controller = new AbortController();
  if (key) activeChecks.set(key, controller);
  try {
    const settings = await getLanguageToolSettings();
    throwIfAborted(controller.signal);
    const source = String(content || "");
    const segmentList = normalizeCheckSegments(segments);
    let chunkInfo;
    if (segmentList.length > 0) {
      chunkInfo = createCheckChunksFromSegments(segmentList, totalChars);
    } else {
      const masked = maskAaronnoteProse(source);
      chunkInfo = createCheckChunks(masked, ranges);
      for (const chunk of chunkInfo.chunks) chunk.sourceText = source.slice(chunk.from, chunk.to);
    }
    const [result, userWords] = await Promise.all([
      runLanguageTool(
        chunkInfo.chunks,
        chunkInfo.totalChars,
        allowLocalFallback !== false,
        interactive === true,
        settings,
        controller.signal,
      ),
      readUserWords(),
    ]);
    throwIfAborted(controller.signal);
    const acceptedWords = new Set([
      ...AARONNOTE_ACCEPTED_WORDS.map(normalizedAcceptedWord),
      ...userWords,
    ]);
    const diagnostics = (result.diagnostics ?? [])
      .filter((diagnostic) => !acceptedWords.has(normalizedAcceptedWord(diagnostic.word)));
    const { source: toolSource, ok, message, partial } = result;
    return {
      ok: true,
      requestId: key,
      diagnostics,
      tools: [{ source: toolSource, ok, message: message || "", partial: !!partial }],
      scope: {
        checkedChars: chunkInfo.checkedChars,
        totalChars: chunkInfo.totalChars,
        partial: chunkInfo.partial || !!result.partial,
      },
      acceptedWords: [...acceptedWords],
    };
  } finally {
    if (key && activeChecks.get(key) === controller) activeChecks.delete(key);
  }
}
