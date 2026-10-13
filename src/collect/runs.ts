// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  DECLARATION_PATH,
  FORKS,
  HISTORY_DAYS,
  LIFECYCLE_WORKFLOWS,
  type LifecycleKind,
  STACK_REPO,
  SYNC_TEMPLATE_WORKFLOW,
  TEMPLATE_REPO,
} from "../config.ts";
import type {
  ForkRuns,
  JobDetail,
  LifecycleRun,
  OutsidePr,
  RunFact,
  StepFact,
  WaitingRun,
} from "../facts.ts";
import type { Gh } from "../forge.ts";
import { type Annotation, reasonFromAnnotations, reasonFromLog } from "../model/reason.ts";
import { pool } from "../util.ts";
import { parseDeclaration } from "./github.ts";

const RUN_JQ =
  "[.workflow_runs[] | {id, name, path, event, status, conclusion, created_at, updated_at, head_branch, head_sha, display_title, html_url, run_attempt}]";

interface RawRun {
  id: number;
  name: string;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  head_branch: string | null;
  head_sha: string;
  display_title: string;
  html_url: string;
  run_attempt: number;
}

function toRun(r: RawRun): RunFact {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    branch: r.head_branch ?? undefined,
    sha: r.head_sha,
    title: r.display_title,
    url: r.html_url,
    attempt: r.run_attempt,
  };
}

async function runs(gh: Gh, path: string): Promise<RunFact[]> {
  return (await gh.rest<RawRun[]>(path, RUN_JQ)).map(toRun);
}

export async function readForkRuns(gh: Gh): Promise<Record<string, ForkRuns>> {
  const out: Record<string, ForkRuns> = {};
  await pool(FORKS, 3, async (f) => {
    const base = `repos/${f.repo}/actions`;
    const [sync, template, cascade, main] = await Promise.all([
      runs(gh, `${base}/workflows/sync.yml/runs?per_page=10`),
      runs(gh, `${base}/workflows/${SYNC_TEMPLATE_WORKFLOW}/runs?per_page=5`),
      runs(gh, `${base}/workflows/cascade.yml/runs?per_page=5`),
      runs(gh, `${base}/workflows/validate.yml/runs?branch=main&event=push&per_page=5`),
    ]);
    out[f.repo] = { sync, template, cascade, main };
  });
  return out;
}

export type PrFiles = Pick<OutsidePr, "files" | "changedFiles" | "additions" | "deletions">;

// Keyed `repo#number@sha`: a PR's files at one head never change.
export type PrFilesCache = Record<string, PrFiles>;

interface RawOpenPr {
  number: number;
  title: string;
  url: string;
  author: string;
  association: string;
  draft: boolean;
  sha: string;
}

async function prFiles(gh: Gh, repo: string, n: number): Promise<PrFiles> {
  const files = await gh.rest<{ path: string; additions: number; deletions: number }[]>(
    `repos/${repo}/pulls/${n}/files?per_page=100`,
    "[.[] | {path: .filename, additions, deletions}]",
  );
  const pr = await gh.rest<{ changed: number; additions: number; deletions: number }>(
    `repos/${repo}/pulls/${n}`,
    "{changed: .changed_files, additions, deletions}",
  );
  return {
    files: files.map((f) => f.path),
    changedFiles: pr.changed,
    additions: pr.additions,
    deletions: pr.deletions,
  };
}

