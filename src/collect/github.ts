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
  LANE_ENVIRONMENT,
  LIFECYCLE_WORKFLOWS,
  type LifecycleKind,
  MARKER_PATH,
  PLANNED,
  plannedRepo,
  STACK_REPO,
  SYNC_TEMPLATE_WORKFLOW,
  TEMPLATE_REPO,
} from "../config.ts";
import type {
  CheckFact,
  Declaration,
  DeploymentFact,
  GithubFacts,
  IssueFact,
  PastIssueFact,
  PastPrFact,
  PrFact,
  ReleaseFact,
  RepoFact,
} from "../facts.ts";
import type { Gh } from "../forge.ts";

// One aliased GraphQL query reads open PRs with their checks, open issues,
// release, markers, the lane ledger and 21 days of gate history for every
// repository at once.

const PULLS = `pullRequests(states: OPEN, first: 40, orderBy: {field: CREATED_AT, direction: DESC}) { nodes {
  number title url createdAt updatedAt isDraft headRefName baseRefName headRefOid mergeStateStatus reviewDecision
  author { login }
  headRef { target { ... on Commit { file(path: "${MARKER_PATH}") { object { ... on Blob { text } } } } } }
  labels(first: 15) { nodes { name } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 80) { nodes {
    __typename
    ... on CheckRun { databaseId name status conclusion startedAt completedAt detailsUrl checkSuite { workflowRun { databaseId workflow { name } } } }
  } } } } } }
} }`;

const ISSUES = `issues(states: OPEN, first: 50, orderBy: {field: CREATED_AT, direction: DESC}) { nodes {
  number title url createdAt updatedAt labels(first: 15) { nodes { name } } comments { totalCount } body
} }`;

const PAST_PULLS = `pastPrs: pullRequests(states: [MERGED, CLOSED], first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes {
  number title url createdAt mergedAt closedAt headRefName baseRefName author { login }
} }`;

const HALT_LABELS = ["sync-failed", "conflict", "cascade-blocked", "cascade-failed"];

const PAST_ISSUES = `pastIssues: issues(states: CLOSED, first: 30, labels: ${JSON.stringify(HALT_LABELS)}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes {
  number url createdAt closedAt labels(first: 15) { nodes { name } }
} }`;

const LIFECYCLE_KINDS = Object.keys(LIFECYCLE_WORKFLOWS) as LifecycleKind[];

const WORKFLOW_FILES = LIFECYCLE_KINDS.map(
  (k) =>
    `wf_${k}: object(expression: "main:.github/workflows/${LIFECYCLE_WORKFLOWS[k]}") { ... on Blob { text } }`,
).join("\n  ");

const FRAGMENTS = `
fragment Base on Repository {
  nameWithOwner url autoMergeAllowed
  defaultBranchRef { target { ... on Commit { oid committedDate } } }
  latestRelease { tagName publishedAt url }
  ${PULLS}
  ${ISSUES}
}
fragment Template on Repository {
  ${PAST_PULLS}
  releases(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { tagName publishedAt url isDraft } }
}
fragment Fork on Repository {
  syncTemplate: object(expression: "main:.github/workflows/${SYNC_TEMPLATE_WORKFLOW}") { ... on Blob { text } }
  marker: object(expression: "main:${MARKER_PATH}") { ... on Blob { text } }
  upstreamLog: ref(qualifiedName: "refs/heads/fork_upstream") { target { ... on Commit { history(first: 10) { nodes { oid message committedDate } } } } }
  deployments(environments: ["${LANE_ENVIRONMENT}"], first: 60, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { createdAt commitOid ref { name } latestStatus { state createdAt } } }
  ${PAST_PULLS}
  ${PAST_ISSUES}
}
fragment Stack on Repository {
  declaration: object(expression: "main:${DECLARATION_PATH}") { ... on Blob { text } }
  releases(first: 40, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { tagName publishedAt url isDraft } }
  ${WORKFLOW_FILES}
}`;

function repoField(alias: string, repo: string, spread: string): string {
  const [owner, name] = repo.split("/");
  return `${alias}: repository(owner: "${owner}", name: "${name}") { ${spread} }`;
}

// GitHub answers HTTP 502 once one query reads about a dozen forks.
export const FORKS_PER_QUERY = 5;

