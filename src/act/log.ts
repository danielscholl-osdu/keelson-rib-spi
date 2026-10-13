// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "@keelson/shared";

export const ACTION_LOG = "actions.jsonl";
const KEEP = 500;

const resultSchema = z.object({
  target: z.string(),
  outcome: z.enum(["done", "refused", "failed"]),
  detail: z.string().optional(),
});

const entrySchema = z.object({
  at: z.string(),
  verb: z.string(),
  label: z.string(),
  item: z.string(),
  results: z.array(resultSchema),
});

export type ActionResult = z.infer<typeof resultSchema>;
export type ActionEntry = z.infer<typeof entrySchema>;

// Append-only, one JSON line per verb run. Without a data dir it lives in memory.
export class ActionLog {
  private readonly entries: ActionEntry[] = [];

  constructor(private readonly dir: string | undefined) {
    if (!dir) return;
    let text = "";
    try {
      text = readFileSync(join(dir, ACTION_LOG), "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n").slice(-KEEP - 1)) {
      if (!line.trim()) continue;
      try {
        const parsed = entrySchema.safeParse(JSON.parse(line));
        if (parsed.success) this.entries.push(parsed.data);
      } catch {}
    }
  }

  append(entry: ActionEntry): void {
    this.entries.push(entry);
    if (this.entries.length > KEEP) this.entries.shift();
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, ACTION_LOG), `${JSON.stringify(entry)}\n`);
  }

  lastFor(item: string | undefined): ActionEntry | undefined {
    if (!item) return undefined;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]?.item === item) return this.entries[i];
    }
    return undefined;
  }
}
