import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.ts";
import { getDb } from "./db.ts";

const exec = promisify(execFile);

export type RuntimeMode = "git" | "docker-webhook" | "docker-readonly";

export type BuildInfo = {
  version: string;
  commit: string | null;
  commitShort: string | null;
  commitTime: string | null;
  branch: string | null;
  buildTime: string | null;
  runtimeMode: RuntimeMode;
  repo: string;
};

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function git(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec("git", args, { cwd: process.cwd(), timeout: 20_000, windowsHide: true });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Environment detection:
 *   - .git present in the repo and git available -> one-click source update is possible
 *   - inside a container (no .git) but UPDATE_WEBHOOK_URL is set -> hand the update to the host script
 *   - anything else (standard container) -> can only show changes and copy commands for the host to run; must not pretend a one-click update works
 */
async function detectRuntimeMode(): Promise<RuntimeMode> {
  if (existsSync(resolve(process.cwd(), ".git"))) {
    const head = await git(["rev-parse", "--is-inside-work-tree"]);
    if (head === "true") return "git";
  }
  if (config.updateWebhookUrl) return "docker-webhook";
  return "docker-readonly";
}

export async function getBuildInfo(): Promise<BuildInfo> {
  const runtimeMode = await detectRuntimeMode();
  const version = readPackageVersion();
  if (runtimeMode === "git") {
    const commit = await git(["rev-parse", "HEAD"]);
    const commitTime = await git(["log", "-1", "--format=%cI"]);
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    return {
      version,
      commit,
      commitShort: commit ? commit.slice(0, 7) : null,
      commitTime,
      branch,
      buildTime: config.appBuildTime || null,
      runtimeMode,
      repo: config.appRepo,
    };
  }
  const commit = config.appCommit || null;
  return {
    version,
    commit,
    commitShort: commit ? commit.slice(0, 7) : null,
    commitTime: null,
    branch: null,
    buildTime: config.appBuildTime || null,
    runtimeMode,
    repo: config.appRepo,
  };
}

export type UpdateCommit = {
  sha: string;
  short: string;
  date: string;
  message: string;
  author: string;
};

export type UpdateCheck = {
  runtimeMode: RuntimeMode;
  current: BuildInfo;
  available: boolean;
  behind: number;
  ahead: number;
  latest: UpdateCommit | null;
  commits: UpdateCommit[];
  dirtyFiles: string[];
  canAutoUpdate: boolean;
  notes: string[];
  checkedAt: string;
};

async function gitDirtyFiles(): Promise<string[]> {
  const out = await git(["status", "--porcelain"]);
  if (!out) return [];
  return out.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 50);
}

async function gitFetchLatest(): Promise<UpdateCommit | null> {
  await git(["fetch", config.selfUpdateRemote, config.selfUpdateBranch, "--quiet"]);
  const out = await git([
    "log",
    "-1",
    "--format=%H%x1f%h%x1f%cI%x1f%s%x1f%an",
    `${config.selfUpdateRemote}/${config.selfUpdateBranch}`,
  ]);
  if (!out) return null;
  const [sha, short, date, message, author] = out.split("\x1f");
  return { sha: sha ?? "", short: short ?? "", date: date ?? "", message: message ?? "", author: author ?? "" };
}

async function gitCommitsBehind(): Promise<UpdateCommit[]> {
  const out = await git([
    "log",
    "--format=%H%x1f%h%x1f%cI%x1f%s%x1f%an",
    `HEAD..${config.selfUpdateRemote}/${config.selfUpdateBranch}`,
    "-n",
    "30",
  ]);
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, short, date, message, author] = line.split("\x1f");
      return { sha: sha ?? "", short: short ?? "", date: date ?? "", message: message ?? "", author: author ?? "" };
    });
}

async function gitAheadCount(): Promise<number> {
  const out = await git(["rev-list", "--count", `${config.selfUpdateRemote}/${config.selfUpdateBranch}..HEAD`]);
  return out ? Number(out) || 0 : 0;
}