function query(fields: string[]): string {
  const body = fields.join("\n  ");
  const used = FRAGMENTS.split(/\n(?=fragment )/)
    .filter((f) => {
      const name = /^\s*fragment (\w+)/.exec(f)?.[1];
      return name && body.includes(`...${name}`);
    })
    .join("\n");
  return `query {\n  rateLimit { cost remaining resetAt }\n  ${body}\n}\n${used}`;
}

export function buildQueries(perQuery = FORKS_PER_QUERY): string[] {
  const forks = FORKS.map((f, i) => repoField(`r_fork${i}`, f.repo, "...Base ...Fork"));
  const queries = [
    query([
      repoField("r_template", TEMPLATE_REPO, "...Base ...Template"),
      repoField("r_stack", STACK_REPO, "...Base ...Stack"),
      ...PLANNED.map((p, i) => repoField(`p_${i}`, plannedRepo(p), "nameWithOwner")),
    ]),
  ];
  for (let i = 0; i < forks.length; i += perQuery)
    queries.push(query(forks.slice(i, i + perQuery)));
  return queries;
}

interface RateRead {
  cost?: number;
  remaining?: number;
  resetAt?: string;
}

// Each query reports its own cost and the budget left after it.
export function mergeReads(reads: Record<string, unknown>[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  let rate: RateRead | undefined;
  for (const data of reads) {
    const { rateLimit, ...rest } = data as { rateLimit?: RateRead };
    Object.assign(merged, rest);
    if (!rateLimit) continue;
    rate = {
      cost: (rate?.cost ?? 0) + (rateLimit.cost ?? 0),
      remaining:
        rate?.remaining === undefined
          ? rateLimit.remaining
          : Math.min(rate.remaining, rateLimit.remaining ?? rate.remaining),
      resetAt: rateLimit.resetAt ?? rate?.resetAt,
    };
  }
  if (rate) merged.rateLimit = rate;
  return merged;
}

interface RawCheck {
  __typename: string;
  databaseId?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  detailsUrl?: string | null;
  checkSuite?: { workflowRun?: { databaseId?: number; workflow?: { name?: string } } | null };
}

interface RawPr {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  author?: { login?: string } | null;
  headRef?: { target?: { file?: { object?: { text?: string } | null } | null } } | null;
  labels?: { nodes?: { name: string }[] };
  commits?: {
    nodes?: { commit?: { statusCheckRollup?: { contexts?: { nodes?: RawCheck[] } } | null } }[];
  };
}

interface RawIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  labels?: { nodes?: { name: string }[] };
  comments?: { totalCount?: number };
  body?: string | null;
}

interface RawRepo {
  nameWithOwner: string;
  url: string;
  autoMergeAllowed?: boolean;
  defaultBranchRef?: { target?: { oid?: string; committedDate?: string } } | null;
  latestRelease?: { tagName: string; publishedAt: string; url: string } | null;
  pullRequests?: { nodes?: RawPr[] };
  issues?: { nodes?: RawIssue[] };
  marker?: { text?: string } | null;
  upstreamLog?: {
    target?: { history?: { nodes?: { oid: string; message: string; committedDate: string }[] } };
  } | null;
  deployments?: {
    nodes?: {
      createdAt: string;
      commitOid?: string;
      ref?: { name?: string } | null;
      latestStatus?: { state?: string; createdAt?: string } | null;
    }[];
  };
  declaration?: { text?: string } | null;
  syncTemplate?: { text?: string } | null;
  pastPrs?: {
    nodes?: {
      number: number;
      title: string;
      url: string;
      createdAt: string;
      mergedAt?: string | null;
      closedAt?: string | null;
      headRefName: string;
      baseRefName: string;
      author?: { login?: string } | null;
    }[];
  };
  pastIssues?: {
    nodes?: {
      number: number;
      url: string;
      createdAt: string;
      closedAt?: string | null;
      labels?: { nodes?: { name: string }[] };
    }[];
  };
  releases?: {
    nodes?: { tagName: string; publishedAt?: string | null; url: string; isDraft?: boolean }[];
  };
  [workflow: `wf_${string}`]: { text?: string } | null | undefined;
}

