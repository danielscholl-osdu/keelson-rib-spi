// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { ActionEntry } from "../act/log.ts";
import { heldText, rolloutActions, rolloutTargets } from "../act/rollout.ts";
import { writeBlocked } from "../act/verbs.ts";
import { FORKS, githubUrl, TEMPLATE_REPO } from "../config.ts";
import type { PrClass } from "../model/attribution.ts";
import type { Model } from "../model/index.ts";
import { templatePrId, templatePrState } from "../model/queue.ts";
import { ownFailure, type TemplateRow, type TemplateStep } from "../model/template.ts";
import { INSPECT_ACTION } from "../surfaces.ts";
import { clip, plural, since, span, stamp, zoned } from "../util.ts";
import { lastAction } from "./inspect.ts";

type Section = CanvasBoardView["sections"][number];
type TableSection = Extract<Section, { kind: "table" }>;
type Cell = TableSection["rows"][number][string];
type Stat = Extract<Section, { kind: "stats" }>["items"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];

export const STEP_PREFIX = "step:";

const REVIEW_SEARCH = `https://github.com/pulls?q=${encodeURIComponent(
  `is:pr is:open label:template-sync ${FORKS.map((f) => `repo:${f.repo}`).join(" ")}`,
)}`;

function one(text: string): string {
  return text.replace(/ /g, " ");
}

function cell(text: string, tone?: CanvasTone, href?: string): Cell {
  return { value: one(text), ...(tone ? { tone } : {}), ...(href ? { href } : {}) };
}

function releaseStat(model: Model, now: Date): Stat {
  const t = model.template;
  const tag = t.latestTag;
  if (!tag) return { label: "Release", value: null, sub: "no osdu-spi release read" };
  const all = t.rows.length;
  const head = t.steps[0];
  const older = t.steps[1];
  const main =
    t.mainAhead === 0
      ? "main is the release"
      : t.mainAhead !== undefined
        ? `main ${plural(t.mainAhead, "commit")} past it`
        : undefined;
  const next = t.releasePr && t.next ? `${t.next} in release PR #${t.releasePr.number}` : undefined;
  const past =
    head?.head && older && head.changes.length > 0
      ? `${plural(head.changes.length, "change")} past ${older.label}`
      : undefined;
  const merged =
    t.merged?.after && t.merged.n > 0
      ? `${plural(t.merged.n, "PR")} merged since${t.merged.dependabot ? `, ${t.merged.dependabot} from Dependabot` : ""}`
      : undefined;
  const sub = [
    t.release?.tag === tag ? `released ${stamp(t.release.at, now)}` : undefined,
    main,
    merged,
    next,
    past,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    label: "Release",
    value: tag,
    delta:
      t.read < all
        ? {
            text: `on ${t.onRelease} of ${all} forks, ${all - t.read} unread`,
            direction: "flat",
            tone: "neutral",
          }
        : t.onRelease === all
          ? { text: "on every fork", direction: "flat", tone: "ok" }
          : { text: `on ${t.onRelease} of ${all} forks`, direction: "flat", tone: "info" },
    ...(sub ? { sub } : {}),
  };
}

function rolloutStat(model: Model, now: Date): Stat {
  const t = model.template;
  const label = "Rollout · oldest PR";
  const open = t.rows.filter((r) => r.pr);
  const targets = [...new Set(open.map((r) => r.target ?? r.label))];
  const carry =
    open.length === 0
      ? undefined
      : targets.length === 1 && targets[0]
        ? `${plural(open.length, "PR")} carry ${targets[0]}`
        : plural(open.length, "open PR");
  const next = t.nextSync ? `next Sync Template ${stamp(t.nextSync, now)}` : undefined;
  const { oldest, medianMs } = model.gates.template;
  const median = model.gates.measured ? span(medianMs) : undefined;
  const sub = [carry, next, median ? `usually merged in ${median}` : undefined]
    .filter(Boolean)
    .join(" · ");
  if (!oldest) {
    const behind = t.rows.filter((r) => (r.behind ?? 0) > 0).length;
    return {
      label,
      value: "none",
      tone: behind > 0 ? "info" : "ok",
      sub:
        [behind > 0 ? `${plural(behind, "fork")} behind main, no PR yet` : undefined, sub]
          .filter(Boolean)
          .join(" · ") || "no template-sync PR open",
    };
  }
  return {
    label,
    clock: { at: oldest.at, mode: "since" },
    tone: oldest.tone,
    ...(sub ? { sub } : {}),
  };
}

