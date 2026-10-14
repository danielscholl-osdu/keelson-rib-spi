// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { OpHandle, RibActionResult } from "@keelson/shared";
import { LIFECYCLE_WORKFLOWS, STACK_REPO } from "../config.ts";
import type { LaneRun, QueueItem } from "../model/queue.ts";
import { attemptText, runName, type StackModel, stoppedAttempts } from "../model/stack.ts";
import { plural, stamp } from "../util.ts";
import { type ActionItem, type Binding, type Target, type Verb, verbAction } from "./verbs.ts";

export const RERUN_LANES: Verb = {
  id: "rerun",
  label: "Re-run lanes",
  command: (t) => ["run", "rerun", String(t.number), "--failed", "-R", t.repo],
};

export const DISPATCH_REFRESH: Verb = {
  id: "dispatch-env-refresh",
  label: "Re-dispatch env-refresh",
  command: (t) => ["workflow", "run", LIFECYCLE_WORKFLOWS.refresh, "-R", t.repo],
};

export const DISPATCH_UPGRADE: Verb = {
  id: "dispatch-env-upgrade",
  label: "Re-dispatch env-upgrade",
  command: (t) => ["workflow", "run", LIFECYCLE_WORKFLOWS.upgrade, "-R", t.repo],
};

export const WAIT_ACTION = "rerun-when-deployable";
export const NO_OPS = "this Keelson has no durable ops";

