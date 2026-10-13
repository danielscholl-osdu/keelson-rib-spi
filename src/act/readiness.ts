// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Project, RibExec } from "@keelson/shared";
import {
  loadKeelsonConfig,
  resolveRibApprovalGrants,
  resolveRibWorkflowGrants,
} from "@keelson/shared/config";
import { FORKS, TEMPLATE_REPO } from "../config.ts";
import { RIB_ID } from "../keys.ts";

export const NEEDED_SCOPES = ["repo", "workflow"] as const;
export const WORKFLOW_GRANTS = ["spi-classify-entry", "spi-absorb-toolchain", "investigate"];
export const APPROVAL_GRANTS = ["spi-classify-entry", "spi-absorb-toolchain"];

// Workflow verbs run in a Keelson project for the repository they change.
export const PROJECT_REPOS: readonly string[] = [...FORKS.map((f) => f.repo), TEMPLATE_REPO];

export interface Grants {
  workflow: string[];
  approval: string[];
}

export interface Readiness {
  // Repository to the project rooted at it; a missing key is a repo with no project.
  projects: Record<string, string>;
  grants?: Grants;
}

// "git@github.com:Azure/osdu-spi-file.git" and "https://github.com/Azure/osdu-spi-file" alike.
export function githubRepoOf(remote: string): string | undefined {
  const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return m?.[1];
}

export function grantsFromHost(): Grants | undefined {
  try {
    const config = loadKeelsonConfig();
    return {
      workflow: [...(resolveRibWorkflowGrants(config).get(RIB_ID) ?? [])],
      approval: [...(resolveRibApprovalGrants(config).get(RIB_ID) ?? [])],
    };
  } catch {
    return undefined;
  }
}

export async function readReadiness(
  exec: RibExec,
  projects: readonly Project[] | undefined,
  grants: () => Grants | undefined = grantsFromHost,
): Promise<Readiness> {
  const wanted = new Map(PROJECT_REPOS.map((r) => [r.toLowerCase(), r]));
  const found: Record<string, string> = {};
  await Promise.all(
    (projects ?? []).map(async (p) => {
      const res = await exec.runText("git", ["-C", p.rootPath, "remote", "get-url", "origin"], {
        timeoutMs: 10_000,
      });
      const repo = res.ok ? githubRepoOf(res.data) : undefined;
      const canonical = repo ? wanted.get(repo.toLowerCase()) : undefined;
      if (canonical && !found[canonical]) found[canonical] = p.name;
    }),
  );
  const g = grants();
  return { projects: found, ...(g ? { grants: g } : {}) };
}
