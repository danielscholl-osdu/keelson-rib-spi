// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { prReady, prVerdict } from "../model/checks.ts";
import type { Model } from "../model/index.ts";
import type { LineModel, LinePr, PillKind } from "../model/lines.ts";
import type { TemplateModel, TemplateStep } from "../model/template.ts";
import { plural, releaseTag, since, stamp, zoned } from "../util.ts";

type Section = CanvasBoardView["sections"][number];
type TableSection = Extract<Section, { kind: "table" }>;
type BarsSection = Extract<Section, { kind: "bars" }>;
type Cell = TableSection["rows"][number][string];

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

function mainText(lines: readonly LineModel[]): string {
  const n = lines.length;
  if (!lines.every((l) => l.runsRead)) return plural(n, "fork");
  const green = lines.filter((l) => l.mainRun?.conclusion === "success").length;
  return green === n ? `main green on all ${n} forks` : `main green on ${green} of ${n} forks`;
}

// Station cells never wrap, so the table gives the spare width to the notes.
function one(text: string): string {
  return text.replace(/ /g, "\u00a0");
}

function station(text: string, tone?: CanvasTone, href?: string): Cell {
  return { value: one(text), ...(tone ? { tone } : {}), ...(href ? { href } : {}) };
}

// An open PR as a station: failing on a real failure, ready to merge, or waiting.
function prStation(p: LinePr, text: string): Cell {
  const shown = p.failures.filter((f) => !f.hidden);
  if (shown.some((f) => f.cls !== "ENV" && f.cls !== "POLICY")) {
    return station(`✕ ${text}`, "warn", p.pr.url);
  }
  return station(`◷ ${text}${prReady(p.pr, p.failures) ? " · ready" : ""}`, "info", p.pr.url);
}

