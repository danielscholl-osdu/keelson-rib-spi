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
import { dispatchActions, laneActions } from "../act/rerun.ts";
import { writeBlocked } from "../act/verbs.ts";
import { type Reading, readItem } from "../brief/index.ts";
import { REPO_PREFIX } from "../brief/repos.ts";
import type { EntryState, ForkEntry } from "../collect/filters.ts";
import type { Model } from "../model/index.ts";
import { itemClass, nextText } from "../model/next.ts";
import {
  associationText,
  diffText,
  type ItemKind,
  type QueueItem,
  type Rung,
} from "../model/queue.ts";
import { INSPECT_ACTION } from "../surfaces.ts";
import { age, plural, stamp, zoned } from "../util.ts";
import { names } from "./fold.ts";
import { MR_PREFIX, mrBoard } from "./radar.ts";
import { repoBoard } from "./repo.ts";
import { ladderSection, rolloutActionItems, STEP_PREFIX, spreadText } from "./template.ts";

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
  access: "fork image cannot be pulled",
  radar: "next sync predicted",
  port: "upstream change owed a port",
  security: "critical alert in SPI code",
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
  return { label: `P${item.rung} · ${itemClass(item)}`, tone: RUNG_TONE[item.rung] };
}

type Card = Extract<Section, { kind: "cards" }>["items"][number];
type ActionItem = NonNullable<Card["actions"]>[number];

const FACT_LABEL: Record<string, string> = {
  PR: "Pull request",
  check: "Failed check",
  head: "Head",
  held: "Held",
  halt: "Halt code",
  why: "Why",
};

function factLabel(label: string): string {
  return FACT_LABEL[label] ?? label.charAt(0).toUpperCase() + label.slice(1);
}

// The recommendation and the buttons that carry it out, so guidance and controls read as one.
function nextCard(
  item: QueueItem,
  reading: Reading,
  state: InspectState,
  verbs: ActionItem[],
): Section {
  const listed =
    state.others?.id === item.id ? state.others.entries.filter((e) => e.state === "listed") : [];
  const next = listed.length > 0 ? sentence(nextText(item, listed)) : reading.next;
  const links = (item.links ?? []).map((l) => ({ label: "", value: l.label, href: l.url }));
  return {
    kind: "cards",
    title: "Next step",
    items: [
      {
        title: next,
        edge: "brand",
        ...(links.length > 0 ? { fields: links } : {}),
        ...(verbs.length > 0 ? { actions: verbs } : {}),
      },
    ],
  };
}

