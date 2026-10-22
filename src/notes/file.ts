// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  existsSync,
  type FSWatcher,
  mkdirSync,
  readFileSync,
  renameSync,
  watch,
  writeFileSync,
} from "node:fs";
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

export type NotesStatus = Notes["status"];

// Edits the status in the file's own text so every other word and its layout stay as written.
export function setNotesStatus(
  dir: string,
  month: string,
  status: NotesStatus,
): { ok: true; path: string; changed: boolean } | { ok: false; error: string } {
  const read = readNotes(dir, month);
  if (read.state === "missing") return { ok: false, error: `${read.path} does not exist` };
  if (read.state === "invalid") {
    return { ok: false, error: `${read.path} does not parse: ${read.error}` };
  }
  if (read.notes.status === status) return { ok: true, path: read.path, changed: false };
  if (status === "approved" && !read.notes.headline.trim()) {
    return { ok: false, error: "write a headline in the notes file before approving it" };
  }
  const text = readFileSync(read.path, "utf8");
  const field = /(?<!\\)"status"(\s*:\s*)"(?:draft|approved)"/;
  const next = field.test(text)
    ? text.replace(field, `"status"$1"${status}"`)
    : text.replace(/^(\s*)\{/, `$1{\n  "status": "${status}",`);
  const after = notesSchema.safeParse(JSON.parse(next));
  const same =
    after.success &&
    after.data.status === status &&
    JSON.stringify({ ...after.data, status: read.notes.status }) === JSON.stringify(read.notes);
  if (!same) return { ok: false, error: `${read.path}: could not change only the status` };
  const tmp = `${read.path}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, read.path);
  return { ok: true, path: read.path, changed: true };
}

export function notesText(dir: string, month: string): string | undefined {
  try {
    return readFileSync(notesPath(dir, month), "utf8");
  } catch {
    return undefined;
  }
}

// An agent's revision lands only on the draft it read; the file it replaces is kept in .history.
export function writeDraft(
  dir: string,
  month: string,
  notes: Notes,
  read: string | undefined,
  at: string,
): { ok: true; path: string; kept?: string } | { ok: false; error: string } {
  const path = notesPath(dir, month);
  const now = notesText(dir, month);
  if (now !== read) {
    return { ok: false, error: `${path} changed while the update ran; press Update again` };
  }
  const current = readNotes(dir, month);
  if (current.state === "ok" && current.notes.status === "approved") {
    return { ok: false, error: "approved notes are not updated; set them back to draft first" };
  }
  mkdirSync(dir, { recursive: true });
  let kept: string | undefined;
  if (now !== undefined) {
    const history = join(dir, ".history");
    mkdirSync(history, { recursive: true });
    kept = join(history, `${month}.${at.replace(/[:.]/g, "-")}.json`);
    writeFileSync(kept, now);
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...notes, status: "draft" }, null, 2)}\n`);
  renameSync(tmp, path);
  return { ok: true, path, ...(kept ? { kept } : {}) };
}

// Chat and editors write notes too; a folder not made yet is polled for, never created.
export function watchNotes(dir: string, onChange: () => void, retryMs = 5000): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let w: FSWatcher | undefined;
  const start = (): boolean => {
    if (!existsSync(dir)) return false;
    try {
      w = watch(dir, { persistent: false }, (_event, name) => {
        if (name && !/^\d{4}-\d{2}\.json$/.test(String(name))) return;
        clearTimeout(timer);
        timer = setTimeout(onChange, 150);
      });
      w.on("error", () => undefined);
      return true;
    } catch {
      return false;
    }
  };
  let poll: ReturnType<typeof setInterval> | undefined;
  if (!start()) {
    poll = setInterval(() => {
      if (!start()) return;
      clearInterval(poll);
      onChange();
    }, retryMs);
    poll.unref?.();
  }
  return () => {
    clearInterval(poll);
    clearTimeout(timer);
    w?.close();
  };
}
