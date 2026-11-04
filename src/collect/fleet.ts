// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { existsSync, readFileSync } from "node:fs";
import {
  builtInFleet,
  DECLARATION_PATH,
  GITLAB_EVERY_MS,
  GITLAB_HOST,
  KNOWN_SERVICES,
  LESSONS_FILE,
  SERVICES_FILE,
  type ServiceDef,
  STACK_REPO,
  TEMPLATE_REPO,
} from "../config.ts";
import type { FleetEntry, FleetFacts, ForkVars } from "../facts.ts";
import type { Gh } from "../forge.ts";
import { type Lessons, parseLessons } from "../lessons.ts";
import { pool } from "../util.ts";

export const LESSONS_PATH = ".github/fleet/lessons.json";

function repoArgs(repo: string): string {
  const [owner, name] = repo.split("/");
  return `owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}`;
}

function blob(alias: string, repo: string, path: string): string {
  return `${alias}: repository(${repoArgs(repo)}) { object(expression: ${JSON.stringify(`main:${path}`)}) { ... on Blob { text } } }`;
}

type BlobRepo = { object: { text?: string } | null } | null;

export function parseForks(text: string): FleetEntry[] {
  const doc = Bun.YAML.parse(text) as { forks?: unknown } | null;
  if (!Array.isArray(doc?.forks)) throw new Error(`${DECLARATION_PATH} has no forks: list`);
  const out: FleetEntry[] = [];
  for (const raw of doc.forks as unknown[]) {
    const e = raw as Partial<Record<keyof FleetEntry, unknown>> | null;
    if (typeof e?.service !== "string" || typeof e.repo !== "string") continue;
    if (!/^[\w.-]+\/[\w.-]+$/.test(e.repo)) continue;
    out.push({
      service: e.service,
      repo: e.repo,
      ...(typeof e.canonicalSource === "string" ? { canonicalSource: e.canonicalSource } : {}),
    });
  }
  if (out.length === 0) throw new Error(`${DECLARATION_PATH} lists no forks the rib can read`);
  return out;
}

async function readVars(gh: Gh, repo: string): Promise<ForkVars | null> {
  try {
    const vars = await gh.rest<{ name: string; value: string }[]>(
      `repos/${repo}/actions/variables?per_page=100`,
      '[.variables[] | select(.name == "UPSTREAM_REPO_URL" or .name == "SYNC_MODE") | {name, value}]',
    );
    const value = (name: string) => vars.find((v) => v.name === name)?.value;
    const upstreamUrl = value("UPSTREAM_REPO_URL");
    const syncMode = value("SYNC_MODE");
    return { ...(upstreamUrl ? { upstreamUrl } : {}), ...(syncMode ? { syncMode } : {}) };
  } catch {
    return null;
  }
}

// The stack's forks list and the lessons file in one query; each fork's variables
// are read again on GitLab's cadence, or as soon as a new fork appears.
export async function readFleet(
  gh: Gh,
  prev: FleetFacts | undefined,
  now: Date,
  files: { services?: string; lessons?: string } = {
    services: SERVICES_FILE,
    lessons: LESSONS_FILE,
  },
): Promise<FleetFacts> {
  const parts = [
    ...(files.services ? [] : [blob("stack", STACK_REPO, DECLARATION_PATH)]),
    ...(files.lessons ? [] : [blob("template", TEMPLATE_REPO, LESSONS_PATH)]),
  ];
  let data: { stack?: BlobRepo; template?: BlobRepo } = {};
  if (parts.length > 0) {
    const res = await gh.graphql<{ stack?: BlobRepo; template?: BlobRepo }>(
      `query { ${parts.join("\n")} }`,
    );
    data = res.data;
  }

  let forks: FleetEntry[] | undefined;
  if (!files.services) {
    const text = data.stack?.object?.text;
    if (!data.stack) throw new Error(`${STACK_REPO} is not readable`);
    if (text === undefined) throw new Error(`${STACK_REPO} has no ${DECLARATION_PATH} on main`);
    forks = parseForks(text);
  }

  let lessons: string | null;
  let lessonsFrom: string;
  if (files.lessons) {
    lessons = existsSync(files.lessons) ? readFileSync(files.lessons, "utf8") : null;
    lessonsFrom = files.lessons;
  } else {
    if (!data.template) throw new Error(`${TEMPLATE_REPO} is not readable`);
    lessons = data.template.object?.text ?? null;
    lessonsFrom = `${TEMPLATE_REPO}:${LESSONS_PATH}`;
  }

  let vars = prev?.vars ?? {};
  let varsAt = prev?.varsAt;
  if (forks) {
    const due =
      !varsAt ||
      now.getTime() - Date.parse(varsAt) >= GITLAB_EVERY_MS ||
      forks.some((f) => !(f.repo in vars));
    if (due) {
      const read: Record<string, ForkVars | null> = {};
      await pool(forks, 4, async (f) => {
        read[f.repo] = await readVars(gh, f.repo);
      });
      vars = read;
      varsAt = now.toISOString();
    }
  }
  return {
    ...(forks ? { forks } : {}),
    vars,
    ...(varsAt ? { varsAt } : {}),
    lessons,
    lessonsFrom,
  };
}

export function upstreamProject(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const host = GITLAB_HOST.replaceAll(".", "\\.");
  return new RegExp(`^https?://${host}/(.+?)(?:\\.git)?/?$`).exec(url.trim())?.[1];
}

export interface ResolvedFleet {
  services: ServiceDef[];
  source: "stack" | "file" | "built-in";
  // Forks the stack lists that the rib cannot follow, with why.
  unresolved: { service: string; why: string }[];
}

// Membership comes from the stack; identity from the built-in map, else the fork's own variables.
export function resolveFleet(data: FleetFacts | undefined): ResolvedFleet {
  if (!data?.forks) {
    return {
      services: builtInFleet(),
      source: SERVICES_FILE ? "file" : "built-in",
      unresolved: [],
    };
  }
  const services: ServiceDef[] = [];
  const unresolved: ResolvedFleet["unresolved"] = [];
  const seen = new Set<string>();
  for (const entry of data.forks) {
    if (seen.has(entry.service)) continue;
    seen.add(entry.service);
    const known = KNOWN_SERVICES.find((s) => s.id === entry.service);
    const vars = data.vars[entry.repo];
    const upstream = known?.upstream ?? upstreamProject(vars?.upstreamUrl);
    if (!upstream) {
      unresolved.push({
        service: entry.service,
        why:
          vars === null
            ? "its repository variables are not readable"
            : "it has no UPSTREAM_REPO_URL variable",
      });
      continue;
    }
    const mirror = vars ? vars.syncMode === "mirror" : known ? false : null;
    services.push({ ...known, id: entry.service, repo: entry.repo, upstream, mirror });
  }
  return { services, source: "stack", unresolved };
}

export function resolveLessons(data: FleetFacts | undefined): {
  lessons?: Lessons;
  warnings: string[];
} {
  if (!data || data.lessons === null) return { warnings: [] };
  return parseLessons(data.lessons);
}
