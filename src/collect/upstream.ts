// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { FORKS } from "../config.ts";
import type { RepoFact, UpstreamFact } from "../facts.ts";
import { encodeProject, type Glab } from "../forge.ts";
import { pool } from "../util.ts";

interface RawBranch {
  commit: { id: string; committed_date?: string; created_at?: string; web_url?: string };
}

interface RawCompare {
  commits?: { id: string; title: string; created_at: string; web_url: string }[];
}

export type UpstreamCompares = Record<string, UpstreamFact["commits"]>;

// Lag is the commits on GitLab master after the fork's last Upstream-Sha
// trailer. A compare between two fixed shas never changes, so it is kept.
export async function readUpstream(
  glab: Glab,
  repos: Record<string, RepoFact>,
  compares: UpstreamCompares,
): Promise<Record<string, UpstreamFact>> {
  const out: Record<string, UpstreamFact> = {};
  await pool(FORKS, 3, async (fork) => {
    const project = encodeProject(fork.upstream);
    const synced = repos[fork.repo]?.upstreamSha?.sha;
    const fact: UpstreamFact = { service: fork.id, synced, commits: [] };
    const branch = await glab.rest<RawBranch>(`projects/${project}/repository/branches/master`);
    const headSha = branch.commit.id;
    fact.head = {
      sha: headSha,
      at: branch.commit.committed_date ?? branch.commit.created_at ?? "",
      url: branch.commit.web_url ?? "",
    };
    if (synced) {
      if (headSha.startsWith(synced) || synced.startsWith(headSha)) {
        fact.lag = 0;
      } else {
        const key = `${synced}...${headSha}`;
        let commits = compares[key];
        if (!commits) {
          const cmp = await glab.rest<RawCompare>(
            `projects/${project}/repository/compare?from=${synced}&to=${headSha}`,
          );
          commits = (cmp.commits ?? []).map((c) => ({
            sha: c.id,
            title: c.title,
            at: c.created_at,
            url: c.web_url,
          }));
          compares[key] = commits;
        }
        fact.commits = commits;
        fact.lag = commits.length;
      }
    }
    out[fork.id] = fact;
  });
  return out;
}
