// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { type ApprovePr, associationText, diffText } from "../model/queue.ts";
import { plural } from "../util.ts";
import { type ActionItem, type Target, type Verb, verbAction } from "./verbs.ts";

const FILES_SHOWN = 8;

export const APPROVE_RUNS: Verb = {
  id: "approve-runs",
  label: "Approve runs",
  command: (t) => ["api", "--method", "POST", `repos/${t.repo}/actions/runs/${t.number}/approve`],
};

export function approveTargets(a: ApprovePr): Target[] {
  return a.runs.map((r) => ({
    repo: a.repo,
    kind: "run",
    number: r.id,
    pr: a.pr.number,
    sha: a.pr.headSha,
    state: "action_required",
    label: `#${a.pr.number} ${r.name}`,
  }));
}

function fileList(a: ApprovePr): string {
  const shown = a.pr.files.slice(0, FILES_SHOWN);
  const more = a.pr.changedFiles - shown.length;
  return `Files: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`;
}

// One button per PR: who wrote it, what it changes and how much, then the calls.
export function approveAction(
  a: ApprovePr,
  binding: { item: string; swept: string },
  disabled?: string,
): ActionItem {
  const n = a.pr.number;
  const detail = [
    `#${n} ${a.pr.title}, by ${a.pr.author} (${associationText(a.pr.association)}${a.pr.draft ? ", draft" : ""}) · ${diffText(a.pr)}.`,
    ...(a.workflowFiles.length > 0
      ? [`It changes ${a.workflowFiles.join(", ")}, and approved runs execute that change.`]
      : []),
    fileList(a),
  ];
  return verbAction(
    APPROVE_RUNS,
    { ...binding, targets: approveTargets(a) },
    {
      label: `Approve #${n} · ${plural(a.runs.length, "run")}`,
      pending: "Approving…",
      title: `Approve runs · ${a.pr.author} #${n}`,
      detail,
      ...(a.workflowFiles.length > 0
        ? { subject: { value: String(n), label: `Type ${n}: this PR changes .github/` } }
        : {}),
      ...(disabled ? { disabled } : {}),
    },
  );
}