const KIND_CHIP: Partial<Record<PrClass, string>> = {
  dependabot: "Dependabot",
  release: "release",
  agent: "agent",
};

// What waits on osdu-spi itself; drawn only while something is open.
function openPrs(model: Model, now: Date, selected: string | undefined): Section | undefined {
  const prs = model.template.prs;
  if (prs.length === 0) return undefined;
  const ids = new Set(model.queue.items.map((i) => i.id));
  const items: Row[] = prs.map((p) => {
    const id = p.cls === "release" ? "releases" : templatePrId(p.pr);
    const action = !p.pr.draft && ids.has(id);
    const state = p.pr.draft ? "draft" : templatePrState(p.pr, p.failures);
    return {
      chip: {
        label: KIND_CHIP[p.cls] ?? "feature",
        tone: p.verdict === "red" ? "warn" : p.cls === "release" ? "info" : "neutral",
      },
      text: `#${p.pr.number} ${p.pr.title}`,
      trailing: `${state} · ${since(p.pr.createdAt, now)}`,
      ...(action ? { action: { type: INSPECT_ACTION, payload: { id } } } : { href: p.pr.url }),
      ...(action && id === selected ? { selected: true } : {}),
    };
  });
  return { kind: "rows", title: `Open on osdu-spi · ${prs.length}`, items };
}

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

function ladder(model: Model, selected: string | undefined): Section | undefined {
  const t = model.template;
  if (t.steps.length === 0) return undefined;
  const total = t.rows.length;
  const items: Row[] = t.steps.map((step) => {
    const id = `${STEP_PREFIX}${step.marker}`;
    return {
      chip: { label: step.label, tone: step.head ? "info" : "neutral" },
      text: stepText(step),
      trailing: spreadText(step, total),
      action: { type: INSPECT_ACTION, payload: { id } },
      ...(id === selected ? { selected: true } : {}),
    };
  });
  return { kind: "rows", title: "Release ladder · newest first", items };
}

function prCell(row: TemplateRow): Cell {
  const pr = row.pr;
  if (pr) {
    const text = `#${pr.number}${row.target ? ` → ${row.target}` : ""}`;
    return cell(text, ownFailure(row) ? "warn" : undefined, pr.url);
  }
  if (row.behind === undefined) return "?";
  if (row.behind === 0) return cell("none · current", "neutral");
  if (row.syncing) return cell("none · Sync Template running", "info", row.syncing.url);
  if (row.awaitingRun) return cell("none · next run opens it", "neutral");
  return cell("none", "error");
}

function checksCell(row: TemplateRow): Cell {
  if (!row.pr) return "";
  const failure = ownFailure(row);
  if (failure)
    return cell(clip(`✕ ${failure.cls} ${failure.check}`, 32), "warn", failure.url ?? row.pr.url);
  const env = row.failures.find((f) => !f.hidden && f.cls === "ENV");
  if (env) return cell("⊘ red on the stack", "neutral", env.url ?? row.pr.url);
  if (row.verdict === "pending") return cell("◷ running", "info", `${row.pr.url}/checks`);
  if (row.verdict === "green" || row.verdict === "red")
    return cell("●", "ok", `${row.pr.url}/checks`);
  return cell("none", "neutral");
}

function reviewCell(row: TemplateRow): Cell {
  const pr = row.pr;
  if (!pr) return "";
  if (pr.draft) return cell("draft", "neutral", pr.url);
  switch (pr.reviewDecision) {
    case "APPROVED":
      return cell("approved", "ok", pr.url);
    case "CHANGES_REQUESTED":
      return cell("changes requested", "warn", pr.url);
    case "REVIEW_REQUIRED":
      return cell("required", "info", `${pr.url}/files`);
    default:
      return cell("not required", "neutral", pr.url);
  }
}

function syncCell(row: TemplateRow, now: Date): Cell {
  if (row.syncing) return cell("↻ running", "info", row.syncing.url);
  const { run, state } = row.delivery;
  if (!run) return "?";
  const at = stamp(run.createdAt, now) ?? "";
  if (state === "failed") return cell(`✕ ${at}`, "error", run.url);
  if (state === "stale") return cell(`● ${at}`, "warn", run.url);
  return cell(`● ${at}`, "ok", run.url);
}

