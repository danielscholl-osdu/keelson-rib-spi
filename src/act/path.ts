// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibActionResult, RibExec } from "@keelson/shared";
import { Gh } from "../forge.ts";
import { clip, plural, pool } from "../util.ts";
import type { ActionLog, ActionResult } from "./log.ts";
import { changed, readTarget } from "./revalidate.ts";
import { bindingSchema, verbOf } from "./verbs.ts";

const TARGETS_AT_ONCE = 5;

export interface ActDeps {
  exec: RibExec;
  log: ActionLog;
  // Reads the area again; the item leaves the queue only when that read shows the change.
  resweep: () => void;
  now: () => Date;
}

function summary(label: string, results: readonly ActionResult[]): string {
  const done = results.filter((r) => r.outcome === "done").length;
  const parts = [`${label}: ${done} of ${results.length} done`];
  for (const r of results) {
    if (r.outcome === "done") continue;
    parts.push(
      `${r.target} ${r.outcome === "refused" ? "skipped" : "failed"}${r.detail ? ` (${r.detail})` : ""}`,
    );
  }
  return parts.join(" · ");
}

// Every write runs this path: parse the binding the board stamped, read each target
// again, write only to the ones that still match, log the outcome, then resweep.
export async function act(payload: unknown, deps: ActDeps): Promise<RibActionResult> {
  const parsed = bindingSchema.safeParse(
    payload && typeof payload === "object"
      ? Object.fromEntries(
          Object.entries(payload).filter(([k]) => ["verb", "item", "swept", "targets"].includes(k)),
        )
      : payload,
  );
  if (!parsed.success) return { ok: false, error: "act needs the binding the board stamped" };
  const binding = parsed.data;
  const verb = verbOf(binding.verb);
  if (!verb) return { ok: false, error: `spi has no verb '${binding.verb}'` };

  const gh = new Gh(deps.exec);
  // Targets are independent, so one slow or failing write does not hold the others.
  const results: ActionResult[] = await pool(binding.targets, TARGETS_AT_ONCE, async (target) => {
    try {
      const why = changed(target, await readTarget(gh, target));
      if (why) return { target: target.label, outcome: "refused", detail: why };
    } catch (err) {
      return {
        target: target.label,
        outcome: "refused",
        detail: `could not read it again: ${clip(err instanceof Error ? err.message : String(err), 160)}`,
      };
    }
    const res = await deps.exec.runText("gh", verb.command(target), { timeoutMs: 60_000 });
    return res.ok
      ? { target: target.label, outcome: "done" }
      : { target: target.label, outcome: "failed", detail: clip(res.error, 200) };
  });

  deps.log.append({
    at: deps.now().toISOString(),
    verb: verb.id,
    label: verb.label,
    item: binding.item,
    results,
  });
  deps.resweep();

  const message = summary(verb.label, results);
  return results.some((r) => r.outcome === "done")
    ? { ok: true, data: { message } }
    : {
        ok: false,
        error: `${message}${results.every((r) => r.outcome === "refused") ? `; ${plural(results.length, "target")} changed, the board redraws` : ""}`,
      };
}
