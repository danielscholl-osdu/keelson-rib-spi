// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { createHash } from "node:crypto";
import type { QueueItem } from "./queue.ts";

// A person's decision to quiet one item until its inputs change or `until` passes.
export interface DismissEntry {
  id: string;
  fingerprint: string;
  until?: string;
  at?: string;
}

const STAMP = /\b(?:\d{2}-\d{2} )?\d{2}:\d{2}\b/g;

// The item's inputs, not its prose: links, heads, runs and entries. Stamps are dropped
// because the same time prints differently once the day turns.
export function fingerprintOf(item: Omit<QueueItem, "fingerprint">): string {
  const inputs = {
    id: item.id,
    kind: item.kind,
    rung: item.rung,
    cls: item.cls ?? null,
    since: item.since ?? null,
    url: item.url ?? null,
    cause: item.cause.map((f) => [f.label, f.value.replace(STAMP, ""), f.url ?? null]),
    effects: item.effects.map((e) => [e.text.replace(STAMP, ""), e.url ?? null]).sort(),
    lanes: (item.lanes ?? []).map((l) => [l.repo, l.runId, l.headSha]),
    halt: item.halt?.entries ?? null,
    approve: (item.approve ?? []).map((a) => [a.repo, a.pr.number, a.pr.headSha]),
  };
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 16);
}

export function quieted(
  item: QueueItem,
  entries: readonly DismissEntry[],
  now: Date,
): DismissEntry | undefined {
  const e = entries.find((d) => d.id === item.id);
  if (!e || e.fingerprint !== item.fingerprint) return undefined;
  if (e.until && Date.parse(e.until) <= now.getTime()) return undefined;
  return e;
}
