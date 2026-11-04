// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { flowActions } from "../act/flow.ts";
import type { ActionItem } from "../act/verbs.ts";
import { nextSentence, nextWhy, pathName, rolloutWords, upstreamPrs } from "../brief/rollout.ts";
import type { Model } from "../model/index.ts";
import type { QueueItem } from "../model/queue.ts";
import type { Cell, CellTone, RolloutFork, RolloutModel } from "../model/rollout.ts";
import { age, names, plural, short, stamp } from "../util.ts";
import { ladderSection } from "./template.ts";

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

const STATUS: Record<RolloutModel["phase"], { label: string; tone: CanvasTone }> = {
  ready: { label: "P1 · ROLLOUT", tone: "caution" },
  rolling: { label: "P1 · ROLLOUT", tone: "caution" },
  stopped: { label: "P0 · ROLLOUT STOPPED", tone: "error" },
  done: { label: "ROLLOUT DONE", tone: "ok" },
};

// A pill never wraps: its words are joined with no-break spaces.
function badge(c: Cell) {
  return c.text === "·"
    ? { value: "·" }
    : {
        badges: [{ text: c.text.replace(/ /g, "\u00a0"), tone: CELL_TONE[c.tone] }],
        ...(c.url ? { href: c.url } : {}),
      };
}

function forkTable(r: RolloutModel): Section {
  return {
    kind: "table",
    title: `Forks · ${r.merged} of ${r.total} merged`,
    columns: [
      { key: "fork", label: "Fork" },
      { key: "validation", label: "Validation" },
      { key: "review", label: "Review" },
      { key: "merge", label: "Merge" },
      { key: "main", label: "Main" },
    ],
    rows: r.forks.map((f) => {
      const pr = f.pr ?? f.merged;
      const fork = f.skip ? `${f.service} (${f.skip})` : f.service;
      return {
        fork: pr ? { value: fork, href: pr.url } : fork,
        validation: badge(f.validation),
        review: badge(f.review),
        merge: badge(f.merge),
        main: badge(f.main),
      };
    }),
  };
}

// What a one-word pill stands for, for the forks where it says more than its word.
function notesSection(r: RolloutModel): Section | undefined {
  const items = r.forks.flatMap((f) => {
    const notes = [f.validation, f.review, f.merge, f.main].flatMap((c) =>
      c.note ? [c.note] : [],
    );
    return notes.length > 0 ? [{ text: f.service, trailing: notes.join(" · ") }] : [];
  });
  return items.length > 0 ? { kind: "rows", items } : undefined;
}

function laneMeter(r: RolloutModel): Section | undefined {
  if (r.lanes.cap === null) return undefined;
  return {
    kind: "bars",
    title: "Lanes on the shared environment",
    items: [
      {
        label: "Lanes",
        value: r.lanes.unread ? null : r.lanes.busy,
        total: r.lanes.cap,
        trailing: r.lanes.unread
          ? `unknown until ${r.lanes.unread} are read`
          : `${r.lanes.busy} of ${r.lanes.cap} busy`,
      },
    ],
  };
}

function scheduleSection(r: RolloutModel, now: Date): Section | undefined {
  const items: Row[] = [];
  const up = stamp(r.schedule.upstream, now);
  if (up) {
    const until = r.schedule.upstream
      ? age(now.toISOString(), new Date(r.schedule.upstream))
      : undefined;
    items.push({
      chip: { label: up, tone: "neutral" },
      text:
        r.schedule.upstreamForks > 0
          ? `Upstream sync opens ${upstreamPrs(r)}${until ? ` in ${until}` : ""}.${r.borrows && r.phase !== "done" ? " They share these lanes; dispatch waits while they validate." : ""}`
          : "Upstream sync has nothing queued.",
    });
  }
  const tmpl = stamp(r.schedule.template, now);
  if (tmpl) {
    items.push({
      chip: { label: tmpl, tone: "neutral" },
      text:
        r.schedule.templateOpens > 0
          ? `Template sync opens a PR on every fork still without one: ${plural(r.schedule.templateOpens, "fork")} now, all at once.`
          : "Template sync. Every fork already has a PR or the change, so it opens nothing.",
    });
  }
  return items.length > 0 ? { kind: "rows", title: "Schedule", items } : undefined;
}

