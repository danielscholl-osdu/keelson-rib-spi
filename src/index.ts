// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  type CanvasBoardView,
  expectView,
  type Rib,
  type RibAction,
  type RibActionResult,
  type RibContext,
  type RibExec,
  type RibSurfaceBadge,
  type RibViewDescriptor,
  type SnapshotManager,
} from "@keelson/shared";
import { APPROVE_RUNS } from "./act/approve.ts";
import { ActionLog } from "./act/log.ts";
import { act, parseBinding } from "./act/path.ts";
import { type Readiness, readReadiness } from "./act/readiness.ts";
import {
  DeployableWait,
  DISPATCH_REFRESH,
  DISPATCH_UPGRADE,
  NO_OPS,
  RERUN_LANES,
  WAIT_ACTION,
} from "./act/rerun.ts";
import { ROLL_OUT, ROLLOUT_ITEM, SYNC_FORKS } from "./act/rollout.ts";
import { ACT_ACTION, registerVerb } from "./act/verbs.ts";
import { AGENTS, resolveAgent } from "./agent.ts";
import { badge } from "./boards/badge.ts";
import { consoleHtml, expectHtml } from "./boards/console.ts";
import { DOCTOR_ID, doctorBoard, doctorStatus } from "./boards/doctor.ts";
import { type InspectState, inspectBoard, inspectTitle, stepTitle } from "./boards/inspect.ts";
import { MR_PREFIX, mrTitle } from "./boards/radar.ts";
import { STEP_PREFIX } from "./boards/template.ts";
import { buildBriefing } from "./brief/index.ts";
import { checkable, entryAcrossForks, type ForkEntry } from "./collect/filters.ts";
import { FORKS, INFLIGHT_POLL_MS, SWEEP_MS } from "./config.ts";
import { Gh, Glab } from "./forge.ts";
import { BADGE_KEY, CONSOLE_KEY, INSPECT_KEY, RIB_ID } from "./keys.ts";
import type { QueueItem } from "./model/queue.ts";
import { Store } from "./store.ts";
import { INSPECT_ACTION, REFRESH_ACTION, SURFACES } from "./surfaces.ts";
import { Sweeper } from "./sweep.ts";
import { registerSpiTools } from "./tools.ts";

type Composer = (sweeper: Sweeper, now: Date) => CanvasBoardView;

// Filter files and upstream trees move slowly; one read serves repeat opens of a halt.
const OTHERS_TTL_MS = 10 * 60_000;

const VIEW_KEYS = [INSPECT_KEY] as const;

let inspect: InspectState = {};
let actionLog = new ActionLog(undefined);
let readiness: Readiness | undefined;
const othersCache = new Map<string, { at: number; entries: ForkEntry[] }>();
// Re-run waits by queue item, in memory only: a restart drops them and the item stays queued.
const waits = new Map<string, DeployableWait>();

const COMPOSERS: Record<(typeof VIEW_KEYS)[number], Composer> = {
  [INSPECT_KEY]: (s, now) =>
    inspect.selected === DOCTOR_ID
      ? doctorBoard(s.facts, now, readiness)
      : inspectBoard(s.model, inspect, now, actionLog.lastFor(lastKey(inspect.selected)), {
          scopes: s.facts.auth.data?.gh.scopes,
          ops: !!context?.registerOp,
          ...waitingFor(inspect.selected),
        }),
};

// Rollout verbs log under one item, whichever template-set id the inspector shows.
function lastKey(selected: string | undefined): string | undefined {
  return selected === "template-set" ? ROLLOUT_ITEM : selected;
}

function badgeOf(data: unknown): RibSurfaceBadge {
  const count = (data as RibSurfaceBadge | null)?.count;
  if (!Number.isInteger(count) || (count as number) < 0) {
    throw new Error(`${BADGE_KEY} expects a whole count`);
  }
  return data as RibSurfaceBadge;
}

let snapshots: SnapshotManager | undefined;
let context: RibContext | undefined;
let sweeper: Sweeper | undefined;
let exec: RibExec | undefined;
let unregisters: Array<() => void> = [];
let timers: Array<ReturnType<typeof setInterval>> = [];

function recomposeAll(): void {
  for (const key of [...VIEW_KEYS, CONSOLE_KEY, BADGE_KEY]) {
    snapshots?.recompose(key).catch(() => undefined);
  }
}

function waitingFor(id: string | undefined): { waiting?: { id: string; at: string } } {
  const w = id ? waits.get(id) : undefined;
  return w && !w.settled ? { waiting: { id: w.op.id, at: w.at } } : {};
}

function wakeWaits(s: Sweeper): void {
  for (const [item, w] of waits) {
    w.wake(s.model.stack)
      .then((over) => {
        if (!over || waits.get(item) !== w) return;
        waits.delete(item);
        snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
      })
      .catch(() => undefined);
  }
}

function actDeps(s: Sweeper, run: RibExec) {
  return { exec: run, log: actionLog, resweep: () => resweep(s), now: s.now };
}