function parseChecks(nodes: RawCheck[] | undefined): CheckFact[] {
  const out: CheckFact[] = [];
  for (const n of nodes ?? []) {
    if (n.__typename !== "CheckRun" || n.databaseId === undefined || !n.name) continue;
    const run = n.checkSuite?.workflowRun ?? undefined;
    out.push({
      id: n.databaseId,
      name: n.name,
      workflow: run?.workflow?.name ?? undefined,
      runId: run?.databaseId ?? undefined,
      status: n.status ?? "UNKNOWN",
      conclusion: n.conclusion ?? undefined,
      startedAt: n.startedAt ?? undefined,
      completedAt: n.completedAt ?? undefined,
      url: n.detailsUrl ?? undefined,
    });
  }
  return out;
}

function parsePr(repo: string, p: RawPr): PrFact {
  return {
    repo,
    number: p.number,
    title: p.title,
    url: p.url,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    draft: p.isDraft,
    head: p.headRefName,
    base: p.baseRefName,
    headSha: p.headRefOid,
    headMarker: p.headRef?.target?.file?.object?.text?.trim() || undefined,
    mergeState: p.mergeStateStatus ?? undefined,
    reviewDecision: p.reviewDecision ?? undefined,
    author: p.author?.login ?? undefined,
    labels: (p.labels?.nodes ?? []).map((l) => l.name),
    checks: parseChecks(p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes),
  };
}

