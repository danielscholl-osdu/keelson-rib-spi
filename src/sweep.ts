// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibExec } from "@keelson/shared";
import { z } from "@keelson/shared";
import { readGithub } from "./collect/github.ts";
import {
  DetailCache,
  type LifecycleState,
  type PrFilesCache,
  pollRun,
  readApprovals,
  readForkRuns,
  readJob,
  readLifecycle,
  readRunJobs,
  readTemplateRuns,
} from "./collect/runs.ts";
import { readTemplate, type TemplateState } from "./collect/template.ts";
import { readUpstream, type UpstreamCompares } from "./collect/upstream.ts";
import { FORKS, GITLAB_EVERY_MS, type LifecycleKind, REPOS } from "./config.ts";
import {
  AREAS,
  type AreaName,
  emptyFacts,
  type Facts,
  type ForkRuns,
  type JobDetail,
  type LifecycleRun,
  type RepoFact,
} from "./facts.ts";
import { type CallCounter, Gh, Glab } from "./forge.ts";
import { failedChecks } from "./model/checks.ts";
import { buildModel, type Model } from "./model/index.ts";
import type { Store } from "./store.ts";
import { errorText, pool } from "./util.ts";

const FACTS_FILE = "facts.json";
// GitHub stamps a dispatched run a little before or after the call returns.
const DISPATCH_SKEW_MS = 30_000;
const DISPATCH_WAIT_MS = 3 * 60_000;
const CACHE_FILE = "cache.json";

const measuredSchema = z.object({
  at: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  errorAt: z.string().optional(),
});
const factsFileSchema = z
  .object(
    Object.fromEntries(AREAS.map((a) => [a, measuredSchema.optional()])) as Record<
      AreaName,
      z.ZodOptional<typeof measuredSchema>
    >,
  )
  .extend({
    sweep: z
      .object({ at: z.string(), ms: z.number(), calls: z.number(), errors: z.number() })
      .optional(),
  });

interface CacheFile {
  details: Record<string, JobDetail>;
  lifecycle: LifecycleState;
  template: TemplateState;
  upstream: UpstreamCompares;
  approvals: PrFilesCache;
}

const cacheFileSchema = z.object({
  details: z.record(z.string(), z.unknown()),
  lifecycle: z.object({
    runJobs: z.record(z.string(), z.unknown()),
    files: z.record(z.string(), z.string()),
  }),
  template: z.object({
    compares: z.record(z.string(), z.unknown()),
    labels: z.record(z.string(), z.string()),
    aheads: z.record(z.string(), z.number()),
    files: z.record(z.string(), z.array(z.string())).optional(),
    synced: z
      .object({
        head: z.string(),
        paths: z.object({ dirs: z.array(z.string()), files: z.array(z.string()) }),
      })
      .optional(),
    tags: z.object({ latest: z.string(), list: z.array(z.string()) }).optional(),
  }),
  upstream: z.record(z.string(), z.unknown()),
  approvals: z.record(z.string(), z.unknown()).optional(),
});

// What the stack strip draws from a run: its status and each job's and step's state.
function progress(run: LifecycleRun): string {
  return JSON.stringify([
    run.status,
    run.conclusion,
    (run.jobs ?? []).map((j) => [
      j.status,
      j.conclusion,
      j.steps.map((s) => [s.status, s.conclusion]),
    ]),
  ]);
}

function emptyCache(): CacheFile {
  return {
    details: {},
    lifecycle: { runJobs: {}, files: {} },
    template: { compares: {}, labels: {}, aheads: {} },
    upstream: {},
    approvals: {},
  };
}

export interface SweeperOptions {
  exec: RibExec;
  store: Store;
  onChange: () => void;
  now?: () => Date;
}

// One in-process sweep feeds every region and tool, so they all count the same
// facts. A failed area keeps its last good data and records the error beside it.
export class Sweeper {
  facts: Facts;
  model: Model;
  readonly now: () => Date;
  private readonly cache: CacheFile;
  private readonly detailCache: DetailCache;
  private running: Promise<void> | undefined;
  private gitlabAt = 0;
  // Sync Template dispatches this rib made, by fork, until a run for each appears.
  // Kept in memory only, so a restart drops the wait.
  private dispatched: Record<string, string> = {};

  constructor(private readonly opts: SweeperOptions) {
    this.now = opts.now ?? (() => new Date());
    const stored = opts.store.read(FACTS_FILE, factsFileSchema);
    this.facts = { ...emptyFacts(), ...(stored as Partial<Facts> | undefined) };
    const cache = opts.store.read(CACHE_FILE, cacheFileSchema) as Partial<CacheFile> | undefined;
    this.cache = cache ? { ...emptyCache(), ...cache } : emptyCache();
    this.detailCache = new DetailCache(this.cache.details);
    const upstreamAt = this.facts.upstream.at ? Date.parse(this.facts.upstream.at) : 0;
    this.gitlabAt = Number.isFinite(upstreamAt) ? upstreamAt : 0;
    this.model = buildModel(this.facts, this.now());
  }