function bind(ctx: RibContext): Sweeper {
  unbind();
  snapshots = ctx.getSnapshotManager?.();
  context = ctx;
  exec = ctx.getExec();
  actionLog = new ActionLog(ctx.getDataDir?.());
  const s = new Sweeper({
    exec,
    store: new Store(ctx.getDataDir?.()),
    onChange: () => {
      recomposeAll();
      if (sweeper) wakeWaits(sweeper);
    },
  });
  sweeper = s;
  unregisters.push(
    registerVerb(APPROVE_RUNS),
    registerVerb(SYNC_FORKS),
    registerVerb(ROLL_OUT),
    registerVerb(RERUN_LANES),
    registerVerb(DISPATCH_REFRESH),
    registerVerb(DISPATCH_UPGRADE),
  );
  const sm = snapshots;
  if (sm) {
    for (const key of VIEW_KEYS) {
      const compose = COMPOSERS[key];
      unregisters.push(
        sm.register(key, () => compose(s, s.now()), { validate: expectView(key, "board") }),
      );
    }
    unregisters.push(
      sm.register(
        CONSOLE_KEY,
        () => {
          const now = s.now();
          return consoleHtml(buildBriefing(s.model, doctorStatus(s.facts, now), now), now);
        },
        { validate: expectHtml },
      ),
    );
    unregisters.push(sm.register(BADGE_KEY, () => badge(s.model), { validate: badgeOf }));
  }
  recomposeAll();
  s.sweep({ force: true }).catch(() => undefined);
  refreshReadiness();
  const sweepTimer = setInterval(() => {
    s.sweep().catch(() => undefined);
    refreshReadiness();
  }, SWEEP_MS);
  const pollTimer = setInterval(() => {
    if (s.hasInflight()) s.pollInflight().catch(() => undefined);
  }, INFLIGHT_POLL_MS);
  sweepTimer.unref?.();
  pollTimer.unref?.();
  timers = [sweepTimer, pollTimer];
  return s;
}

function unbind(): void {
  for (const w of waits.values()) w.drop("the SPI rib was unloaded; the wait is dropped");
  waits.clear();
  for (const un of unregisters) un();
  unregisters = [];
  for (const t of timers) clearInterval(t);
  timers = [];
  snapshots = undefined;
  sweeper = undefined;
  context = undefined;
  readiness = undefined;
  exec = undefined;
  inspect = {};
  othersCache.clear();
}

function refreshReadiness(): void {
  const ctx = context;
  if (!ctx || !exec) return;
  readReadiness(exec, ctx.getProjects?.())
    .then((r) => {
      if (context !== ctx) return;
      readiness = r;
      snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
    })
    .catch(() => undefined);
}

// A sweep already running may have read before the write landed, so wait it out
// and read again.
function resweep(s: Sweeper): void {
  (async () => {
    if (s.sweeping) await s.sweep().catch(() => undefined);
    await s.sweep({ force: true }).catch(() => undefined);
  })();
}

function othersKey(item: QueueItem): string | undefined {
  if (!checkable(item.halt)) return undefined;
  return `${item.halt.fork}:${item.halt.code}:${item.halt.entries.join(",")}`;
}

function cachedOthers(item: QueueItem, now: number): ForkEntry[] | undefined {
  const key = othersKey(item);
  const hit = key ? othersCache.get(key) : undefined;
  return hit && now - hit.at < OTHERS_TTL_MS ? hit.entries : undefined;
}

// Reads the other forks after the drawer is open, and fills them in only if the
// operator is still looking at the same item.
function readOthers(item: QueueItem): void {
  const key = othersKey(item);
  const run = exec;
  if (!key || !run || !checkable(item.halt)) return;
  entryAcrossForks(new Gh(run), new Glab(run), item.halt)
    .then((entries) => {
      othersCache.set(key, { at: Date.now(), entries });
      if (inspect.selected !== item.id) return;
      inspect = { ...inspect, reading: undefined, others: { id: item.id, entries } };
    })
    .catch(() => {
      if (inspect.selected === item.id) inspect = { ...inspect, reading: undefined };
    })
    .finally(() => {
      if (inspect.selected === item.id) snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
    });
}

