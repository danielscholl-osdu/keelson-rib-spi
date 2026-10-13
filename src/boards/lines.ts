// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { HISTORY_DAYS } from "../config.ts";
import type { Gate } from "../model/gates.ts";
import { type TrackDay, type TrackState, worse } from "../model/history.ts";
import type { Model } from "../model/index.ts";
import { type LineModel, type LinePr, type PillKind, prRed } from "../model/lines.ts";
import { plural, releaseTag, since, span, stamp, zoned } from "../util.ts";

type Section = CanvasBoardView["sections"][number];
type TableSection = Extract<Section, { kind: "table" }>;
type Cell = TableSection["rows"][number][string];
type Stat = Extract<Section, { kind: "stats" }>["items"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Bar = NonNullable<Row["bar"]>;
type SeriesCell = Extract<Bar, { cells: unknown }>["cells"][number];

// With this many forks current on every station, they fold into one row.
const FOLD_AT = 4;

const SEVERITY: PillKind[] = [
  "broken",
  "halted",
  "blocked",
  "stale",
  "waiting",
  "unmeasured",
  "current",
];

// The header goes red only for a red main; a halt or a failing PR is work, so amber.
const HEADER_WORDS: [Exclude<PillKind, "current">, string, string][] = [
  ["broken", "MAIN RED", "MAIN RED"],
  ["halted", "HALTED", "HALTED"],
  ["blocked", "BLOCKED", "BLOCKED"],
  ["stale", "STALE", "STALE"],
  ["waiting", "UPDATE WAITING", "UPDATES WAITING"],
  ["unmeasured", "UNMEASURED", "UNMEASURED"],
];

const CLEAR: Cell = { value: "●", tone: "ok" };
const STARVED: Cell = { value: "○", tone: "neutral" };

// Station cells never wrap, so the table gives the spare width to the history.
function one(text: string): string {
  return text.replace(/ /g, "\u00a0");
}

function station(text: string, tone?: CanvasTone, href?: string): Cell {
  return { value: one(text), ...(tone ? { tone } : {}), ...(href ? { href } : {}) };
}

function prCell(p: LinePr, text: string, now: Date): Cell {
  const age = since(p.pr.createdAt, now);
  return prRed(p)
    ? station(`✕ ${text} · ${age}`, "warn", p.pr.url)
    : station(`◷ ${text} · ${age}`, "info", p.pr.url);
}

// Stations after a stopped sync get nothing from upstream, so they draw hollow.
function starved(line: LineModel): boolean {
  return !!line.halt || prRed(line.syncPr);
}

function upstreamCell(line: LineModel): Cell {
  const lag = line.upstream?.lag;
  if (lag === undefined) return "?";
  if (lag === 0) return CLEAR;
  return station(`${lag} behind`, starved(line) ? "warn" : "info");
}

function syncCell(line: LineModel, now: Date): Cell {
  if (line.halt)
    return station(
      `✕ halted · ${since(line.halt.issue.createdAt, now)}`,
      "error",
      line.halt.issue.url,
    );
  if (line.syncPr) return prCell(line.syncPr, `PR #${line.syncPr.pr.number}`, now);
  if (line.syncRun?.conclusion === "failure")
    return station("✕ sync run failed", "error", line.syncRun.url);
  return line.upstream?.lag === undefined ? "?" : CLEAR;
}

function cascadeCell(line: LineModel, now: Date): Cell {
  if (line.cascadeStop) {
    const conflict = line.conflicts[0];
    return conflict
      ? station(`✕ conflict · ${since(conflict.createdAt, now)}`, "warn", conflict.url)
      : station("✕ blocked", "warn", line.tracking?.url);
  }
  if (line.cascadeRunning) return station("↻ running", "info");
  if (starved(line)) return STARVED;
  return CLEAR;
}

function mainCell(line: LineModel, now: Date): Cell {
  if (line.cascadePr) return prCell(line.cascadePr, `PR #${line.cascadePr.pr.number}`, now);
  if (line.mainRed)
    return line.mainRed.cls === "ENV"
      ? station("⊘ red on the stack", "neutral", line.mainRed.run.url)
      : station("✕ main red", "error", line.mainRed.run.url);
  return line.runsRead ? CLEAR : "?";
}

function releaseCell(line: LineModel, now: Date): Cell {
  const tag = line.release?.tag;
  const next = line.releasePr;
  if (next) {
    const to = releaseTag(next.pr.title, tag);
    const move = to ? (tag ? `${tag} → ${to}` : `first ${to}`) : "release";
    return prCell(next, `${move} · #${next.pr.number}`, now);
  }
  if (!tag) return station("no release");
  return { value: one(tag), ...(line.release?.url ? { href: line.release.url } : {}) };
}

function laneCell(line: LineModel): Cell {
  const lane = line.stations.find((s) => s.id === "lane");
  if (!lane || lane.state === "unknown") return station("none yet", "neutral");
  if (lane.state === "stopped") return station("⊘ stack", "neutral");
  if (lane.state === "waiting") return station("✕ last run", "warn");
  return CLEAR;
}

function templateCell(line: LineModel, now: Date): Cell {
  const { behind, label, target, awaitingRun } = line.template;
  const on = label ?? "?";
  const { run, state } = line.templateDelivery;
  if (run && state === "failed")
    return station(`✕ ${on} · Sync Template failed ${stamp(run.createdAt, now)}`, "error", run.url);
  if (run && state === "stale")
    return station(`◷ ${on} · Sync Template ran ${stamp(run.createdAt, now)}`, "warn", run.url);
  if (behind === undefined) return "?";
  if (behind === 0) return station(on, "ok");
  if (awaitingRun) return station(`◷ ${on} · next run`, "info");
  const pr = line.templatePr;
  if (!pr) return station(`✕ ${on} · ${behind} behind, no PR`, "error");
  const failing = line.pill.label === "template blocked";
  const text = `${on}${target ? ` → ${target}` : ""} · #${pr.pr.number}`;
  return failing
    ? station(`✕ ${text}`, "warn", pr.pr.url)
    : station(`◷ ${text}`, "info", pr.pr.url);
}

const TRACK_TONE: Record<TrackState, CanvasTone | undefined> = {
  ok: "ok",
  waiting: "info",
  failing: "warn",
  halted: "error",
  none: undefined,
};

function trackText(day: TrackDay): string {
  if (day.state === "none") return "no fork yet";
  return day.why ?? "caught up";
}

function daysCell(line: LineModel): Cell {
  const h = line.history;
  if (!h) return "?";
  const cells: SeriesCell[] = h.upstream.map((u, i) => {
    const t = h.template[i] as TrackDay;
    const state = worse(u.state, t.state);
    const tone = TRACK_TONE[state];
    return {
      label:
        state === "none"
          ? `${u.day.key} · no fork yet`
          : `${u.day.key} · upstream: ${trackText(u)} · template: ${trackText(t)}`,
      ...(tone ? { tone } : {}),
      ...(state === "none" ? { hollow: true } : {}),
    };
  });
  return { bar: { cells, quiet: true } };
}

function names(list: readonly string[]): string {
  return list.length <= 1
    ? (list[0] ?? "")
    : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

function plannedText(model: Model): string | undefined {
  const planned = model.planned.map((p) => p.service.id);
  if (planned.length === 0) return undefined;
  return `${names(planned)} ${planned.length === 1 ? "has" : "have"} no fork yet`;
}

function settled(line: LineModel): boolean {
  return line.pill.kind === "current" && !line.releasePr;
}

function gateStat(
  label: string,
  gate: Gate,
  measured: boolean,
  sub: (medianText: string | undefined) => string | undefined,
): Stat {
  const median = measured ? span(gate.medianMs) : undefined;
  const text = measured ? sub(median) : "history unread";
  return {
    label,
    ...(gate.oldest
      ? { clock: { at: gate.oldest.at, mode: "since" as const }, tone: gate.oldest.tone }
      : { value: "none", tone: "ok" as const }),
    ...(text ? { sub: text } : {}),
  };
}

function tiles(model: Model): Section {
  const { gates } = model;
  const latest = model.template.steps[0]?.label;
  return {
    kind: "stats",
    items: [
      gateStat("Upstream · oldest held", gates.upstream, gates.measured, (m) =>
        m
          ? `upstream reaches main in ${m} at the median · ${plural(gates.upstream.n, "sync")} in ${HISTORY_DAYS} d`
          : `no sync reached main in ${HISTORY_DAYS} d`,
      ),
      gateStat(
        "Template · oldest PR",
        gates.template,
        gates.measured,
        (m) =>
          [
            latest ? `to ${latest}` : undefined,
            m ? `template-sync PRs merge in ${m} at the median` : undefined,
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
      ),
      gateStat(
        "Release · oldest PR",
        gates.release,
        gates.measured,
        () => `${plural(gates.release.n, "release")} cut in ${HISTORY_DAYS} d`,
      ),
    ],
  };
}

function fleetLane(model: Model, track: "upstream" | "template"): Row | undefined {
  const lines = model.lines;
  const first = lines[0]?.history;
  if (!first) return undefined;
  return {
    text: track,
    bar: {
      total: lines.length,
      rest: "ok",
      columns: first[track].map((d, i) => {
        const days = lines.map((l) => l.history?.[track][i]);
        if (days.some((x) => x === undefined))
          return { label: `${d.day.key} · unread`, segments: [{ label: "unread", n: null }] };
        const count = (state: TrackState) => days.filter((x) => x?.state === state).length;
        const waiting = count("waiting");
        const failing = count("failing");
        const halted = count("halted");
        return {
          label: `${d.day.key} · ${waiting + failing + halted} of ${lines.length} not caught up`,
          segments: [
            { label: "halted", n: halted, tone: "error" as const },
            { label: "failing", n: failing, tone: "warn" as const },
            { label: "waiting on review", n: waiting, tone: "info" as const },
          ].filter((s) => s.n > 0),
        };
      }),
    },
  };
}

export function linesBoard(model: Model, now: Date): CanvasBoardView {
  if (!model.measured) {
    return {
      view: "board",
      header: { status: { label: "NOT READ", tone: "neutral" } },
      sections: [],
    };
  }
  const n = model.lines.length;
  const count = (kind: PillKind) => model.lines.filter((l) => l.pill.kind === kind).length;
  const current = count("current");
  const label =
    current === n
      ? `${n} OF ${n} CURRENT`
      : HEADER_WORDS.filter(([kind]) => count(kind) > 0)
          .map(([kind, singular, many]) => `${count(kind)} ${count(kind) === 1 ? singular : many}`)
          .join(" · ");
  const tone: CanvasTone =
    current === n
      ? "ok"
      : count("broken")
        ? "error"
        : count("halted") || count("blocked") || count("stale")
          ? "warn"
          : count("waiting")
            ? "info"
            : "neutral";
  const caption = plannedText(model);
  const ordered = [...model.lines].sort(
    (a, b) => SEVERITY.indexOf(a.pill.kind) - SEVERITY.indexOf(b.pill.kind),
  );
  const fold = ordered.filter(settled).length >= FOLD_AT;
  const folded = fold ? ordered.filter(settled) : [];
  const shown = fold ? ordered.filter((l) => !settled(l)) : ordered;
  const sections: Section[] = [
    tiles(model),
    {
      kind: "table",
      ...(caption ? { caption } : {}),
      columns: [
        { key: "service", label: "service" },
        { key: "upstream", label: "upstream" },
        { key: "sync", label: "sync" },
        { key: "cascade", label: "cascade" },
        { key: "main", label: "main" },
        { key: "release", label: "release" },
        { key: "lane", label: "lane" },
        { key: "template", label: "template" },
        { key: "days", label: `${HISTORY_DAYS} days` },
      ],
      rows: [
        ...shown.map((line) => ({
          service: { value: line.fork.id, href: line.url },
          upstream: upstreamCell(line),
          sync: syncCell(line, now),
          cascade: cascadeCell(line, now),
          main: mainCell(line, now),
          release: releaseCell(line, now),
          lane: laneCell(line),
          template: templateCell(line, now),
          days: daysCell(line),
        })),
        ...(folded.length
          ? [
              {
                service: `${folded.length} current: ${names(folded.map((l) => l.fork.id))}`,
                upstream: CLEAR,
                sync: CLEAR,
                cascade: CLEAR,
                main: CLEAR,
                release: "",
                lane: CLEAR,
                template: station(model.template.steps[0]?.label ?? "current", "ok"),
                days: "",
              },
            ]
          : []),
      ],
    },
  ];
  const fleet = (["upstream", "template"] as const).flatMap((t) => fleetLane(model, t) ?? []);
  if (fleet.length > 0)
    sections.push({
      kind: "rows",
      title: `Fleet · forks not caught up at day end, last ${HISTORY_DAYS} UTC days`,
      items: fleet,
    });
  const gitlab = stamp(model.upstreamAt, now);
  return {
    view: "board",
    header: {
      status: { label, tone },
      chip: [gitlab ? `GitLab read ${gitlab}` : undefined, zoned(model.sweptAt, now) ?? "not swept"]
        .filter(Boolean)
        .join(" · "),
    },
    sections,
  };
}
