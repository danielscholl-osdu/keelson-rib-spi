// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { FORKS, type ForkDef } from "../config.ts";
import type { ForkPrFact, MergedMrFact, RadarFacts } from "../facts.ts";
import type { Gh, Glab } from "../forge.ts";

const PAGE = 100;

export interface PortPrState {
  // The newest mergedAt seen, so a warm read asks only for later merges.
  watermark?: string;
  prs: Record<string, ForkPrFact>;
  // The open PRs of the last good read, kept for a read that fails.
  open?: ForkPrFact[];
}

export interface LedgerState {
  merged: Record<string, MergedMrFact[]>;
  portPrs: Record<string, PortPrState>;
  // Pins parsed from a pom, by blob oid or by upstream head sha.
  poms: Record<string, PinRead>;
  upstreamPoms: Record<string, PinRead>;
  latest?: { at: string; pins: PinRead };
  removal?: { at: string; read: RemovalRead };
}

export function emptyLedgerState(): LedgerState {
  return { merged: {}, portPrs: {}, poms: {}, upstreamPoms: {} };
}

function seedOf(fork: ForkDef): string | undefined {
  return fork.seeded ? `${fork.seeded}T00:00:00Z` : undefined;
}

interface RawMerged {
  mergeRequests?: {
    pageInfo?: { hasNextPage?: boolean };
    nodes?: {
      iid: string;
      title: string;
      webUrl: string;
      mergedAt: string | null;
      diffHeadSha: string | null;
    }[];
  };
}

// GitLab caps a query's complexity at 250; one project's merged MRs cost about 31.
const PROJECTS_PER_QUERY = 5;

// Upstream MRs merged to master since each fork's seed, a few projects per aliased query.
export async function readMerged(
  glab: Glab,
  state: LedgerState,
): Promise<Record<string, MergedMrFact[]>> {
  const forks = FORKS.filter((f) => seedOf(f));
  const out: Record<string, MergedMrFact[]> = {};
  for (let at = 0; at < forks.length; at += PROJECTS_PER_QUERY) {
    const chunk = forks.slice(at, at + PROJECTS_PER_QUERY);
    const fields = chunk.map(
      (f, i) =>
        `p${i}: project(fullPath: ${JSON.stringify(f.upstream)}) { mergeRequests(state: merged, targetBranches: ["master"], mergedAfter: "${seedOf(f)}", first: ${PAGE}) { pageInfo { hasNextPage } nodes { iid title webUrl mergedAt diffHeadSha } } }`,
    );
    let data: Record<string, RawMerged | null>;
    try {
      data = await glab.graphql<Record<string, RawMerged | null>>(`query { ${fields.join(" ")} }`);
    } catch {
      for (const f of chunk) {
        const kept = state.merged[f.id];
        if (kept) out[f.id] = kept;
      }
      continue;
    }
    chunk.forEach((f, i) => {
      const raw = data[`p${i}`]?.mergeRequests;
      if (!raw || raw.pageInfo?.hasNextPage) return;
      out[f.id] = (raw.nodes ?? []).flatMap((m) =>
        m.mergedAt && m.diffHeadSha
          ? [
              {
                iid: Number(m.iid),
                title: m.title,
                url: m.webUrl,
                mergedAt: m.mergedAt,
                headSha: m.diffHeadSha,
              },
            ]
          : [],
      );
    });
  }
  state.merged = out;
  return out;
}

const MR_URL = /community\.opengroup\.org\/([\w.\-/]+?)\/-\/merge_requests\/(\d+)/g;

export function mrRefs(texts: readonly string[]): string[] {
  const refs = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(MR_URL)) refs.add(`${m[1]}!${m[2]}`);
  return [...refs];
}

interface RawSearch {
  issueCount: number;
  nodes?: ({
    number?: number;
    url?: string;
    mergedAt?: string | null;
    bodyText?: string;
    commits?: { nodes?: { commit: { message: string } }[] };
  } | null)[];
}

const PR_NODE =
  "... on PullRequest { number url mergedAt bodyText commits(first: 50) { nodes { commit { message } } } }";

function day(iso: string): string {
  return iso.slice(0, 10);
}

export interface PortPrRead {
  prs: Record<string, ForkPrFact[]>;
  // Fork PRs and commit messages this read looked at.
  read: { prs: number; commits: number };
}