// The op holds the binding stamped at click time and acts through act() once deployable.
function startWait(s: Sweeper, payload: unknown): RibActionResult {
  const ctx = context;
  const run = exec;
  if (!ctx || !run) return { ok: false, error: "spi is not bound yet" };
  if (!ctx.registerOp) return { ok: false, error: NO_OPS };
  const binding = parseBinding(payload);
  if (!binding || binding.verb !== RERUN_LANES.id) {
    return { ok: false, error: "the wait needs the Re-run lanes binding the board stamped" };
  }
  if (s.model.stack.deployable.state === "yes") {
    return { ok: false, error: "the stack is deployable now; the board redraws with Re-run lanes" };
  }
  const held = waits.get(binding.item);
  if (held && !held.settled) {
    return { ok: false, error: `a wait already holds this item as op ${held.op.id}` };
  }
  const n = binding.targets.length;
  const op = ctx.registerOp({
    kind: WAIT_ACTION,
    title: `Re-run ${n === 1 ? "1 fork lane" : `${n} fork lanes`} when the stack is deployable`,
  });
  const wait = new DeployableWait(op, binding, s.now().toISOString(), s.model.stack, (b) =>
    act(b, actDeps(s, run)),
  );
  waits.set(binding.item, wait);
  op.signal.addEventListener("abort", () => {
    if (waits.get(binding.item) !== wait) return;
    wait.wake(s.model.stack).catch(() => undefined);
    waits.delete(binding.item);
    snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
  });
  snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
  return {
    ok: true,
    data: {
      message: `Waiting for the stack to read deployable as op ${op.id}; run_cancel drops it`,
    },
  };
}

const rib: Rib = {
  id: RIB_ID,
  displayName: "SPI",

  views: [
    { key: CONSOLE_KEY, canvasKind: "html", title: "SPI console" },
    ...VIEW_KEYS.map(
      (key): RibViewDescriptor => ({
        key,
        canvasKind: "view",
        title: `SPI: ${key.split(":").pop()}`,
      }),
    ),
  ],

  surfaces: SURFACES,

  // Composers bind here because this is the first hook that receives the context.
  registerTools: (ctx: RibContext) => registerSpiTools(bind(ctx)),

  onAction: async (action: RibAction): Promise<RibActionResult> => {
    const s = sweeper;
    if (!s) return { ok: false, error: "spi is not bound yet" };
    // Console markup is untrusted by contract: it may select and open the inspector, never act.
    if (action.origin === "canvas-html" && action.type !== INSPECT_ACTION) {
      return { ok: false, error: "the console only opens the inspector; act from its buttons" };
    }
    if (action.type === REFRESH_ACTION) {
      if (s.sweeping) return { ok: true, data: { message: "A sweep is already running" } };
      s.sweep({ force: true }).catch(() => undefined);
      return { ok: true, data: { message: "Sweeping GitHub and GitLab" } };
    }
    if (action.type === ACT_ACTION) {
      if (!exec) return { ok: false, error: "spi is not bound yet" };
      const started = s.now().toISOString();
      const result = await act(action.payload, actDeps(s, exec));
      const entry = actionLog.lastFor(ROLLOUT_ITEM);
      if (entry?.verb === SYNC_FORKS.id && entry.at >= started) {
        const done = new Set(
          entry.results.filter((r) => r.outcome === "done").map((r) => r.target),
        );
        s.expectTemplateRuns(
          FORKS.filter((f) => done.has(f.id)).map((f) => f.repo),
          entry.at,
        );
      }
      snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
      return result;
    }
    if (action.type === WAIT_ACTION) {
      return startWait(s, action.payload);
    }
    if (action.type === INSPECT_ACTION) {
      const id = (action.payload as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string" || !id) {
        return { ok: false, error: "inspect payload must be { id: string }" };
      }
      if (id === DOCTOR_ID) {
        inspect = { selected: DOCTOR_ID };
        await snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
        return {
          ok: true,
          data: {
            effect: "open-canvas" as const,
            key: INSPECT_KEY,
            title: "Doctor",
            placement: "side" as const,
          },
        };
      }
      if (id.startsWith(STEP_PREFIX) || id.startsWith(MR_PREFIX)) {
        const title = id.startsWith(MR_PREFIX) ? mrTitle(s.model, id) : stepTitle(s.model, id);
        if (!title) return { ok: false, error: `${id} has moved; the board redraws` };
        inspect = { selected: id };
        await snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
        return {
          ok: true,
          data: {
            effect: "open-canvas" as const,
            key: INSPECT_KEY,
            title,
            placement: "side" as const,
          },
        };
      }
      const item = s.model.queue.items.find((i) => i.id === id);
      if (!item) return { ok: false, error: `${id} has left the queue; the board redraws` };
      const entries = cachedOthers(item, Date.now());
      const read = !entries && !!othersKey(item);
      inspect = {
        selected: id,
        item,
        ...(entries ? { others: { id, entries } } : {}),
        ...(read ? { reading: id } : {}),
      };
      // The drawer opens on this snapshot, so it must hold the item just clicked.
      await snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
      if (read) readOthers(item);
      return {
        ok: true,
        data: {
          effect: "open-canvas" as const,
          key: INSPECT_KEY,
          title: inspectTitle(item),
          placement: "side" as const,
        },
      };
    }
    return { ok: false, error: `spi does not handle '${action.type}'` };
  },

  listAgents: () => AGENTS,
  resolveAgent: (slug) => resolveAgent(slug),

  authStatus: async (ctx) => {
    const status = await new Gh(ctx.getExec()).status();
    return { authenticated: status.ok, statusMessage: status.detail };
  },

  dispose: () => {
    unbind();
  },
};

export default rib;
