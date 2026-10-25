// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { FORKS } from "../config.ts";
import type { DiffFact, LibraryPins, MrFact, RadarFacts } from "../facts.ts";
import { type FilterMap, parseFilter, type UpstreamFilter } from "./filter.ts";
import type { LineModel } from "./lines.ts";
import { semverCmp } from "./stack.ts";

export type Bucket = "Port" | "Interface" | "Toolchain" | "Halt" | "Shared" | "Filtered";

export type HaltCode =
  | "UNKNOWN_TOP_LEVEL"
  | "UNKNOWN_TESTING_ENTRY"
  | "UNKNOWN_PROFILE"
  | "UNKNOWN_FOSSA_MODULE";

export interface PathVerdict {
  bucket: Bucket;
  code?: HaltCode;
  entry?: string;
  // The filter map the entry belongs in.
  map?: FilterMap;
}

export interface Verdict {
  bucket: Bucket;
  paths: string[];
  code?: HaltCode;
  entry?: string;
  map?: FilterMap;
  // "Java 25", "os-core-common 9.2.0"
  value?: string;
  mr?: {
    iid: number;
    title: string;
    draft: boolean;
    url: string;
    createdAt: string;
    updatedAt: string;
  };
  commit?: { sha: string; title: string; url: string };
  // Other forks whose filters lack this entry too.
  elsewhere?: string[];
}

export type RadarState =
  | "halted"
  | "toolchain-blocked"
  | "will-halt"
  | "toolchain-queued"
  | "port-owed"
  | "at-risk"
  | "lagging"
  | "clean"
  | "unmeasured";

export interface OwedMr {
  iid: number;
  title: string;
  url: string;
  mergedAt: string;
  // The fork-owned paths it changed, and the fork-owned trees they sit in.
  paths: string[];
  trees: string[];
}

// Upstream MRs merged since the seed that changed fork-owned paths, and which a fork PR cites.
export interface PortLedger {
  owed: OwedMr[];
  ported: { iid: number; pr: string }[];
}

export type LibraryState = "skewed" | "behind" | "match" | "unread";

// A fork's library pins against upstream master and the newest release; undefined is unread.
export interface LibrarySkew {
  osCoreCommon: { fork?: string; upstream?: string; latest?: string };
  coreLibAzure: { fork?: string; latest?: string };
  state: LibraryState;
}

export type RemovalStage = "pending" | "established" | "fork-only";

export interface RadarService {
  state: RadarState;
  queued: number;
  mrs: number;
  certain: Verdict[];
  possible: Verdict[];
  filterSha?: string;
  // Undefined while the merged MRs, their diffs or the fork PRs are unread.
  ports?: PortLedger;
  libraries?: LibrarySkew;
  // Undefined while no removal issue for the service was read.
  removal?: RemovalStage;
}

export interface RadarModel {
  services: Record<string, RadarService>;
  // The M28 milestone's due date, when the removal issues carry it.
  removalDue?: string;
}

// What the next sync does with the queued commits, and what open MRs would do.
export interface Prediction {
  queued: number;
  mrs: number;
  certain: Verdict[];
  possible: Verdict[];
  filterSha: string;
  ports?: PortLedger;
}

const MAP_CODE: Record<FilterMap, HaltCode> = {
  top_level: "UNKNOWN_TOP_LEVEL",
  testing: "UNKNOWN_TESTING_ENTRY",
  profiles: "UNKNOWN_PROFILE",
  fossa_modules: "UNKNOWN_FOSSA_MODULE",
};

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function forkOwned(filter: UpstreamFilter): string[] {
  if (filter.fork_owned) return filter.fork_owned;
  const svc = filter.service;
  return svc ? [`provider/${svc}-azure`, `testing/${svc}-test-azure`] : [];
}

function byMap(filter: UpstreamFilter, map: FilterMap, entry: string): PathVerdict {
  const verdict = filter[map][entry];
  if (verdict === undefined) return { bucket: "Halt", code: MAP_CODE[map], entry, map };
  return { bucket: verdict === "strip" || verdict === "fork" ? "Filtered" : "Shared", entry, map };
}

