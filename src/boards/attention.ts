// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone, RibSurfaceBadge } from "@keelson/shared";
import type { Readiness } from "../act/readiness.ts";
import type { Facts } from "../facts.ts";
import type { Model } from "../model/index.ts";
import { itemClass, verbOf } from "../model/next.ts";
import type { Rung, Verdict } from "../model/queue.ts";
import { INSPECT_ACTION } from "../surfaces.ts";
import { age, clip, plural, zoned } from "../util.ts";
import { doctorRow, doctorStatus } from "./doctor.ts";

type Section = CanvasBoardView["sections"][number];

const RUNG_TONE: Record<Rung, CanvasTone> = { 0: "error", 1: "caution", 2: "info" };
const VERDICT_TONE: Record<Verdict, CanvasTone> = {
  BLOCKED: "error",
  ATTENTION: "caution",
  MOVING: "info",
  CONVERGED: "ok",
};

export function verdictLabel(model: Model): string {
  const { verdict, incidents } = model.queue;
  if ((verdict === "BLOCKED" || verdict === "ATTENTION") && incidents > 0) {
    return `${verdict} · ${plural(incidents, "INCIDENT", "INCIDENTS")}`;
  }
  return verdict;
}

export function attentionBoard(
  model: Model,
  facts: Facts,
  now: Date,
  opts: { selected?: string; act?: Readiness } = {},
): CanvasBoardView {
  const { selected, act } = opts;
  const doctor = doctorRow(facts, now, act);
  if (!model.measured) {
    const error = facts.github.error;
    return {
      view: "board",
      header: { status: { label: error ? "DARK" : "SWEEPING", tone: "neutral" } },
      sections: [
        doctor && doctor.tone !== "ok"
          ? doctor.section
          : {
              kind: "rows",
              items: [{ glyph: "neutral", text: "The first sweep is reading GitHub and GitLab." }],
            },
      ],
    };
  }
  const { counts, items, verdict, incidents } = model.queue;
  const problems = doctor && doctor.tone !== "ok" ? doctorStatus(facts, now).problems.length : 0;
  const flag =
    doctor?.tone === "error"
      ? "⚠ DOCTOR · GITHUB DARK · "
      : problems > 0
        ? `⚠ DOCTOR · ${plural(problems, "PROBLEM", "PROBLEMS")} · `
        : "";
  // A port owed is neither broken nor a gate; it counts apart so the words still sum to the badge.
  const owed = items.filter((i) => i.cls === "PORT" && i.rung < 2).length;
  const gates = counts.p0 + counts.p1 - incidents - owed;
  const chip = `${flag}${incidents} broke · ${gates} gate${owed > 0 ? ` · ${owed} owed` : ""} · ${counts.p2} ready${model.sweptAt ? ` · ${zoned(model.sweptAt, now)}` : ""}`;
  const queue: Section = {
    kind: "rows",
    items:
      items.length === 0
        ? [
            {
              glyph: "ok",
              text: "Nothing needs a person. Every line is current and the stack is deployable.",
            },
          ]
        : items.map((item) => {
            const trailing = [verbOf(item), item.note, age(item.since, now)]
              .filter(Boolean)
              .join(" · ");
            return {
              chip: { label: `P${item.rung} · ${itemClass(item)}`, tone: RUNG_TONE[item.rung] },
              text: clip(`${item.scope} · ${item.text}`, 220),
              action: { type: INSPECT_ACTION, payload: { id: item.id } },
              ...(item.id === selected ? { selected: true } : {}),
              trailing,
            };
          }),
  };
  // A rib that cannot see outranks the queue it builds; one that can sits quietly last.
  const sections = !doctor
    ? [queue]
    : doctor.tone === "ok"
      ? [queue, doctor.section]
      : [doctor.section, queue];
  return {
    view: "board",
    header: { status: { label: verdictLabel(model), tone: VERDICT_TONE[verdict] }, chip },
    sections,
  };
}

export function badge(model: Model): RibSurfaceBadge {
  if (!model.measured) return { count: 0 };
  const { p0, p1 } = model.queue.counts;
  const count = p0 + p1;
  return count > 0 ? { count, title: `SPI · ${p0} P0 · ${p1} P1` } : { count: 0 };
}