// Open fork PRs, and fork PRs merged since the seed (or since the last one seen), in one query.
export async function readPortPrs(gh: Gh, state: LedgerState): Promise<PortPrRead> {
  const forks = FORKS.filter((f) => seedOf(f));
  const fields = forks.flatMap((f, i) => {
    const since = day(state.portPrs[f.id]?.watermark ?? seedOf(f) ?? "");
    return [
      `port_o${i}: search(query: "repo:${f.repo} is:pr is:open", type: ISSUE, first: ${PAGE}) { issueCount nodes { ${PR_NODE} } }`,
      `port_m${i}: search(query: "repo:${f.repo} is:pr is:merged merged:>=${since}", type: ISSUE, first: ${PAGE}) { issueCount nodes { ${PR_NODE} } }`,
    ];
  });
  const out: Record<string, ForkPrFact[]> = {};
  const read = { prs: 0, commits: 0 };
  let data: Record<string, RawSearch | null>;
  try {
    data = (await gh.graphql<Record<string, RawSearch | null>>(`query { ${fields.join(" ")} }`))
      .data;
  } catch {
    for (const f of forks) {
      const known = state.portPrs[f.id];
      if (known?.open) out[f.id] = [...known.open, ...Object.values(known.prs)];
    }
    return { prs: out, read };
  }
  forks.forEach((f, i) => {
    const open = data[`port_o${i}`];
    const merged = data[`port_m${i}`];
    if (!open || !merged) return;
    if (open.issueCount > PAGE || merged.issueCount > PAGE) return;
    const fact = (
      n: NonNullable<NonNullable<RawSearch["nodes"]>[number]>,
      kind: ForkPrFact["state"],
    ) => {
      const messages = (n.commits?.nodes ?? []).map((c) => c.commit.message);
      read.prs++;
      read.commits += messages.length;
      return {
        number: n.number ?? 0,
        url: n.url ?? "",
        state: kind,
        refs: mrRefs([n.bodyText ?? "", ...messages]),
      };
    };
    const known = state.portPrs[f.id] ?? { prs: {} };
    let watermark = known.watermark;
    for (const n of merged.nodes ?? []) {
      if (!n?.number) continue;
      known.prs[String(n.number)] = fact(n, "merged");
      if (n.mergedAt && (!watermark || n.mergedAt > watermark)) watermark = n.mergedAt;
    }
    const openPrs = (open.nodes ?? []).flatMap((n) => (n?.number ? [fact(n, "open")] : []));
    state.portPrs[f.id] = { ...(watermark ? { watermark } : {}), prs: known.prs, open: openPrs };
    out[f.id] = [...openPrs, ...Object.values(known.prs)];
  });
  return { prs: out, read };
}

export interface PinRead {
  osCoreCommon?: string;
  coreLibAzure?: string;
}

const LIBRARIES = {
  osCoreCommon: "osdu/platform/system/lib/core/os-core-common",
  coreLibAzure: "osdu/platform/system/lib/cloud/azure/os-core-lib-azure",
} as const;
const LATEST_MS = 60 * 60_000;

// os-core-common.version and core-lib-azure.version, or core-lib-azure's own <version>.
export function pinsOf(pom: string): PinRead {
  const prop = (name: string) =>
    new RegExp(`<${name.replace(/\./g, "\\.")}>\\s*([^<$\\s]+)\\s*<`).exec(pom)?.[1];
  const artifact =
    /<artifactId>\s*core-lib-azure\s*<\/artifactId>\s*<version>\s*([^<$\s]+)\s*</.exec(pom)?.[1];
  const osCoreCommon = prop("os-core-common.version");
  const coreLibAzure = prop("core-lib-azure.version") ?? artifact;
  return {
    ...(osCoreCommon ? { osCoreCommon } : {}),
    ...(coreLibAzure ? { coreLibAzure } : {}),
  };
}

function decode(content: string): string {
  return Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8");
}

interface RawPoms {
  root?: { oid?: string } | null;
  azure?: { oid?: string } | null;
}