// Runs held at "action_required" are outside PRs waiting for a maintainer to
// approve their workflows. Each run is matched to the open PR at its head; a run
// on a head the PR has since moved past has nothing left to approve.
export async function readApprovals(
  gh: Gh,
  cache: PrFilesCache = {},
): Promise<Record<string, WaitingRun[]>> {
  const repos = [TEMPLATE_REPO, STACK_REPO, ...FORKS.map((f) => f.repo)];
  const out: Record<string, WaitingRun[]> = {};
  await pool(repos, 4, async (repo) => {
    const waiting = await runs(
      gh,
      `repos/${repo}/actions/runs?status=action_required&per_page=100`,
    );
    out[repo] = waiting;
    if (waiting.length === 0) return;
    let open: RawOpenPr[];
    try {
      open = await gh.rest<RawOpenPr[]>(
        `repos/${repo}/pulls?state=open&per_page=100`,
        "[.[] | {number, title, url: .html_url, author: .user.login, association: .author_association, draft, sha: .head.sha}]",
      );
    } catch {
      return;
    }
    const bySha = new Map(open.map((p) => [p.sha, p]));
    const live = new Map<number, OutsidePr | undefined>();
    for (const p of open) {
      if (!waiting.some((r) => r.sha === p.sha)) continue;
      const key = `${repo}#${p.number}@${p.sha}`;
      try {
        const files = cache[key] ?? (await prFiles(gh, repo, p.number));
        cache[key] = files;
        const { sha, ...rest } = p;
        live.set(p.number, { ...rest, headSha: sha, ...files });
      } catch {
        live.set(p.number, undefined);
      }
    }
    out[repo] = waiting.map((r) => {
      const p = bySha.get(r.sha);
      if (!p) return { ...r, pr: null };
      const pr = live.get(p.number);
      return pr ? { ...r, pr } : r;
    });
  });
  return out;
}

const JOBS_JQ =
  "[.jobs[] | {id, name, status, conclusion, started_at, completed_at, html_url, steps: [(.steps // [])[] | {number, name, status, conclusion, started_at, completed_at}]}]";
const JOB_JQ =
  "{id, name, status, conclusion, started_at, completed_at, html_url, steps: [(.steps // [])[] | {number, name, status, conclusion, started_at, completed_at}]}";

interface RawJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
  steps: {
    number: number;
    name: string;
    status: string;
    conclusion: string | null;
    started_at?: string | null;
    completed_at?: string | null;
  }[];
}

function toJob(j: RawJob): JobDetail {
  const steps: StepFact[] = j.steps.map((s) => ({
    number: s.number,
    name: s.name,
    status: s.status,
    conclusion: s.conclusion ?? undefined,
    startedAt: s.started_at ?? undefined,
    completedAt: s.completed_at ?? undefined,
  }));
  return {
    id: j.id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion ?? undefined,
    startedAt: j.started_at ?? undefined,
    completedAt: j.completed_at ?? undefined,
    url: j.html_url,
    steps,
    failedStep: steps.find((s) => s.conclusion === "failure")?.name,
  };
}

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

// Completed jobs never change, so a finished job's detail is read once and kept.
export class DetailCache {
  constructor(private readonly entries: Record<string, JobDetail> = {}) {}

  get(repo: string, id: number): JobDetail | undefined {
    return this.entries[`${repo}#${id}`];
  }

  put(repo: string, detail: JobDetail): void {
    if (detail.status === "completed") this.entries[`${repo}#${detail.id}`] = detail;
  }

  prune(keep: ReadonlySet<string>): void {
    for (const key of Object.keys(this.entries)) if (!keep.has(key)) delete this.entries[key];
  }

  snapshot(): Record<string, JobDetail> {
    return { ...this.entries };
  }
}

async function explain(gh: Gh, repo: string, job: JobDetail, readLog: boolean): Promise<void> {
  if (!FAILED.has(job.conclusion ?? "")) return;
  try {
    const annotations = await gh.rest<Annotation[]>(
      `repos/${repo}/check-runs/${job.id}/annotations`,
      "[.[] | {level: .annotation_level, message}]",
    );
    job.reason = reasonFromAnnotations(annotations);
  } catch {
    job.reason = undefined;
  }
  if (job.reason && !readLog) return;
  try {
    const fromLog = reasonFromLog(await gh.text(`repos/${repo}/actions/jobs/${job.id}/logs`));
    if (fromLog) job.reason = fromLog;
  } catch {
    // An expired or missing log leaves the annotation reason, if any.
  }
}

// A Java Build failure explains itself only in the log; every other job is
// read from its annotations first.
export async function readJob(
  gh: Gh,
  cache: DetailCache,
  repo: string,
  id: number,
  name: string,
): Promise<JobDetail> {
  const cached = cache.get(repo, id);
  if (cached) return cached;
  const job = toJob(await gh.rest<RawJob>(`repos/${repo}/actions/jobs/${id}`, JOB_JQ));
  await explain(gh, repo, job, /java build/i.test(name));
  cache.put(repo, job);
  return job;
}

