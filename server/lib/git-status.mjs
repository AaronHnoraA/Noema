// Pure parser for `git status --porcelain=v1 --branch` output.
//
// Two producers feed it.  The Node path asks for `-z`, so unusual filenames
// arrive verbatim and rename entries carry their origin as a separate field.
// The kernel Git provider only hands back the newline form as an opaque
// string, so the same parser accepts C-quoted paths and the ` -> ` rename
// spelling.  Everything the repository view shows — branch, upstream,
// ahead/behind, per-file state — is already in this one command's output.

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

// Everything git can put in an index/worktree status column.  Anything else on
// a line means the payload is not porcelain v1, and inventing a changed file
// out of it would be worse than dropping the line.
const STATUS_CHARS = new Set([" ", "M", "A", "D", "R", "C", "U", "T", "?", "!"]);

const CODE_LABELS = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  U: "Unmerged",
};

const CONFLICT_LABELS = {
  UU: "Both modified",
  AA: "Both added",
  DD: "Both deleted",
  AU: "Added by us",
  UA: "Added by them",
  DU: "Deleted by us",
  UD: "Deleted by them",
};

function unquotePath(value) {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  const encoder = new TextEncoder();
  const bytes = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      for (const byte of encoder.encode(char)) bytes.push(byte);
      continue;
    }
    const next = body[index + 1] || "";
    index += 1;
    if (next === "n") bytes.push(0x0a);
    else if (next === "t") bytes.push(0x09);
    else if (next === "r") bytes.push(0x0d);
    else if (next >= "0" && next <= "7") {
      bytes.push(Number.parseInt(body.slice(index, index + 3), 8) & 0xff);
      index += 2;
    } else for (const byte of encoder.encode(next)) bytes.push(byte);
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function emptyHeader() {
  return { branch: "", upstream: "", ahead: 0, behind: 0, detached: false, initial: false, gone: false };
}

function parseBranchHeader(field) {
  const header = emptyHeader();
  let rest = field.replace(/^##\s*/, "").trim();
  if (!rest) return header;
  if (rest.startsWith("HEAD (no branch)")) {
    header.branch = "HEAD";
    header.detached = true;
    return header;
  }
  const fresh = /^(?:No commits yet on|Initial commit on)\s+(.+)$/.exec(rest);
  if (fresh) {
    header.initial = true;
    rest = fresh[1];
  }
  const tracking = /\s\[([^\]]*)\]$/.exec(rest);
  if (tracking) {
    rest = rest.slice(0, tracking.index);
    for (const part of tracking[1].split(",")) {
      const token = part.trim();
      if (token === "gone") header.gone = true;
      const ahead = /^ahead\s+(\d+)$/.exec(token);
      if (ahead) header.ahead = Number(ahead[1]);
      const behind = /^behind\s+(\d+)$/.exec(token);
      if (behind) header.behind = Number(behind[1]);
    }
  }
  const split = rest.indexOf("...");
  if (split >= 0) {
    header.branch = rest.slice(0, split);
    header.upstream = rest.slice(split + 3);
  } else header.branch = rest;
  return header;
}

function entryLabel(code) {
  if (code === "??") return "Untracked";
  if (code === "!!") return "Ignored";
  if (CONFLICT_LABELS[code]) return CONFLICT_LABELS[code];
  const [x, y] = code;
  const primary = y !== " " ? y : x;
  return CODE_LABELS[primary] || "Changed";
}

function headerDisplay(header) {
  if (!header.branch) return "";
  const tracking = [];
  if (header.gone) tracking.push("gone");
  if (header.ahead) tracking.push(`ahead ${header.ahead}`);
  if (header.behind) tracking.push(`behind ${header.behind}`);
  return `## ${header.branch}${header.upstream ? `...${header.upstream}` : ""}`
    + (tracking.length ? ` [${tracking.join(", ")}]` : "");
}

export function parseGitPorcelainStatus(text, { nul = false } = {}) {
  const fields = nul ? String(text || "").split("\0") : String(text || "").split(/\r?\n/);
  const entries = [];
  let header = emptyHeader();
  for (let index = 0; index < fields.length; index += 1) {
    const field = nul ? fields[index] : fields[index].replace(/\r$/, "");
    if (!field) continue;
    if (field.startsWith("##")) {
      header = parseBranchHeader(field);
      continue;
    }
    if (field.length < 4 || field[2] !== " ") continue;
    const x = field[0];
    const y = field[1];
    if (!STATUS_CHARS.has(x) || !STATUS_CHARS.has(y)) continue;
    const code = `${x}${y}`;
    if (code === "!!") continue;
    let path = field.slice(3);
    let origPath = "";
    if (x === "R" || x === "C") {
      if (nul) {
        origPath = fields[index + 1] || "";
        index += 1;
      } else {
        const arrow = path.indexOf(" -> ");
        if (arrow >= 0) {
          origPath = path.slice(0, arrow);
          path = path.slice(arrow + 4);
        }
      }
    }
    if (!nul) {
      path = unquotePath(path);
      if (origPath) origPath = unquotePath(origPath);
    }
    const conflicted = CONFLICT_CODES.has(code);
    const untracked = code === "??";
    entries.push({
      code,
      path,
      origPath,
      label: entryLabel(code),
      conflicted,
      untracked,
      staged: !conflicted && !untracked && x !== " ",
      unstaged: untracked || (!conflicted && y !== " "),
    });
  }
  return {
    ...header,
    entries,
    changedFiles: entries.length,
    conflictedFiles: entries.filter((entry) => entry.conflicted).length,
    clean: entries.length === 0,
    display: [headerDisplay(header), ...entries.map((entry) => (
      `${entry.code} ${entry.origPath ? `${entry.origPath} -> ` : ""}${entry.path}`
    ))].filter(Boolean).join("\n"),
  };
}
