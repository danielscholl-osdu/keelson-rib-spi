// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { FORKS } from "../config.ts";
import type { DiffFact, MrFact, RadarFacts, UpstreamFact } from "../facts.ts";
import { encodeProject, type Gh, type Glab } from "../forge.ts";
import { parseFilter } from "../model/filter.ts";
import { forkOwned } from "../model/radar.ts";
import { pool } from "../util.ts";
import { readFilterFile } from "./filters.ts";
import {
  emptyLedgerState,
  type LedgerState,
  readForkPins,
  readLatest,
  readMerged,
  readPortPrs,
  readRemoval,
  readUpstreamPins,
} from "./ledgers.ts";

interface RawMr {
  iid: number;
  title: string;
  author?: { username?: string };
  draft?: boolean;
  work_in_progress?: boolean;
  labels?: string[];
  created_at: string;
  updated_at: string;
  sha: string;
  web_url: string;
  head_pipeline?: { status?: string } | null;
}

interface RawDiff {
  old_path: string;
  new_path: string;
  diff?: string;
  deleted_file?: boolean;
}

export interface DiffEntry {
  paths: string[];
  hunks?: Record<string, string[]>;
  // Paths the change deletes; absent on entries cached before deletions were recorded.
  deleted?: string[];
}

export interface RadarState {
  mrDiffs: Record<string, DiffEntry>;
  commitDiffs: Record<string, DiffEntry>;
  filters: Record<string, string>;
  ledgers: LedgerState;
}

export function emptyRadarState(): RadarState {
  return { mrDiffs: {}, commitDiffs: {}, filters: {}, ledgers: emptyLedgerState() };
}

const HUNK_FILES = /(^|\/)(pom\.xml|\.fossa\.yml)$/;

export function diffEntry(diffs: readonly RawDiff[]): DiffEntry {
  const paths = new Set<string>();
  const deleted: string[] = [];
  const hunks: Record<string, string[]> = {};
  for (const d of diffs) {
    if (d.deleted_file) deleted.push(d.old_path);
    paths.add(d.new_path);
    if (d.old_path !== d.new_path) paths.add(d.old_path);
    if (!HUNK_FILES.test(d.new_path)) continue;
    const lines = (d.diff ?? "")
      .split("\n")
      .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
    if (lines.length > 0) hunks[d.new_path] = lines;
  }
  return { paths: [...paths], ...(Object.keys(hunks).length > 0 ? { hunks } : {}), deleted };
}

export function mrKey(project: string, iid: number, sha: string): string {
  return `${project}!${iid}@${sha}`;
}

async function cachedDiff(
  cache: Record<string, DiffEntry>,
  key: string,
  read: () => Promise<RawDiff[]>,
): Promise<DiffEntry | undefined> {
  const known = cache[key];
  if (known) return known;
  try {
    const entry = diffEntry(await read());
    cache[key] = entry;
    return entry;
  } catch {
    return undefined;
  }
}

function withDiff<T extends object>(fact: T, entry: DiffEntry | undefined): T {
  if (!entry) return fact;
  return { ...fact, paths: entry.paths, ...(entry.hunks ? { hunks: entry.hunks } : {}) };
}