// Each fork's root and Azure provider pom by blob oid; a blob is read only the first time its oid shows.
export async function readForkPins(
  gh: Gh,
  forks: readonly { id: string; repo: string; azure?: string }[],
  state: LedgerState,
): Promise<Record<string, { root?: PinRead; azure?: PinRead }>> {
  const out: Record<string, { root?: PinRead; azure?: PinRead }> = {};
  if (forks.length === 0) return out;
  const fields = forks.map((f, i) => {
    const [owner, name] = f.repo.split("/");
    const azure = f.azure
      ? ` azure: object(expression: "main:${f.azure}/pom.xml") { ... on Blob { oid } }`
      : "";
    return `pom${i}: repository(owner: "${owner}", name: "${name}") { root: object(expression: "main:pom.xml") { ... on Blob { oid } }${azure} }`;
  });
  let data: Record<string, RawPoms | null>;
  try {
    data = (await gh.graphql<Record<string, RawPoms | null>>(`query { ${fields.join(" ")} }`)).data;
  } catch {
    return out;
  }
  const blob = async (repo: string, oid: string | undefined): Promise<PinRead | undefined> => {
    if (!oid) return undefined;
    const known = state.poms[oid];
    if (known) return known;
    try {
      const file = await gh.rest<{ content: string }>(`repos/${repo}/git/blobs/${oid}`);
      const pins = pinsOf(decode(file.content));
      state.poms[oid] = pins;
      return pins;
    } catch {
      return undefined;
    }
  };
  await Promise.all(
    forks.map(async (f, i) => {
      const raw = data[`pom${i}`];
      if (!raw) return;
      const root = await blob(f.repo, raw.root?.oid);
      const azure = await blob(f.repo, raw.azure?.oid ?? undefined);
      out[f.id] = { ...(root ? { root } : {}), ...(azure ? { azure } : {}) };
    }),
  );
  return out;
}

// Upstream's root pom at master, read again only when master's head moves.
export async function readUpstreamPins(
  glab: Glab,
  project: string,
  head: string | undefined,
  state: LedgerState,
): Promise<PinRead | undefined> {
  if (!head) return undefined;
  const known = state.upstreamPoms[head];
  if (known) return known;
  try {
    const file = await glab.rest<{ content: string }>(
      `projects/${encodeURIComponent(project)}/repository/files/pom.xml?ref=${head}`,
    );
    const pins = pinsOf(decode(file.content));
    state.upstreamPoms[head] = pins;
    return pins;
  } catch {
    return undefined;
  }
}

function newest(tags: readonly string[]): string | undefined {
  const plain = tags.filter((t) => /^v?\d+\.\d+\.\d+$/.test(t)).map((t) => t.replace(/^v/, ""));
  return plain.sort((a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++)
      if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
    return 0;
  })[0];
}

// The newest release of each library from its tags, read at most hourly.
export async function readLatest(glab: Glab, state: LedgerState, now: number): Promise<PinRead> {
  const held = state.latest;
  if (held && now - Date.parse(held.at) < LATEST_MS) return held.pins;
  const pins: PinRead = { ...(held?.pins ?? {}) };
  for (const [key, project] of Object.entries(LIBRARIES) as [keyof PinRead, string][]) {
    try {
      const tags = await glab.rest<{ name: string }[]>(
        `projects/${encodeURIComponent(project)}/repository/tags?per_page=100`,
      );
      const top = newest(tags.map((t) => t.name));
      if (top) pins[key] = top;
    } catch {
      // The last good release stays.
    }
  }
  state.latest = { at: new Date(now).toISOString(), pins };
  return pins;
}

const REMOVAL_GROUP = "osdu/platform";
const REMOVAL_LABELS = {
  pending: "SPI fork::pending",
  established: "SPI fork::established",
} as const;

interface RawIssue {
  references?: { full?: string };
  milestone?: { due_date?: string | null } | null;
}

export type RemovalRead = NonNullable<RadarFacts["removal"]>;

// The M28 removal issues by their SPI fork label, read at most hourly; a failed read keeps the last.
export async function readRemoval(
  glab: Glab,
  state: LedgerState,
  now: number,
): Promise<RemovalRead | undefined> {
  const held = state.removal;
  if (held && now - Date.parse(held.at) < LATEST_MS) return held.read;
  const labels: RemovalRead["labels"] = {};
  let due: string | undefined;
  try {
    for (const [stage, label] of Object.entries(REMOVAL_LABELS) as [
      keyof typeof REMOVAL_LABELS,
      string,
    ][]) {
      const issues = await glab.restAll<RawIssue>(
        `groups/${encodeURIComponent(REMOVAL_GROUP)}/issues?labels=${encodeURIComponent(label)}&state=all`,
      );
      for (const i of issues) {
        const project = i.references?.full?.split("#")[0];
        if (project && labels[project] !== "established") labels[project] = stage;
        due ??= i.milestone?.due_date ?? undefined;
      }
    }
  } catch {
    return held?.read;
  }
  const read: RemovalRead = { ...(due ? { due } : {}), labels };
  state.removal = { at: new Date(now).toISOString(), read };
  return read;
}
