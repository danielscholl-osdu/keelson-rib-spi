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
import { act } from "./act/path.ts";
import { type Readiness, readReadiness } from "./act/readiness.ts";
import { ACT_ACTION, registerVerb } from "./act/verbs.ts";
import { AGENTS, resolveAgent } from "./agent.ts";
import { attentionBoard, badge } from "./boards/attention.ts";
import { engineeringBoard, STEP_PREFIX } from "./boards/engineering.ts";
import { type InspectState, inspectBoard, inspectTitle, stepTitle } from "./boards/inspect.ts";
import { linesBoard } from "./boards/lines.ts";
import { stackBoard } from "./boards/stack.ts";
import { checkable, entryAcrossForks, type ForkEntry } from "./collect/filters.ts";
import { INFLIGHT_POLL_MS, SWEEP_MS } from "./config.ts";
import { Gh, Glab } from "./forge.ts";
import {
  ATTENTION_KEY,
  BADGE_KEY,
  BOARD_KEYS,
  ENGINEERING_KEY,
  INSPECT_KEY,
  LINES_KEY,
  RIB_ID,
  STACK_KEY,
} from "./keys.ts";
import type { QueueItem } from "./model/queue.ts";
import { Store } from "./store.ts";
import { INSPECT_ACTION, REFRESH_ACTION, SURFACES } from "./surfaces.ts";
import { Sweeper } from "./sweep.ts";
import { registerSpiTools } from "./tools.ts";

type Composer = (sweeper: Sweeper, now: Date) => CanvasBoardView;

// Filter files and upstream trees move slowly; one read serves repeat opens of a halt.
const OTHERS_TTL_MS = 10 * 60_000;

const VIEW_KEYS = [...BOARD_KEYS, INSPECT_KEY] as const;

let inspect: InspectState = {};
let actionLog = new ActionLog(undefined);
let readiness: Readiness | undefined;
const othersCache = new Map<string, { at: number; entries: ForkEntry[] }>();

const COMPOSERS: Record<(typeof VIEW_KEYS)[number], Composer> = {
  [ATTENTION_KEY]: (s, now) =>
    attentionBoard(s.model, s.facts, now, { selected: inspect.selected, act: readiness }),
  [STACK_KEY]: (s, now) => stackBoard(s.model, now),
  [ENGINEERING_KEY]: (s, now) => engineeringBoard(s.model, now, { selected: inspect.selected }),
  [LINES_KEY]: (s, now) => linesBoard(s.model, now),
  [INSPECT_KEY]: (s, now) =>
    inspectBoard(s.model, inspect, now, actionLog.lastFor(inspect.selected), {
      scopes: s.facts.auth.data?.gh.scopes,
    }),
};

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
  for (const key of [...VIEW_KEYS, BADGE_KEY]) snapshots?.recompose(key).catch(() => undefined);
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
    onChange: recomposeAll,
  });
  sweeper = s;
  unregisters.push(registerVerb(APPROVE_RUNS));
  const sm = snapshots;
  if (sm) {
    for (const key of VIEW_KEYS) {
      const compose = COMPOSERS[key];
      unregisters.push(
        sm.register(key, () => compose(s, s.now()), { validate: expectView(key, "board") }),
      );
    }
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
      snapshots?.recompose(ATTENTION_KEY).catch(() => undefined);
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

const rib: Rib = {
  id: RIB_ID,
  displayName: "SPI",

  views: VIEW_KEYS.map(
    (key): RibViewDescriptor => ({
      key,
      canvasKind: "view",
      title: `SPI: ${key.split(":").pop()}`,
    }),
  ),

  surfaces: SURFACES,

  // Composers bind here because this is the first hook that receives the context.
  registerTools: (ctx: RibContext) => registerSpiTools(bind(ctx)),

  onAction: async (action: RibAction): Promise<RibActionResult> => {
    const s = sweeper;
    if (!s) return { ok: false, error: "spi is not bound yet" };
    if (action.type === REFRESH_ACTION) {
      if (s.sweeping) return { ok: true, data: { message: "A sweep is already running" } };
      s.sweep({ force: true }).catch(() => undefined);
      return { ok: true, data: { message: "Sweeping GitHub and GitLab" } };
    }
    if (action.type === ACT_ACTION) {
      if (!exec) return { ok: false, error: "spi is not bound yet" };
      const result = await act(action.payload, {
        exec,
        log: actionLog,
        resweep: () => resweep(s),
        now: s.now,
      });
      snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
      return result;
    }
    if (action.type === INSPECT_ACTION) {
      const id = (action.payload as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string" || !id) {
        return { ok: false, error: "inspect payload must be { id: string }" };
      }
      if (id.startsWith(STEP_PREFIX)) {
        const title = stepTitle(s.model, id);
        if (!title) return { ok: false, error: "that ladder step has moved; the board redraws" };
        inspect = { selected: id };
        await snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
        snapshots?.recompose(ATTENTION_KEY).catch(() => undefined);
        snapshots?.recompose(ENGINEERING_KEY).catch(() => undefined);
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
      snapshots?.recompose(ATTENTION_KEY).catch(() => undefined);
      snapshots?.recompose(ENGINEERING_KEY).catch(() => undefined);
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
