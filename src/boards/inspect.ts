// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { approveAction } from "../act/approve.ts";
import type { ActionEntry } from "../act/log.ts";
import { writeBlocked } from "../act/verbs.ts";
import type { EntryState, ForkEntry } from "../collect/filters.ts";
import type { Model } from "../model/index.ts";
import { itemClass, nextText, verbOf } from "../model/next.ts";
import { diffText, type ItemKind, type QueueItem, type Rung } from "../model/queue.ts";
import { age, plural, stamp, zoned } from "../util.ts";
import { STEP_PREFIX, spreadText } from "./engineering.ts";
import { names } from "./fold.ts";

type Section = CanvasBoardView["sections"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];

const RUNG_TONE: Record<Rung, CanvasTone> = { 0: "error", 1: "caution", 2: "info" };

export const KIND_TITLE: Record<ItemKind, string> = {
  stack: "environment not deployable",
  maintenance: "maintenance held",
  lanes: "fork lanes failed on the environment",
  halt: "sync halted",
  "sync-run": "Sync Upstream failed",
  conflict: "cascade conflict",
  cascade: "cascade stopped",
  main: "main red",
  "template-run": "Sync Template failed",
  gate1: "sync PR",
  gate2: "release/upstream PR",
  "template-red": "template-sync PR failing",
  labels: "label configuration",
  approvals: "workflow approval",
  "template-set": "template-sync set",
  "release-red": "release PR failing",
  releases: "release PRs",
  "template-pr": "osdu-spi PR",
  bump: "env bump",
};

// A listed rule is the one to copy; absent forks fold into one line.
const ENTRY_ORDER: EntryState[] = ["listed", "unlisted", "unread"];

const ENTRY_BADGE: Record<EntryState, { text: string; tone: CanvasTone }> = {
  absent: { text: "absent", tone: "neutral" },
  listed: { text: "listed", tone: "ok" },
  unlisted: { text: "unlisted", tone: "caution" },
  unread: { text: "?", tone: "neutral" },
};

export interface InspectState {
  // The queue item id the operator last opened, or a ladder step as "step:<marker>".
  selected?: string;
  // The item as it was when opened, so a cleared item still says what it was.
  item?: QueueItem;
  others?: { id: string; entries: ForkEntry[] };
  // The item whose other forks are being read now.
  reading?: string;
}

export function inspectTitle(item: QueueItem): string {
  return `${item.scope} · ${KIND_TITLE[item.kind]}`;
}

function statusOf(item: QueueItem): { label: string; tone: CanvasTone } {
  return { label: itemClass(item), tone: RUNG_TONE[item.rung] };
}

function nextSection(item: QueueItem, state: InspectState): Section {
  const listed =
    state.others?.id === item.id ? state.others.entries.filter((e) => e.state === "listed") : [];
  return {
    kind: "rows",
    title: "Next",
    items: [{ chip: { label: verbOf(item), tone: "accent" }, text: nextText(item, listed) }],
  };
}

function sameEntry(item: QueueItem, state: InspectState): Section | undefined {
  const title = "Same entry in other forks";
  if (!item.halt) return undefined;
  if (state.others?.id !== item.id) {
    return state.reading === item.id
      ? {
          kind: "rows",
          title,
          items: [{ glyph: "neutral", text: "reading each fork's filter and upstream tree" }],
        }
      : undefined;
  }
  const several = item.halt.entries.length > 1;
  const name = (e: ForkEntry) => (several ? `${e.fork} · ${e.entry}` : e.fork);
  const entries = state.others.entries;
  const items: Row[] = ENTRY_ORDER.flatMap((s) => entries.filter((e) => e.state === s)).map((e) => {
    const badge = ENTRY_BADGE[e.state];
    return {
      chip: { label: badge.text, tone: badge.tone },
      text: name(e),
      ...(e.verdict ? { trailing: e.verdict } : {}),
      ...(e.url ? { href: e.url } : {}),
    };
  });
  const absent = entries.filter((e) => e.state === "absent");
  if (absent.length > 0) {
    items.push({
      glyph: "neutral",
      text: `${plural(absent.length, "fork")} ${absent.length === 1 ? "has" : "have"} no such entry upstream · ${names(absent.map(name))}`,
    });
  }
  return items.length > 0 ? { kind: "rows", title, items } : undefined;
}

