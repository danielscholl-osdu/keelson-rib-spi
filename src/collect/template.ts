// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { FORKS, githubUrl, TEMPLATE_REPO } from "../config.ts";
import type { RepoFact, TemplateChange, TemplateCompare, TemplateFacts } from "../facts.ts";
import type { Gh } from "../forge.ts";
import { short } from "../util.ts";

interface RawCommit {
  sha: string;
  parents: string[];
  message: string;
  date: string;
  url: string;
}

interface RawCompare {
  status: string;
  ahead_by: number;
  behind_by: number;
  commits: RawCommit[];
}

const COMPARE_JQ =
  "{status, ahead_by, behind_by, commits: [.commits[] | {sha, parents: [.parents[].sha], message: .commit.message, date: .commit.committer.date, url: .html_url}]}";

// A merge commit carries its PR title on the third line; a squash merge ends
// its subject with "(#N)".
export function changeOf(c: RawCommit): TemplateChange {
  const lines = c.message.split(/\r?\n/);
  const merge = /^Merge pull request #(\d+) from \S+/.exec(lines[0] ?? "");
  if (merge) {
    const title =
      lines
        .slice(1)
        .find((l) => l.trim().length > 0)
        ?.trim() ??
      lines[0] ??
      "";
    const pr = Number(merge[1]);
    return { sha: c.sha, title, pr, url: githubUrl(TEMPLATE_REPO, `/pull/${pr}`), at: c.date };
  }
  const subject = (lines[0] ?? "").trim();
  const squash = /\(#(\d+)\)$/.exec(subject);
  return {
    sha: c.sha,
    title: subject,
    pr: squash ? Number(squash[1]) : undefined,
    url: squash ? githubUrl(TEMPLATE_REPO, `/pull/${squash[1]}`) : c.url,
    at: c.date,
  };
}

// The first-parent chain from main back to the marker is the list of changes
// main took; side-branch commits behind a merge are part of that merge.
export function firstParentChanges(head: string, commits: readonly RawCommit[]): TemplateChange[] {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const out: TemplateChange[] = [];
  let cur = bySha.get(head);
  while (cur) {
    out.push(changeOf(cur));
    cur = cur.parents[0] ? bySha.get(cur.parents[0]) : undefined;
  }
  return out;
}

async function label(
  gh: Gh,
  marker: string,
  tag: string | undefined,
  labels: Record<string, string>,
): Promise<string> {
  if (!tag) return short(marker);
  const key = `${tag}...${marker}`;
  const known = labels[key];
  if (known) return known;
  const cmp = await gh.rest<RawCompare>(
    `repos/${TEMPLATE_REPO}/compare/${tag}...${marker}`,
    "{status, ahead_by, behind_by, commits: []}",
  );
  const text =
    cmp.status === "identical"
      ? tag
      : cmp.status === "ahead"
        ? `${tag} +${cmp.ahead_by}`
        : `${short(marker)} (before ${tag})`;
  labels[key] = text;
  return text;
}

export interface TemplateState {
  compares: Record<string, TemplateCompare>;
  labels: Record<string, string>;
  aheads: Record<string, number>;
}

export async function readTemplate(
  gh: Gh,
  repos: Record<string, RepoFact>,
  state: TemplateState,
): Promise<TemplateFacts> {
  const template = repos[TEMPLATE_REPO];
  const head = template?.head?.sha;
  const latestTag = template?.release?.tag;
  const facts: TemplateFacts = { latestTag, compares: {} };
  if (!head) return facts;
  if (latestTag) {
    const key = `${latestTag}...${head}`;
    if (state.aheads[key] === undefined) {
      const cmp = await gh.rest<RawCompare>(
        `repos/${TEMPLATE_REPO}/compare/${key}`,
        "{status, ahead_by, behind_by, commits: []}",
      );
      state.aheads[key] = cmp.status === "identical" ? 0 : cmp.ahead_by;
    }
    facts.mainAhead = state.aheads[key];
  }
  const markers = [
    ...new Set(FORKS.map((f) => repos[f.repo]?.marker).filter((m): m is string => !!m)),
  ];
  for (const marker of markers) {
    const key = `${marker}...${head}@${latestTag ?? ""}`;
    let entry = state.compares[key];
    if (!entry) {
      const cmp = await gh.rest<RawCompare>(
        `repos/${TEMPLATE_REPO}/compare/${marker}...${head}`,
        COMPARE_JQ,
      );
      entry = {
        marker,
        head,
        label: await label(gh, marker, latestTag, state.labels),
        aheadBy: cmp.status === "identical" ? 0 : cmp.ahead_by,
        shas: cmp.commits.map((c) => c.sha),
        changes: firstParentChanges(head, cmp.commits),
      };
      state.compares[key] = entry;
    }
    facts.compares[marker] = entry;
  }
  const moved = new Set(
    FORKS.flatMap((f) =>
      (repos[f.repo]?.prs ?? [])
        .map((p) => p.headMarker)
        .filter((m): m is string => !!m && m !== repos[f.repo]?.marker),
    ),
  );
  const targets: Record<string, string> = {};
  for (const sha of moved) targets[sha] = await label(gh, sha, latestTag, state.labels);
  if (moved.size > 0) facts.targets = targets;
  return facts;
}
