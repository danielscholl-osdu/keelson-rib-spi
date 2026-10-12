// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { githubUrl } from "../config.ts";
import { CLASS_TONE } from "../model/attribution.ts";
import type { Model } from "../model/index.ts";
import type { TemplateRow } from "../model/template.ts";
import { age, plural, short, stamp } from "../util.ts";

type Section = CanvasBoardView["sections"][number];
type TableSection = Extract<Section, { kind: "table" }>;
type Cell = TableSection["rows"][number][string];

const DELIVERY_TONE: Record<TemplateRow["delivery"]["state"], CanvasTone> = {
  ok: "ok",
  failed: "error",
  stale: "warn",
  unknown: "neutral",
};

function blockedBy(row: TemplateRow): Cell {
  if (!row.pr) return "—";
  const classes = [...new Set(row.failures.filter((f) => !f.hidden).map((f) => f.cls))];
  const badges: { text: string; tone: CanvasTone }[] = classes.map((c) => ({
    text: c,
    tone: CLASS_TONE[c],
  }));
  if (row.pr.reviewDecision === "REVIEW_REQUIRED") badges.push({ text: "review", tone: "neutral" });
  if (badges.length === 0)
    return { value: row.verdict === "pending" ? "checks running" : "nothing", tone: "ok" };
  return { badges };
}

function changeGlyph(title: string): CanvasTone {
  if (/^fix/i.test(title)) return "caution";
  if (/^feat/i.test(title)) return "info";
  return "neutral";
}

export function templateBoard(model: Model, now: Date): CanvasBoardView {
  if (!model.measured) {
    return {
      view: "board",
      header: { status: { label: "NOT READ", tone: "neutral" } },
      sections: [],
    };
  }
  const t = model.template;
  const n = t.rows.length;
  const release = t.releasePr ? /release\s+v?(\S+)/i.exec(t.releasePr.title)?.[1] : undefined;
  const chip = [
    `osdu-spi ${t.latestTag ?? "?"}`,
    t.mainAhead !== undefined ? `main +${t.mainAhead}` : undefined,
    release ? `release ${release} pending` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const sections: Section[] = [
    {
      kind: "segments",
      items: [
        { label: "current", n: t.current, tone: "ok" },
        { label: "waiting on a PR", n: t.waiting, tone: "warn" },
        { label: "behind with no PR", n: t.behindNoPr, tone: "error" },
        ...(t.unmeasured > 0 ? [{ label: "unmeasured", n: null }] : []),
      ],
    },
    {
      kind: "table",
      columns: [
        { key: "fork", label: "fork" },
        { key: "on", label: "on" },
        { key: "behind", label: "behind" },
        { key: "pr", label: "PR waiting" },
        { key: "blocked", label: "blocked by" },
        { key: "delivery", label: "delivery" },
      ],
      rows: t.rows.map((row) => ({
        fork: { value: row.service, href: githubUrl(row.repo) },
        on: row.label ?? (row.marker ? short(row.marker) : null),
        behind:
          row.behind === undefined
            ? null
            : { value: row.behind, tone: row.behind > 0 ? "warn" : "ok" },
        pr: row.pr
          ? { value: `#${row.pr.number} · ${age(row.pr.createdAt, now)}`, href: row.pr.url }
          : "none",
        blocked: blockedBy(row),
        delivery: row.delivery.run
          ? {
              value: `${row.delivery.state} · ${stamp(row.delivery.run.createdAt, now)}`,
              tone: DELIVERY_TONE[row.delivery.state],
              href: row.delivery.run.url,
            }
          : { value: "no run", tone: "neutral" },
      })),
    },
  ];
  if (t.changes.length > 0) {
    sections.push({
      kind: "rows",
      title: `Not yet adopted · ${plural(t.changes.length, "change")}, ${plural(t.commits, "commit")}`,
      items: t.changes.map((c) => ({
        glyph: changeGlyph(c.title),
        text: `${c.title}${c.pr ? ` (#${c.pr})` : ""}`,
        href: c.url,
        trailing: `${plural(c.forks, "fork")} · ${age(c.at, now)}`,
      })),
    });
  }
  return {
    view: "board",
    header: {
      status: { label: `${t.current} OF ${n} CURRENT`, tone: t.current === n ? "ok" : "warn" },
      chip,
    },
    sections,
  };
}