export interface InspectOptions {
  // The gh token's scopes, when the sign-in probe could read them.
  scopes?: string[];
}

function approvalSections(item: QueueItem, model: Model, opts: InspectOptions): Section[] {
  const approve = item.approve ?? [];
  if (approve.length === 0) return [];
  const rows: Row[] = approve.map((a) => {
    const chip =
      a.workflowFiles.length > 0
        ? { label: ".github", tone: "caution" as const }
        : a.pr.draft
          ? { label: "draft", tone: "neutral" as const }
          : undefined;
    return {
      ...(chip ? { chip } : {}),
      text: `#${a.pr.number} ${a.pr.title}`,
      trailing: `${a.pr.author} · ${diffText(a.pr)}`,
      href: a.pr.url,
    };
  });
  const disabled = writeBlocked(model.sweptAt, opts.scopes);
  const swept = model.sweptAt ?? "";
  return [
    { kind: "rows", title: `Outside PRs · ${approve.length}`, items: rows },
    {
      kind: "actions",
      items: approve.map((a) => approveAction(a, { item: item.id, swept }, disabled)),
    },
  ];
}

function evidence(item: QueueItem): Section | undefined {
  const items: Row[] = [];
  if (item.url) items.push({ icon: "↗", text: "Open on GitHub", href: item.url });
  return items.length > 0 ? { kind: "rows", title: "Evidence", items } : undefined;
}

export function lastAction(entry: ActionEntry | undefined, now: Date): Section {
  if (!entry) {
    return {
      kind: "rows",
      title: "Last action",
      items: [{ glyph: "neutral", text: "none from this board" }],
    };
  }
  const done = entry.results.filter((r) => r.outcome === "done").length;
  const tone: CanvasTone = done === entry.results.length ? "ok" : done > 0 ? "warn" : "error";
  return {
    kind: "rows",
    title: "Last action",
    items: [
      {
        glyph: tone,
        text: `${entry.label} · ${done} of ${entry.results.length} done`,
        trailing: zoned(entry.at, now) ?? "",
      },
      ...entry.results
        .filter((r) => r.outcome !== "done")
        .map((r) => ({
          glyph: (r.outcome === "refused" ? "warn" : "error") as CanvasTone,
          text: `${r.target} ${r.outcome === "refused" ? "skipped" : "failed"}${r.detail ? `: ${r.detail}` : ""}`,
        })),
    ],
  };
}

export function stepTitle(model: Model, id: string): string | undefined {
  const step = model.template.steps.find((s) => `${STEP_PREFIX}${s.marker}` === id);
  return step ? `osdu-spi · ${step.label}` : undefined;
}

