#!/usr/bin/env bun
// Read-only inspection of the OpenSEO selfhost fork layout. Never fetches,
// switches branches, installs, or deploys. Reports .env.selfhost keys by name
// only.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

interface Check {
  readonly severity: "blocker" | "warning" | "ok";
  readonly name: string;
  readonly detail: string;
}

interface RepoState {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly clean: boolean | null;
}

const decoder = new TextDecoder();

const run = (command: readonly string[], cwd?: string) => {
  const result = Bun.spawnSync([...command], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    ok: result.exitCode === 0,
    stdout: decoder.decode(result.stdout).trim(),
    stderr: decoder.decode(result.stderr).trim(),
  };
};

const git = (repository: string, ...args: readonly string[]) =>
  run(["git", "-C", repository, ...args]);

const args = process.argv.slice(2);
const json = args.includes("--json");
const optionValue = (flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : resolve(args[index + 1] ?? "");
};

const resolveMain = (): string => {
  const override = optionValue("--main");
  if (override) return override;
  const root = run(["git", "rev-parse", "--show-toplevel"]);
  if (!root.ok) {
    process.stderr.write("Run from the open-seo checkout or pass --main.\n");
    process.exit(2);
  }
  const common = git(root.stdout, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return common.ok && basename(common.stdout) === ".git" ? dirname(common.stdout) : root.stdout;
};

const repoState = (path: string): RepoState => {
  if (!existsSync(path)) return { path, head: null, branch: null, clean: null };
  const head = git(path, "rev-parse", "HEAD");
  const branch = git(path, "symbolic-ref", "--quiet", "--short", "HEAD");
  const status = git(path, "status", "--porcelain");
  return {
    path,
    head: head.ok ? head.stdout : null,
    branch: branch.ok ? branch.stdout : null,
    clean: status.ok ? status.stdout.length === 0 : null,
  };
};

const checks: Check[] = [];
const push = (severity: Check["severity"], name: string, detail: string) =>
  checks.push({ severity, name, detail });

const addRepoChecks = (label: string, state: RepoState, expectedBranch: string | null) => {
  if (state.head === null) {
    push("blocker", `${label}.exists`, state.path);
    return;
  }
  push("ok", `${label}.exists`, state.path);
  push(
    state.clean === true ? "ok" : "blocker",
    `${label}.clean`,
    state.clean === true ? "clean" : state.clean === false ? "working tree has changes" : "unable to read status",
  );
  push(
    state.branch === expectedBranch ? "ok" : "blocker",
    `${label}.branch`,
    state.branch === expectedBranch
      ? (expectedBranch ?? "detached HEAD")
      : `expected ${expectedBranch ?? "detached HEAD"}, found ${state.branch ?? "detached HEAD"}`,
  );
};

const mainPath = resolveMain();
const upstreamPath =
  optionValue("--upstream") ?? join(dirname(mainPath), "open-seo-worktrees", "upstream");
const main = repoState(mainPath);
const upstream = repoState(upstreamPath);

addRepoChecks("main", main, "dev");
addRepoChecks("upstream", upstream, null);

const rev = (ref: string) => {
  const result = git(mainPath, "rev-parse", "--verify", "--quiet", ref);
  return result.ok ? result.stdout : null;
};
const originDev = rev("refs/remotes/origin/dev");
const upstreamMain = rev("refs/remotes/upstream/main");
const localMain = rev("refs/heads/main");

for (const [name, remote, expected] of [
  ["origin", "origin", "aryasaatvik/open-seo"],
  ["upstream", "upstream", "every-app/open-seo"],
] as const) {
  const url = git(mainPath, "remote", "get-url", remote);
  push(
    url.ok && url.stdout.includes(expected) ? "ok" : "blocker",
    `remotes.${name}`,
    url.ok ? url.stdout : `remote ${remote} missing`,
  );
}

if (!originDev) push("blocker", "refs.origin-dev", "missing origin/dev");
if (!upstreamMain) push("blocker", "refs.upstream-main", "missing upstream/main");

if (originDev && main.head) {
  if (main.head === originDev) push("ok", "main.alignment", originDev);
  else {
    const ahead = git(mainPath, "rev-list", "--count", `${originDev}..${main.head}`);
    const behind = git(mainPath, "rev-list", "--count", `${main.head}..${originDev}`);
    push(
      "warning",
      "main.alignment",
      `HEAD ${main.head} != origin/dev ${originDev} (${ahead.stdout} unpushed, ${behind.stdout} unpulled)`,
    );
  }
}

if (upstreamMain && upstream.head) {
  push(
    upstream.head === upstreamMain ? "ok" : "warning",
    "upstream.alignment",
    upstream.head === upstreamMain
      ? upstreamMain
      : `HEAD ${upstream.head} != upstream/main ${upstreamMain}`,
  );
}

if (upstreamMain && localMain) {
  push(
    localMain === upstreamMain ? "ok" : "warning",
    "main-branch.mirror",
    localMain === upstreamMain
      ? "local main == upstream/main"
      : `local main ${localMain} != upstream/main ${upstreamMain}; fast-forward with: git fetch upstream main:main`,
  );
}

let upstreamOnly: number | null = null;
let forkOnly: number | null = null;
let mergeBase: string | null = null;
const forkCommits: { sha: string; subject: string; scoped: boolean }[] = [];
if (originDev && upstreamMain) {
  const counts = git(mainPath, "rev-list", "--left-right", "--count", `${upstreamMain}...${originDev}`);
  if (counts.ok) [upstreamOnly, forkOnly] = counts.stdout.split(/\s+/).map(Number);
  const base = git(mainPath, "merge-base", originDev, upstreamMain);
  mergeBase = base.ok ? base.stdout : null;
  const log = git(mainPath, "log", "--format=%H%x09%s", `${upstreamMain}..${originDev}`);
  for (const line of log.stdout.split("\n").filter(Boolean)) {
    const [sha, subject] = line.split("\t");
    forkCommits.push({ sha, subject, scoped: /^[a-z]+\(selfhost\)!?:/.test(subject) });
  }
  const unscoped = forkCommits.filter((commit) => !commit.scoped);
  push(
    unscoped.length === 0 ? "ok" : "warning",
    "fork.scope",
    unscoped.length === 0
      ? `${forkCommits.length} fork-only commits, all scoped (selfhost)`
      : `fork-only commits without (selfhost) scope: ${unscoped.map((c) => `${c.sha.slice(0, 7)} ${c.subject}`).join("; ")}`,
  );
  const forkFiles = git(mainPath, "diff", "--name-only", `${upstreamMain}...${originDev}`);
  const appFiles = forkFiles.stdout
    .split("\n")
    .filter((file) => file && !/^(alchemy\.(run|access)\.ts|\.env\.selfhost\.example|knip\.jsonc|\.agents\/skills\/openseo-selfhost-upgrade\/|\.claude\/skills\/openseo-selfhost-upgrade)/.test(file));
  push(
    appFiles.length === 0 ? "ok" : "warning",
    "fork.surface",
    appFiles.length === 0
      ? "fork patches stay in the deploy layer"
      : `fork touches files outside the documented patch surface: ${appFiles.join(", ")}; update references/topology.md`,
  );
}

// .env.selfhost: names only.
const envPath = join(mainPath, ".env.selfhost");
const envKeys: string[] = [];
if (!existsSync(envPath)) {
  push("blocker", "env.exists", ".env.selfhost missing; cp .env.selfhost.example .env.selfhost");
} else {
  push("ok", "env.exists", envPath);
  const mode = statSync(envPath).mode & 0o777;
  push(mode === 0o600 ? "ok" : "warning", "env.mode", `mode ${mode.toString(8)}${mode === 0o600 ? "" : "; expected 600"}`);
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && match[2].length > 0) envKeys.push(match[1]);
  }
  envKeys.sort();
  const has = (key: string) => envKeys.includes(key);
  if (!has("DATAFORSEO_API_KEY")) push("blocker", "env.dataforseo", "DATAFORSEO_API_KEY unset");
  const managedAccess = !(has("TEAM_DOMAIN") && has("POLICY_AUD"));
  if (managedAccess && !has("ACCESS_ALLOWED_EMAILS")) {
    push("blocker", "env.access", "ACCESS_ALLOWED_EMAILS unset and no TEAM_DOMAIN+POLICY_AUD");
  }
  const google = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "BETTER_AUTH_SECRET"].filter(has);
  if (google.length > 0 && google.length < 3) {
    push("blocker", "env.google", `Google needs all three keys, found ${google.join(", ")}`);
  }
  push(has("DOMAIN") ? "ok" : "warning", "env.domain", has("DOMAIN") ? "DOMAIN set" : "DOMAIN unset; deploy would fall back to workers.dev");
  push("ok", "env.keys", envKeys.join(", "));

  const examplePath = join(mainPath, ".env.selfhost.example");
  if (existsSync(examplePath)) {
    const exampleKeys = [...readFileSync(examplePath, "utf8").matchAll(/^#?\s?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    const unknown = envKeys.filter((key) => !exampleKeys.includes(key));
    if (unknown.length > 0) push("warning", "env.unknown", `keys not in .env.selfhost.example: ${unknown.join(", ")}`);
    const unused = exampleKeys.filter((key) => !envKeys.includes(key));
    push("ok", "env.unset", unused.length === 0 ? "every example key is set" : `example keys left unset: ${unused.join(", ")}`);
  }
}

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
push(
  nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6) ? "ok" : "warning",
  "runtime.node",
  `bun reports node ${process.versions.node}; deploy needs 22.6+ (check node --version separately)`,
);
push(
  existsSync(join(mainPath, "node_modules")) ? "ok" : "warning",
  "runtime.node_modules",
  existsSync(join(mainPath, "node_modules")) ? "installed" : "missing; run pnpm install --frozen-lockfile",
);
const pkg = JSON.parse(readFileSync(join(mainPath, "package.json"), "utf8")) as {
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};
const alchemyPin = pkg.devDependencies?.alchemy ?? pkg.dependencies?.alchemy ?? "missing";
push("ok", "alchemy.pin", alchemyPin);

