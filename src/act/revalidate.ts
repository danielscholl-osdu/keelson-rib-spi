// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  CASCADE_WORKFLOW,
  FLEET_RELEASE_WORKFLOW,
  LIFECYCLE_WORKFLOWS,
  STACK_REPO,
  SYNC_TEMPLATE_WORKFLOW,
  SYNC_UPSTREAM_WORKFLOW,
  TEMPLATE_REPO,
} from "../config.ts";
import type { Gh } from "../forge.ts";
import { short } from "../util.ts";
import type { Target } from "./verbs.ts";

export interface Seen {
  sha?: string;
  state?: string;
  // The newest cascade run, for a cascade dispatch.
  run?: number;
}

// The state a target is in on GitHub now, in the same terms the board stamps.
export async function readTarget(gh: Gh, t: Target): Promise<Seen> {
  if (t.kind === "workflow" && t.workflow === SYNC_UPSTREAM_WORKFLOW)
    return readSyncUpstream(gh, t);
  if (t.kind === "workflow" && t.workflow === CASCADE_WORKFLOW) {
    const runs = await gh.rest<{ id: number; status: string }[]>(
      `repos/${t.repo}/actions/workflows/${CASCADE_WORKFLOW}/runs?per_page=5`,
      "[.workflow_runs[] | {id, status}]",
    );
    return {
      state: runs.some((r) => r.status !== "completed") ? "running" : "idle",
      ...(runs[0] ? { run: runs[0].id } : {}),
    };
  }
  if (t.kind === "workflow") {
    // The stack's lifecycle workflows share concurrency group env-shared, so either one busy counts.
    const files =
      t.repo === STACK_REPO
        ? [LIFECYCLE_WORKFLOWS.refresh, LIFECYCLE_WORKFLOWS.upgrade]
        : t.repo === TEMPLATE_REPO
          ? [FLEET_RELEASE_WORKFLOW]
          : [SYNC_TEMPLATE_WORKFLOW];
    const statuses = await Promise.all(
      files.map((file) =>
        gh.rest<string[]>(
          `repos/${t.repo}/actions/workflows/${file}/runs?per_page=5`,
          "[.workflow_runs[].status]",
        ),
      ),
    );
    const state = statuses.flat().some((st) => st !== "completed") ? "running" : "idle";
    // A workflow target's sha is the osdu-spi main it was drawn for.
    if (!t.sha) return { state };
    const main = await gh.rest<{ sha: string }>(
      `repos/${TEMPLATE_REPO}/commits/main`,
      "{sha: .sha}",
    );
    return { state, sha: main.sha };
  }
  if (t.kind === "repo" || t.number === undefined) return {};
  if (t.kind === "pr") {
    const pr = await gh.rest<{ state: string; merged: boolean; sha: string }>(
      `repos/${t.repo}/pulls/${t.number}`,
      "{state: .state, merged: .merged, sha: .head.sha}",
    );
    return { sha: pr.sha, state: pr.merged ? "merged" : pr.state };
  }
  if (t.kind === "run") {
    const run = await gh.rest<{ status: string; conclusion: string | null; sha: string }>(
      `repos/${t.repo}/actions/runs/${t.number}`,
      "{status: .status, conclusion: .conclusion, sha: .head_sha}",
    );
    const state = runState(run.status, run.conclusion);
    if (t.pr === undefined) return { sha: run.sha, state };
    const pr = await readTarget(gh, { ...t, kind: "pr", number: t.pr, pr: undefined });
    return { sha: pr.sha, state: pr.state === "open" ? state : `PR #${t.pr} ${pr.state}` };
  }
  const issue = await gh.rest<{ state: string }>(
    `repos/${t.repo}/issues/${t.number}`,
    "{state: .state}",
  );
  return { state: issue.state };
}

// A Sync Upstream dispatch is stale once a run is in flight or a sync PR is already open.
async function readSyncUpstream(gh: Gh, t: Target): Promise<Seen> {
  const [statuses, heads] = await Promise.all([
    gh.rest<string[]>(
      `repos/${t.repo}/actions/workflows/${SYNC_UPSTREAM_WORKFLOW}/runs?per_page=5`,
      "[.workflow_runs[].status]",
    ),
    gh.rest<string[]>(
      `repos/${t.repo}/pulls?state=open&base=fork_upstream&per_page=20`,
      "[.[].head.ref]",
    ),
  ]);
  if (statuses.some((st) => st !== "completed")) return { state: "running" };
  if (heads.some((h) => h.startsWith("sync/upstream-"))) return { state: "prepared" };
  return { state: "idle" };
}

export function runState(status: string, conclusion: string | null | undefined): string {
  return status === "completed" ? (conclusion ?? "completed") : status;
}

// Why a target no longer matches what was drawn, or undefined when it still does.
export function changed(t: Target, now: Seen): string | undefined {
  if (t.sha && now.sha && t.sha !== now.sha) {
    const what = t.kind === "workflow" ? "osdu-spi main" : "head";
    return `${what} moved ${short(t.sha)} → ${short(now.sha)}`;
  }
  if (t.state && now.state && t.state !== now.state) return `now ${now.state}, was ${t.state}`;
  if (t.workflow === CASCADE_WORKFLOW && now.run !== undefined && now.run !== t.number) {
    return `cascade run ${now.run} ran after the board drew`;
  }
  return undefined;
}
