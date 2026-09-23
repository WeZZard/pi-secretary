/**
 * A read-only definition denies `edit` and `write` but keeps `bash`, because `bash` is pi's only
 * search mechanism (architecture §5.2): an allowlist naming tools pi does not provide reduces the
 * agent to `read` alone and it can no longer discover a file. That leaves `bash` as a second route
 * to the filesystem, so the read-only contract is prompt-enforced unless something inspects the
 * command before it runs. This module is that inspection, applied by the composed `beforeToolCall`
 * guard in `runner.ts`.
 *
 * It is a guard, not a sandbox, and no surface may describe a read-only subagent as sandboxed.
 * It recognizes the write forms a coding agent actually reaches for: filesystem redirection, the
 * destructive coreutils, and the mutating subcommands of tools that have both read and write modes.
 * A shell is Turing-complete, so the following remain able to write and are deliberately not
 * claimed to be covered: an interpreter (`python -c`, `node -e`, `awk`), an unlisted tool, a
 * command whose name is computed or obfuscated, and a wrapper this module does not know. The
 * guard fails closed on what it does recognize; it does not certify the absence of writes.
 */

/** Commands that write to the filesystem whatever their arguments. */
const WRITING_COMMANDS = new Set([
  "rm", "rmdir", "mv", "cp", "install", "ln", "touch", "mkdir", "mkfifo", "mknod",
  "truncate", "tee", "dd", "shred", "chmod", "chown", "chgrp", "chflags",
  "rsync", "patch", "unzip", "gzip", "gunzip", "bzip2", "xz", "zip",
  "kill", "pkill", "killall", "launchctl", "systemctl", "crontab",
]);

/** Commands that write only in some modes, so the mode has to be read before refusing. */
const CONDITIONAL_COMMANDS = new Set(["sed", "perl", "ruby", "curl", "wget", "git", "npm", "yarn", "pnpm", "pip", "pip3", "cargo", "go", "brew", "apt", "apt-get", "find", "make", "cmake", "tar"]);

/** Wrappers that run another command; the command word is found past them. */
const WRAPPERS = new Set(["env", "sudo", "command", "nohup", "time", "nice", "stdbuf", "gtimeout", "timeout"]);

/** `git` subcommands that only read. */
const GIT_READING = new Set([
  "log", "show", "diff", "status", "blame", "grep", "cat-file", "rev-parse", "rev-list",
  "ls-files", "ls-tree", "ls-remote", "describe", "shortlog", "show-ref", "for-each-ref",
  "merge-base", "whatchanged", "reflog", "name-rev", "symbolic-ref", "version", "help",
  "count-objects", "verify-pack", "check-ignore", "check-attr", "diff-tree", "diff-files",
  "diff-index", "var", "stripspace", "show-branch", "unpack-file",
]);

/** `git` subcommands that read only when invoked bare, and write as soon as they are given an operand. */
const GIT_READING_WHEN_BARE = new Set(["branch", "tag", "remote", "worktree", "submodule", "notes"]);

/** A `git` listing verb that reads even though the subcommand around it can write. */
const GIT_LISTING_VERBS = new Set(["list", "show", "status", "get-url", "get"]);

/** Paths whose write is not a filesystem mutation this contract covers. */
const SINK = /^(?:\/dev\/(?:null|stdout|stderr|tty)|\/dev\/fd\/\d+|\/dev\/tty)$/;

/** Remove quoted spans so quoted text cannot be mistaken for an operator. */
function stripQuotes(text: string): string {
  return text.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/** The first path receiving redirected output, or undefined when every `>` is a descriptor dup or a sink. */
function redirectTarget(command: string): string | undefined {
  for (const match of command.matchAll(/(&>>?|>>?)\s*([^\s|;&<>]*)/g)) {
    const target = match[2] ?? "";
    if (target === "") continue;              // `echo hi >` is a syntax error, and `2>&1` duplicates a descriptor
    if (target.startsWith("&")) continue;
    if (SINK.test(target)) continue;
    return target;
  }
  return undefined;
}

/** Split into pipeline and list segments, so each command in `a | b; c` is inspected. */
function segments(command: string): string[][] {
  return command.split(/\n|;|&&|\|\||\|/).map(part => part.trim().split(/\s+/).filter(Boolean));
}

/** The command word of a segment, past environment assignments and wrappers. */
function commandWord(words: string[]): { name: string; rest: string[] } {
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { index++; continue; }
    if (WRAPPERS.has(word)) { index++; while (index < words.length && words[index]!.startsWith("-")) index++; continue; }
    break;
  }
  return { name: words[index] ?? "", rest: words.slice(index + 1) };
}

/** The first non-flag word after a command, skipping `git -C <path>` and `git -c <k=v>`. */
function subcommand(rest: string[]): string {
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index]!;
    if (word === "-C" || word === "-c" || word === "--git-dir" || word === "--work-tree") { index++; continue; }
    if (word.startsWith("-")) continue;
    return word;
  }
  return "";
}

