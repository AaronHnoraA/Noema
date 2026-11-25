export const packageManagers = ["npm", "pnpm", "yarn", "bun", "deno"] as const;
export type PackageManager = typeof packageManagers[number];
type TargetManager = Exclude<PackageManager, "npm">;

const prefixes = {
  pnpm: { install: "pnpm install", add: "pnpm add", remove: "pnpm remove", run: "pnpm run", create: "pnpm create", init: "pnpm init", ci: "pnpm install --frozen-lockfile", exec: "pnpm dlx" },
  yarn: { install: "yarn install", add: "yarn add", remove: "yarn remove", run: "yarn run", create: "yarn create", init: "yarn init", ci: "yarn install --immutable", exec: "yarn dlx" },
  bun: { install: "bun install", add: "bun add", remove: "bun remove", run: "bun run", create: "bun create", init: "bun init", ci: "bun install --frozen-lockfile", exec: "bunx" },
  deno: { install: "deno install", add: "deno add", remove: "deno remove", run: "deno task", create: "deno create", init: "deno init", ci: "deno ci", exec: "deno x" },
} as const satisfies Record<TargetManager, Record<string, string>>;

interface Word {
  from: number;
  to: number;
  text: string;
  value: string;
  dynamic: boolean;
}

const compoundWord = /^(?:if|then|elif|else|fi|case|esac|for|while|until|do|done|function|\{|\})$/;

function shellChain(line: string): Word[][] | null {
  const segments: Word[][] = [[]];
  for (let index = 0; index < line.length;) {
    const char = line[index]!;
    if (char === " " || char === "\t") { index++; continue; }
    if (char === "#") break;
    if (line.startsWith("&&", index)) {
      if (!segments.at(-1)!.length) return null;
      segments.push([]);
      index += 2;
      continue;
    }
    if (/[;|&<>()`]/.test(char)) return null;
    const from = index;
    let quote = "";
    let value = "";
    let dynamic = false;
    while (index < line.length) {
      const current = line[index]!;
      if (current === "\\" && quote !== "'") {
        if (index + 1 >= line.length) return null;
        const next = line[index + 1]!;
        value += quote === '"' && !/[\\$"`]/.test(next) ? "\\" + next : next;
        index += 2;
        continue;
      }
      if (quote) {
        if (current === quote) quote = "";
        else if (quote === '"' && (current === "`" || line.startsWith("$(", index))) return null;
        else {
          if (quote === '"' && current === "$") dynamic = true;
          value += current;
        }
      } else if (current === '"' || current === "'") {
        quote = current;
      } else if (/[ \t;&|<>()`]/.test(current)) {
        break;
      } else {
        if (/[$*?\[\]]/.test(current)) dynamic = true;
        value += current;
      }
      index++;
    }
    if (quote || index === from) return null;
    segments.at(-1)!.push({ from, to: index, text: line.slice(from, index), value, dynamic });
  }
  if (segments.length > 1 && !segments.at(-1)!.length) return null;
  return segments.some((words) => words[0] && compoundWord.test(words[0].text)) ? null : segments;
}

const packageSpec = /^(?:@[a-z\d._-]+\/)?[a-z\d][a-z\d._-]*(?:@[a-z\d.^~*+_-]+)?$/i;
const scriptName = /^[a-z\d][\w:.-]*$/i;
const isPackage = (word: Word) => !word.dynamic && packageSpec.test(word.text);
const isDelimiter = (word: Word | undefined) => !!word && !word.dynamic && word.value === "--";
const mayBeOption = (word: Word) => word.dynamic || word.value.startsWith("-");
const dependencyCommands = /^(?:install|i|add)$/;
const removeCommands = /^(?:uninstall|remove|rm|un|unlink|r)$/;
const runCommands = /^(?:run|run-script)$/;
const installOptions = new Map([
  ["-D", "dev"], ["--save-dev", "dev"],
  ["-O", "optional"], ["--save-optional", "optional"],
  ["-E", "exact"], ["--save-exact", "exact"],
]);
const flags = {
  pnpm: { dev: "-D", optional: "-O", exact: "-E" },
  yarn: { dev: "-D", optional: "-O", exact: "-E" },
  bun: { dev: "-D", optional: "--optional", exact: "-E" },
  deno: { dev: "-D", optional: "-O", exact: "--save-exact" },
} as const;

function rewrite(words: readonly Word[], line: string, manager: TargetManager): string | null {
  const [program, operation, ...args] = words;
  if (!program || !operation) return null;
  const command = prefixes[manager];
  const spelling = (values: readonly Word[]): string =>
    values.length ? line.slice(values[0]!.from, values.at(-1)!.to) : "";
  const operationName = operation.text;
  const withRegistry = (word: Word) => manager === "deno" ? "npm:" + word.text : word.text;
  if (program.text === "npx" && isPackage(operation)) {
    return command.exec + " " + withRegistry(operation) + line.slice(operation.to, words.at(-1)!.to);
  }
  if (program.text !== "npm") return null;
  if (args.length === 0) {
    if (operationName === "ci") return command.ci;
    if (operationName === "init") return command.init;
    if (dependencyCommands.test(operationName)) return command.install;
    return null;
  }
  if (dependencyCommands.test(operationName)) {
    const options = new Set(args.map(({ text }) => installOptions.get(text)).filter(Boolean));
    const packages = args.filter(({ text }) => !installOptions.has(text));
    if ((options.has("dev") && options.has("optional")) || !packages.length || packages.some((word) => !isPackage(word))) return null;
    const translated = (["dev", "optional", "exact"] as const).filter((kind) => options.has(kind)).map((kind) => flags[manager][kind]);
    return [command.add, ...translated, ...packages.map(withRegistry)].join(" ");
  }
  if (removeCommands.test(operationName) && args.every(isPackage)) return command.remove + " " + spelling(args);
  const target = args[0]!;
  const delimiterAtStart = isDelimiter(args[1]);
  const rest = args.slice(delimiterAtStart ? 2 : 1);
  if (runCommands.test(operationName) && scriptName.test(target.text)) {
    if (!delimiterAtStart && rest.some(mayBeOption)) return null;
    return [command.run, target.text, spelling(rest)].filter(Boolean).join(" ");
  }
  if (operationName === "create" && isPackage(target)) {
    const delimiter = args.findIndex((word, index) => index > 0 && isDelimiter(word));
    const positional = delimiter < 0 ? args.slice(1) : args.slice(1, delimiter);
    if (positional.some(mayBeOption)) return null;
    const tail = delimiter < 0 ? [] : args.slice(delimiter + (manager === "deno" ? 0 : 1));
    return [command.create, withRegistry(target), spelling(positional), spelling(tail)].filter(Boolean).join(" ");
  }
  return null;
}

export function packageManagerScripts(source: string, managers: readonly PackageManager[]): string[] {
  const lines = source.split("\n");
  const chains = lines.map(shellChain);
  // An opaque line can affect how the shell reads the lines that follow it.
  // Keep the snippet as authored when it falls outside the single-line grammar.
  if (chains.some((chain) => chain === null)) return managers.map(() => source);
  return managers.map((manager) => manager === "npm" ? source : lines.map((line, index) => {
    const segments = chains[index]!;
    let start = 0;
    let result = "";
    for (const words of segments) {
      const replacement = rewrite(words, line, manager);
      if (!replacement) continue;
      result += line.slice(start, words[0]!.from) + replacement;
      start = words.at(-1)!.to;
    }
    return result + line.slice(start);
  }).join("\n"));
}

export function packageManagerScript(source: string, manager: PackageManager): string {
  return packageManagerScripts(source, [manager])[0]!;
}