function dependabotCell(row: TemplateRow): Cell {
  const n = row.dependabot.length;
  if (n === 0) return cell("●", "ok");
  const href = `${githubUrl(row.repo, "/pulls")}?q=${encodeURIComponent("is:pr is:open author:app/dependabot")}`;
  return cell(`${n} open`, "info", href);
}

function rollout(model: Model, now: Date): Section {
  const rows = [...model.template.rows].sort(
    (a, b) => (b.behind ?? Infinity) - (a.behind ?? Infinity) || a.service.localeCompare(b.service),
  );
  return {
    kind: "table",
    caption: "Rollout · one row per fork",
    columns: [
      { key: "fork", label: "fork" },
      { key: "on", label: "on" },
      { key: "pr", label: "template-sync PR" },
      { key: "checks", label: "checks" },
      { key: "review", label: "review" },
      { key: "sync", label: "Sync Template" },
      { key: "dependabot", label: "Dependabot" },
    ],
    rows: rows.map((row) => ({
      fork: { value: row.service, href: githubUrl(row.repo, "") },
      on: row.label ? cell(row.label) : "?",
      pr: prCell(row),
      checks: checksCell(row),
      review: reviewCell(row),
      sync: syncCell(row, now),
      dependabot: dependabotCell(row),
    })),
  };
}

function links(model: Model): Section | undefined {
  const open = model.template.rows.filter((r) => r.pr).length;
  if (open === 0) return undefined;
  const held = heldText(rolloutTargets(model.template).held);
  return {
    kind: "rows",
    items: [
      ...(held ? [{ glyph: "neutral" as const, text: `Held back from Roll out: ${held}` }] : []),
      {
        icon: "↗",
        text: `Review on GitHub · ${plural(open, "template-sync PR")} in one list`,
        href: REVIEW_SEARCH,
      },
    ],
  };
}

function status(model: Model): { label: string; tone: CanvasTone } {
  const t = model.template;
  const tag = t.latestTag;
  if (!tag) return { label: "NO RELEASE", tone: "neutral" };
  const failing = t.rows.filter((r) => r.pr && ownFailure(r)).length;
  const halted = t.rows.filter(
    (r) =>
      r.delivery.state === "failed" ||
      ((r.behind ?? 0) > 0 && !r.pr && !r.awaitingRun && !r.syncing),
  ).length;
  const all = t.rows.length;
  const parts = [
    t.onRelease === all ? `${tag} ON EVERY FORK` : `${tag} ON ${t.onRelease} OF ${all}`,
    failing ? `${failing} FAILING` : undefined,
    halted ? `${halted} HALTED` : undefined,
  ].filter(Boolean);
  const tone: CanvasTone = halted
    ? "error"
    : failing
      ? "warn"
      : t.onRelease === all
        ? "ok"
        : "info";
  return { label: parts.join(" · "), tone };
}

export interface EngineeringOptions {
  selected?: string;
  scopes?: string[];
  last?: ActionEntry;
}

export function engineeringBoard(
  model: Model,
  now: Date,
  opts: EngineeringOptions = {},
): CanvasBoardView {
  if (!model.measured) {
    return {
      view: "board",
      header: { status: { label: "NOT READ", tone: "neutral" } },
      sections: [],
    };
  }
  const sections: Section[] = [
    {
      kind: "stats",
      items: [releaseStat(model, now), rolloutStat(model, now)],
    },
  ];
  const open = openPrs(model, now, opts.selected);
  if (open) sections.push(open);
  const steps = ladder(model, opts.selected);
  if (steps) sections.push(steps);
  sections.push(rollout(model, now));
  sections.push({
    kind: "actions",
    wrap: true,
    items: rolloutActions(
      model.template,
      { swept: model.sweptAt ?? "" },
      now,
      writeBlocked(model.sweptAt, opts.scopes),
    ),
  });
  const link = links(model);
  if (link) sections.push(link);
  if (opts.last) sections.push(lastAction(opts.last, now));
  return {
    view: "board",
    header: {
      status: status(model),
      chip: `${TEMPLATE_REPO} · ${zoned(model.sweptAt, now) ?? "not swept"}`,
    },
    sections,
  };
}