function sentence(text: string): string {
  const t = text.charAt(0).toUpperCase() + text.slice(1).trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

// Each fact beside its own link, so the evidence sits with the claim it proves.
function whySection(item: QueueItem, said: string): Section | undefined {
  const facts = item.cause.filter(
    (f) => f.label !== "held" && !said.includes(f.value.toLowerCase()),
  );
  const fields = facts.map((f) => ({
    label: factLabel(f.label),
    value: f.value,
    ...(f.url ? { href: f.url } : {}),
  }));
  const source = sourceOf(item);
  if (source) fields.push(source);
  if (fields.length === 0) return undefined;
  return { kind: "cards", items: [{ title: "Why", prose: true, fields }] };
}

const SOURCE_TEXT: Partial<Record<ItemKind, string>> = {
  approvals: "runs waiting for approval",
};

// The item's own page, unless a fact or a link already carries it.
function sourceOf(item: QueueItem): { label: string; value: string; href: string } | undefined {
  if (!item.url) return undefined;
  if ([...item.cause, ...(item.links ?? [])].some((f) => f.url === item.url)) return undefined;
  return { label: "Source", value: SOURCE_TEXT[item.kind] ?? "open on GitHub", href: item.url };
}

function relatedSection(reading: Reading): Section | undefined {
  if (reading.related.length === 0) return undefined;
  return {
    kind: "rows",
    title: "Same cause elsewhere",
    items: reading.related.map((r) => ({
      text: r.text,
      trailing: r.state,
      ...(r.inspect
        ? { action: { type: INSPECT_ACTION, payload: { id: r.inspect } } }
        : r.url
          ? { href: r.url }
          : {}),
    })),
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
  // The harness can hold a durable op, so a wait can be offered.
  ops?: boolean;
  // The re-run wait already holding the selected item.
  waiting?: { id: string; at: string };
}

function approvalSection(item: QueueItem, model: Model, opts: InspectOptions): Section | undefined {
  const approve = item.approve ?? [];
  if (approve.length === 0) return undefined;
  const disabled = writeBlocked(model.sweptAt, opts.scopes);
  const swept = model.sweptAt ?? "";
  return {
    kind: "cards",
    title: `Outside PRs · ${approve.length}`,
    items: approve.map((a) => {
      const pill =
        a.workflowFiles.length > 0
          ? { label: "changes .github", tone: "caution" as const }
          : a.pr.draft
            ? { label: "draft", tone: "neutral" as const }
            : undefined;
      return {
        title: `#${a.pr.number} ${a.pr.title}`,
        href: a.pr.url,
        ...(pill ? { pill } : {}),
        fields: [
          { label: "by", value: `${a.pr.author} · ${associationText(a.pr.association)}` },
          { label: "diff", value: diffText(a.pr) },
          { label: "waiting", value: plural(a.runs.length, "run") },
        ],
        actions: [approveAction(a, { item: item.id, swept }, disabled)],
      };
    }),
  };
}

function verbsOf(item: QueueItem, model: Model, opts: InspectOptions, now: Date): ActionItem[] {
  const blocked = writeBlocked(model.sweptAt, opts.scopes);
  const swept = model.sweptAt ?? "";
  if (item.kind === "template-set") return rolloutActionItems(model, now, blocked);
  return item.kind === "lanes"
    ? laneActions(item, model.stack, {
        swept,
        now,
        ops: opts.ops ?? false,
        ...(blocked ? { blocked } : {}),
        ...(opts.waiting ? { waiting: opts.waiting } : {}),
      })
    : dispatchActions(item, model.stack, { swept, ...(blocked ? { blocked } : {}) });
}

function evidence(item: QueueItem): Section | undefined {
  const source = sourceOf(item);
  return source
    ? { kind: "rows", items: [{ icon: "↗", text: source.value, href: source.href }] }
    : undefined;
}

export function lastAction(entry: ActionEntry | undefined, now: Date): Section | undefined {
  if (!entry) return undefined;
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

// A prediction has not happened yet, so its age is how long it has been queued.
function sinceWord(item: QueueItem): string {
  return item.kind === "radar" ? "queued" : item.incident ? "open" : "waiting";
}

export function inspectBoard(
  model: Model,
  state: InspectState,
  now: Date,
  entry?: ActionEntry,
  opts: InspectOptions = {},
): CanvasBoardView {
  if (state.selected?.startsWith(STEP_PREFIX)) return stepBoard(model, state.selected, now);
  if (state.selected?.startsWith(MR_PREFIX)) return mrBoard(model, state.selected, now);
  if (state.selected?.startsWith(REPO_PREFIX)) return repoBoard(model, state.selected, now);
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
              text: "Pick an item in the console to see its cause and effects.",
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
  const reading = readItem(model, item, now);
  const since = age(item.since, now);
  const chip = [
    item.scope,
    since ? `${sinceWord(item)} ${since}` : undefined,
    item.note?.replace(" behind", " held"),
  ]
    .filter(Boolean)
    .join(" · ");
  const listed = !!item.approve?.length || item.effects.length > 1;
  // The tiles say the cause when the item names both sides of a gap; a list says the effects.
  // With no effects of its own, the effect line only restates the held commits the chip shows.
  const effect = listed || (item.effects.length === 0 && item.note) ? undefined : reading.effect;
  const lede = [reading.gap ? undefined : reading.cause, effect]
    .filter((t, i, all): t is string => !!t && all.indexOf(t) === i)
    .join(" ");
  const sections: Section[] = lede ? [{ kind: "rows", items: [{ text: lede }] }] : [];
  if (reading.gap) {
    sections.push({
      kind: "stats",
      items: [
        { label: "Fork builds with", value: reading.gap.have },
        { label: "Upstream requires", value: reading.gap.need, tone: "warn" },
      ],
    });
  }
  const approvals = approvalSection(item, model, opts);
  sections.push(nextCard(item, reading, state, verbsOf(item, model, opts, now)));
  if (approvals) sections.push(approvals);
  const why = whySection(item, `${reading.cause} ${reading.effect}`.toLowerCase());
  if (why) sections.push(why);
  if (listed && !approvals) {
    sections.push({
      kind: "rows",
      title: `Effects · ${item.effects.length}`,
      items: item.effects.map((e) => ({ text: e.text, ...(e.url ? { href: e.url } : {}) })),
    });
  }
  if (item.kind === "template-set") {
    const steps = ladderSection(model);
    if (steps) sections.push(steps);
  }
  const same = sameEntry(item, state);
  if (same) sections.push(same);
  const related = relatedSection(reading);
  if (related) sections.push(related);
  const last = lastAction(entry, now);
  if (last) sections.push(last);
  return {
    view: "board",
    title: reading.title,
    header: { status: statusOf(item), chip },
    sections,
  };
}