/** Container / non-git environment: compare commits through the GitHub API, so at least the site owner sees whether there is anything new */
async function githubLatest(): Promise<{ latest: UpdateCommit | null; commits: UpdateCommit[]; behind: number }> {
  const url = `https://api.github.com/repos/${config.appRepo}/commits?sha=${encodeURIComponent(config.selfUpdateBranch)}&per_page=20`;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "freebie-radar" };
  if (config.githubToken) headers.authorization = "Bearer " + config.githubToken;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return { latest: null, commits: [], behind: 0 };
    const data = (await res.json()) as Array<{
      sha: string;
      commit: { message: string; author: { name: string; date: string } };
    }>;
    const commits: UpdateCommit[] = data.map((c) => ({
      sha: c.sha,
      short: c.sha.slice(0, 7),
      date: c.commit.author.date,
      message: c.commit.message.split("\n")[0] ?? "",
      author: c.commit.author.name,
    }));
    return { latest: commits[0] ?? null, commits, behind: commits.length };
  } catch {
    return { latest: null, commits: [], behind: 0 };
  }
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  const current = await getBuildInfo();
  const notes: string[] = [];
  const dirtyFiles = current.runtimeMode === "git" ? await gitDirtyFiles() : [];

  if (current.runtimeMode === "git") {
    const latest = await gitFetchLatest();
    const commits = latest ? await gitCommitsBehind() : [];
    const ahead = await gitAheadCount();
    if (ahead > 0) notes.push(`local branch is ${ahead} commits ahead and not pushed; a one-click update will follow the remote`);
    if (dirtyFiles.length) notes.push(`the working tree has ${dirtyFiles.length} uncommitted changes; a one-click update would be refused (to avoid overwriting them)`);
    return {
      runtimeMode: current.runtimeMode,
      current,
      available: commits.length > 0,
      behind: commits.length,
      ahead,
      latest,
      commits,
      dirtyFiles,
      canAutoUpdate: dirtyFiles.length === 0 && commits.length > 0,
      notes,
      checkedAt: new Date().toISOString(),
    };
  }

  const gh = await githubLatest();
  const same = current.commit && gh.latest?.sha === current.commit;
  if (!current.commit) notes.push("the current version has no commit info (APP_COMMIT was not injected at build time); an exact comparison is impossible, so only the latest remote commits are listed");
  notes.push(
    current.runtimeMode === "docker-webhook"
      ? "the image cannot be rebuilt inside the container; clicking update calls the host Webhook script you configured"
      : "a standard Docker container cannot self-update; copy the host command and run it manually",
  );
  return {
    runtimeMode: current.runtimeMode,
    current,
    available: Boolean(gh.latest) && !same,
    behind: gh.behind,
    ahead: 0,
    latest: gh.latest,
    commits: gh.commits,
    dirtyFiles: [],
    canAutoUpdate: current.runtimeMode === "docker-webhook",
    notes,
    checkedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * One-click update job (in-memory, polled by the frontend)
 * ------------------------------------------------------------------ */

export type UpdateStep = { name: string; status: "pending" | "running" | "done" | "failed" | "skipped"; detail?: string };

export type UpdateJob = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "done" | "failed";
  steps: UpdateStep[];
  log: string;
  error: string | null;
  restartScheduled: boolean;
};

let currentJob: UpdateJob | null = null;

export function getUpdateJob(): UpdateJob | null {
  return currentJob;
}

function step(job: UpdateJob, name: string): UpdateStep {
  const s: UpdateStep = { name, status: "running" };
  job.steps.push(s);
  return s;
}

function append(job: UpdateJob, text: string): void {
  job.log += text.endsWith("\n") ? text : text + "\n";
  if (job.log.length > 20_000) job.log = job.log.slice(-20_000);
}

