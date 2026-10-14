// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { FailureClass } from "./attribution.ts";
import type { ItemKind, QueueItem } from "./queue.ts";
import { pullFailure } from "./reason.ts";

export type ItemClass = FailureClass | "INCIDENT" | "GATE" | "READY";

// A fork whose upstream filter already lists a halted entry, and what its rule says.
export interface ListedEntry {
  fork: string;
  verdict?: string;
}

export function itemClass(item: QueueItem): ItemClass {
  return item.cls ?? (item.incident ? "INCIDENT" : item.rung === 1 ? "GATE" : "READY");
}

export const CLASS_VERB: Record<FailureClass | "INCIDENT", string> = {
  HALT: "Classify entry",
  TOOLCHAIN: "Absorb toolchain",
  BUILD: "Investigate",
  TEST: "Investigate",
  INFRA: "Investigate",
  UNREAD: "Investigate",
  POLICY: "Investigate",
  ENV: "Re-run lanes",
  ACCESS: "Open run, Open PR",
  CONFLICT: "Investigate, then Dispatch cascade",
  INCIDENT: "Investigate",
};

// Gates and ready work carry no failure class; their verb follows the kind.
const KIND_VERB: Partial<Record<ItemKind, string>> = {
  stack: "Re-dispatch",
  maintenance: "Re-dispatch",
  cascade: "Investigate, then Dispatch cascade",
  approvals: "Approve runs",
  gate1: "Review on GitHub",
  gate2: "Merge",
  labels: "Review on GitHub",
  "template-set": "Review, then Roll out",
  releases: "Review on GitHub",
  "template-pr": "Review on GitHub",
  bump: "Merge",
};

export function verbOf(item: QueueItem): string {
  if (item.kind === "radar") return item.cls === "TOOLCHAIN" ? "Absorb toolchain" : "Pre-classify";
  const byKind = KIND_VERB[item.kind];
  if (byKind && (!item.cls || item.cls === "ENV")) return byKind;
  return CLASS_VERB[item.cls ?? "INCIDENT"];
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function fact(item: QueueItem, label: string): string | undefined {
  return item.cause.find((f) => f.label === label)?.value;
}

function haltNext(item: QueueItem, listed: readonly ListedEntry[]): string {
  const entries = item.halt?.entries ?? [];
  const rule = `Add a rule for ${entries.length > 0 ? list(entries) : "the entry"} to .github/upstream-filter.yml, then dispatch sync`;
  const byVerdict = new Map<string, string[]>();
  for (const e of listed) {
    const forks = byVerdict.get(e.verdict ?? "a rule") ?? [];
    if (!forks.includes(e.fork)) forks.push(e.fork);
    byVerdict.set(e.verdict ?? "a rule", forks);
  }
  const copies = [...byVerdict].map(
    ([verdict, forks]) =>
      `${list(forks)} ${forks.length === 1 ? "lists" : "list"} it as ${verdict}`,
  );
  return copies.length > 0 ? `${rule} · ${copies.join("; ")}` : rule;
}

function failureNext(item: QueueItem): string {
  const check = fact(item, "check");
  const reason = fact(item, "reason") ?? "";
  switch (item.cls) {
    case "TOOLCHAIN": {
      const want = /allowed range \[(\d+)/.exec(reason)?.[1];
      return want
        ? `Move the fork's Java pin to ${want}, the version upstream now requires`
        : "Move the fork's Java or library pin to what upstream now requires";
    }
    case "TEST": {
      const suites = /failed suites?: (.+)$/i.exec(reason)?.[1];
      return suites
        ? `Open the Prove log for the ${list(suites.split(/,\s*/))} ${suites.includes(",") ? "suites" : "suite"}`
        : `Open the failed job${check ? ` (${check})` : ""} for the failing tests`;
    }
    case "INFRA":
      return `Re-run ${check ?? "the check"} on GitHub; it failed on the network, not the code`;
    case "ACCESS": {
      const pull = pullFailure(fact(item, "reason") ?? "");
      return pull
        ? `The fork's own image ${pull.image} cannot be pulled (${pull.code}); the stack is not the cause`
        : "The fork's own image cannot be pulled; the stack is not the cause";
    }
    case "UNREAD":
      return "Open the failed check on GitHub; the rib could not read its job";
    case "CONFLICT":
      return "Resolve the conflict named in the issue on the fork, then dispatch the cascade";
    default:
      return `Open the failed job${check ? ` (${check})` : ""}; the reason is in the cause above`;
  }
}

function radarNext(item: QueueItem): string {
  if (item.cls !== "TOOLCHAIN") {
    const entries = item.halt?.entries ?? [];
    return `Pre-classify: add ${entries.length > 0 ? list(entries) : "the entry"} to ${fact(item, "map") ?? "its map"} in .github/upstream-filter.yml before the next Sync Upstream`;
  }
  const value = fact(item, "value") ?? "";
  const java = /^Java (\d+)$/.exec(value)?.[1];
  return java
    ? `Move the fork's Java pin to ${java} before the next Sync Upstream carries it`
    : `Absorb ${value || "the toolchain move"} on the fork before the next Sync Upstream carries it`;
}

// What a person does to clear the item, in the words of its verb.
export function nextText(item: QueueItem, listed: readonly ListedEntry[] = []): string {
  switch (item.kind) {
    case "halt":
      return haltNext(item, listed);
    case "stack":
      return item.text.includes(" now")
        ? "Wait for the run in flight; if it fails, fix its cause and re-dispatch"
        : "Fix the cause the last attempt names, then re-dispatch it";
    case "maintenance":
      return "Re-dispatch the lifecycle run that clears maintenance";
    case "lanes":
      return item.note
        ? "Re-run the fork lanes that failed while the stack was down"
        : "Wait for the stack to read deployable, then re-run the lanes it failed";
    case "sync-run":
      return "Open the failed Sync Upstream run; no halt issue says why it stopped";
    case "cascade":
      return "Fix what stopped the cascade, clear the tracking issue's label, then dispatch the cascade";
    case "template-run":
      return "Open the failed Sync Template run so template changes reach the fork again";
    case "approvals":
      return "Read each outside PR's diff, then approve its runs below";
    case "labels":
      return "Apply the template's label changes by hand, then close the issue";
    case "template-set":
      return "Review the template-sync PRs on GitHub; Roll out merges the reviewed ones together";
    case "releases":
      return "Review each release PR on GitHub and merge it to cut the release";
    case "bump":
      return "Merge the env bump PR on GitHub to start env-upgrade";
    case "radar":
      return radarNext(item);
  }
  if (item.cls && item.cls !== "ENV") return failureNext(item);
  switch (item.kind) {
    case "gate1":
      return "Review the sync PR on GitHub and merge it";
    case "gate2":
      return "Approve the release/upstream PR and merge it with a merge commit, never a squash";
    case "template-pr":
      return "Review the PR on GitHub; every fork takes it at the next Sync Template";
    default:
      return failureNext(item);
  }
}
