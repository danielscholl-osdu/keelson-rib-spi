// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { FORKS, type ForkDef } from "../config.ts";
import type { ForkPrFact, MergedMrFact } from "../facts.ts";
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
}

export function emptyLedgerState(): LedgerState {
  return { merged: {}, portPrs: {} };
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