export function classifyPath(filter: UpstreamFilter, path: string): PathVerdict {
  const parts = path.split("/");
  const top = parts[0] ?? path;
  const owned = forkOwned(filter).find((o) => path === o || path.startsWith(`${o}/`));
  if (owned) return { bucket: "Port", entry: owned };
  const svc = filter.service;
  if (svc && new RegExp(`^${escapeRe(svc)}-core/(.+/)?provider/interfaces/`).test(path)) {
    return { bucket: "Interface", entry: `${svc}-core` };
  }
  if (top === "provider" || top === "devops") return { bucket: "Filtered", entry: top };
  if (top === "testing" && parts.length > 1) return byMap(filter, "testing", parts[1] as string);
  return byMap(filter, "top_level", top);
}

const TOOLCHAIN_RULES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/<java\.version>\s*(\d+)\s*</, (m) => `Java ${m[1]}`],
  [/<maven\.compiler\.release>\s*(\d+)\s*</, (m) => `Java ${m[1]}`],
  [/<os-core-common\.version>\s*([^<\s]+)\s*</, (m) => `os-core-common ${m[1]}`],
  // The enforcer's Java range, as in <version>[25,)</version> under RequireJavaVersion.
  [/<version>\s*\[(\d+),/, (m) => `Java ${m[1]}`],
  [/RequireJavaVersion|requireJavaVersion/, () => "Java enforcer rule"],
];

export function toolchainValues(lines: readonly string[] | undefined): string[] {
  const found: string[] = [];
  for (const line of lines ?? []) {
    if (!line.startsWith("+")) continue;
    for (const [re, name] of TOOLCHAIN_RULES) {
      const m = re.exec(line);
      if (m) {
        const value = name(m);
        if (!found.includes(value)) found.push(value);
        break;
      }
    }
  }
  return found.sort((a, b) => Number(b.startsWith("Java ")) - Number(a.startsWith("Java ")));
}

// Profile ids from an added <profile> block; nothing when the block is not wholly visible.
export function addedProfiles(lines: readonly string[] | undefined): string[] {
  const ids: string[] = [];
  let open = false;
  for (const line of lines ?? []) {
    if (!line.startsWith("+")) {
      open = false;
      continue;
    }
    if (/<profile>/.test(line)) open = true;
    const m = /<id>\s*([^<]+?)\s*<\/id>/.exec(line);
    if (open && m?.[1]) {
      ids.push(m[1]);
      open = false;
    }
    if (/<\/profile>/.test(line)) open = false;
  }
  return ids;
}

