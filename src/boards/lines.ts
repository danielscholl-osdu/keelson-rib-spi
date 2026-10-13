// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { TEMPLATE_REPO } from "../config.ts";
import { prVerdict } from "../model/checks.ts";
import type { Model } from "../model/index.ts";
import type { LineModel, LinePr } from "../model/lines.ts";
import type { TemplateModel } from "../model/template.ts";
import { age, days, plural, stamp, zoned } from "../util.ts";

type Section = CanvasBoardView["sections"][number];
type TableSection = Extract<Section, { kind: "table" }>;
type RowsSection = Extract<Section, { kind: "rows" }>;
type Cell = TableSection["rows"][number][string];

const CHANGES_SHOWN = 8;

// Station cells never wrap, so the table gives the spare width to the notes.
function one(text: string): string {
  return text.replace(/ /g, "\u00a0");
}

function station(text: string, tone?: CanvasTone, href?: string): Cell {
  return { value: one(text), ...(tone ? { tone } : {}), ...(href ? { href } : {}) };
}

// "4d" past a day, "7h" before it.
function since(at: string, now: Date): string {
  const d = days(at, now);
  return d ? `${d}d` : (age(at, now) ?? "?");
}

// An open PR as a station: stopped on a real failure, ready to merge, or waiting.
function prStation(p: LinePr, text: string): Cell {
  const shown = p.failures.filter((f) => !f.hidden);
  if (shown.some((f) => f.cls !== "ENV" && f.cls !== "POLICY")) {
    return station(`✕ ${text}`, "error", p.pr.url);
  }
  const ready =
    shown.length === 0 &&
    prVerdict(p.pr) === "green" &&
    !p.pr.draft &&
    p.pr.reviewDecision !== "REVIEW_REQUIRED" &&
    p.pr.reviewDecision !== "CHANGES_REQUESTED";
  return ready
    ? station(`◷ ${text} · ready`, "info", p.pr.url)
    : station(`◷ ${text}`, "warn", p.pr.url);
}

function upstreamCell(line: LineModel): Cell {
  const lag = line.upstream?.lag;
  const behind = lag ? ` · ${lag} behind` : "";
  if (line.halt) return station(`✕ halted${behind}`, "error", line.halt.issue.url);
  const pr = line.syncPr;
  if (pr && prVerdict(pr.pr) === "red") {
    return station(`✕ PR #${pr.pr.number} red${behind}`, "error", pr.pr.url);
  }
  if (pr) return prStation(pr, `PR #${pr.pr.number}${behind}`);
  if (line.syncRun?.conclusion === "failure") {
    return station("✕ sync run failed", "error", line.syncRun.url);
  }
  if (lag === undefined) return "?";
  if (lag > 0) return station(`◷ ${lag} behind`, "warn");
  return station("✓ caught up");
}

// The version a fork is on and, with a template-sync PR open, the one it moves to.
function templateCell(line: LineModel, now: Date): Cell {
  const { run, state } = line.templateDelivery;
  if (run && state === "failed") {
    return station(`✕ template-sync failed · ${stamp(run.createdAt, now)}`, "error", run.url);
  }
  if (run && state === "stale") {
    return station(`◷ template-sync stale · ${stamp(run.createdAt, now)}`, "warn", run.url);
  }
  const { behind, label, target, awaitingRun } = line.template;
  if (behind === undefined) return "?";
  if (behind === 0) return station(`✓ ${label ?? "current"}`);
  const pr = line.templatePr;
  if (awaitingRun) return station(`◷ ${label ?? "?"} · ${behind} behind`, "warn");
  if (!pr) return station(`✕ ${label ?? "?"} · ${behind} behind, no PR`, "error");
  return prStation(pr, `PR #${pr.pr.number} · ${label ?? "?"} → ${target ?? "?"}`);
}