  get sweeping(): boolean {
    return this.running !== undefined;
  }

  sweep(opts: { force?: boolean } = {}): Promise<void> {
    if (!this.running) {
      this.running = this.run(opts.force ?? false).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  hasInflight(): boolean {
    const lc = this.facts.lifecycle.data;
    const stack =
      !!lc && [...(lc.refresh ?? []), ...(lc.upgrade ?? [])].some((r) => r.status !== "completed");
    return stack || this.syncingForks().length > 0;
  }

  expectTemplateRuns(repos: readonly string[], at: string): void {
    for (const repo of repos) this.dispatched[repo] = at;
    this.rebuild();
  }

  // A dispatch is answered by a run created after it; one that never shows stops waiting.
  private pendingDispatch(repo: string): string | undefined {
    const at = this.dispatched[repo];
    if (!at) return undefined;
    const since = Date.parse(at);
    const runs = this.facts.runs.data?.[repo]?.template ?? [];
    if (
      runs.some((r) => Date.parse(r.createdAt) >= since - DISPATCH_SKEW_MS) ||
      this.now().getTime() - since > DISPATCH_WAIT_MS
    ) {
      delete this.dispatched[repo];
      return undefined;
    }
    return at;
  }

  private syncingForks(): string[] {
    const runs = this.facts.runs.data ?? {};
    return FORKS.map((f) => f.repo).filter(
      (repo) =>
        !!this.pendingDispatch(repo) ||
        (runs[repo]?.template ?? []).some((r) => r.status !== "completed"),
    );
  }

  // Between sweeps, a running refresh or upgrade is re-read on its own so the
  // stack strip follows it; when it settles, a full sweep picks up the effects.
  async pollInflight(): Promise<void> {
    if (this.running) return;
    const lc = this.facts.lifecycle.data;
    const gh = new Gh(this.opts.exec);
    let settled = false;
    let changed = false;
    // A Sync Template run moves its fork's PR when it ends, so a settled one asks for a sweep.
    const forkRuns = this.facts.runs.data;
    for (const repo of this.syncingForks()) {
      const entry = forkRuns?.[repo];
      if (!entry) continue;
      try {
        const fresh = await readTemplateRuns(gh, repo);
        const before = entry.template.map((r) => `${r.id}:${r.status}`).join();
        entry.template = fresh;
        if (fresh.map((r) => `${r.id}:${r.status}`).join() !== before) changed = true;
        if (!this.syncingForks().includes(repo)) settled = true;
      } catch {
        // The next full sweep retries.
      }
    }
    for (const kind of ["refresh", "upgrade"] as LifecycleKind[]) {
      if (!lc) break;
      const runs = lc[kind] ?? [];
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        if (!run || run.status === "completed") continue;
        try {
          const fresh = await pollRun(gh, this.detailCache, run);
          if (progress(fresh) !== progress(run)) changed = true;
          runs[i] = fresh;
          if (fresh.status === "completed") settled = true;
        } catch {
          // The next full sweep retries.
        }
      }
    }
    if (changed) this.rebuild();
    if (settled) await this.sweep({ force: false });
  }

  private async area<T>(name: AreaName, read: () => Promise<T>): Promise<boolean> {
    try {
      const data = await read();
      (this.facts as unknown as Record<AreaName, unknown>)[name] = {
        at: this.now().toISOString(),
        data,
      };
      return true;
    } catch (err) {
      const prev = this.facts[name];
      (this.facts as unknown as Record<AreaName, unknown>)[name] = {
        ...prev,
        error: errorText(err),
        errorAt: this.now().toISOString(),
      };
      return false;
    }
  }

  private async run(force: boolean): Promise<void> {
    const started = this.now();
    const counter: CallCounter = { calls: 0 };
    const gh = new Gh(this.opts.exec, counter);
    const glab = new Glab(this.opts.exec, counter);

    await this.area("auth", async () => {
      const [ghStatus, glabStatus] = await Promise.all([gh.status(), glab.status()]);
      return { gh: ghStatus, glab: glabStatus };
    });
    await this.area("github", () => readGithub(gh));
    const repos = this.facts.github.data?.repos ?? {};
    await Promise.all([
      this.area("runs", () => this.readRuns(gh)),
      this.area("approvals", () => readApprovals(gh, this.cache.approvals)),
      this.area("lifecycle", () =>
        readLifecycle(gh, this.detailCache, this.cache.lifecycle, started),
      ),
      this.area("template", () => readTemplate(gh, repos, this.cache.template)),
      this.area("details", () => this.readDetails(gh, repos)),
    ]);
    const gitlabDue =
      force || !this.facts.upstream.data || started.getTime() - this.gitlabAt >= GITLAB_EVERY_MS;
    if (gitlabDue) {
      const ok = await this.area("upstream", () => readUpstream(glab, repos, this.cache.upstream));
      if (ok) this.gitlabAt = started.getTime();
    }
    this.facts.sweep = {
      at: started.toISOString(),
      ms: this.now().getTime() - started.getTime(),
      calls: counter.calls,
      errors: AREAS.filter((a) => {
        const errorAt = this.facts[a].errorAt;
        return !!errorAt && Date.parse(errorAt) >= started.getTime();
      }).length,
    };
    this.prune();
    this.persist();
    this.rebuild();
  }

  private async readRuns(gh: Gh): Promise<Record<string, ForkRuns>> {
    const runs = await readForkRuns(gh);
    await pool(FORKS, 3, async (fork) => {
      const entry = runs[fork.repo];
      const last = entry?.main.find((r) => r.status === "completed");
      if (!entry || !last || last.conclusion === "success") return;
      const key = String(last.id);
      const known = this.cache.lifecycle.runJobs[key];
      try {
        entry.mainJobs = known ?? (await readRunJobs(gh, this.detailCache, fork.repo, last));
        this.cache.lifecycle.runJobs[key] = entry.mainJobs;
      } catch {
        entry.mainJobs = known;
      }
    });
    return runs;
  }

  // Only the failed checks on open PRs are read in detail: their failed step
  // and reason decide the failure class.
  private async readDetails(
    gh: Gh,
    repos: Record<string, RepoFact>,
  ): Promise<Record<string, JobDetail>> {
    const wanted: { repo: string; id: number; name: string }[] = [];
    for (const repo of REPOS) {
      for (const pr of repos[repo]?.prs ?? []) {
        for (const c of failedChecks(pr)) {
          if (c.workflow && c.name !== "Validation Summary")
            wanted.push({ repo, id: c.id, name: c.name });
        }
      }
    }
    const out: Record<string, JobDetail> = {};
    let failures = 0;
    await pool(wanted, 4, async (w) => {
      try {
        out[`${w.repo}#${w.id}`] = await readJob(gh, this.detailCache, w.repo, w.id, w.name);
      } catch {
        failures++;
      }
    });
    if (failures > 0 && failures === wanted.length)
      throw new Error(`no failed job could be read (${failures})`);
    return out;
  }

  private prune(): void {
    const keep = new Set<string>(Object.keys(this.facts.details.data ?? {}));
    const lc = this.facts.lifecycle.data;
    const liveRuns = new Set<string>();
    for (const runs of Object.values(lc ?? {})) {
      for (const run of runs ?? []) {
        liveRuns.add(String(run.id));
        for (const j of run.jobs ?? []) keep.add(`Azure/osdu-spi-stack#${j.id}`);
      }
    }
    for (const entry of Object.values(this.facts.runs.data ?? {})) {
      const last = entry.main.find((r) => r.status === "completed");
      if (last) liveRuns.add(String(last.id));
    }
    for (const key of Object.keys(this.cache.lifecycle.runJobs)) {
      if (!liveRuns.has(key)) delete this.cache.lifecycle.runJobs[key];
    }
    for (const [repo, entry] of Object.entries(this.facts.runs.data ?? {})) {
      for (const j of entry.mainJobs ?? []) keep.add(`${repo}#${j.id}`);
    }
    this.detailCache.prune(keep);
    this.cache.details = this.detailCache.snapshot();
    const compares = Object.keys(this.cache.template.compares);
    if (compares.length > 40) {
      for (const key of compares.slice(0, compares.length - 40))
        delete this.cache.template.compares[key];
    }
    const waiting = new Set<string>();
    for (const [repo, runs] of Object.entries(this.facts.approvals.data ?? {})) {
      for (const r of runs) if (r.pr) waiting.add(`${repo}#${r.pr.number}@${r.pr.headSha}`);
    }
    for (const key of Object.keys(this.cache.approvals)) {
      if (!waiting.has(key)) delete this.cache.approvals[key];
    }
    const upstream = Object.keys(this.cache.upstream);
    if (upstream.length > 40) {
      for (const key of upstream.slice(0, upstream.length - 40)) delete this.cache.upstream[key];
    }
  }

  private persist(): void {
    try {
      this.opts.store.write(FACTS_FILE, this.facts);
      this.opts.store.write(CACHE_FILE, this.cache);
    } catch {
      // A read-only data dir keeps the rib working from memory.
    }
  }

  rebuild(): void {
    const dispatched: Record<string, string> = {};
    for (const repo of Object.keys(this.dispatched)) {
      const at = this.pendingDispatch(repo);
      if (at) dispatched[repo] = at;
    }
    this.model = buildModel(this.facts, this.now(), { dispatched });
    this.opts.onChange();
  }
}
