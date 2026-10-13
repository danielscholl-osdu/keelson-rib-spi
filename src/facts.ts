// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { LifecycleKind } from "./config.ts";

// What the sweep read, before any judgment. The model module turns these into
// lines, incidents and the queue; nothing here is derived.

export interface CheckFact {
  id: number;
  name: string;
  workflow?: string;
  runId?: number;
  status: string;
  conclusion?: string;
  startedAt?: string;
  completedAt?: string;
  url?: string;
}

export interface PrFact {
  repo: string;
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  head: string;
  base: string;
  headSha: string;
  // The template marker at the PR head: where a template-sync PR takes the fork.
  headMarker?: string;
  mergeState?: string;
  reviewDecision?: string;
  author?: string;
  labels: string[];
  checks: CheckFact[];
}

export interface IssueFact {
  repo: string;
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  comments: number;
  halt?: string;
}

// A merged or closed PR, for the 21-day history of each line's gates.
export interface PastPrFact {
  number: number;
  title: string;
  url: string;
  head: string;
  base: string;
  createdAt: string;
  mergedAt?: string;
  closedAt?: string;
}

export interface PastIssueFact {
  number: number;
  url: string;
  createdAt: string;
  closedAt?: string;
  labels: string[];
}

export interface ReleaseFact {
  tag: string;
  at: string;
  url: string;
}

export interface DeploymentFact {
  createdAt: string;
  ref?: string;
  sha?: string;
  state?: string;
  statusAt?: string;
}

export interface Declaration {
  stackVersion?: string;
  location?: string;
  profile?: string;
  forks: string[];
}

export interface RepoFact {
  repo: string;
  url: string;
  autoMergeAllowed?: boolean;
  head?: { sha: string; at: string };
  release?: { tag: string; at: string; url: string };
  marker?: string;
  upstreamSha?: { sha: string; at: string };
  declaration?: Declaration;
  prs: PrFact[];
  issues: IssueFact[];
  deployments: DeploymentFact[];
  pastPrs?: PastPrFact[];
  pastIssues?: PastIssueFact[];
  releases?: ReleaseFact[];
  // Cron expressions per lifecycle workflow, read from the workflow files on main.
  schedules?: Partial<Record<LifecycleKind, string[]>>;
}

export interface GithubFacts {
  repos: Record<string, RepoFact>;
  planned: Record<string, boolean>;
  rate?: { remaining: number; resetAt: string };
}

export interface RunFact {
  id: number;
  name: string;
  path: string;
  event: string;
  status: string;
  conclusion?: string;
  createdAt: string;
  updatedAt: string;
  branch?: string;
  sha: string;
  title: string;
  url: string;
  attempt: number;
}

export interface StepFact {
  number: number;
  name: string;
  status: string;
  conclusion?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface JobDetail {
  id: number;
  name: string;
  status: string;
  conclusion?: string;
  startedAt?: string;
  completedAt?: string;
  url: string;
  steps: StepFact[];
  failedStep?: string;
  reason?: string;
}

// The fork workflows the sweep follows per repository.
export interface ForkRuns {
  sync: RunFact[];
  template: RunFact[];
  cascade: RunFact[];
  main: RunFact[];
  mainJobs?: JobDetail[];
}

export interface LifecycleRun extends RunFact {
  kind: LifecycleKind;
  jobs?: JobDetail[];
  target?: string;
}

export interface UpstreamFact {
  service: string;
  head?: { sha: string; at: string; url: string };
  synced?: string;
  lag?: number;
  commits: { sha: string; title: string; at: string; url: string }[];
}

export interface TemplateChange {
  sha: string;
  parent?: string;
  title: string;
  pr?: number;
  url: string;
  at: string;
}

export interface TemplateCompare {
  marker: string;
  head: string;
  label: string;
  aheadBy: number;
  shas: string[];
  changes: TemplateChange[];
}

// The template paths .github/sync-config.json copies into every fork.
export interface SyncedPaths {
  dirs: string[];
  files: string[];
}

export interface TemplateFacts {
  latestTag?: string;
  mainAhead?: number;
  compares: Record<string, TemplateCompare>;
  targets?: Record<string, string>;
  synced?: SyncedPaths;
  files?: Record<string, string[]>;
}

export interface AuthFacts {
  gh: { ok: boolean; detail: string };
  glab: { ok: boolean; detail: string };
}

// One area of the last sweep: the last good data, and the newest failure when
// the latest read did not succeed. A failed read never erases good data.
export interface Measured<T> {
  at?: string;
  data?: T;
  error?: string;
  errorAt?: string;
}

export interface Facts {
  github: Measured<GithubFacts>;
  runs: Measured<Record<string, ForkRuns>>;
  approvals: Measured<Record<string, RunFact[]>>;
  lifecycle: Measured<Record<LifecycleKind, LifecycleRun[]>>;
  details: Measured<Record<string, JobDetail>>;
  upstream: Measured<Record<string, UpstreamFact>>;
  template: Measured<TemplateFacts>;
  auth: Measured<AuthFacts>;
  sweep?: { at: string; ms: number; calls: number; errors: number };
}

export const AREAS = [
  "github",
  "runs",
  "approvals",
  "lifecycle",
  "details",
  "upstream",
  "template",
  "auth",
] as const;
export type AreaName = (typeof AREAS)[number];

export function emptyFacts(): Facts {
  return {
    github: {},
    runs: {},
    approvals: {},
    lifecycle: {},
    details: {},
    upstream: {},
    template: {},
    auth: {},
  };
}
