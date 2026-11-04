// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "@keelson/shared";
import type { DismissEntry } from "./model/dismiss.ts";
import type { Queue } from "./model/queue.ts";
import type { Store } from "./store.ts";

export const DISMISS_FILE = "dismissed.json";
export const DISMISS_ACTION = "dismiss";
export const UNDISMISS_ACTION = "undismiss";

const entrySchema = z.object({
  id: z.string().min(1),
  fingerprint: z.string().min(1),
  until: z.string().optional(),
  at: z.string().optional(),
});
const fileSchema = z.array(entrySchema);

export const dismissPayloadSchema = z.object({
  id: z.string().min(1),
  fingerprint: z.string().min(1),
  until: z.iso.datetime({ offset: true }).optional(),
});

// The dismiss file in the rib's data dir: a local decision, never a forge write.
export class Dismissals {
  private entries: DismissEntry[];

  constructor(private readonly store: Store) {
    this.entries = store.read(DISMISS_FILE, fileSchema) ?? [];
  }

  list(): readonly DismissEntry[] {
    return this.entries;
  }

  add(entry: DismissEntry): void {
    this.entries = [...this.entries.filter((e) => e.id !== entry.id), entry];
    this.save();
  }

  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) return false;
    this.save();
    return true;
  }

  // A dismissal ends once its item is back in the queue with new inputs, or its until passes.
  prune(queue: Queue, now: Date): boolean {
    const back = new Set(queue.items.map((i) => i.id));
    const kept = this.entries.filter(
      (e) => !back.has(e.id) && !(e.until && Date.parse(e.until) <= now.getTime()),
    );
    if (kept.length === this.entries.length) return false;
    this.entries = kept;
    this.save();
    return true;
  }

  private save(): void {
    try {
      this.store.write(DISMISS_FILE, this.entries);
    } catch {
      // A read-only data dir keeps dismissals in memory for this run.
    }
  }
}