const blockers = checks.filter((c) => c.severity === "blocker");
const warnings = checks.filter((c) => c.severity === "warning");
const report = {
  status: blockers.length === 0 ? "ready" : "blocked",
  generatedAt: new Date().toISOString(),
  note: "Read-only local inspection. Remote-tracking refs were not fetched.",
  repositories: { main, upstream },
  refs: { originDev, upstreamMain, localMain, mergeBase, divergence: { upstreamOnly, forkOnly } },
  forkCommits,
  envKeys,
  alchemyPin,
  checks,
};

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`OpenSEO selfhost preflight: ${report.status.toUpperCase()}\n`);
  process.stdout.write(`origin/dev:    ${originDev ?? "missing"}\n`);
  process.stdout.write(`upstream/main: ${upstreamMain ?? "missing"}\n`);
  process.stdout.write(`divergence:    ${upstreamOnly ?? "?"} upstream-only, ${forkOnly ?? "?"} fork-only\n`);
  for (const commit of forkCommits) {
    process.stdout.write(`  ${commit.scoped ? " " : "!"} ${commit.sha.slice(0, 7)} ${commit.subject}\n`);
  }
  process.stdout.write(`env keys:      ${envKeys.join(", ") || "none"}\n`);
  process.stdout.write(`alchemy:       ${alchemyPin}\n`);
  for (const check of [...blockers, ...warnings]) {
    process.stdout.write(`${check.severity.toUpperCase()}: ${check.name}: ${check.detail}\n`);
  }
}

process.exit(blockers.length === 0 ? 0 : 1);
