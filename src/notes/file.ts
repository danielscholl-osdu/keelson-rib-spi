// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "@keelson/shared";

// The written half of a month's release notes: what GitHub cannot say. A person
// reviews it and sets status to approved; until then every copy reads as a draft.
export const notesSchema = z
  .object({
    status: z.enum(["draft", "approved"]).default("draft"),
    headline: z.string().default(""),
    keyChanges: z.array(z.string()).default([]),
    actions: z
      .array(
        z.object({
          level: z.enum(["required", "recommended", "info"]),
          title: z.string().min(1),
          body: z.string().optional(),
          owner: z.string().optional(),
          when: z.string().optional(),
          ifSkipped: z.string().optional(),
        }),
      )
      .default([]),
    highlights: z
      .array(
        z.object({
          title: z.string().min(1),
          body: z.string().optional(),
          visual: z.enum(["coverage", "library", "commands", "steps"]).optional(),
          items: z
            .array(z.object({ text: z.string().min(1), sub: z.string().optional() }))
            .optional(),
        }),
      )
      .default([]),
    knownIssues: z
      .array(
        z.object({
          state: z.enum(["open", "resolved"]),
          title: z.string().min(1),
          body: z.string().optional(),
        }),
      )
      .default([]),
    changelog: z
      .array(
        z.object({
          area: z.string().min(1),
          items: z.array(
            z.object({
              type: z.enum(["breaking", "new", "improved", "fixed", "security"]),
              text: z.string().min(1),
            }),
          ),
        }),
      )
      .optional(),
  })
  .strict();

export type Notes = z.infer<typeof notesSchema>;

export type NotesRead =
  | { state: "missing"; path: string }
  | { state: "invalid"; path: string; error: string }
  | { state: "ok"; path: string; notes: Notes };

// RIB_SPI_NOTES_DIR points the notes at a checkout so they can be reviewed as PRs.
export function notesDir(dataDir: string | undefined): string {
  return (
    process.env.RIB_SPI_NOTES_DIR ??
    join(dataDir ?? join(homedir(), ".keelson", "rib-spi"), "release-notes")
  );
}

export function notesPath(dir: string, month: string): string {
  return join(dir, `${month}.json`);
}

export function readNotes(dir: string, month: string): NotesRead {
  const path = notesPath(dir, month);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { state: "missing", path };
  }
  try {
    const parsed = notesSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { state: "ok", path, notes: parsed.data };
    const issue = parsed.error.issues[0];
    return {
      state: "invalid",
      path,
      error: issue ? `${issue.path.join(".") || "file"}: ${issue.message}` : "does not match",
    };
  } catch (err) {
    return { state: "invalid", path, error: `not JSON: ${(err as Error).message}` };
  }
}

export function skeleton(): Notes {
  return {
    status: "draft",
    headline: "",
    keyChanges: [],
    actions: [],
    highlights: [],
    knownIssues: [],
  };
}

// Never overwrites: a file that exists already holds someone's words.
export function createNotes(dir: string, month: string): { path: string; created: boolean } {
  const path = notesPath(dir, month);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify(skeleton(), null, 2)}\n`, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return { path, created: false };
    throw e;
  }
  return { path, created: true };
}