// Module names added under an added analyze.modules key; nothing when the key is not visible.
export function addedFossaModules(lines: readonly string[] | undefined): string[] {
  const names: string[] = [];
  let open = false;
  for (const line of lines ?? []) {
    if (!line.startsWith("+")) {
      open = false;
      continue;
    }
    if (/^\+\s*modules:\s*$/.test(line)) {
      open = true;
      continue;
    }
    const m = /^\+\s*-\s+name:\s*(\S+)/.exec(line);
    if (open && m?.[1]) names.push(m[1].replace(/^["']|["']$/g, ""));
  }
  return names;
}

export function diffVerdicts(
  filter: UpstreamFilter,
  diff: { paths?: string[]; hunks?: Record<string, string[]> },
): (PathVerdict & { path: string; value?: string })[] {
  const out: (PathVerdict & { path: string; value?: string })[] = [];
  for (const path of diff.paths ?? []) out.push({ ...classifyPath(filter, path), path });
  const pom = diff.hunks?.["pom.xml"];
  for (const value of toolchainValues(pom)) {
    out.push({ bucket: "Toolchain", path: "pom.xml", value });
  }
  for (const id of addedProfiles(pom)) {
    const v = byMap(filter, "profiles", id);
    if (v.bucket === "Halt") out.push({ ...v, path: "pom.xml" });
  }
  for (const name of addedFossaModules(diff.hunks?.[".fossa.yml"])) {
    const v = byMap(filter, "fossa_modules", name);
    if (v.bucket === "Halt") out.push({ ...v, path: ".fossa.yml" });
  }
  return out;
}

const BUCKET_ORDER: Bucket[] = ["Halt", "Toolchain", "Port", "Interface", "Shared", "Filtered"];

function gather(
  filter: UpstreamFilter,
  diffs: readonly { diff: DiffFact | MrFact; mr?: Verdict["mr"]; commit?: Verdict["commit"] }[],
): Verdict[] {
  const out = new Map<string, Verdict>();
  for (const { diff, mr, commit } of diffs) {
    if (!diff.paths) continue;
    for (const v of diffVerdicts(filter, diff)) {
      const key = [mr?.iid ?? "", v.bucket, v.code ?? "", v.entry ?? "", v.value ?? ""].join("|");
      const known = out.get(key);
      if (known) {
        if (!known.paths.includes(v.path)) known.paths.push(v.path);
        continue;
      }
      out.set(key, {
        bucket: v.bucket,
        paths: [v.path],
        ...(v.code ? { code: v.code } : {}),
        ...(v.entry ? { entry: v.entry } : {}),
        ...(v.map ? { map: v.map } : {}),
        ...(v.value ? { value: v.value } : {}),
        ...(mr ? { mr } : {}),
        ...(commit ? { commit } : {}),
      });
    }
  }
  return [...out.values()].sort(
    (a, b) => BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket),
  );
}

export function portLedger(
  service: RadarFacts["services"][string],
  filter: UpstreamFilter,
): PortLedger | undefined {
  const { merged, forkPrs } = service;
  if (!merged || !forkPrs || merged.some((m) => !m.paths)) return undefined;
  const cited = new Map<string, string>();
  for (const pr of forkPrs) for (const ref of pr.refs) cited.set(ref.toLowerCase(), pr.url);
  const owed: OwedMr[] = [];
  const ported: PortLedger["ported"] = [];
  for (const m of merged) {
    const hits = (m.paths ?? [])
      .map((p) => ({ p, v: classifyPath(filter, p) }))
      .filter((x) => x.v.bucket === "Port");
    if (hits.length === 0) continue;
    // Upstream deleting fork-owned code is the removal, not a change the fork takes.
    if (hits.every((x) => (m.deleted ?? []).includes(x.p))) continue;
    const paths = hits.map((x) => x.p);
    const trees = [...new Set(hits.map((x) => x.v.entry ?? ""))];
    const pr = cited.get(`${service.project}!${m.iid}`.toLowerCase());
    if (pr) ported.push({ iid: m.iid, pr });
    else owed.push({ iid: m.iid, title: m.title, url: m.url, mergedAt: m.mergedAt, paths, trees });
  }
  return { owed, ported };
}

export function predict(
  service: RadarFacts["services"][string] | undefined,
  filterFile: RadarFacts["filters"][string] | undefined,
): Prediction | undefined {
  if (!service || !filterFile?.text) return undefined;
  const filter = parseFilter(filterFile.text);
  const certain = gather(
    filter,
    service.queued.map((c) => ({
      diff: c,
      commit: { sha: c.sha, title: c.title, url: c.url },
    })),
  );
  const possible = gather(
    filter,
    service.mrs.map((m) => ({
      diff: m,
      mr: {
        iid: m.iid,
        title: m.title,
        draft: m.draft,
        url: m.url,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      },
    })),
  );
  const ports = portLedger(service, filter);
  return {
    queued: service.queued.length,
    mrs: service.mrs.length,
    certain,
    possible,
    filterSha: filterFile.sha,
    ...(ports ? { ports } : {}),
  };
}

export function predictAll(radar: RadarFacts | undefined): Record<string, Prediction> {
  const out: Record<string, Prediction> = {};
  if (!radar) return out;
  const filters = Object.fromEntries(
    Object.entries(radar.filters).map(([svc, f]) => [svc, parseFilter(f.text)]),
  );
  for (const fork of FORKS) {
    const p = predict(radar.services[fork.id], radar.filters[fork.id]);
    if (!p) continue;
    for (const v of [...p.certain, ...p.possible]) {
      if (v.bucket !== "Halt" || !v.map || !v.entry) continue;
      const map = v.map;
      const entry = v.entry;
      const elsewhere = Object.entries(filters)
        .filter(([svc, f]) => svc !== fork.id && f[map][entry] === undefined)
        .map(([svc]) => svc);
      if (elsewhere.length > 0) v.elsewhere = elsewhere;
    }
    out[fork.id] = p;
  }
  return out;
}

const BREAKS = new Set<Bucket>(["Halt", "Toolchain"]);

export function radarState(p: Prediction | undefined, line: LineModel | undefined): RadarState {
  if (!p) return "unmeasured";
  if (line?.halt) return "halted";
  if (line?.syncPr?.failures.some((f) => f.cls === "TOOLCHAIN")) return "toolchain-blocked";
  if (p.certain.some((v) => v.bucket === "Halt")) return "will-halt";
  if (p.certain.some((v) => v.bucket === "Toolchain")) return "toolchain-queued";
  if (p.certain.some((v) => v.bucket === "Port")) return "port-owed";
  if (p.possible.some((v) => BREAKS.has(v.bucket) && !v.mr?.draft)) return "at-risk";
  return p.queued > 0 ? "lagging" : "clean";
}

function older(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && semverCmp(a, b) < 0;
}

export function librarySkew(
  pins: RadarFacts["services"][string]["pins"],
  latest: LibraryPins | undefined,
): LibrarySkew | undefined {
  if (!pins) return undefined;
  const os = {
    ...(pins.fork?.osCoreCommon ? { fork: pins.fork.osCoreCommon } : {}),
    ...(pins.upstream?.osCoreCommon ? { upstream: pins.upstream.osCoreCommon } : {}),
    ...(latest?.osCoreCommon ? { latest: latest.osCoreCommon } : {}),
  };
  const azure = {
    ...(pins.fork?.coreLibAzure ? { fork: pins.fork.coreLibAzure } : {}),
    ...(latest?.coreLibAzure ? { latest: latest.coreLibAzure } : {}),
  };
  const state: LibraryState =
    !os.fork || !os.upstream
      ? "unread"
      : older(os.fork, os.upstream)
        ? "skewed"
        : older(os.fork, os.latest) || older(azure.fork, azure.latest)
          ? "behind"
          : "match";
  return { osCoreCommon: os, coreLibAzure: azure, state };
}

// Fork-only once a merged upstream MR deletes the fork's Azure provider tree.
export function removalStage(
  fork: { id: string; upstream: string },
  facts: RadarFacts | undefined,
): RemovalStage | undefined {
  const text = facts?.filters[fork.id]?.text;
  const tree = text
    ? forkOwned(parseFilter(text)).find((p) => p.startsWith("provider/"))
    : undefined;
  const merged = facts?.services[fork.id]?.merged ?? [];
  const under = (p: string) => !!tree && p.startsWith(`${tree}/`);
  const removed = merged.some((m) => {
    const touched = (m.paths ?? []).filter(under);
    return touched.length > 0 && touched.every((p) => (m.deleted ?? []).includes(p));
  });
  if (removed) return "fork-only";
  return facts?.removal?.labels[fork.upstream];
}

export function buildRadar(
  predictions: Record<string, Prediction>,
  lines: readonly LineModel[],
  facts?: RadarFacts,
): RadarModel {
  const services: Record<string, RadarService> = {};
  for (const line of lines) {
    const p = predictions[line.fork.id];
    services[line.fork.id] = p
      ? {
          state: radarState(p, line),
          queued: p.queued,
          mrs: p.mrs,
          certain: p.certain,
          possible: p.possible,
          filterSha: p.filterSha,
          ...(p.ports ? { ports: p.ports } : {}),
        }
      : { state: "unmeasured", queued: 0, mrs: 0, certain: [], possible: [] };
    const svc = services[line.fork.id] as RadarService;
    const libraries = librarySkew(facts?.services[line.fork.id]?.pins, facts?.latest);
    if (libraries) svc.libraries = libraries;
    const removal = removalStage(line.fork, facts);
    if (removal) svc.removal = removal;
  }
  return { services, ...(facts?.removal?.due ? { removalDue: facts.removal.due } : {}) };
}

function names(list: readonly string[]): string {
  return list.length <= 1
    ? (list[0] ?? "")
    : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

// "will halt on schemathesis-tests", "Java 25 queued", "port owed", or nothing.
export function certainText(certain: readonly Verdict[]): string | undefined {
  const halts = certain.filter((v) => v.bucket === "Halt" && v.entry);
  if (halts.length > 0) return `will halt on ${names(halts.map((v) => v.entry as string))}`;
  const tool = certain.find((v) => v.bucket === "Toolchain" && v.value);
  if (tool) return `${tool.value} queued`;
  if (certain.some((v) => v.bucket === "Port")) return "port owed";
  return undefined;
}