export async function readRadar(
  gh: Gh,
  glab: Glab,
  upstream: Record<string, UpstreamFact>,
  state: RadarState,
): Promise<RadarFacts> {
  const out: RadarFacts = { services: {}, filters: {} };
  const merged = await readMerged(glab, state.ledgers);
  const ports = await readPortPrs(gh, state.ledgers);
  out.portRead = ports.read;
  await pool(FORKS, 3, async (fork) => {
    const project = encodeProject(fork.upstream);
    const raw = await glab.restAll<RawMr>(
      `projects/${project}/merge_requests?state=opened&target_branch=master`,
    );
    const mrs = await pool(raw, 3, async (m): Promise<MrFact> => {
      const fact: MrFact = {
        iid: m.iid,
        title: m.title,
        author: m.author?.username ?? "",
        draft: m.draft ?? m.work_in_progress ?? false,
        labels: m.labels ?? [],
        createdAt: m.created_at,
        updatedAt: m.updated_at,
        headSha: m.sha,
        url: m.web_url,
        ...(m.head_pipeline?.status ? { pipeline: m.head_pipeline.status } : {}),
      };
      const entry = await cachedDiff(state.mrDiffs, mrKey(fork.upstream, m.iid, m.sha), () =>
        glab.restAll<RawDiff>(`projects/${project}/merge_requests/${m.iid}/diffs`),
      );
      return withDiff(fact, entry);
    });
    const queued = await pool(
      upstream[fork.id]?.commits ?? [],
      3,
      async (c): Promise<DiffFact> =>
        withDiff(
          { sha: c.sha, title: c.title, at: c.at, url: c.url },
          await cachedDiff(state.commitDiffs, c.sha, () =>
            glab.restAll<RawDiff>(`projects/${project}/repository/commits/${c.sha}/diff`),
          ),
        ),
    );
    const list = merged[fork.id];
    const landed = list
      ? await pool(list, 3, async (m) => {
          const key = mrKey(fork.upstream, m.iid, m.headSha);
          if (state.mrDiffs[key] && !state.mrDiffs[key].deleted) delete state.mrDiffs[key];
          const entry = await cachedDiff(state.mrDiffs, key, () =>
            glab.restAll<RawDiff>(`projects/${project}/merge_requests/${m.iid}/diffs`),
          );
          return entry ? { ...m, paths: entry.paths, deleted: entry.deleted ?? [] } : m;
        })
      : undefined;
    const forkPrs = ports.prs[fork.id];
    const upstreamPins = await readUpstreamPins(
      glab,
      fork.upstream,
      upstream[fork.id]?.head?.sha,
      state.ledgers,
    );
    out.services[fork.id] = {
      project: fork.upstream,
      mrs,
      queued,
      ...(landed ? { merged: landed } : {}),
      ...(forkPrs ? { forkPrs } : {}),
      ...(upstreamPins ? { pins: { upstream: upstreamPins } } : {}),
    };
    try {
      const file = await readFilterFile(gh, fork.repo);
      state.filters[file.sha] = file.text;
      out.filters[fork.id] = file;
    } catch {
      // A fork whose filter cannot be read stays unread; the others still count.
    }
  });
  const azure = (text: string | undefined) =>
    text ? forkOwned(parseFilter(text)).find((p) => p.startsWith("provider/")) : undefined;
  const pins = await readForkPins(
    gh,
    FORKS.map((f) => {
      const tree = azure(out.filters[f.id]?.text);
      return { id: f.id, repo: f.repo, ...(tree ? { azure: tree } : {}) };
    }),
    state.ledgers,
  );
  for (const [id, p] of Object.entries(pins)) {
    const svc = out.services[id];
    if (!svc || !p.root) continue;
    const fork = {
      ...(p.root ?? {}),
      ...(p.azure?.coreLibAzure ? { coreLibAzure: p.azure.coreLibAzure } : {}),
    };
    svc.pins = { ...(svc.pins ?? {}), fork };
  }
  out.latest = await readLatest(glab, state.ledgers, Date.now());
  const removal = await readRemoval(glab, state.ledgers, Date.now());
  if (removal) out.removal = removal;
  return out;
}

// Diffs a current MR or queued commit points at stay; the rest keep the newest up to the cap.
export function pruneRadar(state: RadarState, facts: RadarFacts | undefined, cap = 200): void {
  const mrs = new Set<string>();
  const commits = new Set<string>();
  const blobs = new Set<string>();
  for (const svc of Object.values(facts?.services ?? {})) {
    for (const m of svc.mrs) mrs.add(mrKey(svc.project, m.iid, m.headSha));
    for (const c of svc.queued) commits.add(c.sha);
    for (const m of svc.merged ?? []) mrs.add(mrKey(svc.project, m.iid, m.headSha));
  }
  for (const f of Object.values(facts?.filters ?? {})) blobs.add(f.sha);
  capMap(state.mrDiffs, mrs, cap);
  capMap(state.commitDiffs, commits, cap);
  for (const key of Object.keys(state.filters)) if (!blobs.has(key)) delete state.filters[key];
  capMap(state.ledgers.poms, new Set(), 60);
  capMap(state.ledgers.upstreamPoms, new Set(), 60);
}

function capMap(map: Record<string, unknown>, keep: ReadonlySet<string>, cap: number): void {
  const keys = Object.keys(map);
  let over = keys.length - cap;
  for (const key of keys) {
    if (over <= 0) break;
    if (keep.has(key)) continue;
    delete map[key];
    over--;
  }
}
