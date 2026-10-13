// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { ActionEntry } from "../act/log.ts";
import type { EntryState, ForkEntry } from "../collect/filters.ts";
import type { Model } from "../model/index.ts";
import type { ItemKind, QueueItem, Rung } from "../model/queue.ts";
import { age, zoned } from "../util.ts";

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
  bump: "env bump",
};

const ENTRY_BADGE: Record<EntryState, { text: string; tone: CanvasTone }> = {
  absent: { text: "absent", tone: "neutral" },
  listed: { text: "listed", tone: "ok" },
  unlisted: { text: "unlisted", tone: "caution" },
  unread: { text: "?", tone: "neutral" },
};

export interface InspectState {
  // The queue item id the operator last opened.
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
  const label = item.cls ?? (item.incident ? "INCIDENT" : item.rung === 1 ? "GATE" : "READY");
  return { label, tone: RUNG_TONE[item.rung] };
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
  const items: Row[] = state.others.entries.map((e) => {
    const badge = ENTRY_BADGE[e.state];
    return {
      chip: { label: badge.text, tone: badge.tone },
      text: several ? `${e.fork} · ${e.entry}` : e.fork,
      ...(e.verdict ? { trailing: e.verdict } : {}),
      ...(e.url ? { href: e.url } : {}),
    };
  });
  return items.length > 0 ? { kind: "rows", title, items } : undefined;
}

function evidence(item: QueueItem): Section | undefined {
  const items: Row[] = [];
  if (item.url) items.push({ icon: "↗", text: "Open on GitHub", href: item.url });
  return items.length > 0 ? { kind: "rows", title: "Evidence", items } : undefined;
}

function lastAction(entry: ActionEntry | undefined, now: Date): Section {
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

export function inspectBoard(
  model: Model,
  state: InspectState,
  now: Date,
  last?: ActionEntry,
): CanvasBoardView {
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
  if (item.effects.length > 0) {
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