function pinsSection(r: RolloutModel, now: Date, only?: RolloutFork): Section | undefined {
  const forks = (only ? [only] : r.forks).filter((f) => f.merged || f.red);
  if (forks.length === 0) return undefined;
  return {
    kind: "rows",
    title: only ? `Last-good pin for ${only.service}` : "Last-good pins",
    items: [
      {
        glyph: "neutral",
        text: only
          ? "The main run this merge replaced. Pin it on the stack if the fix will take a while."
          : "The last green main run each merge replaced.",
      },
      ...forks.map((f) => ({
        text: f.service,
        trailing: f.lastGood
          ? `main ${short(f.lastGood.sha)} · green ${stamp(f.lastGood.at, now) ?? ""}`
          : "no green main run read before the merge",
        ...(f.lastGood ? { href: f.lastGood.url } : {}),
      })),
    ],
  };
}

function reachSection(r: RolloutModel): Section | undefined {
  if (r.changes.length === 0) return undefined;
  return {
    kind: "rows",
    title: `What reaches the forks · ${r.reaching} of ${plural(r.changes.length, "change")}`,
    items: r.changes.map((c) => ({
      text: c.change.title.replace(/\s*\(#\d+\)$/, ""),
      trailing: [
        c.consequences === null
          ? "reach unread"
          : c.consequences.length > 0
            ? c.consequences.join(", ")
            : "template only",
        c.change.pr ? `#${c.change.pr}` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      href: c.change.url,
    })),
  };
}

function failedSection(r: RolloutModel, now: Date): Section | undefined {
  const stop = r.stops[0];
  if (!stop?.red) return undefined;
  const job = stop.red.job;
  const held = r.forks.filter((f) => !f.onTarget && !f.red).map((f) => f.service);
  return {
    kind: "cards",
    title: "What failed",
    items: [
      {
        title: stop.service,
        edge: "error",
        fields: [
          {
            label: "Fork",
            value: `${stop.service} · merged ${stamp(stop.merged?.at, now) ?? "?"} · main run attempt ${stop.red.run.attempt}`,
            ...(stop.merged ? { href: stop.merged.url } : {}),
          },
          {
            label: "Job",
            value: [job?.name, job?.failedStep].filter(Boolean).join(" · ") || "unread",
            ...(job?.url || stop.red.run.url ? { href: job?.url ?? stop.red.run.url } : {}),
          },
          {
            label: "Class",
            value: stop.red.judgement
              ? `real · ${stop.red.judgement.note ?? "no Environment annotation on any failed job"}`
              : "real until its annotations are read",
          },
          ...(job?.reason ? [{ label: "First error", value: job.reason }] : []),
          {
            label: "Same cause",
            value:
              r.stops.length > 1
                ? names(r.stops.slice(1).map((f) => f.service))
                : `none yet${held.length ? ` · ${names(held)} ${held.length === 1 ? "is" : "are"} not merged` : ""}`,
          },
        ],
      },
    ],
  };
}

function whereStopped(r: RolloutModel): Section {
  return {
    kind: "rows",
    title: "Where each fork stopped",
    items: r.forks.map((f) => {
      const green = f.onTarget && f.main.tone === "ok";
      return {
        glyph: (f.red ? "error" : green ? "ok" : "neutral") as CanvasTone,
        text: f.service,
        trailing: f.red ? "main red" : green ? "main green" : f.onTarget ? f.main.text : "held",
      };
    }),
  };
}

function statsSection(r: RolloutModel, model: Model, now: Date): Section {
  const env = model.stack;
  const envTile = {
    label: "Environment",
    value: env.running?.version ?? env.declared ?? "?",
    sub:
      env.deployable.state === "yes"
        ? "deployable"
        : env.deployable.state === "no"
          ? `held · ${env.deployable.reason}`
          : "deployability unread",
  };
  if (r.phase === "ready") {
    return {
      kind: "stats",
      items: [
        {
          label: "Reaches the forks",
          value: `${r.reaching} of ${r.changes.length}`,
          sub: r.consequences.join(", ") || "template only",
        },
        {
          label: "Lanes",
          value: r.borrows ? String(r.lanes.needed) : "0",
          sub: r.lanes.cap
            ? `${r.lanes.cap} at a time · ${plural(r.lanes.waves ?? 0, "wave")}`
            : "unpaced",
        },
        envTile,
      ],
    };
  }
  if (r.phase === "stopped") {
    return {
      kind: "stats",
      items: [
        { label: "Merged", value: `${r.merged} of ${r.total}` },
        { label: "Main runs", value: `${r.mainGreen} green`, sub: `${r.stops.length} red` },
        { label: "Held", value: String(r.forks.filter((f) => !f.onTarget && !f.red).length) },
      ],
    };
  }
  if (r.phase === "done") {
    return {
      kind: "stats",
      items: [
        { label: "Merged", value: `${r.total} of ${r.total}`, sub: "every main run green" },
        {
          label: "Environment re-runs",
          value: String(r.rerunsUsed.length),
          sub: r.rerunsUsed.length ? `${names(r.rerunsUsed)} · green on a later attempt` : "none",
        },
        { label: "Stops", value: "0", sub: "no real failure" },
        {
          label: "Released",
          value: `${r.released} of ${r.total}`,
          sub:
            r.released < r.total
              ? `${plural(r.total - r.released, "fork")} not released on it yet`
              : "every fork",
        },
      ],
    };
  }
  return {
    kind: "stats",
    items: [
      { label: "Merged", value: `${r.merged} of ${r.total}` },
      {
        label: "Lanes",
        value: r.lanes.cap ? `${r.lanes.busy} of ${r.lanes.cap} busy` : `${r.lanes.busy} busy`,
        sub: r.borrows ? `${plural(r.lanes.needed, "lane")} still to go` : "no lanes borrowed",
      },
      {
        ...envTile,
        sub: `${envTile.sub}${stamp(env.running?.at, now) ? ` · ${stamp(env.running?.at, now)}` : ""}`,
      },
    ],
  };
}

function nextStepCard(
  r: RolloutModel,
  item: QueueItem,
  verbs: { primary: ActionItem; secondary: ActionItem[] },
): Section {
  const why = nextWhy(r);
  const links = [
    ...(item.links ?? []).map((l) => ({ label: "", value: l.label, href: l.url })),
    ...r.reviews.map((f) => ({
      label: "",
      value: `Review ${f.service} #${f.pr?.number} on GitHub`,
      href: f.pr?.url as string,
    })),
  ];
  return {
    kind: "cards",
    title: "Next step",
    items: [
      {
        title: nextSentence(r),
        edge: r.phase === "stopped" ? "error" : "brand",
        fields: [...(why ? [{ label: "", value: why }] : []), ...links],
        actions: [verbs.primary, ...verbs.secondary],
      },
    ],
  };
}

export function rolloutBoard(
  model: Model,
  r: RolloutModel,
  item: QueueItem,
  now: Date,
  opts: { blocked?: string; extra: Section[] },
): CanvasBoardView {
  const w = rolloutWords(r, now);
  const verbs = flowActions(r, {
    swept: model.sweptAt ?? "",
    item: "engineering",
    load: model.lanes,
    now,
    ...(opts.blocked ? { blocked: opts.blocked } : {}),
  });
  const started = stamp(r.started, now);
  const chip = [
    "fleet",
    r.phase === "done" && started && r.finished
      ? `${started} to ${stamp(r.finished, now)} · ${age(r.started, new Date(r.finished))}`
      : started
        ? `started ${started} · ${age(r.started, now)}`
        : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const sections: Section[] = [
    { kind: "rows", items: [{ text: w.sub }, { text: `${w.cause} ${w.effect}` }] },
    statsSection(r, model, now),
    nextStepCard(r, item, verbs),
  ];
  if (r.phase === "stopped") {
    const failed = failedSection(r, now);
    if (failed) sections.push(failed);
    const pin = pinsSection(r, now, r.stops[0]);
    if (pin) sections.push(pin);
    sections.push(whereStopped(r));
  } else {
    const meter = r.phase === "done" ? undefined : laneMeter(r);
    if (meter) sections.push(meter);
    sections.push(forkTable(r));
    const notes = notesSection(r);
    if (notes) sections.push(notes);
    if (r.phase === "ready") {
      sections.push({
        kind: "rows",
        title: "Plan",
        items: [
          { text: w.plan },
          ...r.ordering.map((o) => ({
            glyph: "neutral" as CanvasTone,
            text: `${o.service} after ${names(o.after)}`,
            ...(o.reason ? { trailing: o.reason } : {}),
          })),
        ],
      });
    }
    const schedule = r.phase === "done" ? undefined : scheduleSection(r, now);
    if (schedule) sections.push(schedule);
    const pins = pinsSection(r, now);
    if (pins) sections.push(pins);
  }
  const reach = reachSection(r);
  if (reach) {
    sections.push(reach);
    const paths = [...new Set(r.changes.flatMap((c) => c.paths.map(pathName)))];
    if (paths.length > 0) {
      sections.push({
        kind: "rows",
        title: "Synced paths it touches",
        items: paths.map((p) => ({ text: p })),
      });
    }
  }
  const ladder = r.phase === "stopped" ? undefined : ladderSection(model, true);
  if (ladder) sections.push(ladder);
  sections.push(...opts.extra);
  return {
    view: "board",
    title: w.title,
    header: { status: STATUS[r.phase], chip },
    sections,
  };
}
