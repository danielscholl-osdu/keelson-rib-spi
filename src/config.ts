// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// The service identity map is configuration, never derived from names:
// entitlements builds as entitlements-v2 and schema's upstream is schema-service.
export interface ServiceDef {
  id: string;
  upstream: string;
  prefix: string;
  repo?: string;
  seeded?: string;
}

export const SERVICES: readonly ServiceDef[] = [
  {
    id: "partition",
    repo: "Azure/osdu-spi-partition",
    upstream: "osdu/platform/system/partition",
    prefix: "partition",
    seeded: "2026-08-04",
  },
  {
    id: "entitlements",
    repo: "Azure/osdu-spi-entitlements",
    upstream: "osdu/platform/security-and-compliance/entitlements",
    prefix: "entitlements-v2",
    seeded: "2026-09-14",
  },
  {
    id: "legal",
    repo: "Azure/osdu-spi-legal",
    upstream: "osdu/platform/security-and-compliance/legal",
    prefix: "legal",
    seeded: "2026-09-16",
  },
  {
    id: "schema",
    repo: "Azure/osdu-spi-schema",
    upstream: "osdu/platform/system/schema-service",
    prefix: "schema",
    seeded: "2026-09-24",
  },
  {
    id: "file",
    repo: "Azure/osdu-spi-file",
    upstream: "osdu/platform/system/file",
    prefix: "file",
    seeded: "2026-09-29",
  },
  { id: "storage", upstream: "osdu/platform/system/storage", prefix: "storage" },
  { id: "indexer", upstream: "osdu/platform/system/indexer-service", prefix: "indexer" },
  { id: "search", upstream: "osdu/platform/system/search-service", prefix: "search" },
];

export type ForkDef = ServiceDef & { repo: string };

export const FORKS: readonly ForkDef[] = SERVICES.filter((s): s is ForkDef => !!s.repo);
export const PLANNED: readonly ServiceDef[] = SERVICES.filter((s) => !s.repo);

export const TEMPLATE_REPO = "Azure/osdu-spi";
export const STACK_REPO = "Azure/osdu-spi-stack";
export const GITLAB_HOST = "community.opengroup.org";
export const DECLARATION_PATH = "ops/environments/shared.yaml";
export const MARKER_PATH = ".github/.template-sync-commit";
export const SYNC_TEMPLATE_WORKFLOW = "sync-template.yml";
export const LANE_ENVIRONMENT = "spi-stack";

export const REPOS: readonly string[] = [TEMPLATE_REPO, STACK_REPO, ...FORKS.map((f) => f.repo)];

export function plannedRepo(service: ServiceDef): string {
  return `Azure/osdu-spi-${service.id}`;
}

export function forkOf(repo: string): ForkDef | undefined {
  return FORKS.find((f) => f.repo === repo);
}

export function shortRepo(repo: string): string {
  return repo.replace(/^Azure\//, "");
}

export function githubUrl(repo: string, path = ""): string {
  return `https://github.com/${repo}${path}`;
}

export function gitlabUrl(project: string, path = ""): string {
  return `https://${GITLAB_HOST}/${project}${path}`;
}

export const LIFECYCLE_WORKFLOWS = {
  refresh: "env-refresh.yml",
  upgrade: "env-upgrade.yml",
  smoke: "smoke.yml",
  sweeper: "sweeper.yml",
} as const;
export type LifecycleKind = keyof typeof LIFECYCLE_WORKFLOWS;

export const HISTORY_DAYS = 21;

export const SWEEP_MS = 5 * 60_000;
export const GITLAB_EVERY_MS = 30 * 60_000;
export const INFLIGHT_POLL_MS = 15_000;