function names(list: readonly string[]): string {
  return list.length <= 1
    ? (list[0] ?? "")
    : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

export function laneTargets(lanes: readonly LaneRun[]): Target[] {
  const perPr = new Map<string, number>();
  for (const l of lanes) perPr.set(`${l.repo}#${l.pr}`, (perPr.get(`${l.repo}#${l.pr}`) ?? 0) + 1);
  return lanes.map((l) => ({
    repo: l.repo,
    kind: "run",
    number: l.runId,
    pr: l.pr,
    sha: l.headSha,
    state: "failure",
    label: `${l.service} #${l.pr}${(perPr.get(`${l.repo}#${l.pr}`) ?? 0) > 1 ? ` run ${l.runId}` : ""}`,
  }));
}

function steps(lanes: readonly LaneRun[]): string[] {
  return [...new Set(lanes.flatMap((l) => (l.step ? [l.step] : [])))];
}

// "schema #37 run 38481923150"; each lane's step is named only when they differ.
function laneLine(lanes: readonly LaneRun[]): string {
  const each = steps(lanes).length > 1;
  const list = lanes.map(
    (l) => `${l.service} #${l.pr} run ${l.runId}${each && l.step ? ` (${l.step})` : ""}`,
  );
  return `${lanes.length === 1 ? "Lane" : "Lanes"}: ${names(list)}.`;
}

function stepText(lanes: readonly LaneRun[]): string {
  const found = steps(lanes);
  const who = lanes.length === 1 ? "The lane" : "Each lane";
  return `${who} failed in ${found.length > 0 ? names(found) : "a step"}, on the shared stack rather than the code, so only the failed jobs run again.`;
}

export interface LaneOptions {
  swept: string;
  now: Date;
  blocked?: string;
  // The harness offers registerOp.
  ops: boolean;
  // A wait already holds this item.
  waiting?: { id: string; at: string };
}

// Re-run lanes while the stack is deployable; otherwise a wait that re-runs them once it is.
export function laneActions(item: QueueItem, stack: StackModel, opts: LaneOptions): ActionItem[] {
  const lanes = item.lanes ?? [];
  if (lanes.length === 0) return [];
  const targets = laneTargets(lanes);
  const binding = { item: item.id, swept: opts.swept, targets };
  const n = lanes.length;
  if (stack.deployable.state === "yes") {
    const since = stamp(stack.lastGreen?.updatedAt, opts.now);
    return [
      verbAction(RERUN_LANES, binding, {
        primary: true,
        label: `Re-run lanes · ${n}`,
        pending: `Re-running ${n}…`,
        title: `Re-run ${plural(n, "failed lane")}`,
        detail: [
          `The stack has been deployable${since ? ` since ${since}` : ""}. ${stepText(lanes)}`,
          laneLine(lanes),
        ],
        ...(opts.blocked ? { disabled: opts.blocked } : {}),
      }),
    ];
  }
  const disabled =
    opts.blocked ??
    (!opts.ops
      ? NO_OPS
      : opts.waiting
        ? `already waiting since ${stamp(opts.waiting.at, opts.now)} as op ${opts.waiting.id}; run_cancel drops it`
        : undefined);
  return [
    {
      ...verbAction(RERUN_LANES, binding, {
        primary: true,
        label: "Re-run when deployable",
        pending: "Setting the wait…",
        title: `Re-run ${plural(n, "failed lane")} when deployable`,
        detail: [
          `The stack is not deployable now (${stack.deployable.reason}). A wait holds ${n === 1 ? "this lane" : `these ${n} lanes`} and, on the first sweep that reads deployable, re-runs ${n === 1 ? "it" : "them"} through the same calls.`,
          "It stands down without writing if a lifecycle run fails again. A Keelson restart drops the wait and the item stays in the queue.",
          laneLine(lanes),
        ],
        ...(disabled ? { disabled } : {}),
      }),
      type: WAIT_ACTION,
    },
  ];
}

// The lifecycle run a person re-dispatches: the kind that last stopped, or refresh for a bare hold.
function primaryKind(item: QueueItem, stack: StackModel): "refresh" | "upgrade" {
  if (item.kind !== "stack") return "refresh";
  return stoppedAttempts(stack).at(-1)?.run.kind === "upgrade" ? "upgrade" : "refresh";
}

export function dispatchActions(
  item: QueueItem,
  stack: StackModel,
  opts: { swept: string; blocked?: string },
): ActionItem[] {
  if (item.kind !== "stack" && item.kind !== "maintenance") return [];
  const busy = stack.inflight
    ? `${runName(stack.inflight.run)} is ${stack.inflight.run.status === "queued" ? "queued" : "running"} in concurrency group env-shared`
    : undefined;
  const disabled = opts.blocked ?? busy;
  const primary = primaryKind(item, stack);
  const shared =
    "env-refresh and env-upgrade share concurrency group env-shared, so this is refused while either one is queued or running.";
  const target = (label: string): Target => ({
    repo: STACK_REPO,
    kind: "workflow",
    state: "idle",
    label,
  });
  const refresh = verbAction(
    DISPATCH_REFRESH,
    { item: item.id, swept: opts.swept, targets: [target("env-refresh")] },
    {
      primary: primary === "refresh",
      pending: "Dispatching…",
      title: "Re-dispatch env-refresh · osdu-spi-stack",
      detail: [
        "Runs env-refresh on the shared environment: quiesce, reconcile the pinned source, wait for Flux, probe the gateway, then reopen for deploys.",
        "It clears maintenance only after its probes pass; the board has no verb that clears maintenance directly.",
        shared,
      ],
      ...(disabled ? { disabled } : {}),
    },
  );
  const upgrade = verbAction(
    DISPATCH_UPGRADE,
    { item: item.id, swept: opts.swept, targets: [target("env-upgrade")] },
    {
      primary: primary === "upgrade",
      pending: "Dispatching…",
      title: "Re-dispatch env-upgrade · osdu-spi-stack",
      detail: [
        `Runs env-upgrade, which deploys the declared stackVersion${stack.declared ? ` ${stack.declared}` : ""} from ops/environments/shared.yaml onto the shared environment. It takes no inputs.`,
        "It clears maintenance only after its verify stage passes.",
        shared,
      ],
      ...(disabled ? { disabled } : {}),
    },
  );
  return primary === "upgrade" ? [upgrade, refresh] : [refresh, upgrade];
}

// Holds a Re-run lanes binding until a sweep reads the stack deployable, then runs it once.
export class DeployableWait {
  private readonly known: Set<number>;
  private busy = false;
  private said: string | undefined;
  settled = false;

  constructor(
    readonly op: OpHandle,
    readonly binding: Binding,
    readonly at: string,
    stack: StackModel,
    private readonly run: (binding: Binding) => Promise<RibActionResult>,
  ) {
    this.known = new Set(stoppedAttempts(stack).map((a) => a.run.id));
    op.progress(`waiting for deployable · ${stack.deployable.reason}`);
    this.said = stack.deployable.reason;
  }

  // True once the wait has acted, stood down or been cancelled.
  async wake(stack: StackModel): Promise<boolean> {
    if (this.settled) return true;
    if (this.op.signal.aborted) return this.settle();
    if (this.busy) return false;
    const again = stoppedAttempts(stack).find((a) => !this.known.has(a.run.id));
    if (again) {
      const message = `stood down: ${attemptText(again)}; no lane was re-run`;
      this.op.log(message);
      this.op.done({ outcome: "stood-down", message });
      return this.settle();
    }
    if (stack.deployable.state !== "yes") {
      if (stack.deployable.reason !== this.said) {
        this.said = stack.deployable.reason;
        this.op.progress(`waiting for deployable · ${stack.deployable.reason}`);
      }
      return false;
    }
    this.busy = true;
    this.op.progress(`deployable · re-running ${plural(this.binding.targets.length, "lane")}`);
    try {
      const res = await this.run(this.binding);
      if (this.op.signal.aborted) return this.settle();
      const message = res.ok ? ((res.data as { message?: string })?.message ?? "") : res.error;
      if (res.ok) this.op.done({ outcome: "re-ran", message });
      else this.op.error(message);
    } catch (err) {
      this.op.error(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy = false;
    }
    return this.settle();
  }

  drop(why: string): void {
    if (this.settled) return;
    this.op.error(why);
    this.settle();
  }

  private settle(): true {
    this.settled = true;
    return true;
  }
}
