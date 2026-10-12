// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone, RibSurfaceBadge } from "@keelson/shared";
import type { Facts } from "../facts.ts";
import type { Model } from "../model/index.ts";
import type { QueueItem, Rung, Verdict } from "../model/queue.ts";
import { age, clip, plural, stamp } from "../util.ts";

const RUNG_TONE: Record<Rung, CanvasTone> = { 0: "error", 1: "caution", 2: "info" };
const VERDICT_TONE: Record<Verdict, CanvasTone> = {
  BLOCKED: "error",
  ATTENTION: "caution",
  MOVING: "info",
  CONVERGED: "ok",
};

// The row's disclosure holds at most 4000 characters, so a long effect list is cut
// at a whole line and says how many were left out.
function effectsDetail(item: QueueItem): string | undefined {
  if (item.effects.length === 0) return undefined;
  const lines = item.effects.map((e) => `• ${e.text}${e.url ? `\n  ${e.url}` : ""}`);
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > 3800) break;
    kept.push(line);
    size += line.length + 1;
  }
  const left = lines.length - kept.length;
  return left > 0 ? `${kept.join("\n")}\n…and ${left} more` : kept.join("\n");
}

export function verdictLabel(model: Model): string {
  const { verdict, incidents } = model.queue;
  if ((verdict === "BLOCKED" || verdict === "ATTENTION") && incidents > 0) {
    return `${verdict} · ${plural(incidents, "INCIDENT", "INCIDENTS")}`;
  }
  return verdict;
}

export function attentionBoard(model: Model, facts: Facts, now: Date): CanvasBoardView {
  if (!model.measured) {
    const error = facts.github.error;
    return {
      view: "board",
      header: { status: { label: error ? "DARK" : "SWEEPING", tone: "neutral" } },
      sections: [
        {
          kind: "rows",
          items: [
            {
              glyph: error ? "error" : "neutral",
              text: error
                ? `GitHub could not be read: ${clip(error, 160)}. Open the Doctor below.`
                : "The first sweep is reading GitHub and GitLab.",
            },
          ],
        },
      ],
    };
  }
  const { counts, items, verdict } = model.queue;
  const chip = `P0 ${counts.p0} · P1 ${counts.p1} · P2 ${counts.p2}${model.sweptAt ? ` · ${stamp(model.sweptAt, now)}` : ""}`;
  return {
    view: "board",
    header: { status: { label: verdictLabel(model), tone: VERDICT_TONE[verdict] }, chip },
    sections: [
      {
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
                const detail = effectsDetail(item);
                const trailing = [item.note, age(item.since, now)].filter(Boolean).join(" · ");
                return {
                  chip: { label: `P${item.rung}`, tone: RUNG_TONE[item.rung] },
                  text: clip(`${item.scope} · ${item.text}`, 220),
                  ...(item.url ? { href: item.url } : {}),
                  ...(trailing ? { trailing } : {}),
                  ...(detail ? { detail } : {}),
                };
              }),
      },
    ],
  };
}

export function badge(model: Model): RibSurfaceBadge {
  if (!model.measured) return { count: 0 };
  const { p0, p1 } = model.queue.counts;
  const count = p0 + p1;
  return count > 0 ? { count, title: `SPI · ${p0} P0 · ${p1} P1` } : { count: 0 };
}
