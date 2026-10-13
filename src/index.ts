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
  type RibSurfaceBadge,
  type RibViewDescriptor,
  type SnapshotManager,
} from "@keelson/shared";
import { AGENTS, resolveAgent } from "./agent.ts";
import { attentionBoard, badge } from "./boards/attention.ts";
import { doctorBoard } from "./boards/doctor.ts";
import { linesBoard } from "./boards/lines.ts";
import { stackBoard } from "./boards/stack.ts";
import { INFLIGHT_POLL_MS, SWEEP_MS } from "./config.ts";
import { Gh } from "./forge.ts";
import {
  ATTENTION_KEY,
  BADGE_KEY,
  BOARD_KEYS,
  DOCTOR_KEY,
  LINES_KEY,
  RIB_ID,
  STACK_KEY,
} from "./keys.ts";
import { Store } from "./store.ts";
import { REFRESH_ACTION, SURFACES } from "./surfaces.ts";
import { Sweeper } from "./sweep.ts";
import { registerSpiTools } from "./tools.ts";

type Composer = (sweeper: Sweeper, now: Date) => CanvasBoardView;

const COMPOSERS: Record<(typeof BOARD_KEYS)[number], Composer> = {
  [ATTENTION_KEY]: (s, now) => attentionBoard(s.model, s.facts, now),
  [STACK_KEY]: (s, now) => stackBoard(s.model, now),
  [LINES_KEY]: (s, now) => linesBoard(s.model, now),
  [DOCTOR_KEY]: (s, now) => doctorBoard(s.facts, now),
};

function badgeOf(data: unknown): RibSurfaceBadge {
  const count = (data as RibSurfaceBadge | null)?.count;
  if (!Number.isInteger(count) || (count as number) < 0) {
    throw new Error(`${BADGE_KEY} expects a whole count`);
  }
  return data as RibSurfaceBadge;
}

let snapshots: SnapshotManager | undefined;
let sweeper: Sweeper | undefined;
let unregisters: Array<() => void> = [];
let timers: Array<ReturnType<typeof setInterval>> = [];

function recomposeAll(): void {
  for (const key of [...BOARD_KEYS, BADGE_KEY]) snapshots?.recompose(key).catch(() => undefined);
}

function bind(ctx: RibContext): Sweeper {
  unbind();
  snapshots = ctx.getSnapshotManager?.();
  const s = new Sweeper({
    exec: ctx.getExec(),
    store: new Store(ctx.getDataDir?.()),
    onChange: recomposeAll,
  });
  sweeper = s;
  const sm = snapshots;
  if (sm) {
    for (const key of BOARD_KEYS) {
      const compose = COMPOSERS[key];
      unregisters.push(
        sm.register(key, () => compose(s, s.now()), { validate: expectView(key, "board") }),
      );
    }
    unregisters.push(sm.register(BADGE_KEY, () => badge(s.model), { validate: badgeOf }));
  }
  recomposeAll();
  s.sweep({ force: true }).catch(() => undefined);
  const sweepTimer = setInterval(() => {
    s.sweep().catch(() => undefined);
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
}

const rib: Rib = {
  id: RIB_ID,
  displayName: "SPI",

  views: BOARD_KEYS.map(
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