// One step of the release ladder: the changes it brings and where each fork stands on it.
function stepBoard(model: Model, id: string, now: Date): CanvasBoardView {
  const steps = model.template.steps;
  const at = steps.findIndex((s) => `${STEP_PREFIX}${s.marker}` === id);
  const step = steps[at];
  if (!step) {
    return {
      view: "board",
      header: { status: { label: "MOVED", tone: "neutral" } },
      sections: [
        {
          kind: "rows",
          items: [
            { glyph: "ok", text: "No fork sits at this position any more; the ladder redrew." },
          ],
        },
      ],
    };
  }
  const older = steps[at + 1];
  const total = model.template.rows.length;
  const sections: Section[] = [
    {
      kind: "rows",
      items: [
        {
          glyph: step.head ? "info" : "neutral",
          text: older
            ? `${plural(step.changes.length, "change")} from ${older.label} to ${step.label}${step.consequences.length ? `, reaching ${step.consequences.join(", ")}` : ""}.`
            : `${step.label} is the oldest position a fork holds.`,
        },
      ],
    },
  ];
  if (step.changes.length > 0) {
    sections.push({
      kind: "rows",
      title: `Changes · ${step.changes.length}`,
      items: step.changes.map((c) => ({
        text: c.title,
        trailing: [c.pr ? `#${c.pr}` : undefined, stamp(c.at, now)].filter(Boolean).join(" · "),
        href: c.url,
      })),
    });
  }
  const forks: Row[] = [
    ...step.adopted.map((f) => ({ glyph: "ok" as const, text: f, trailing: "on it" })),
    ...step.waiting.map((f) => ({ glyph: "info" as const, text: f, trailing: "PR waits" })),
    ...step.failing.map((f) => ({ glyph: "warn" as const, text: f, trailing: "PR fails" })),
    ...step.noPr.map((f) => ({ glyph: "neutral" as const, text: f, trailing: "no PR carries it" })),
    ...step.unmeasured.map((f) => ({ glyph: "neutral" as const, text: f, trailing: "unread" })),
  ];
  sections.push({ kind: "rows", title: "Forks", items: forks });
  if (step.url) {
    sections.push({
      kind: "rows",
      title: "Evidence",
      items: [{ icon: "↗", text: "Compare on GitHub", href: step.url }],
    });
  }
  return {
    view: "board",
    header: {
      status: { label: step.label, tone: step.head ? "info" : "neutral" },
      chip: spreadText(step, total),
    },
    sections,
  };
}

export function inspectBoard(
  model: Model,
  state: InspectState,
  now: Date,
  last?: ActionEntry,
  opts: InspectOptions = {},
): CanvasBoardView {
  if (state.selected?.startsWith(STEP_PREFIX)) return stepBoard(model, state.selected, now);
  const live = state.selected ? model.queue.items.find((i) => i.id === state.selected) : undefined;
  const item = live ?? state.item;
  if (!item) {
    return {
      view: "board",
      sections: [
        {
          kind: "rows",
          items: [
            {
              glyph: "neutral",
              text: "Pick an item in Needs attention to see its cause and effects.",
            },
          ],
        },
      ],
    };
  }
  if (!live) {
    const swept = model.sweptAt ? zoned(model.sweptAt, now) : undefined;
    const rows: Row[] = [
      {
        glyph: "ok",
        text: `Left the queue: the sweep${swept ? ` at ${swept}` : ""} no longer reads it.`,
      },
      { glyph: "neutral", text: item.text },
    ];
    const ev = evidence(item);
    return {
      view: "board",
      header: { status: { label: "CLEARED", tone: "ok" } },
      sections: [{ kind: "rows", items: rows }, ...(ev ? [ev] : [])],
    };
  }
  const since = age(item.since, now);
  const chip = [`P${item.rung}`, since, item.note].filter(Boolean).join(" · ");
  const sections: Section[] = [
    { kind: "rows", items: [{ glyph: RUNG_TONE[item.rung], text: item.text }] },
    nextSection(item, state),
  ];
  if (item.cause.length > 0) {
    sections.push({
      kind: "rows",
      title: "Cause",
      boxed: true,
      items: item.cause.map((f) => ({
        text: f.label,
        trailing: f.value,
        ...(f.url ? { href: f.url } : {}),
      })),
    });
  }
  const approvals = approvalSections(item, model, opts);
  if (approvals.length > 0) sections.push(...approvals);
  else if (item.effects.length > 0) {
    sections.push({
      kind: "rows",
      title: item.effects.length === 1 ? "Effect" : `Effects · ${item.effects.length}`,
      items: item.effects.map((e) => ({
        glyph: "neutral" as const,
        text: e.text,
        ...(e.url ? { href: e.url } : {}),
      })),
    });
  }
  const same = sameEntry(item, state);
  if (same) sections.push(same);
  sections.push(lastAction(last, now));
  const ev = evidence(item);
  if (ev) sections.push(ev);
  return {
    view: "board",
    header: { status: statusOf(item), chip },
    sections,
  };
}