function releaseCell(line: LineModel, now: Date): Cell {
  if (line.cascadeStop) {
    const conflict = line.conflicts[0];
    return conflict
      ? station("✕ cascade conflict", "error", conflict.url)
      : station("✕ cascade blocked", "error", line.tracking?.url);
  }
  const cascade = line.cascadePr;
  if (cascade && prVerdict(cascade.pr) === "red") {
    return station(`✕ cascade PR #${cascade.pr.number} red`, "error", cascade.pr.url);
  }
  if (cascade) return prStation(cascade, `cascade PR #${cascade.pr.number}`);
  if (line.cascadeRunning) return station("↻ cascade running", "info");
  if (line.mainRed) {
    return line.mainRed.cls === "ENV"
      ? station("⊘ main red on the stack", undefined, line.mainRed.run.url)
      : station("✕ main red", "error", line.mainRed.run.url);
  }
  const next = line.releasePr;
  if (next) {
    const version = /release\s+v?(\S+)/i.exec(next.pr.title)?.[1];
    return prStation(next, `release PR #${next.pr.number}${version ? ` · ${version}` : ""}`);
  }
  if (!line.runsRead) return "?";
  const release = line.release
    ? `${line.release.tag} · ${since(line.release.at, now)}`
    : "no release yet";
  return station(`${line.mainRun ? "✓ " : ""}${release}`, undefined, line.release?.url);
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

function changeTone(title: string): CanvasTone {
  if (/^fix/i.test(title)) return "caution";
  if (/^feat/i.test(title)) return "info";
  return "neutral";
}

// "all 5 forks", "all but schema", or the forks still missing it.
function missingText(missing: readonly string[], forks: readonly string[]): string {
  if (missing.length === forks.length) return `all ${forks.length} forks`;
  const have = forks.filter((f) => !missing.includes(f));
  if (have.length === 1) return `all but ${have[0]}`;
  return missing.length <= 2 ? names(missing) : plural(missing.length, "fork");
}

function changesSection(t: TemplateModel, forks: readonly string[], now: Date): RowsSection {
  const release = t.releasePr ? /release\s+v?(\S+)/i.exec(t.releasePr.title)?.[1] : undefined;
  const ahead = t.mainAhead ?? t.commits;
  const title = [
    "Template changes not on every fork",
    `osdu-spi main, ${plural(ahead, "commit")} past ${t.latestTag ?? "the last tag"}`,
    release ? `release ${release} pending` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const shown = t.changes.slice(0, CHANGES_SHOWN);
  const rest = t.changes.length - shown.length;
  return {
    kind: "rows",
    title,
    items: [
      ...shown.map((c) => ({
        glyph: changeTone(c.title),
        text: `${c.title}${c.pr ? ` (#${c.pr})` : ""}`,
        href: c.url,
        trailing: `${missingText(c.missing, forks)} · ${since(c.at, now)}`,
      })),
      ...(rest > 0
        ? [
            {
              text: `${plural(rest, "more change")} on osdu-spi main`,
              href: `https://github.com/${TEMPLATE_REPO}/compare/${t.latestTag ?? "main"}...main`,
            },
          ]
        : []),
    ],
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
  const stopped = model.lines.filter((l) => l.pill.tone === "error").length;
  const waiting = model.lines.filter((l) => l.pill.tone === "warn").length;
  const current = model.lines.filter((l) => l.current).length;
  const label =
    current === n
      ? `${n} OF ${n} CURRENT`
      : [stopped ? `${stopped} STOPPED` : "", waiting ? `${waiting} WAITING` : ""]
          .filter(Boolean)
          .join(" · ") || `${current} OF ${n} CURRENT`;
  const tone: CanvasTone = current === n ? "ok" : stopped ? "error" : "warn";
  const caption = plannedText(model);
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
      rows: model.lines.map((line) => ({
        service: { value: line.fork.id, href: line.url },
        state: { badges: [{ text: one(line.pill.label), tone: line.pill.tone }] },
        upstream: upstreamCell(line),
        template: templateCell(line, now),
        release: releaseCell(line, now),
        notes: line.why ?? "",
      })),
    },
  ];
  if (model.template.changes.length > 0) {
    sections.push(
      changesSection(
        model.template,
        model.lines.map((l) => l.fork.id),
        now,
      ),
    );
  }
  return {
    view: "board",
    header: {
      status: { label, tone },
      chip: `${n} forks · ${current} current · ${zoned(model.sweptAt, now) ?? "not swept"}`,
    },
    sections,
  };
}
