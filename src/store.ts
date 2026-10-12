// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "@keelson/shared";

// JSON files in the rib's data dir. Without a data dir the store keeps state in
// memory only, so a test context or an older host still works.
export class Store {
  private readonly memory = new Map<string, unknown>();

  constructor(private readonly dir: string | undefined) {}

  read<T>(name: string, schema: z.ZodType<T>): T | undefined {
    let raw: unknown = this.memory.get(name);
    if (raw === undefined && this.dir) {
      try {
        raw = JSON.parse(readFileSync(join(this.dir, name), "utf8"));
      } catch {
        return undefined;
      }
    }
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  write(name: string, data: unknown): void {
    this.memory.set(name, data);
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, name);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data)}\n`);
    renameSync(tmp, path);
  }
}
