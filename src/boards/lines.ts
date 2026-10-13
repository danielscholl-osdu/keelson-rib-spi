// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { AUTOMATION_APP, githubUrl, HISTORY_DAYS } from "../config.ts";
import type { Gate } from "../model/gates.ts";
import {
  type FleetDay,
  fleetDays,
  type TrackDay,
  type TrackState,
  worse,
} from "../model/history.ts";
import type { Model } from "../model/index.ts";
import { type LineModel, type LinePr, type PillKind, prRed } from "../model/lines.ts";
import type { IssueKind, WorkRow } from "../model/work.ts";
import { plural, releaseTag, since, span, stamp, zoned } from "../util.ts";
import { FOLD_AT, fleetSearch, names } from "./fold.ts";
import { keyGrid, spanText } from "./key.ts";

type Section = CanvasBoardView["sections"][number];
type TableSection = Extract<Section, { kind: "table" }>;
type Cell = TableSection["rows"][number][string];
type Stat = Extract<Section, { kind: "stats" }>["items"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Bar = NonNullable<Row["bar"]>;
type SeriesCell = Extract<Bar, { cells: unknown }>["cells"][number];

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
  return line.mainRun ? CLEAR : "?";
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

function plannedText(model: Model): string | undefined {
  const planned = model.planned.map((p) => p.service.id);
  if (planned.length === 0) return undefined;
  return `${names(planned)} ${planned.length === 1 ? "has" : "have"} no fork yet`;
}

type LineCells = Record<string, Cell>;

function lineCells(line: LineModel, now: Date): LineCells {
  return {
    service: { value: line.fork.id, href: line.url },
    upstream: upstreamCell(line),
    sync: syncCell(line, now),
    cascade: cascadeCell(line, now),
    main: mainCell(line, now),
    release: releaseCell(line, now),
    lane: laneCell(line),
    template: templateCell(line, now),
    days: daysCell(line),
  };
}

// Waiting or current on every station, read everywhere, and no PR red: the banner names its PRs.
function quiet(line: LineModel, cells: LineCells): boolean {
  if (line.pill.kind !== "current" && line.pill.kind !== "waiting") return false;
  if ([line.syncPr, line.cascadePr, line.releasePr, line.templatePr].some((p) => p && prRed(p)))
    return false;
  return Object.entries(cells).every(
    ([key, c]) =>
      key === "days" ||
      (c !== "?" && !(typeof c === "object" && c && (c.tone === "warn" || c.tone === "error"))),
  );
}

function waitingPrs(lines: readonly LineModel[]): string | undefined {
  const count = (pick: (l: LineModel) => boolean) => lines.filter(pick).length;
  const parts: [number, string][] = [
    [count((l) => !!l.releasePr && !l.release?.tag), "first-release PR"],
    [count((l) => !!l.releasePr && !!l.release?.tag), "release PR"],
    [count((l) => !!l.templatePr), "template-sync PR"],
    [count((l) => !!l.syncPr), "sync PR"],
    [count((l) => !!l.cascadePr), "release/upstream PR"],
  ];
  const named = parts.filter(([n]) => n > 0);
  if (named.length === 0) return undefined;
  const total = named.reduce((n, [k]) => n + k, 0);
  return `${names(named.map(([n, w]) => plural(n, w)))} ${total === 1 ? "waits" : "wait"}, named in the banner`;
}

function foldLine(lines: readonly LineModel[]): Section {
  const prs = waitingPrs(lines);
  const text = [
    `${plural(lines.length, "fork")} ${prs ? "current or waiting on review" : "current"}`,
    names(lines.map((l) => l.fork.id)),
    prs,
  ]
    .filter(Boolean)
    .join(" · ");
  return { kind: "rows", items: [{ glyph: prs ? "info" : "ok", text }] };
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
  return {
    kind: "stats",
    items: [
      gateStat("Upstream · oldest held", gates.upstream, gates.measured, (m) =>
        m
          ? `upstream reaches main in ${m} at the median · ${plural(gates.upstream.n, "sync")} in ${HISTORY_DAYS} d`
          : `no sync reached main in ${HISTORY_DAYS} d`,
      ),
      gateStat(
        "Release · oldest PR",
        gates.release,
        gates.measured,
        () => `${plural(gates.release.n, "release")} cut in ${HISTORY_DAYS} d`,
      ),
      workStat(model.work.forks),
    ],
  };
}

function workStat(rows: readonly WorkRow[]): Stat {
  const read = rows.filter((r) => r.read);
  const prs = read.reduce((n, r) => n + r.prs.people.length, 0);
  const outside = read.reduce((n, r) => n + r.contributors.length, 0);
  const issues = read.reduce((n, r) => n + peopleIssues(r).length, 0);
  return {
    label: "Open work · people",
    value: plural(prs, "PR"),
    sub: [outside ? `${outside} from outside` : undefined, plural(issues, "issue")]
      .filter(Boolean)
      .join(" · "),
  };
}

const ISSUE_WORDS: [Exclude<IssueKind, "automation">, string][] = [
  ["bug", "bug"],
  ["enhancement", "enhancement"],
  ["other", "other"],
];

function peopleIssues(row: WorkRow) {
  return [...row.issues.bug, ...row.issues.enhancement, ...row.issues.other];
}

function search(repo: string, kind: "pulls" | "issues", q: string): string {
  return `${githubUrl(repo, `/${kind}`)}?q=${encodeURIComponent(q)}`;
}

const NONE: Cell = { value: "—", tone: "neutral" };

function countCell(n: number, href: string, extra: (string | undefined)[] = []): Cell {
  if (n === 0) return NONE;
  return { value: [String(n), ...extra].filter(Boolean).join(" · "), href };
}

function workRowCells(row: WorkRow, now: Date): Record<string, Cell> {
  const repo = { value: row.name, href: githubUrl(row.repo) };
  if (!row.read)
    return {
      repo,
      people: "?",
      issues: "?",
      automation: "?",
      oldest: "?",
    };
  const { people } = row.prs;
  const drafts = people.filter((p) => p.draft).length;
  const outside = row.contributors.length;
  const issues = peopleIssues(row);
  const peopleCell = countCell(
    people.length,
    search(row.repo, "pulls", `is:pr is:open -author:app/dependabot -author:app/${AUTOMATION_APP}`),
    [outside ? `${outside} outside` : undefined, drafts ? `${drafts} draft` : undefined],
  );
  return {
    repo,
    people:
      outside && typeof peopleCell === "object" ? { ...peopleCell, tone: "info" } : peopleCell,
    issues: countCell(
      issues.length,
      search(row.repo, "issues", `is:issue is:open -author:app/${AUTOMATION_APP}`),
      ISSUE_WORDS.map(([k, word]) =>
        row.issues[k].length && row.issues[k].length < issues.length
          ? `${row.issues[k].length} ${word}`
          : undefined,
      ),
    ),
    automation: countCell(
      row.issues.automation.length,
      search(row.repo, "issues", `is:issue is:open author:app/${AUTOMATION_APP}`),
    ),
    oldest: row.oldest
      ? {
          value: one(`#${row.oldest.number} · ${since(row.oldest.createdAt, now)}`),
          href: row.oldest.url,
        }
      : NONE,
  };
}

// Pipeline PRs and Dependabot are the pipeline's own; one line counts them across the fleet.
function workTotals(rows: readonly WorkRow[]): Section {
  const read = rows.filter((r) => r.read);
  const pipeline = read.reduce((n, r) => n + r.prs.pipeline.length, 0);
  const bots = read.reduce((n, r) => n + r.prs.bots.length, 0);
  return {
    kind: "rows",
    items: [
      {
        icon: "↗",
        text: `${plural(pipeline, "pipeline PR")} · ${bots} Dependabot across ${plural(read.length, "fork")}`,
        trailing: "open on GitHub",
        href: fleetSearch(
          read.map((r) => r.repo),
          "is:pr is:open",
        ),
      },
    ],
  };
}

function peopleWork(row: WorkRow): boolean {
  return (
    !row.read ||
    row.prs.people.length > 0 ||
    peopleIssues(row).length > 0 ||
    row.unreadPrs > 0 ||
    row.unreadIssues > 0
  );
}

function workTable(model: Model, now: Date): Section | undefined {
  const rows = model.work.forks.filter(peopleWork);
  if (rows.length === 0) return undefined;
  const short = model.work.forks.filter((r) => r.unreadPrs > 0 || r.unreadIssues > 0);
  const caption = [
    "Open work · forks with people PRs or issues",
    ...short.map(
      (r) =>
        `${r.name}: ${[r.unreadPrs ? plural(r.unreadPrs, "PR") : undefined, r.unreadIssues ? plural(r.unreadIssues, "issue") : undefined].filter(Boolean).join(" and ")} past the page, not counted`,
    ),
  ].join(" · ");
  return {
    kind: "table",
    caption,
    columns: [
      { key: "repo", label: "fork" },
      { key: "people", label: "people PRs" },
      { key: "issues", label: "issues" },
      { key: "automation", label: "automation issues" },
      { key: "oldest", label: "oldest people PR" },
    ],
    rows: rows.map((row) => workRowCells(row, now)),
  };
}

// Every fill draws at full tone, so forks not yet created are named in the tooltip, not drawn.
function fleetColumn(d: FleetDay, total: number) {
  if (d.unread) return { label: `${d.day.key} · unread`, segments: [{ label: "unread", n: null }] };
  const behind = d.halted + d.failing + d.waiting;
  const absent = total - d.forks;
  return {
    label: `${d.day.key} · ${behind} of ${d.forks} not caught up${absent > 0 ? `, ${absent} not forked yet` : ""}`,
    segments: [
      { label: "halted", n: d.halted, tone: "error" as const },
      { label: "failing", n: d.failing, tone: "warn" as const },
      { label: "waiting on review", n: d.waiting, tone: "info" as const },
    ].filter((s) => s.n > 0),
  };
}

function fleetLane(days: readonly FleetDay[], track: string, total: number): Row {
  return {
    text: track,
    bar: { total, rest: "ok", columns: days.map((d) => fleetColumn(d, total)) },
  };
}

const FLEET_KEY = [
  { label: "halted", tone: "error" as const },
  { label: "failing", tone: "warn" as const },
  { label: "waiting on review", tone: "info" as const },
];

function fleet(model: Model): Section[] {
  const total = model.lines.length;
  const tracks = (["upstream", "template"] as const).map((t) => ({
    t,
    days: fleetDays(model.lines.map((l) => l.history?.[t])),
  }));
  const lanes = tracks.filter((x) => x.days.length > 0);
  if (lanes.length === 0) return [];
  return [
    keyGrid(
      `Fleet · forks not caught up at day end · ${spanText(lanes[0]?.days ?? [], "column")}`,
      FLEET_KEY,
    ),
    { kind: "rows", items: lanes.map((x) => fleetLane(x.days, x.t, total)) },
  ];
}

export function linesBoard(
  model: Model,
  now: Date,
  opts: { stale?: string } = {},
): CanvasBoardView {
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
  const drawn = ordered.map((line) => ({ line, cells: lineCells(line, now) }));
  const calm = drawn.filter(({ line, cells }) => quiet(line, cells));
  const fold = calm.length >= FOLD_AT;
  const shown = fold ? drawn.filter((d) => !calm.includes(d)) : drawn;
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
      rows: shown.map((d) => d.cells),
    },
  ];
  if (fold) sections.push(foldLine(calm.map((d) => d.line)));
  sections.push(...fleet(model));
  sections.push(workTotals(model.work.forks));
  const work = workTable(model, now);
  if (work) sections.push(work);
  const gitlab = stamp(model.upstreamAt, now);
  return {
    view: "board",
    header: {
      status: { label, tone },
      chip: [
        opts.stale,
        gitlab ? `GitLab read ${gitlab}` : undefined,
        opts.stale ? undefined : (zoned(model.sweptAt, now) ?? "not swept"),
      ]
        .filter(Boolean)
        .join(" · "),
    },
    sections,
  };
}
