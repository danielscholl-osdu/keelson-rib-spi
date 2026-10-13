// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { SYNC_TEMPLATE_WORKFLOW } from "../config.ts";
import type { Gh } from "../forge.ts";
import { short } from "../util.ts";
import type { Target } from "./verbs.ts";

export interface Seen {
  sha?: string;
  state?: string;
}

// The state a target is in on GitHub now, in the same terms the board stamps.
export async function readTarget(gh: Gh, t: Target): Promise<Seen> {
  if (t.kind === "workflow") {
    const statuses = await gh.rest<string[]>(
      `repos/${t.repo}/actions/workflows/${SYNC_TEMPLATE_WORKFLOW}/runs?per_page=5`,
      "[.workflow_runs[].status]",
    );
    return { state: statuses.some((st) => st !== "completed") ? "running" : "idle" };
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

export function runState(status: string, conclusion: string | null | undefined): string {
  return status === "completed" ? (conclusion ?? "completed") : status;
}

// Why a target no longer matches what was drawn, or undefined when it still does.
export function changed(t: Target, now: Seen): string | undefined {
  if (t.sha && now.sha && t.sha !== now.sha) {
    return `head moved ${short(t.sha)} → ${short(now.sha)}`;
  }
  if (t.state && now.state && t.state !== now.state) return `now ${now.state}, was ${t.state}`;
  return undefined;
}
