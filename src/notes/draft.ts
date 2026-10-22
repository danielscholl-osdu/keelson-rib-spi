// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { type Notes, notesSchema } from "./file.ts";

export const DRAFT_SYSTEM =
  "You revise one month of release notes for consumers of the Azure OSDU SPI program. Reply with one JSON object and nothing else.";

// The month's facts are the spi_release_notes payload, so chat and the button see the same read.
export function draftPrompt(month: string, facts: unknown, current: Notes | undefined): string {
  const rules = current
    ? [
        "Revise the current notes file. Keep every sentence that is still true, word for word.",
        "Change a sentence only when the facts now contradict it. Add what the facts show that the notes miss: releases since the notes were written, versions that moved, services that arrived.",
        current.changelog
          ? "The file has its own changelog: keep its areas and items, and add items for what is new."
          : "The file has no changelog: leave the changelog key out so the computed one shows.",
        "Mark a known issue resolved only when the facts show it; never drop one.",
      ]
    : [
        "There is no notes file yet. Write one from the facts.",
        "Leave the changelog key out so the computed one shows.",
      ];
  return [
    `Release notes for ${month}.`,
    "",
    ...rules.map((r) => `- ${r}`),
    "- Write plain sentences a consumer can act on. No PR numbers, commit shas or links.",
    "- headline is one sentence naming the month's outcome; keyChanges is at most three sentences.",
    '- status stays "draft".',
    "- Reply with the whole notes file as one JSON object, no prose and no code fence.",
    "",
    "Current notes file:",
    current ? JSON.stringify(current, null, 2) : "(none)",
    "",
    "Facts, candidate changelog and the fields the file takes:",
    JSON.stringify(facts, null, 2),
  ].join("\n");
}

export function parseDraft(
  text: string,
): { ok: true; notes: Notes } | { ok: false; error: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return { ok: false, error: "the agent replied without JSON" };
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { ok: false, error: `the agent's JSON does not parse: ${(err as Error).message}` };
  }
  const parsed = notesSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `the agent's notes do not match: ${issue ? `${issue.path.join(".") || "file"}: ${issue.message}` : "invalid"}`,
    };
  }
  if (!parsed.data.headline.trim()) return { ok: false, error: "the agent wrote no headline" };
  return { ok: true, notes: { ...parsed.data, status: "draft" } };
}