// Position first, handle last, so a column's versions line up under its ✓ cells.
function upstreamCell(line: LineModel): Cell {
  const lag = line.upstream?.lag;
  const at = (hold: string) => (lag ? `${lag} behind · ${hold}` : hold);
  if (line.halt) return station(`✕ ${at("halted")}`, "error", line.halt.issue.url);
  const pr = line.syncPr;
  if (pr && prVerdict(pr.pr) === "red") {
    return station(`✕ ${at(`PR #${pr.pr.number} failing`)}`, "warn", pr.pr.url);
  }
  if (pr) return prStation(pr, at(`PR #${pr.pr.number}`));
  if (line.syncRun?.conclusion === "failure") {
    return station(`✕ ${at("sync run failed")}`, "error", line.syncRun.url);
  }
  if (lag === undefined) return "?";
  if (lag > 0) return station(`◷ ${lag} behind`, "info");
  return station("✓ current", "ok");
}

// The version a fork is on and, with a template-sync PR open, the one it moves to.
function templateCell(line: LineModel, now: Date): Cell {
  const { behind, label, awaitingRun } = line.template;
  const on = label ?? "?";
  const { run, state } = line.templateDelivery;
  if (run && state === "failed") {
    return station(`✕ ${on} · Sync Template failed ${stamp(run.createdAt, now)}`, "error", run.url);
  }
  if (run && state === "stale") {
    return station(`◷ ${on} · Sync Template ran ${stamp(run.createdAt, now)}`, "warn", run.url);
  }
  if (behind === undefined) return "?";
  if (behind === 0) return station(`✓ ${label ?? "current"}`, "ok");
  const pr = line.templatePr;
  if (awaitingRun) return station(`◷ ${on} · ${behind} behind`, "info");
  if (!pr) return station(`✕ ${on} · ${behind} behind, no PR`, "error");
  return prStation(pr, `${on} · PR #${pr.pr.number}`);
}

function releaseCell(line: LineModel, now: Date): Cell {
  const tag = line.release?.tag;
  const at = (hold: string) => (tag ? `${tag} · ${hold}` : hold);
  if (line.cascadeStop) {
    const conflict = line.conflicts[0];
    return conflict
      ? station(`✕ ${at("cascade conflict")}`, "warn", conflict.url)
      : station(`✕ ${at("cascade blocked")}`, "warn", line.tracking?.url);
  }
  const cascade = line.cascadePr;
  if (cascade && prVerdict(cascade.pr) === "red") {
    return station(`✕ ${at(`cascade PR #${cascade.pr.number} failing`)}`, "warn", cascade.pr.url);
  }
  if (cascade) return prStation(cascade, at(`cascade PR #${cascade.pr.number}`));
  if (line.cascadeRunning) return station(`↻ ${at("cascade running")}`, "info");
  if (line.mainRed) {
    return line.mainRed.cls === "ENV"
      ? station(`⊘ ${at("main red on the stack")}`, undefined, line.mainRed.run.url)
      : station(`✕ ${at("main red")}`, "error", line.mainRed.run.url);
  }
  const next = line.releasePr;
  if (next) {
    const to = releaseTag(next.pr.title, tag);
    const move = to ? (tag ? `${tag} → ${to} · ` : `first release ${to} · `) : "";
    return prStation(next, `${move}PR #${next.pr.number}`);
  }
  if (!line.runsRead) return "?";
  const release = line.release ? at(since(line.release.at, now)) : "no release yet";
  return line.mainRun
    ? station(`✓ ${release}`, "ok", line.release?.url)
    : station(release, undefined, line.release?.url);
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

function stepCounts(step: TemplateStep, total: number): string {
  const counts = [
    `${step.adopted.length} of ${total}`,
    step.waiting.length ? `${step.waiting.length} waiting` : "",
    step.failing.length ? `${step.failing.length} failing` : "",
    step.noPr.length ? `${step.noPr.length} no PR` : "",
    step.unmeasured.length ? `${step.unmeasured.length} unread` : "",
  ].filter(Boolean);
  return step.changes.length === 0 && step.adopted.length === total
    ? `${counts[0]} · every fork`
    : counts.join(" · ");
}

function stepLabel(step: TemplateStep): string {
  if (step.changes.length === 0) return step.label;
  const what = [
    ...step.consequences,
    step.templateOnly ? `${step.templateOnly} template only` : "",
    step.unread ? `${step.unread} unread` : "",
  ].filter(Boolean);
  return `${step.label} · ${plural(step.changes.length, "change")}: ${what.join(", ")}`;
}

// One bar per step of template history a fork still sits behind, newest first.
function ladderSection(t: TemplateModel, total: number): BarsSection | undefined {
  if (t.steps.length === 0) return undefined;
  const top = t.steps[0];
  const past = t.changes.length;
  const title =
    top && !t.mainAhead
      ? `Template · osdu-spi main is ${top.label}`
      : `Template · osdu-spi main is ${top?.label ?? "?"}, ${plural(past, "change")} past ${t.latestTag ?? "the last tag"}`;
  return {
    kind: "bars",
    title,
    items: t.steps.map((step) => {
      const measured = total - step.unmeasured.length;
      const segments = [
        { label: "adopted", n: step.adopted.length, tone: "ok" as const },
        { label: "PR waiting", n: step.waiting.length, tone: "info" as const },
        { label: "PR failing", n: step.failing.length, tone: "warn" as const },
        { label: "no PR", n: step.noPr.length, tone: "error" as const },
        { label: "unread", n: step.unmeasured.length, tone: "neutral" as const },
      ].filter((seg) => seg.n > 0);
      return {
        label: stepLabel(step),
        value: measured === 0 ? null : step.adopted.length,
        total,
        segments: segments.length ? segments : [{ label: "adopted", n: 0, tone: "ok" as const }],
        trailing: stepCounts(step, total),
        ...(step.url ? { href: step.url } : {}),
      };
    }),
  };
}

function settled(line: LineModel): boolean {
  return line.pill.kind === "current" && !line.releasePr;
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
    {
      kind: "table",
      ...(caption ? { caption } : {}),
      columns: [
        { key: "service", label: "service" },
        { key: "state", label: "state" },
        { key: "upstream", label: "upstream" },
        { key: "template", label: "template" },
        { key: "release", label: "release" },
        { key: "notes", label: "notes" },
      ],
      rows: [
        ...shown.map((line) => ({
          service: { value: line.fork.id, href: line.url },
          state: { badges: [{ text: one(line.pill.label), tone: line.pill.tone }] },
          upstream: upstreamCell(line),
          template: templateCell(line, now),
          release: releaseCell(line, now),
          notes: line.why ?? "",
        })),
        ...(folded.length
          ? [
              {
                service: `${folded.length} current`,
                state: { badges: [{ text: "current", tone: "ok" as const }] },
                upstream: station("✓ current", "ok"),
                template: station(`✓ ${model.template.steps[0]?.label ?? "current"}`, "ok"),
                release: station("✓ no release waiting", "ok"),
                notes: names(folded.map((l) => l.fork.id)),
              },
            ]
          : []),
      ],
    },
  ];
  const ladder = ladderSection(model.template, n);
  if (ladder) sections.push(ladder);
  return {
    view: "board",
    header: {
      status: { label, tone },
      chip: `${mainText(model.lines)} · ${current} current · ${zoned(model.sweptAt, now) ?? "not swept"}`,
    },
    sections,
  };
}
