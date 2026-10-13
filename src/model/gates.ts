// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasTone } from "@keelson/shared";
import { gateWaits, median } from "./history.ts";
import type { LineModel } from "./lines.ts";
import { prRed } from "./lines.ts";

export interface GateHold {
  at: string;
  tone: CanvasTone;
}

export interface Gate {
  // The oldest item the gate holds now.
  oldest?: GateHold;
  medianMs?: number;
  n: number;
}

export interface Gates {
  measured: boolean;
  upstream: Gate;
  template: Gate;
  release: Gate;
}

function oldest(items: readonly GateHold[]): GateHold | undefined {
  if (items.length === 0) return undefined;
  const first = [...items].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] as GateHold;
  const tone = items.some((i) => i.tone === "error")
    ? "error"
    : items.some((i) => i.tone === "warn")
      ? "warn"
      : first.tone;
  return { at: first.at, tone };
}

export function buildGates(lines: readonly LineModel[], now: Date): Gates {
  const upstream: GateHold[] = [];
  const template: GateHold[] = [];
  const release: GateHold[] = [];
  const waits = { upstreamMs: [] as number[], templateMs: [] as number[], releases: 0 };
  let measured = lines.length > 0;
  for (const line of lines) {
    if (line.halt) upstream.push({ at: line.halt.issue.createdAt, tone: "warn" });
    if (line.syncPr)
      upstream.push({ at: line.syncPr.pr.createdAt, tone: prRed(line.syncPr) ? "warn" : "info" });
    if (line.cascadePr)
      upstream.push({
        at: line.cascadePr.pr.createdAt,
        tone: prRed(line.cascadePr) ? "warn" : "info",
      });
    for (const c of line.conflicts) upstream.push({ at: c.createdAt, tone: "warn" });
    if (line.templatePr)
      template.push({
        at: line.templatePr.pr.createdAt,
        tone: line.pill.label === "template blocked" ? "warn" : "info",
      });
    if (line.templateDelivery.state === "failed" && line.templateDelivery.run)
      template.push({ at: line.templateDelivery.run.createdAt, tone: "error" });
    if (line.releasePr) release.push({ at: line.releasePr.pr.createdAt, tone: "info" });
    if (!line.past) {
      measured = false;
      continue;
    }
    const w = gateWaits(line.past, now);
    waits.upstreamMs.push(...w.upstreamMs);
    waits.templateMs.push(...w.templateMs);
    waits.releases += w.releases;
  }
  return {
    measured,
    upstream: {
      oldest: oldest(upstream),
      medianMs: median(waits.upstreamMs),
      n: waits.upstreamMs.length,
    },
    template: {
      oldest: oldest(template),
      medianMs: median(waits.templateMs),
      n: waits.templateMs.length,
    },
    release: { oldest: oldest(release), n: waits.releases },
  };
}