function backupDatabase(): string {
  const dir = resolve(process.cwd(), "data", "backups");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `radar-pre-update-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  // Use SQLite's own VACUUM INTO; it yields a consistent snapshot even in WAL mode
  getDb().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

function pruneBackups(keep = 3): void {
  try {
    const dir = resolve(process.cwd(), "data", "backups");
    if (!existsSync(dir)) return;
    const files = readdirSync(dir)
      .filter((f: string) => /^radar-pre-update-.*\.db$/.test(f))
      .sort();
    while (files.length > keep) {
      const victim = files.shift();
      if (victim) rmSync(resolve(dir, victim), { force: true });
    }
  } catch {
    /* A failed cleanup does not affect the update */
  }
}

export async function runUpdate(): Promise<UpdateJob> {
  if (currentJob && currentJob.status === "running") return currentJob;
  const info = await getBuildInfo();
  const job: UpdateJob = {
    id: "upd-" + Date.now().toString(36),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    steps: [],
    log: "",
    error: null,
    restartScheduled: false,
  };
  currentJob = job;

  if (info.runtimeMode === "git") {
    void gitUpdate(job);
  } else if (info.runtimeMode === "docker-webhook") {
    void webhookUpdate(job);
  } else {
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    job.error = "this is a read-only container environment; it cannot self-update in-process";
    job.steps.push({ name: "environment precheck", status: "failed", detail: job.error });
  }
  return job;
}

async function gitUpdate(job: UpdateJob): Promise<void> {
  try {
    const precheck = step(job, "environment precheck");
    const dirty = await gitDirtyFiles();
    if (dirty.length) {
      precheck.status = "failed";
      precheck.detail = `working tree has uncommitted changes: ${dirty.slice(0, 5).join(", ")}`;
      job.error = precheck.detail;
      throw new Error(precheck.detail);
    }
    append(job, "$ git status --porcelain -> clean");
    precheck.status = "done";

    const fetchStep = step(job, "fetch remote");
    const latest = await gitFetchLatest();
    append(job, `remote latest: ${latest?.short ?? "?"} ${latest?.message ?? ""}`);
    fetchStep.status = "done";

    const backupStep = step(job, "backup database");
    const backupPath = backupDatabase();
    append(job, `backed up to ${backupPath}`);
    pruneBackups(3);
    backupStep.status = "done";

    const pullStep = step(job, "git pull --ff-only");
    const { stdout, stderr } = await exec(
      "git",
      ["pull", "--ff-only", config.selfUpdateRemote, config.selfUpdateBranch],
      { cwd: process.cwd(), timeout: 120_000, windowsHide: true },
    );
    append(job, stdout || stderr || "already up to date");
    pullStep.status = "done";

    const installStep = step(job, "install dependencies and build");
    append(job, "$ pnpm install --frozen-lockfile");
    const inst = await exec("pnpm", ["install", "--frozen-lockfile"], { cwd: process.cwd(), timeout: 300_000, windowsHide: true });
    append(job, inst.stdout || inst.stderr);
    append(job, "$ pnpm build");
    const build = await exec("pnpm", ["build"], { cwd: process.cwd(), timeout: 300_000, windowsHide: true });
    append(job, build.stdout || build.stderr);
    installStep.status = "done";

    job.status = "done";
    job.finishedAt = new Date().toISOString();
    append(job, "update finished, restarting the process...");
    scheduleRestart(job);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    job.status = "failed";
    job.error = msg;
    job.finishedAt = new Date().toISOString();
    append(job, "update failed: " + msg);
    for (const s of job.steps) if (s.status === "running") s.status = "failed";
  }
}

async function webhookUpdate(job: UpdateJob): Promise<void> {
  try {
    const s = step(job, "call host update Webhook");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.updateWebhookToken) headers.authorization = "Bearer " + config.updateWebhookToken;
    const res = await fetch(config.updateWebhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "update", branch: config.selfUpdateBranch, repo: config.appRepo }),
      signal: AbortSignal.timeout(240_000),
    });
    const text = (await res.text()).slice(0, 4000);
    append(job, text);
    if (!res.ok) throw new Error("Webhook returned HTTP " + res.status);
    s.status = "done";
    job.status = "done";
    job.finishedAt = new Date().toISOString();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    job.status = "failed";
    job.error = msg;
    job.finishedAt = new Date().toISOString();
    append(job, "Webhook update failed: " + msg);
    for (const s of job.steps) if (s.status === "running") s.status = "failed";
  }
}

function scheduleRestart(job: UpdateJob): void {
  job.restartScheduled = true;
  const cmd = config.selfUpdateRestartCmd;
  setTimeout(() => {
    if (cmd) {
      try {
        exec("sh", ["-c", cmd], { windowsHide: true }).catch(() => undefined);
      } catch {
        /* ignore */
      }
      return;
    }
    // No restart command configured: exit on purpose and let the systemd / pm2 / docker restart policy bring it back up
    process.exit(0);
  }, 1200).unref?.();
}

/** Host upgrade command (offered to the frontend for one-click copy in the docker-readonly environment) */
export function hostUpdateCommand(): string {
  return [
    `cd /opt/freebie-radar`,
    `git pull --ff-only`,
    `docker compose up -d --build`,
  ].join(" && ");
}