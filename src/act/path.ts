// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibActionResult, RibExec } from "@keelson/shared";
import { replayFile } from "../config.ts";
import { Gh } from "../forge.ts";
import { type LaneLoad, laneRoom } from "../model/lanes.ts";
import { clip, plural, pool } from "../util.ts";
import type { ActionLog, ActionResult } from "./log.ts";
import { changed, readTarget } from "./revalidate.ts";
import { type Binding, bindingSchema, type Target, type Verb, verbOf } from "./verbs.ts";

// Write concurrency only; how many forks a press may start is the lane cap.
const TARGETS_AT_ONCE = 5;

export interface ActDeps {
  exec: RibExec;
  log: ActionLog;
  // Reads the area again; the item leaves the queue only when that read shows the change.
  resweep: () => void;
  now: () => Date;
  // The lanes in flight as of the latest sweep and press, for a paced verb.
  lanes?: () => LaneLoad;
  // Counts the forks a paced verb just wrote to as in flight until a sweep sees their runs.
  hold?: (repos: string[], at: string) => void;
  // Why the shared environment takes no new lane as of the latest sweep, or undefined.
  held?: () => string | undefined;
}

function summary(label: string, results: readonly ActionResult[]): string {
  const done = results.filter((r) => r.outcome === "done").length;
  const waiting = results.filter((r) => r.outcome === "waiting");
  const parts = [`${label}: ${done} of ${results.length} done`];
  if (waiting.length > 0) {
    parts.push(
      `${plural(waiting.length, "target")} wait for the next press (${waiting[0]?.detail})`,
    );
  }
  for (const r of results) {
    if (r.outcome === "done" || r.outcome === "waiting") continue;
    parts.push(
      `${r.target} ${r.outcome === "refused" ? "skipped" : "failed"}${r.detail ? ` (${r.detail})` : ""}`,
    );
  }
  return parts.join(" · ");
}

export function parseBinding(payload: unknown): Binding | undefined {
  const parsed = bindingSchema.safeParse(
    payload && typeof payload === "object"
      ? Object.fromEntries(
          Object.entries(payload).filter(([k]) => ["verb", "item", "swept", "targets"].includes(k)),
        )
      : payload,
  );
  return parsed.success ? parsed.data : undefined;
}

// A paced verb starts at most the lane cap's room, in the binding's order, and never
// writes to a fork whose lane is already in flight; a press tops up, it does not add N.
export function paceTargets(
  targets: readonly Target[],
  load: LaneLoad,
): { go: Target[]; held: ActionResult[] } {
  const busy = new Set(load.inflight.map((l) => l.repo));
  const room = laneRoom(load);
  const claimed = load.claims?.length ?? 0;
  const started = new Set<string>();
  const go: Target[] = [];
  const held: ActionResult[] = [];
  for (const t of targets) {
    if (busy.has(t.repo)) {
      held.push({ target: t.label, outcome: "refused", detail: "its lane is already in flight" });
    } else if (!started.has(t.repo) && started.size >= room) {
      held.push({
        target: t.label,
        outcome: "waiting",
        detail: load.unread
          ? `lanes unknown until ${load.unread} are read`
          : `${load.inflight.length + claimed + started.size} of ${load.cap} lanes in flight${claimed ? " or claimed" : ""}`,
      });
    } else {
      started.add(t.repo);
      go.push(t);
    }
  }
  return { go, held };
}

// Paced presses run one at a time, so each reads the lanes the one before it held.
let pacedTurn: Promise<unknown> = Promise.resolve();

// Every write runs this path: parse the binding the board stamped, read each target
// again, write only to the ones that still match, log the outcome, then resweep.
export async function act(payload: unknown, deps: ActDeps): Promise<RibActionResult> {
  if (replayFile()) {
    return { ok: false, error: "replaying recorded facts (RIB_SPI_FACTS_FILE); nothing writes" };
  }
  const binding = parseBinding(payload);
  if (!binding) return { ok: false, error: "act needs the binding the board stamped" };
  const verb = verbOf(binding.verb);
  if (!verb) return { ok: false, error: `spi has no verb '${binding.verb}'` };
  if (!verb.paced) return write(binding, verb, deps);
  const turn = pacedTurn.then(() => write(binding, verb, deps));
  pacedTurn = turn.catch(() => undefined);
  return turn;
}

async function write(binding: Binding, verb: Verb, deps: ActDeps): Promise<RibActionResult> {
  const gh = new Gh(deps.exec);
  const hold = verb.paced ? deps.held?.() : undefined;
  const paced = hold
    ? {
        go: [],
        held: binding.targets.map((t) => ({
          target: t.label,
          outcome: "refused" as const,
          detail: `the environment is held: ${hold}`,
        })),
      }
    : verb.paced && deps.lanes
      ? paceTargets(binding.targets, deps.lanes())
      : { go: binding.targets, held: [] };
  // Targets are independent, so one slow or failing write does not hold the others.
  const written: ActionResult[] = await pool(paced.go, TARGETS_AT_ONCE, async (target) => {
    try {
      const why = changed(target, await readTarget(gh, target));
      if (why) return { target: target.label, outcome: "refused", detail: why };
    } catch (err) {
      return {
        target: target.label,
        outcome: "refused",
        detail: `could not read it again: ${clip(err instanceof Error ? err.message : String(err), 160)}`,
      };
    }
    const res = await deps.exec.runText("gh", verb.command(target), { timeoutMs: 60_000 });
    if (!res.ok) return { target: target.label, outcome: "failed", detail: clip(res.error, 200) };
    const then = verb.followUp?.(target);
    if (!then) return { target: target.label, outcome: "done" };
    const next = await deps.exec.runText("gh", then, { timeoutMs: 60_000 });
    return next.ok
      ? { target: target.label, outcome: "done" }
      : {
          target: target.label,
          outcome: "failed",
          detail: `the first write landed, the second failed: ${clip(next.error, 180)}`,
        };
  });
  const results = [...written, ...paced.held];
  const at = deps.now().toISOString();
  if (verb.paced) {
    const done = new Set(written.filter((r) => r.outcome === "done").map((r) => r.target));
    const repos = paced.go.filter((t) => done.has(t.label)).map((t) => t.repo);
    if (repos.length > 0) deps.hold?.([...new Set(repos)], at);
  }

  deps.log.append({
    at,
    verb: verb.id,
    label: verb.label,
    item: binding.item,
    results,
  });
  deps.resweep();

  const message = summary(verb.label, results);
  return results.some((r) => r.outcome === "done")
    ? { ok: true, data: { message } }
    : {
        ok: false,
        error: `${message}${results.every((r) => r.outcome === "refused") ? `; ${plural(results.length, "target")} changed, the board redraws` : ""}`,
      };
}
