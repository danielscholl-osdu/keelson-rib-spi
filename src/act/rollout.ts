// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { forkOf, SYNC_TEMPLATE_WORKFLOW } from "../config.ts";
import { type LaneLoad, laneRoom } from "../model/lanes.ts";
import { ownFailure, type TemplateModel, type TemplateRow } from "../model/template.ts";
import { plural, stamp } from "../util.ts";
import { type ActionItem, type Target, type Verb, verbAction } from "./verbs.ts";

export const ROLLOUT_ITEM = "engineering";

export const SYNC_FORKS: Verb = {
  id: "sync-template",
  label: "Sync all forks",
  command: (t) => ["workflow", "run", SYNC_TEMPLATE_WORKFLOW, "-R", t.repo],
  paced: true,
};

// Template-sync PRs have always landed as merge commits, so the rollout keeps that.
export const ROLL_OUT: Verb = {
  id: "roll-out",
  label: "Roll out",
  command: (t) => ["pr", "merge", String(t.number), "-R", t.repo, "--merge"],
  paced: true,
};

function names(list: readonly string[]): string {
  return list.length <= 1
    ? (list[0] ?? "")
    : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

// Why a fork never takes a fleet button: a mirror (ADR-039) never runs Sync Template.
function mirrored(repo: string): string | undefined {
  const mirror = forkOf(repo)?.mirror;
  return mirror ? "mirror" : mirror === null ? "sync mode unread" : undefined;
}

export interface Paced {
  targets: Target[];
  // Eligible forks past the lane cap, in board order, for the next press.
  waiting: Target[];
}

// The first forks in board order up to the room the cap leaves; the rest wait.
export function paced(eligible: readonly Target[], load: LaneLoad | undefined): Paced {
  const room = load ? laneRoom(load) : Number.POSITIVE_INFINITY;
  const repos = new Set<string>();
  const targets: Target[] = [];
  const waiting: Target[] = [];
  for (const t of eligible) {
    if (repos.has(t.repo) || repos.size < room) {
      repos.add(t.repo);
      targets.push(t);
    } else waiting.push(t);
  }
  return { targets, waiting };
}

function inflight(load: LaneLoad | undefined, repo: string): string | undefined {
  return load?.inflight.find((l) => l.repo === repo)?.what;
}

// A fork to dispatch: behind main, no Sync Template running, and no PR already at main.
export function syncTargets(t: TemplateModel, load?: LaneLoad): Paced & { skipped: string[] } {
  const head = t.head?.sha;
  const eligible: Target[] = [];
  const skipped: string[] = [];
  for (const row of t.rows) {
    if (!head || !row.behind) continue;
    if (row.pr?.headMarker === head) continue;
    const mirror = mirrored(row.repo);
    if (mirror) {
      skipped.push(`${row.service} (${mirror})`);
      continue;
    }
    if (row.syncing || row.dispatched) {
      skipped.push(`${row.service} (Sync Template ${row.syncing ? "running" : "dispatched"})`);
      continue;
    }
    const busy = inflight(load, row.repo);
    if (busy) {
      skipped.push(`${row.service} (${busy})`);
      continue;
    }
    eligible.push({ repo: row.repo, kind: "workflow", state: "idle", label: row.service });
  }
  return { ...paced(eligible, load), skipped };
}

// Why Roll out leaves a fork's PR alone, or undefined when it is ready to merge.
export function heldBecause(row: TemplateRow): string | undefined {
  const pr = row.pr;
  if (!pr) return undefined;
  if (pr.draft) return "is a draft";
  const own = ownFailure(row);
  if (own) return `fails ${own.cls} ${own.check}`;
  if (row.failures.some((f) => !f.hidden && f.cls === "ENV")) return "is red on the stack";
  if (row.verdict === "pending") return "has checks running";
  if (row.verdict === "red") return "is red";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "has changes requested";
  if (pr.reviewDecision === "REVIEW_REQUIRED") return "needs review";
  if (pr.mergeState === "DIRTY") return "has conflicts";
  if (pr.mergeState === "BEHIND") return "is behind main";
  return undefined;
}

export function rolloutTargets(
  t: TemplateModel,
  load?: LaneLoad,
): Paced & { held: { row: TemplateRow; why: string }[] } {
  const targets: Target[] = [];
  const held: { row: TemplateRow; why: string }[] = [];
  for (const row of t.rows) {
    const pr = row.pr;
    if (!pr) continue;
    const mirror = mirrored(row.repo);
    const why =
      (mirror === "mirror"
        ? "is a mirror"
        : mirror
          ? "has its sync mode unread"
          : heldBecause(row)) ?? busyText(inflight(load, row.repo));
    if (why) {
      held.push({ row, why });
      continue;
    }
    targets.push({
      repo: row.repo,
      kind: "pr",
      number: pr.number,
      sha: pr.headSha,
      state: "open",
      label: `${row.service} #${pr.number}`,
    });
  }
  return { ...paced(targets, load), held };
}

function busyText(what: string | undefined): string | undefined {
  return what ? `has a lane in flight (${what})` : undefined;
}

const PLURAL_VERB: Record<string, string> = {
  is: "are",
  has: "have",
  needs: "need",
  fails: "fail",
};

function pluralVerb(why: string): string {
  const [verb, ...rest] = why.split(" ");
  return [PLURAL_VERB[verb as string] ?? verb, ...rest].join(" ");
}

export function heldText(held: readonly { row: TemplateRow; why: string }[]): string | undefined {
  if (held.length === 0) return undefined;
  const byWhy = new Map<string, string[]>();
  for (const h of held) {
    byWhy.set(h.why, [...(byWhy.get(h.why) ?? []), `${h.row.service} #${h.row.pr?.number}`]);
  }
  return [...byWhy.entries()]
    .map(([why, prs]) => `${names(prs)} ${prs.length > 1 ? pluralVerb(why) : why}`)
    .join("; ");
}

// What the cap means for this press, or nothing when the buttons are not paced.
export function paceText(load: LaneLoad | undefined, waiting: readonly Target[]): string[] {
  if (!load || load.cap === null) return [];
  const busy = load.inflight.map((l) => l.service);
  const lines = [
    `Paced to ${plural(load.cap, "lane")} on the shared environment: ${busy.length} in flight now${busy.length ? ` (${names(busy)})` : ""}, and a press only tops up to ${load.cap}.`,
  ];
  if (waiting.length > 0) {
    lines.push(
      `${plural(waiting.length, "more fork")} ${waiting.length === 1 ? "waits" : "wait"} for the next press: ${names(waiting.map((w) => w.label))}.`,
    );
  }
  return lines;
}

function fullText(load: LaneLoad | undefined, waiting: readonly Target[]): string | undefined {
  if (!load || load.cap === null || waiting.length === 0) return undefined;
  return `${load.inflight.length} of ${load.cap} lanes in flight; ${plural(waiting.length, "fork")} ${waiting.length === 1 ? "waits" : "wait"} for the next press`;
}

export function waitSuffix(waiting: readonly Target[]): string {
  return waiting.length > 0 ? ` · ${waiting.length} wait` : "";
}

export function rolloutActions(
  t: TemplateModel,
  binding: { swept: string },
  now: Date,
  blocked?: string,
  load?: LaneLoad,
): ActionItem[] {
  const item = ROLLOUT_ITEM;
  const sync = syncTargets(t, load);
  const head = t.steps[0]?.label ?? "main";
  const next = t.nextSync ? ` instead of at ${stamp(t.nextSync, now)}` : "";
  const syncDisabled =
    blocked ??
    (sync.targets.length === 0
      ? (fullText(load, sync.waiting) ??
        (sync.skipped.length > 0
          ? `nothing to dispatch: ${names(sync.skipped)}`
          : `every fork is on ${head} or its PR carries it`))
      : undefined);
  const roll = rolloutTargets(t, load);
  const held = heldText(roll.held);
  const rollDisabled =
    blocked ??
    (roll.targets.length === 0
      ? (fullText(load, roll.waiting) ??
        (t.rows.some((r) => r.pr) ? `nothing is ready: ${held}` : "no template-sync PR is open"))
      : undefined);
  const placeholder: Target = { repo: "Azure/osdu-spi", kind: "repo", label: "none" };
  const carried = [...new Set(t.rows.filter((r) => r.pr).map((r) => r.target ?? r.label))];
  return [
    verbAction(
      SYNC_FORKS,
      { item, swept: binding.swept, targets: sync.targets.length ? sync.targets : [placeholder] },
      {
        label: `Sync all forks · ${sync.targets.length}${waitSuffix(sync.waiting)}`,
        pending: `Dispatching ${sync.targets.length}…`,
        title: `Sync all forks · ${plural(sync.targets.length, "fork")}`,
        detail: [
          `Dispatches Sync Template on ${names(sync.targets.map((x) => x.label))}, so each template-sync PR moves to ${head} now${next}.`,
          ...paceText(load, sync.waiting),
          ...(sync.skipped.length ? [`Skipped: ${names(sync.skipped)}.`] : []),
          "A fork already on main, or whose PR carries it, is left alone.",
        ],
        ...(syncDisabled ? { disabled: syncDisabled } : {}),
      },
    ),
    verbAction(
      ROLL_OUT,
      { item, swept: binding.swept, targets: roll.targets.length ? roll.targets : [placeholder] },
      {
        label: `Roll out · ${roll.targets.length} ready${waitSuffix(roll.waiting)}`,
        pending: `Merging ${roll.targets.length}…`,
        title: `Roll out · ${plural(roll.targets.length, "template-sync PR")}`,
        detail: [
          `Merges ${names(roll.targets.map((x) => x.label))} into main with a merge commit${carried.length === 1 ? `, taking each fork to ${carried[0]}` : ""}.`,
          ...paceText(load, roll.waiting),
          ...(held ? [`Held back: ${held}.`] : []),
          "Each PR merges on its own; one that fails does not stop the others.",
        ],
        subject: {
          value: String(roll.targets.length),
          label: `Type ${roll.targets.length}: the number of PRs this merges into main`,
        },
        ...(rollDisabled ? { disabled: rollDisabled } : {}),
      },
    ),
  ];
}
