// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "@keelson/shared";
import { FORKS, RELEASE_REPOS, RELEASES_EVERY_MS } from "../config.ts";
import type { Gh } from "../forge.ts";
import type { Store } from "../store.ts";
import { errorText, pool } from "../util.ts";
import { pinsOf } from "./ledgers.ts";

const RELEASES_FILE = "releases.json";

export interface ReleaseFact {
  tag: string;
  at: string;
  body: string;
}

// What a service builds against at one release tag; null when no pom names it.
export interface BuildPins {
  lib: string | null;
  java: string | null;
}

export interface ReleaseReads {
  at?: string;
  releases: Record<string, ReleaseFact[]>;
  created: Record<string, string>;
  pins: Record<string, BuildPins>;
  errors: Record<string, string>;
}

const readsSchema = z.object({
  at: z.string().optional(),
  releases: z.record(
    z.string(),
    z.array(z.object({ tag: z.string(), at: z.string(), body: z.string() })),
  ),
  created: z.record(z.string(), z.string()),
  pins: z.record(z.string(), z.object({ lib: z.string().nullable(), java: z.string().nullable() })),
  errors: z.record(z.string(), z.string()),
});

export function emptyReads(): ReleaseReads {
  return { releases: {}, created: {}, pins: {}, errors: {} };
}

export function pinKey(repo: string, tag: string): string {
  return `${repo}@${tag}`;
}

// The first of java.version, maven.compiler.release and maven.compiler.target.
export function javaOf(pom: string): string | null {
  for (const name of ["java.version", "maven.compiler.release", "maven.compiler.target"]) {
    const v = new RegExp(`<${name.replace(/\./g, "\\.")}>\\s*([^<$\\s]+)\\s*<`).exec(pom)?.[1];
    if (v) return v.replace(/^1\./, "");
  }
  return null;
}

// Azure provider poms carry the core-lib-azure pin; test modules never ship.
export function pinPoms(paths: readonly string[]): string[] {
  return paths.filter(
    (p) => p.endsWith("pom.xml") && /azure|aks|enqueue/i.test(p) && !/test/i.test(p),
  );
}

interface RawBlob {
  text?: string | null;
}

async function readPins(gh: Gh, repo: string, tag: string): Promise<BuildPins> {
  const paths = await gh.rest<string[]>(
    `repos/${repo}/git/trees/${encodeURIComponent(tag)}?recursive=1`,
    "[.tree[].path]",
  );
  const poms = ["pom.xml", ...pinPoms(paths)];
  const [owner, name] = repo.split("/");
  const fields = poms
    .map(
      (p, i) =>
        `p${i}: object(expression: ${JSON.stringify(`${tag}:${p}`)}) { ... on Blob { text } }`,
    )
    .join(" ");
  const { data } = await gh.graphql<{ repository: Record<string, RawBlob | null> | null }>(
    `{ repository(owner: "${owner}", name: "${name}") { ${fields} } }`,
  );
  const texts = poms.map((_, i) => data.repository?.[`p${i}`]?.text ?? "");
  const root = texts[0] ?? "";
  const lib = texts
    .slice(1)
    .concat(root)
    .map((t) => pinsOf(t).coreLibAzure)
    .find((v) => v && !v.startsWith("$"));
  return { lib: lib ?? null, java: javaOf(root) };
}

// Releases, repository creation dates and each service release's build pins, read
// on their own slow cadence. A repository that fails keeps its last good read.
export class ReleaseReader {
  private reads: ReleaseReads;
  private reading: Promise<void> | undefined;

  constructor(
    private readonly gh: Gh,
    private readonly store: Store,
    private readonly now: () => Date,
    private readonly onChange: () => void = () => undefined,
  ) {
    this.reads = store.read(RELEASES_FILE, readsSchema) ?? emptyReads();
  }

  get data(): ReleaseReads {
    return this.reads;
  }

  get busy(): boolean {
    return !!this.reading;
  }

  read(opts: { force?: boolean } = {}): Promise<void> {
    if (this.reading) return this.reading;
    const last = Date.parse(this.reads.at ?? "");
    if (!opts.force && Number.isFinite(last) && this.now().getTime() - last < RELEASES_EVERY_MS) {
      return Promise.resolve();
    }
    this.reading = this.readAll().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  private async readAll(): Promise<void> {
    const releases = { ...this.reads.releases };
    const errors: Record<string, string> = {};
    await pool(RELEASE_REPOS, 4, async (repo) => {
      try {
        const list = await this.gh.pages<ReleaseFact>(
          `repos/${repo}/releases?per_page=100`,
          '.[] | select(.draft | not) | {tag: .tag_name, at: (.published_at // .created_at), body: (.body // "")}',
        );
        releases[repo] = list.sort((a, b) => b.at.localeCompare(a.at));
      } catch (err) {
        errors[repo] = errorText(err);
      }
    });
    const created = { ...this.reads.created };
    try {
      const fields = RELEASE_REPOS.map((r, i) => {
        const [owner, name] = r.split("/");
        return `r${i}: repository(owner: "${owner}", name: "${name}") { createdAt }`;
      }).join(" ");
      const { data } = await this.gh.graphql<Record<string, { createdAt?: string } | null>>(
        `{ ${fields} }`,
      );
      RELEASE_REPOS.forEach((r, i) => {
        const at = data[`r${i}`]?.createdAt;
        if (at) created[r] = at;
      });
    } catch (err) {
      errors.created = errorText(err);
    }
    const pins = { ...this.reads.pins };
    const forks = new Set(FORKS.map((f) => f.repo));
    const missing = Object.entries(releases)
      .filter(([repo]) => forks.has(repo))
      .flatMap(([repo, list]) => list.map((r) => ({ repo, tag: r.tag })))
      .filter((r) => !pins[pinKey(r.repo, r.tag)]);
    await pool(missing, 4, async ({ repo, tag }) => {
      try {
        pins[pinKey(repo, tag)] = await readPins(this.gh, repo, tag);
      } catch (err) {
        errors[pinKey(repo, tag)] = errorText(err);
      }
    });
    const readAny = RELEASE_REPOS.some((r) => !errors[r]);
    this.reads = {
      ...(readAny ? { at: this.now().toISOString() } : this.reads.at ? { at: this.reads.at } : {}),
      releases,
      created,
      pins,
      errors,
    };
    this.store.write(RELEASES_FILE, this.reads);
    this.onChange();
  }
}