// The sync engine writes the halt as "### Halt" followed by "<CODE>: <detail>".
export function parseHalt(body: string | null | undefined): string | undefined {
  if (!body) return undefined;
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((l) => /^#{2,4}\s*Halt\s*$/i.test(l.trim()));
  if (at < 0) return undefined;
  return lines
    .slice(at + 1)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
}

function parseIssue(repo: string, i: RawIssue): IssueFact {
  const labels = (i.labels?.nodes ?? []).map((l) => l.name);
  return {
    repo,
    number: i.number,
    title: i.title,
    url: i.url,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    labels,
    comments: i.comments?.totalCount ?? 0,
    halt: labels.includes("sync-failed") ? parseHalt(i.body) : undefined,
  };
}

export function parseDeclaration(text: string | undefined): Declaration | undefined {
  if (!text) return undefined;
  const field = (name: string) =>
    new RegExp(`^${name}:\\s*["']?([^"'\\s#]+)`, "m").exec(text)?.[1] ?? undefined;
  const forks = [...text.matchAll(/^\s*-\s*service:\s*["']?([\w-]+)/gm)].map((m) => m[1] as string);
  return {
    stackVersion: field("stackVersion"),
    location: field("location"),
    profile: field("profile"),
    forks,
  };
}

export function parseUpstreamSha(
  nodes: { oid: string; message: string; committedDate: string }[] | undefined,
): { sha: string; at: string } | undefined {
  for (const n of nodes ?? []) {
    const m = /^Upstream-Sha:\s*([0-9a-f]{7,40})\s*$/m.exec(n.message);
    if (m) return { sha: m[1] as string, at: n.committedDate };
  }
  return undefined;
}

function parseDeployments(raw: RawRepo["deployments"]): DeploymentFact[] {
  return (raw?.nodes ?? []).map((d) => ({
    createdAt: d.createdAt,
    ref: d.ref?.name ?? undefined,
    sha: d.commitOid ?? undefined,
    state: d.latestStatus?.state ?? undefined,
    statusAt: d.latestStatus?.createdAt ?? undefined,
  }));
}

export function parseCrons(text: string | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(/^\s*-?\s*cron:\s*["']([^"']+)["']/gm)].map((m) =>
    (m[1] as string).trim(),
  );
}

function parsePastPrs(raw: RawRepo["pastPrs"]): PastPrFact[] | undefined {
  if (!raw) return undefined;
  return (raw.nodes ?? []).map((p) => ({
    number: p.number,
    title: p.title,
    url: p.url,
    head: p.headRefName,
    base: p.baseRefName,
    createdAt: p.createdAt,
    mergedAt: p.mergedAt ?? undefined,
    closedAt: p.closedAt ?? undefined,
    ...(p.author?.login ? { author: p.author.login } : {}),
  }));
}

function parsePastIssues(raw: RawRepo["pastIssues"]): PastIssueFact[] | undefined {
  if (!raw) return undefined;
  return (raw.nodes ?? []).map((i) => ({
    number: i.number,
    url: i.url,
    createdAt: i.createdAt,
    closedAt: i.closedAt ?? undefined,
    labels: (i.labels?.nodes ?? []).map((l) => l.name),
  }));
}

function parseReleases(raw: RawRepo["releases"]): ReleaseFact[] | undefined {
  if (!raw) return undefined;
  return (raw.nodes ?? []).flatMap((r) =>
    r.isDraft || !r.publishedAt ? [] : [{ tag: r.tagName, at: r.publishedAt, url: r.url }],
  );
}

function parseSchedules(raw: RawRepo): RepoFact["schedules"] {
  const out: NonNullable<RepoFact["schedules"]> = {};
  let any = false;
  for (const kind of LIFECYCLE_KINDS) {
    const file = raw[`wf_${kind}`];
    if (file === undefined) continue;
    any = true;
    out[kind] = parseCrons(file?.text);
  }
  return any ? out : undefined;
}

export function parseRepo(raw: RawRepo): RepoFact {
  const repo = raw.nameWithOwner;
  const target = raw.defaultBranchRef?.target;
  return {
    repo,
    url: raw.url,
    autoMergeAllowed: raw.autoMergeAllowed,
    head:
      target?.oid && target.committedDate
        ? { sha: target.oid, at: target.committedDate }
        : undefined,
    release: raw.latestRelease
      ? {
          tag: raw.latestRelease.tagName,
          at: raw.latestRelease.publishedAt,
          url: raw.latestRelease.url,
        }
      : undefined,
    marker: raw.marker?.text?.trim() || undefined,
    upstreamSha: parseUpstreamSha(raw.upstreamLog?.target?.history?.nodes),
    declaration: parseDeclaration(raw.declaration?.text ?? undefined),
    prs: (raw.pullRequests?.nodes ?? []).map((p) => parsePr(repo, p)),
    issues: (raw.issues?.nodes ?? []).map((i) => parseIssue(repo, i)),
    deployments: parseDeployments(raw.deployments),
    pastPrs: parsePastPrs(raw.pastPrs),
    pastIssues: parsePastIssues(raw.pastIssues),
    releases: parseReleases(raw.releases),
    schedules: parseSchedules(raw),
    ...(raw.syncTemplate !== undefined ? { syncCrons: parseCrons(raw.syncTemplate?.text) } : {}),
  };
}

export function parseGithub(data: Record<string, unknown>): GithubFacts {
  const repos: Record<string, RepoFact> = {};
  const planned: Record<string, boolean> = {};
  for (const [alias, value] of Object.entries(data)) {
    if (alias.startsWith("r_") && value) {
      const fact = parseRepo(value as RawRepo);
      repos[fact.repo] = fact;
    }
  }
  PLANNED.forEach((p, i) => {
    planned[p.id] = !!data[`p_${i}`];
  });
  const rate = data.rateLimit as
    | { cost?: number; remaining?: number; resetAt?: string }
    | undefined;
  return {
    repos,
    planned,
    rate:
      rate?.remaining !== undefined && rate.resetAt
        ? {
            remaining: rate.remaining,
            resetAt: rate.resetAt,
            ...(rate.cost !== undefined ? { cost: rate.cost } : {}),
          }
        : undefined,
  };
}

export async function readGithub(gh: Gh): Promise<GithubFacts> {
  const reads = await Promise.all(
    buildQueries().map((q) => gh.graphql<Record<string, unknown>>(q)),
  );
  const data = mergeReads(reads.map((r) => r.data));
  const errors = reads.flatMap((r) => r.errors);
  const real = errors.filter(
    (e) => !(e.type === "NOT_FOUND" && String(e.path?.[0]).startsWith("p_")),
  );
  const facts = parseGithub(data);
  const missing = [TEMPLATE_REPO, STACK_REPO, ...FORKS.map((f) => f.repo)].filter(
    (r) => !facts.repos[r],
  );
  if (missing.length > 0) {
    throw new Error(
      `GraphQL did not return ${missing.join(", ")}${real[0] ? `: ${real[0].message}` : ""}`,
    );
  }
  return facts;
}
