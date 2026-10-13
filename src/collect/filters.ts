// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { FORKS, githubUrl, gitlabUrl } from "../config.ts";
import { encodeProject, type Gh, type Glab } from "../forge.ts";
import type { HaltEntries } from "../model/queue.ts";

export const FILTER_PATH = ".github/upstream-filter.yml";

// absent: upstream has no such entry, so this fork will not halt on it.
// listed: the fork's filter already classifies it. unlisted: the next sync halts.
export type EntryState = "absent" | "listed" | "unlisted" | "unread";

export interface ForkEntry {
  fork: string;
  entry: string;
  state: EntryState;
  verdict?: string;
  url?: string;
}

// The halts whose entries are checked against each fork's filter, and where they live.
const CHECKED: Record<string, { section: string; path?: string }> = {
  UNKNOWN_TOP_LEVEL: { section: "top_level" },
  UNKNOWN_TESTING_ENTRY: { section: "testing", path: "testing" },
};

export function checkable(halt: HaltEntries | undefined): halt is HaltEntries {
  return !!halt && halt.entries.length > 0 && halt.code in CHECKED;
}

// The filter is a flat `section:` then indented `name: verdict` map, so a line
// reader is enough and the rib carries no YAML dependency.
export function filterSection(text: string, section: string): Map<string, string> {
  const out = new Map<string, string>();
  let inside = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      inside = line.trim() === `${section}:`;
      continue;
    }
    if (!inside) continue;
    const m = /^\s+([^:\s][^:]*):\s*(\S+)\s*$/.exec(line);
    if (m?.[1] && m[2]) out.set(m[1].trim(), m[2]);
  }
  return out;
}

async function readFilter(gh: Gh, repo: string): Promise<string> {
  const b64 = await gh.rest<string>(`repos/${repo}/contents/${FILTER_PATH}`, ".content");
  return Buffer.from(b64.replace(/\s/g, ""), "base64").toString("utf8");
}

async function readTree(glab: Glab, project: string, path?: string): Promise<Set<string>> {
  const query = `ref=master&per_page=100${path ? `&path=${encodeURIComponent(path)}` : ""}`;
  const tree = await glab.rest<{ name: string }[]>(
    `projects/${encodeProject(project)}/repository/tree?${query}`,
  );
  return new Set(tree.map((t) => t.name));
}

export async function entryAcrossForks(
  gh: Gh,
  glab: Glab,
  halt: HaltEntries,
): Promise<ForkEntry[]> {
  const where = CHECKED[halt.code];
  if (!where) return [];
  const others = FORKS.filter((f) => f.id !== halt.fork);
  const perFork = await Promise.all(
    others.map(async (fork): Promise<ForkEntry[]> => {
      const [filter, tree] = await Promise.allSettled([
        readFilter(gh, fork.repo),
        readTree(glab, fork.upstream, where.path),
      ]);
      const listed =
        filter.status === "fulfilled" ? filterSection(filter.value, where.section) : undefined;
      const present = tree.status === "fulfilled" ? tree.value : undefined;
      return halt.entries.map((entry): ForkEntry => {
        if (!present) return { fork: fork.id, entry, state: "unread" };
        if (!present.has(entry)) {
          return {
            fork: fork.id,
            entry,
            state: "absent",
            url: gitlabUrl(fork.upstream, `/-/tree/master${where.path ? `/${where.path}` : ""}`),
          };
        }
        if (!listed) return { fork: fork.id, entry, state: "unread" };
        const verdict = listed.get(entry);
        return {
          fork: fork.id,
          entry,
          state: verdict ? "listed" : "unlisted",
          ...(verdict ? { verdict } : {}),
          url: githubUrl(fork.repo, `/blob/main/${FILTER_PATH}`),
        };
      });
    }),
  );
  return perFork.flat();
}