export async function readRunJobs(
  gh: Gh,
  cache: DetailCache,
  repo: string,
  run: RunFact,
): Promise<JobDetail[]> {
  const jobs = (
    await gh.rest<RawJob[]>(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=60`, JOBS_JQ)
  ).map(toJob);
  return pool(jobs, 3, async (job) => {
    const cached = cache.get(repo, job.id);
    if (cached && cached.status === job.status && cached.conclusion === job.conclusion) {
      const kept = { ...cached, steps: job.steps };
      cache.put(repo, kept);
      return kept;
    }
    await explain(gh, repo, job, false);
    cache.put(repo, job);
    return job;
  });
}

const VERSION_IN_TITLE = /stackVersion to (v\d+\.\d+\.\d+)/;

// Upgrades dispatched by hand carry no version in their title, so the target is
// the declaration at the run's commit.
async function targetOf(
  gh: Gh,
  run: RunFact,
  files: Record<string, string>,
): Promise<string | undefined> {
  const fromTitle = VERSION_IN_TITLE.exec(run.title)?.[1];
  if (fromTitle) return fromTitle;
  if (files[run.sha]) return files[run.sha];
  try {
    const file = await gh.rest<{ text: string }>(
      `repos/${STACK_REPO}/contents/${DECLARATION_PATH}?ref=${run.sha}`,
      "{text: (.content | @base64d)}",
    );
    const version = parseDeclaration(file.text)?.stackVersion;
    if (version) files[run.sha] = version;
    return version;
  } catch {
    return undefined;
  }
}

// Jobs cached before step times were kept are read once more.
function timed(job: JobDetail): boolean {
  return job.steps.length === 0 || job.steps.some((s) => s.startedAt !== undefined);
}

export interface LifecycleState {
  runJobs: Record<string, JobDetail[]>;
  files: Record<string, string>;
}

export async function readLifecycle(
  gh: Gh,
  cache: DetailCache,
  state: LifecycleState,
  now: Date,
): Promise<Record<LifecycleKind, LifecycleRun[]>> {
  const since = new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const kinds = Object.keys(LIFECYCLE_WORKFLOWS) as LifecycleKind[];
  const out = {} as Record<LifecycleKind, LifecycleRun[]>;
  await pool(kinds, 2, async (kind) => {
    const list = await runs(
      gh,
      `repos/${STACK_REPO}/actions/workflows/${LIFECYCLE_WORKFLOWS[kind]}/runs?per_page=60&created=${encodeURIComponent(`>=${since}`)}`,
    );
    const withJobs = kind === "refresh" || kind === "upgrade";
    out[kind] = await pool(list, 3, async (run): Promise<LifecycleRun> => {
      const entry: LifecycleRun = { ...run, kind };
      if (!withJobs) return entry;
      const key = String(run.id);
      const known = state.runJobs[key];
      const settled =
        run.status === "completed" &&
        known?.every((j) => j.status === "completed" && timed(j)) === true;
      try {
        entry.jobs = settled ? known : await readRunJobs(gh, cache, STACK_REPO, run);
        if (run.status === "completed") state.runJobs[key] = entry.jobs;
      } catch {
        entry.jobs = known;
      }
      entry.target = await targetOf(gh, run, state.files);
      return entry;
    });
  });
  return out;
}

// The in-flight poll: refresh only the running lifecycle run's jobs.
export async function pollRun(
  gh: Gh,
  cache: DetailCache,
  run: LifecycleRun,
): Promise<LifecycleRun> {
  const fresh = toRun(
    await gh.rest<RawRun>(
      `repos/${STACK_REPO}/actions/runs/${run.id}`,
      "{id, name, path, event, status, conclusion, created_at, updated_at, head_branch, head_sha, display_title, html_url, run_attempt}",
    ),
  );
  const jobs = await readRunJobs(gh, cache, STACK_REPO, fresh);
  return { ...run, ...fresh, jobs };
}
