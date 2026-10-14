// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { rolloutActions, syncTargets } from "../act/rollout.ts";
import type { Model } from "../model/index.ts";
import type { TemplateStep } from "../model/template.ts";
import { INSPECT_ACTION } from "../surfaces.ts";
import { clip, plural } from "../util.ts";

type Section = CanvasBoardView["sections"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Action = ReturnType<typeof rolloutActions>[number];

export const STEP_PREFIX = "step:";

const CHANGE_PREFIX = /^(\w+)(\([^)]*\))?!?:\s*/;

const ROUTINE = [/^(build|chore)\(deps/, /^Bump /, /^chore(\([^)]*\))?: release /];

// The change a reader would name the step by: the first that is not a bump or a release.
function notable(step: TemplateStep): string | undefined {
  const pick = step.changes.find((c) => !ROUTINE.some((r) => r.test(c.title))) ?? step.changes[0];
  return pick
    ? clip(pick.title.replace(CHANGE_PREFIX, "").replace(/\s*\(#\d+\)$/, ""), 48)
    : undefined;
}

export function spreadText(step: TemplateStep, total: number): string {
  const parts = [`${step.adopted.length} of ${total}`];
  const behind = total - step.adopted.length - step.unmeasured.length;
  if (behind > 0 && step.noPr.length === behind) parts.push("no PR carries it yet");
  else {
    if (step.waiting.length) parts.push(`${step.waiting.length} waiting`);
    if (step.failing.length) parts.push(`${step.failing.length} failing`);
    if (step.noPr.length) parts.push(`${step.noPr.length} without a PR`);
  }
  if (step.unmeasured.length) parts.push(`${step.unmeasured.length} unread`);
  return parts.join(" · ");
}

function stepText(step: TemplateStep): string {
  if (step.changes.length === 0) return "the oldest fork position";
  const reach =
    step.consequences.length > 0
      ? step.consequences.join(", ")
      : step.unread === step.changes.length
        ? "reach unread"
        : "template only";
  const name = notable(step);
  return [plural(step.changes.length, "change"), reach, name].filter(Boolean).join(" · ");
}

export function ladderSection(model: Model): Section | undefined {
  const t = model.template;
  if (t.steps.length === 0) return undefined;
  const total = t.rows.length;
  const items: Row[] = t.steps.map((step) => ({
    chip: { label: step.label, tone: step.head ? "info" : "neutral" },
    text: stepText(step),
    trailing: spreadText(step, total),
    action: { type: INSPECT_ACTION, payload: { id: `${STEP_PREFIX}${step.marker}` } },
  }));
  return { kind: "rows", title: "Release ladder · newest first", items };
}

// Name the forks a Sync all forks would dispatch, so the button says what it touches.
function syncNamed(action: Action, model: Model): Action {
  const forks = syncTargets(model.template).targets.map((t) => t.label);
  if (forks.length === 0) return action;
  const label = `Sync all forks · ${forks.length <= 3 ? forks.join(", ") : forks.length}`;
  return {
    ...action,
    label,
    ...(action.confirm ? { confirm: { ...action.confirm, confirmLabel: label } } : {}),
  };
}

export function rolloutActionItems(model: Model, now: Date, blocked: string | undefined): Action[] {
  return rolloutActions(model.template, { swept: model.sweptAt ?? "" }, now, blocked).map((a) =>
    a.label.startsWith("Sync all forks") ? syncNamed(a, model) : a,
  );
}