/** Whether a `git` invocation reaches a writing subcommand. */
function gitWrites(rest: string[]): string | undefined {
  const name = subcommand(rest);
  if (name === "") return undefined;                       // `git --version` reads
  if (GIT_READING.has(name)) return undefined;
  // Drop the subcommand word itself; the operands are what decide for a dual-mode subcommand.
  const operands = rest.filter(word => !word.startsWith("-")).slice(1);
  if (name === "config") return rest.some(word => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(word)) ? undefined : "git config";
  if (name === "stash") return GIT_LISTING_VERBS.has(operands[0] ?? "") ? undefined : `git stash ${operands[0] ?? ""}`.trim();
  if (!GIT_READING_WHEN_BARE.has(name)) return `git ${name}`;
  if (operands.length === 0) return undefined;              // a bare listing reads
  const [verb] = operands;
  return GIT_LISTING_VERBS.has(verb!) ? undefined : `git ${name} ${verb}`;
}

/** Whether a package-manager invocation reaches an installing or publishing subcommand. */
function packageWrites(name: string, rest: string[]): string | undefined {
  const verb = subcommand(rest);
  const reading = new Set(["ls", "list", "view", "info", "show", "why", "outdated", "help", "root", "bin", "prefix", "doctor", "audit", "explain", "config", "ping", "whoami", "--version", "-v"]);
  if (name === "pip" || name === "pip3") return ["download", "list", "show", "freeze", "check", "help", "config"].includes(verb) ? undefined : `pip ${verb || "install"}`;
  if (name === "cargo") return ["search", "tree", "metadata", "pkgid", "verify-project", "version", "help", "clippy", "fmt", "doc", "test", "check", "bench"].includes(verb) ? undefined : `cargo ${verb}`;
  if (name === "go") return ["env", "version", "list", "doc", "vet", "test", "build", "run", "help"].includes(verb) ? undefined : `go ${verb}`;
  if (name === "brew") return ["list", "info", "search", "outdated", "config", "doctor", "--version", "help", "deps", "uses"].includes(verb) ? undefined : `brew ${verb}`;
  if (name === "apt" || name === "apt-get") return ["list", "show", "search", "policy", "help", "--version"].includes(verb) ? undefined : `${name} ${verb}`;
  const verbIsRead = reading.has(verb) || verb.startsWith("--version") || verb === "";
  return verbIsRead && verb !== "" ? undefined : `${name} ${verb || "install"}`;
}

/**
 * A reason to refuse this command for a read-only agent, or undefined when nothing recognized writes.
 * The reason completes the sentence "refusing bash because ...".
 */
export function inspectBashCommand(command: string): string | undefined {
  const text = stripQuotes(command);
  const target = redirectTarget(text);
  if (target !== undefined) return `it redirects output into ${target}`;
  for (const words of segments(text)) {
    const { name, rest } = commandWord(words);
    if (name === "") continue;
    const bare = name.replace(/^.*\//, "");                 // `/bin/rm` is still `rm`
    if (WRITING_COMMANDS.has(bare)) return `it runs ${bare}`;
    if (!CONDITIONAL_COMMANDS.has(bare)) continue;
    if (bare === "sed" || bare === "perl" || bare === "ruby") {
      if (rest.some(word => /^-[a-zA-Z]*i/.test(word))) return `it edits in place with ${bare} -i`;
    } else if (bare === "curl") {
      if (rest.some(word => word === "-o" || word === "-O" || word.startsWith("--output") || word.startsWith("-O"))) return "it downloads to a file with curl";
    } else if (bare === "wget") {
      if (!rest.some(word => word === "-O-" || word === "--output-document=-")) return "it downloads with wget, which writes a file by default";
    } else if (bare === "git") {
      const write = gitWrites(rest);
      if (write) return `it runs ${write}`;
    } else if (bare === "npm" || bare === "yarn" || bare === "pnpm" || bare === "pip" || bare === "pip3" || bare === "cargo" || bare === "go" || bare === "brew" || bare === "apt" || bare === "apt-get") {
      const write = packageWrites(bare, rest);
      if (write) return `it runs ${write}, which writes to the filesystem`;
    } else if (bare === "find") {
      if (rest.some(word => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fls"].includes(word))) return "it asks find to modify or execute";
    } else if (bare === "make" || bare === "cmake" || bare === "tar") {
      return `it runs ${bare}, which writes build or archive output`;
    }
  }
  return undefined;
}

/** The read-only contract (architecture §5.2): a definition that denies `write` is read-only. */
export function isReadOnly(definition: { disallowedTools?: string[] }): boolean {
  return definition.disallowedTools?.includes("write") ?? false;
}
