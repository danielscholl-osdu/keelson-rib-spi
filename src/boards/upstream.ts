// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { forkActions, planActions, type UpstreamActions } from "../act/upstream.ts";
import {
  carriesText,
  LINE_COLUMNS,
  planOrder,
  stepWhy,
  tag,
  upstreamView,
} from "../brief/upstream.ts";
import type { Model } from "../model/index.ts";
import type { Cell, CellTone } from "../model/rollout.ts";
import {
  planStep,
  UPSTREAM_ITEM,
  UPSTREAM_PREFIX,
  type UpFork,
  type UpstreamModel,
} from "../model/upstream.ts";
import { INSPECT_ACTION } from "../surfaces.ts";
import { names, plural, stamp, whose } from "../util.ts";

type Section = CanvasBoardView["sections"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type BadgeTone = "caution" | "error" | "info" | "neutral" | "ok" | "warn";

const CELL_TONE: Record<CellTone, BadgeTone> = {
  ok: "ok",
  run: "info",
  warn: "caution",
  bad: "error",
  idle: "neutral",
};

export interface UpstreamBoardOptions {
  blocked?: string;
  extra?: Section[];
}

function badge(c: Cell) {
  return c.text === "·"
    ? { value: "·" }
    : {
        badges: [{ text: c.text.replace(/ /g, " "), tone: CELL_TONE[c.tone] }],
        ...(c.url ? { href: c.url } : {}),
      };
}

function inspectRow(id: string): Pick<Row, "action"> {
  return { action: { type: INSPECT_ACTION, payload: { id } } };
}

// The words a one-word pill leaves out, one line per fork that has any.
function lineNotes(forks: readonly UpFork[]): Section | undefined {
  const items = forks.flatMap((f) => {
    const why =
      f.stop?.error ??
      f.wait ??
      f.planWait ??
      [f.cells.toMain, f.cells.main, f.cells.cascade, f.cells.sync].find((c) => c.note)?.note;
    return why
      ? [{ text: f.service, trailing: why, ...inspectRow(`${UPSTREAM_PREFIX}${f.service}`) }]
      : [];
  });
  return items.length > 0 ? { kind: "rows", title: "Why each fork waits", items } : undefined;
}

// The radar's buckets for the queued commits, the same words the rollout's reach list uses.
function carriesSection(model: Model, f: UpFork): Section | undefined {
  const svc = model.radar.services[f.service];
  if (!svc || !f.behind) return undefined;
  const items = svc.certain.map((v) => ({
    chip: {
      label: v.bucket,
      tone: v.bucket === "Halt" ? ("error" as const) : ("neutral" as const),
    },
    text: v.value ?? v.entry ?? plural(v.paths.length, "path"),
    trailing: plural(v.paths.length, "path"),
  }));
  if (items.length === 0) return undefined;
  return {
    kind: "rows",
    title: `What the next sync carries · ${plural(f.behind, "commit")}`,
    items,
  };
}

function lineTable(forks: readonly UpFork[], title: string): Section {
  return {
    kind: "table",
    title,
    columns: [
      { key: "fork", label: "Fork" },
      { key: "sync", label: LINE_COLUMNS[0] as string },
      { key: "cascade", label: LINE_COLUMNS[1] as string },
      { key: "toMain", label: LINE_COLUMNS[2] as string },
      { key: "main", label: LINE_COLUMNS[3] as string },
    ],
    rows: forks.map((f) => ({
      fork: { value: f.service, href: f.url },
      sync: badge(f.cells.sync),
      cascade: badge(f.cells.cascade),
      toMain: badge(f.cells.toMain),
      main: badge(f.cells.main),
    })),
  };
}

function laneMeter(u: UpstreamModel): Section | undefined {
  if (u.lanes.cap === null) return undefined;
  return {
    kind: "bars",
    title: "Lanes on the shared environment",
    items: [
      {
        label: "Lanes",
        value: u.lanes.unread ? null : u.lanes.busy,
        total: u.lanes.cap,
        trailing: u.lanes.unread
          ? `unknown until ${u.lanes.unread} are read`
          : `${u.lanes.busy} of ${u.lanes.cap} busy${u.lanes.claims ? ` · ${plural(u.lanes.claims, "cascade")} claiming` : ""}${u.lanes.holders.length ? ` · ${names(u.lanes.holders)}` : ""}`,
      },
    ],
  };
}

function nextCard(
  title: string,
  why: string,
  verbs: UpstreamActions,
  links: { value: string; href: string }[],
  edge: CanvasTone,
): Section {
  return {
    kind: "cards",
    title: "Next step",
    items: [
      {
        title,
        edge,
        fields: [
          ...(why ? [{ label: "", value: why }] : []),
          ...links.map((l) => ({ label: "", value: l.value, href: l.href })),
        ],
        actions: [verbs.primary, ...verbs.secondary],
      },
    ],
  };
}

function stepsSection(): Section {
  return {
    kind: "rows",
    title: "What each fork goes through",
    items: [
      {
        chip: { label: "you · rib", tone: "ok" },
        text: "Prepare",
        trailing: "Dispatch Sync Upstream. Opens a sync PR into fork_upstream. No lane.",
      },
      {
        chip: { label: "you · rib", tone: "ok" },
        text: "Start",
        trailing: "Merge the sync PR. The rib dispatches the cascade at once, no 6 hour wait.",
      },
      {
        chip: { label: "automatic", tone: "neutral" },
        text: "Cascade",
        trailing: "Merges into fork_integration and builds with the Azure provider. No lane.",
      },
      {
        chip: { label: "you · GitHub", tone: "caution" },
        text: "Review",
        trailing: "Approve the Sync to Main PR. Its validation takes a lane; it auto-merges green.",
      },
      {
        chip: { label: "automatic", tone: "neutral" },
        text: "Main run",
        trailing: "Takes a lane. Green ends the fork; its release PR waits for Releases.",
      },
      {
        glyph: "neutral",
        text: "You press three times per fork: Prepare, Start, and the review on GitHub. A plan batches the first two across a wave.",
      },
    ],
  };
}

function wavesSection(u: UpstreamModel): Section | undefined {
  const rows: Record<string, string>[] = [];
  if (u.pilot.length > 0) {
    rows.push({ wave: "Pilot", forks: u.pilot.join(", "), starts: "you press Start" });
  }
  for (const w of u.waves) {
    rows.push({
      wave: w.name,
      forks: w.forks.join(", "),
      starts: w.gate ?? "open now: Start tops up to the free lanes",
    });
  }
  if (u.held.length > 0) {
    rows.push({
      wave: "Held",
      forks: u.held.map((f) => f.service).join(", "),
      starts: "each fork's blocker clears",
    });
  }
  if (rows.length === 0) return undefined;
  return {
    kind: "table",
    title: "Waves",
    columns: [
      { key: "wave", label: "Wave" },
      { key: "forks", label: "Forks" },
      { key: "starts", label: "Starts when" },
    ],
    rows,
  };
}

function heldSection(u: UpstreamModel): Section | undefined {
  if (u.held.length === 0) return undefined;
  return {
    kind: "rows",
    title: "Held, and what clears it",
    items: u.held.map((f) =>
      f.held === "snapshot"
        ? {
            chip: { label: "SNAPSHOT", tone: "caution" as const },
            text: f.service,
            trailing: `upstream moved to ${f.snapshot}; clears when upstream pins a release, or take it anyway from ${whose(f.service)} inspector`,
            ...inspectRow(`${UPSTREAM_PREFIX}${f.service}`),
          }
        : {
            chip: { label: "filter", tone: "error" as const },
            text: f.service,
            trailing: `the sync halts on ${f.halt?.entry ?? "an unlisted entry"}; clears when the fork's filter carries a rule for it`,
            ...(f.halt?.url ? { href: f.halt.url } : {}),
          },
    ),
  };
}

function scheduleSection(u: UpstreamModel, now: Date): Section | undefined {
  const s = upstreamView(u, now).schedule;
  if (!s) return undefined;
  return {
    kind: "rows",
    title: "Schedule",
    items: [
      { chip: { label: stamp(u.schedule.upstream, now) ?? "?", tone: "neutral" }, text: s.text },
      {
        glyph: "neutral",
        text: "A sync PR the schedule opens is adopted as Prepared; a fork already in the plan keeps its PR, updated in place.",
      },
    ],
  };
}

function serviceSection(u: UpstreamModel): Section {
  return {
    kind: "rows",
    title: "One service",
    items: u.forks
      .filter((f) => f.phase !== "current" && f.phase !== "unread")
      .map((f) => ({
        text: f.service,
        trailing: [tag(f), f.cells.sync.text !== "·" ? f.cells.sync.text : carriesText(f)]
          .filter(Boolean)
          .join(" · "),
        ...inspectRow(`${UPSTREAM_PREFIX}${f.service}`),
      })),
  };
}

export function upstreamPlanBoard(
  model: Model,
  now: Date,
  opts: UpstreamBoardOptions = {},
): CanvasBoardView {
  const u = model.upstream;
  const view = upstreamView(u, now);
  const step = planStep(u);
  const verbs = planActions(u, {
    swept: model.sweptAt ?? "",
    load: model.lanes,
    now,
    ...(opts.blocked ? { blocked: opts.blocked } : {}),
  });
  const planned = u.pilot.length + u.waves.reduce((n, w) => n + w.forks.length, 0);
  const waves = (u.pilot.length > 0 ? 1 : 0) + u.waves.length;
  const sub = [
    plural(u.commits, "commit"),
    u.pilot.length > 0 ? "pilot first" : undefined,
    u.held.length > 0 ? `${plural(u.held.length, "fork")} held` : undefined,
    u.lanes.cap !== null ? `${plural(u.needed, "lane")}, ${u.lanes.cap} at a time` : "unpaced",
  ]
    .filter(Boolean)
    .join(" · ");
  const links = [
    ...u.reviews.map((f) => ({
      value: `Review ${whose(f.service)} Sync to Main #${f.toMain?.number} on GitHub`,
      href: f.toMain?.url as string,
    })),
  ];
  const targets = step.forks.map((f) => f.repo);
  const sections: Section[] = [
    { kind: "rows", items: [{ text: sub }, { text: view.headline }] },
    nextCard(
      `${view.next.title}.`,
      [stepWhy(u, step, now), targets.length ? `Touches ${targets.join(", ")}.` : ""]
        .filter(Boolean)
        .join(" "),
      verbs,
      links,
      u.paused || u.stops.length > 0 ? "error" : "brand",
    ),
  ];
  if (u.paused) {
    sections.push({
      kind: "rows",
      title: "Paused: absorb the move",
      items: [
        {
          glyph: "error",
          text: `${names(u.paused.forks)} failed the cascade with the same first error`,
          trailing: u.paused.error,
        },
        ...u.forks
          .filter((f) => f.verb === "start" || f.verb === "prepare")
          .map((f) => ({
            chip: { label: "absorb", tone: "caution" as const },
            text: f.service,
            trailing: "absorb the move on main before its cascade",
            ...inspectRow(`${UPSTREAM_PREFIX}${f.service}`),
          })),
      ],
    });
  }
  const meter = laneMeter(u);
  if (meter) sections.push(meter);
  const shown = planOrder(u).filter((f) => f.phase !== "current" && f.phase !== "unread");
  sections.push(lineTable(shown, `Forks · ${plural(planned, "fork")} in ${plural(waves, "wave")}`));
  const notes = lineNotes(shown);
  if (notes) sections.push(notes);
  const w = wavesSection(u);
  if (w) sections.push(w);
  const held = heldSection(u);
  if (held) sections.push(held);
  if (u.mode !== "flight") sections.push(stepsSection());
  const sched = scheduleSection(u, now);
  if (sched) sections.push(sched);
  sections.push({
    kind: "rows",
    title: "Lanes",
    items: [
      {
        text: `Sync PRs and cascades build on GitHub runners and take no lane. Sync to Main and the main run take one each: ${plural(u.needed, "lane")} to go${u.lanes.cap !== null ? `, ${u.lanes.cap} at a time` : ""}, in one ledger with the template rollout.`,
      },
    ],
  });
  sections.push(serviceSection(u));
  sections.push(...(opts.extra ?? []));
  return {
    view: "board",
    title: `Sync ${plural(planned, "fork")} from upstream in ${plural(waves, "wave")}`,
    header: {
      status: {
        label: u.paused ? "UPSTREAM PLAN PAUSED" : "UPSTREAM PLAN",
        tone: u.paused ? "error" : "caution",
      },
      chip: `fleet · ${u.mode === "flight" ? "in flight" : "plan"}`,
    },
    sections,
  };
}

const PHASE_LABEL: Record<UpFork["phase"], { label: string; tone: CanvasTone }> = {
  unread: { label: "UNREAD", tone: "neutral" },
  current: { label: "CURRENT", tone: "ok" },
  idle: { label: "BEHIND UPSTREAM", tone: "caution" },
  halted: { label: "SYNC HALTS", tone: "error" },
  preparing: { label: "PREPARING", tone: "info" },
  prepared: { label: "PREPARED", tone: "caution" },
  merged: { label: "CASCADE OWED", tone: "caution" },
  cascading: { label: "IN CASCADE", tone: "info" },
  stopped: { label: "P1 · CASCADE STOPPED", tone: "error" },
  review: { label: "SYNC TO MAIN", tone: "caution" },
  main: { label: "MAIN RUN", tone: "info" },
  red: { label: "MAIN RED", tone: "error" },
  done: { label: "ON MAIN", tone: "ok" },
};

function forkTitle(f: UpFork): string {
  switch (f.phase) {
    case "stopped":
      return `${whose(f.service)} cascade ${f.stop?.label ?? "stopped"}`;
    case "idle":
      return `${f.service} is ${plural(f.behind ?? 0, "commit")} behind upstream`;
    case "halted":
      return `${whose(f.service)} next sync halts on ${f.halt?.entry ?? "an unlisted entry"}`;
    case "prepared":
      return `${whose(f.service)} sync PR #${f.syncPr?.number} is prepared`;
    case "merged":
      return `${whose(f.service)} sync PR merged; the cascade has not run`;
    case "cascading":
      return `${whose(f.service)} cascade is running`;
    case "review":
      return `${whose(f.service)} Sync to Main #${f.toMain?.number} is open`;
    case "main":
      return `${whose(f.service)} main run is testing`;
    case "red":
      return `${whose(f.service)} main run went red after Sync to Main`;
    case "done":
      return `${f.service} is on main`;
    default:
      return f.service;
  }
}

function forkNext(u: UpstreamModel, f: UpFork): { title: string; why: string } {
  const sameMove = u.forks.filter((o) => o !== f && ["review", "main", "done"].includes(o.phase));
  switch (f.verb) {
    case "prepare":
      return {
        title: "Prepare: dispatch Sync Upstream",
        why: "Opens a sync PR into fork_upstream with the filtered tree and a tracking issue. Nothing merges, and no lane is taken.",
      };
    case "start":
      return {
        title: `Start: merge #${f.syncPr?.number}, then dispatch the cascade`,
        why: "The cascade merges main and upstream into fork_integration and builds core and azure. A green one opens a Sync to Main PR that borrows a lane.",
      };
    case "dispatch":
      return {
        title: "Dispatch the cascade",
        why: "The sync PR merged and no cascade ran. The monitor would dispatch it within 6 hours; this runs it now.",
      };
    case "rerun":
      return f.wait
        ? {
            title: `Fix ${f.service} on fork_integration, then re-run the cascade`,
            why:
              sameMove.length > 0 && f.stop?.label === "build failed"
                ? `${names(sameMove.map((o) => o.service))} took the same move green, so this is ${whose(f.service)} own provider code, not the toolchain. A fix lands as a PR into fork_integration.`
                : "A fix lands as a PR into fork_integration; Re-run opens once it does.",
          }
        : {
            title: "Re-run the cascade",
            why: "A fix landed on fork_integration after the failure.",
          };
    case "review":
      return {
        title: `Review Sync to Main #${f.toMain?.number} on GitHub`,
        why: "Its validation borrows a lane, and it auto-merges once approved and green. The rib never approves.",
      };
    default:
      return { title: forkTitle(f), why: f.wait ?? f.planWait ?? "" };
  }
}

function failedSection(u: UpstreamModel, f: UpFork, now: Date): Section | undefined {
  const s = f.stop;
  if (!s) return undefined;
  const passed = u.forks
    .filter((o) => ["review", "main", "done"].includes(o.phase))
    .map((o) => o.service);
  const same = u.stops.filter((o) => o !== f && o.stop?.error && o.stop.error === s.error);
  return {
    kind: "cards",
    title: "What failed",
    items: [
      {
        title: f.service,
        edge: "error",
        fields: [
          {
            label: "Stage",
            value: [s.run?.name ?? "Cascade Integration", s.job?.name, s.job?.failedStep]
              .filter(Boolean)
              .join(" · "),
            ...(s.job?.url || s.run?.url ? { href: (s.job?.url ?? s.run?.url) as string } : {}),
          },
          ...(s.issue
            ? [{ label: "Issue", value: `#${s.issue.number} ${s.issue.title}`, href: s.issue.url }]
            : []),
          { label: "First error", value: s.error ?? "unread" },
          {
            label: "Failed",
            value: stamp(s.run?.updatedAt, now) ?? "?",
          },
          {
            label: "Same cause",
            value:
              same.length > 0
                ? `${names(same.map((o) => o.service))}: the wave pauses`
                : `none${passed.length > 0 ? ` · ${names(passed)} passed the cascade` : ""}`,
          },
          {
            label: "fork_integration",
            value:
              s.fixLanded === null
                ? "not read yet"
                : s.fixLanded
                  ? "a commit landed after the failure"
                  : "no commit since the failure",
          },
        ],
      },
    ],
  };
}

function lineRows(f: UpFork): Section {
  const cells = [f.cells.sync, f.cells.cascade, f.cells.toMain, f.cells.main];
  const tone = (c: Cell): CanvasTone =>
    c.tone === "bad"
      ? "error"
      : c.tone === "ok"
        ? "ok"
        : c.tone === "run"
          ? "info"
          : c.tone === "warn"
            ? "caution"
            : "neutral";
  return {
    kind: "rows",
    title: `${whose(f.service)} line`,
    items: [
      ...cells.map((c, i) => ({
        chip: { label: c.text === "·" ? "idle" : c.text, tone: tone(c) },
        text: LINE_COLUMNS[i] as string,
        ...(c.note ? { trailing: c.note } : {}),
        ...(c.url ? { href: c.url } : {}),
      })),
      {
        chip: {
          label: f.releasePr ? `#${f.releasePr.number} waits` : "·",
          tone: "neutral" as const,
        },
        text: "Release",
        ...(f.releasePr ? { href: f.releasePr.url } : {}),
      },
    ],
  };
}

export function upstreamForkBoard(
  model: Model,
  service: string,
  now: Date,
  opts: UpstreamBoardOptions = {},
): CanvasBoardView | undefined {
  const u = model.upstream;
  const f = u.forks.find((x) => x.service === service);
  if (!f) return undefined;
  const verbs = forkActions(u, f, {
    swept: model.sweptAt ?? "",
    load: model.lanes,
    now,
    ...(opts.blocked ? { blocked: opts.blocked } : {}),
  });
  const next = forkNext(u, f);
  const links = [
    ...(f.syncPr ? [{ value: `Sync PR #${f.syncPr.number}`, href: f.syncPr.url }] : []),
    ...(f.tracking
      ? [{ value: `Tracking issue #${f.tracking.number}`, href: f.tracking.url }]
      : []),
    ...(f.stop?.job?.url ? [{ value: "Open the failing job", href: f.stop.job.url }] : []),
    ...(f.toMain
      ? [{ value: `Sync to Main #${f.toMain.number} on GitHub`, href: f.toMain.url }]
      : []),
    ...(f.held === "halt" && f.halt?.url
      ? [{ value: "Open the fork's filter", href: f.halt.url }]
      : []),
    ...(f.templatePr
      ? [{ value: `Start waits for template PR #${f.templatePr.number}`, href: f.templatePr.url }]
      : []),
  ];
  const sub = [
    f.behind !== undefined && f.behind > 0
      ? `${plural(f.behind, "upstream commit")} queued · carries ${carriesText(f)}`
      : undefined,
    f.phase === "stopped" ? "Sync to Main not opened" : undefined,
    f.phase === "stopped" ? "the rest of the plan keeps going" : undefined,
    f.planWait ? `the plan: ${f.planWait}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const sections: Section[] = [];
  if (sub) sections.push({ kind: "rows", items: [{ text: sub }] });
  sections.push(
    nextCard(
      `${next.title}.`,
      next.why,
      verbs,
      links,
      f.phase === "stopped" || f.phase === "red" ? "error" : "brand",
    ),
  );
  const failed = failedSection(u, f, now);
  if (failed) sections.push(failed);
  if (f.phase === "stopped") {
    sections.push({
      kind: "rows",
      title: "When a second fork fails the same way",
      items: [
        {
          text: "The rib pauses the wave and turns the rest into Absorb items: the move is the toolchain, not one fork. Forks already past the cascade carry on.",
        },
      ],
    });
  }
  sections.push(lineRows(f));
  const carries = carriesSection(model, f);
  if (carries) sections.push(carries);
  const waits = u.ordering.filter((o) => o.after.includes(f.service)).map((o) => o.service);
  if (waits.length > 0 || f.heldBy.length > 0) {
    sections.push({
      kind: "rows",
      title: `Who waits on ${f.service}`,
      items: [
        ...waits.map((w) => ({
          text: w,
          trailing: `rollout.json orders it after ${names(u.ordering.find((o) => o.service === w)?.after ?? [])}`,
          ...inspectRow(`${UPSTREAM_PREFIX}${w}`),
        })),
        ...(f.heldBy.length > 0
          ? [{ glyph: "neutral" as const, text: `${f.service} waits on ${names(f.heldBy)}` }]
          : []),
      ],
    });
  }
  const at = stamp(u.schedule.upstream, now);
  if (at && f.phase === "stopped") {
    sections.push({
      kind: "rows",
      title: `Before ${at}`,
      items: [
        {
          text: "A blocked cascade doesn't stop Sync Upstream, so new upstream commits can arrive as a fresh sync PR. The rib shows it as Prepared and doesn't offer Start until this cascade clears.",
        },
      ],
    });
  }
  sections.push({
    kind: "rows",
    items: [{ text: "Back to the upstream plan", ...inspectRow(UPSTREAM_ITEM) }],
  });
  sections.push(...(opts.extra ?? []));
  const role = tag(f);
  return {
    view: "board",
    title: forkTitle(f),
    header: {
      status: PHASE_LABEL[f.phase],
      chip: [f.service, role, "upstream sync plan"].filter(Boolean).join(" · "),
    },
    sections,
  };
}

export function upstreamTitle(model: Model, id: string): string | undefined {
  if (id === UPSTREAM_ITEM) return "Upstream plan";
  const service = id.slice(UPSTREAM_PREFIX.length);
  return model.upstream.forks.some((f) => f.service === service)
    ? `${service} · upstream`
    : undefined;
}
