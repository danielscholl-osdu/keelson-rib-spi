// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { FORKS, githubUrl, TEMPLATE_REPO } from "../config.ts";
import type {
  RepoFact,
  SyncedPaths,
  TemplateChange,
  TemplateCompare,
  TemplateFacts,
} from "../facts.ts";
import type { Gh } from "../forge.ts";
import { semverCmp } from "../model/stack.ts";
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

const SYNC_CONFIG_JQ =
  '.content | gsub("\\n"; "") | @base64d | fromjson | .sync_rules | {dirs: [.directories[]?.path], files: ([.files[]?.path] + [.workflows.template_workflows[]?.path])}';

const COMPARE_JQ =
  "{status, ahead_by, behind_by, commits: [.commits[] | {sha, parents: [.parents[].sha], message: .commit.message, date: .commit.committer.date, url: .html_url}]}";

// A merge commit carries its PR title on the third line; a squash merge ends
// its subject with "(#N)".
export function changeOf(c: RawCommit): TemplateChange {
  const lines = c.message.split(/\r?\n/);
  const parent = c.parents[0];
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
    return {
      sha: c.sha,
      parent,
      title,
      pr,
      url: githubUrl(TEMPLATE_REPO, `/pull/${pr}`),
      at: c.date,
    };
  }
  const subject = (lines[0] ?? "").trim();
  const squash = /\(#(\d+)\)$/.exec(subject);
  return {
    sha: c.sha,
    parent,
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

// Older releases a commit is checked against before it falls back to its sha.
const LABEL_TAGS = 5;

// A template commit by the newest release it contains: "v1.2.0", "v1.2.0 +14".
async function label(
  gh: Gh,
  marker: string,
  tags: readonly string[],
  labels: Record<string, string>,
): Promise<string> {
  const newest = tags[0];
  if (!newest) return short(marker);
  const key = `${newest}@${marker}`;
  const known = labels[key];
  if (known) return known;
  let text = short(marker);
  for (const tag of tags.slice(0, LABEL_TAGS)) {
    const cmp = await gh.rest<RawCompare>(
      `repos/${TEMPLATE_REPO}/compare/${tag}...${marker}`,
      "{status, ahead_by, behind_by, commits: []}",
    );
    if (cmp.status === "identical") text = tag;
    else if (cmp.status === "ahead") text = `${tag} +${cmp.ahead_by}`;
    else continue;
    break;
  }
  labels[key] = text;
  return text;
}

// Release tags newest first, read again only when a new release is cut.
async function releaseTags(
  gh: Gh,
  latest: string | undefined,
  state: TemplateState,
): Promise<string[]> {
  if (!latest) return [];
  if (state.tags?.latest === latest) return state.tags.list;
  try {
    const names = await gh.rest<string[]>(`repos/${TEMPLATE_REPO}/tags?per_page=30`, "[.[].name]");
    const list = names.filter((t) => /^v?\d+\.\d+\.\d+$/.test(t)).sort((a, b) => semverCmp(b, a));
    if (!list.includes(latest)) list.unshift(latest);
    state.tags = { latest, list };
    return list;
  } catch {
    return [latest];
  }
}

export interface TemplateState {
  compares: Record<string, TemplateCompare>;
  labels: Record<string, string>;
  aheads: Record<string, number>;
  files?: Record<string, string[]>;
  synced?: { head: string; paths: SyncedPaths };
  tags?: { latest: string; list: string[] };
}

// A change's files never change, so each is read once; a failed read stays unread.
async function changeFiles(
  gh: Gh,
  changes: readonly TemplateChange[],
  known: Record<string, string[]>,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const c of changes) {
    if (!known[c.sha] && c.parent) {
      try {
        known[c.sha] = await gh.rest<string[]>(
          `repos/${TEMPLATE_REPO}/compare/${c.parent}...${c.sha}`,
          "[.files[]?.filename]",
        );
      } catch {}
    }
    const files = known[c.sha];
    if (files) out[c.sha] = files;
  }
  return out;
}

async function syncedPaths(gh: Gh, head: string, state: TemplateState) {
  if (state.synced?.head === head) return state.synced.paths;
  try {
    const paths = await gh.rest<SyncedPaths>(
      `repos/${TEMPLATE_REPO}/contents/.github/sync-config.json?ref=${head}`,
      SYNC_CONFIG_JQ,
    );
    state.synced = { head, paths };
    return paths;
  } catch {
    return state.synced?.paths;
  }
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
  const tags = await releaseTags(gh, latestTag, state);
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
    const key = `${marker}...${head}@${latestTag ?? ""}#parents`;
    let entry = state.compares[key];
    if (!entry) {
      const cmp = await gh.rest<RawCompare>(
        `repos/${TEMPLATE_REPO}/compare/${marker}...${head}`,
        COMPARE_JQ,
      );
      entry = {
        marker,
        head,
        label: await label(gh, marker, tags, state.labels),
        aheadBy: cmp.status === "identical" ? 0 : cmp.ahead_by,
        shas: cmp.commits.map((c) => c.sha),
        changes: firstParentChanges(head, cmp.commits),
      };
      state.compares[key] = entry;
    } else {
      entry.label = await label(gh, marker, tags, state.labels);
    }
    facts.compares[marker] = entry;
  }
  state.files ??= {};
  const changes = Object.values(facts.compares).flatMap((c) => c.changes);
  facts.files = await changeFiles(gh, changes, state.files);
  const synced = await syncedPaths(gh, head, state);
  if (synced) facts.synced = synced;
  const moved = new Set(
    FORKS.flatMap((f) =>
      (repos[f.repo]?.prs ?? [])
        .map((p) => p.headMarker)
        .filter((m): m is string => !!m && m !== repos[f.repo]?.marker),
    ),
  );
  const targets: Record<string, string> = {};
  for (const sha of moved) targets[sha] = await label(gh, sha, tags, state.labels);
  if (moved.size > 0) facts.targets = targets;
  return facts;
}
