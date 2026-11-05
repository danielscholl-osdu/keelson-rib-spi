// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CellTone } from "../model/rollout.ts";
import {
  planStep,
  UPSTREAM_ITEM,
  UPSTREAM_PREFIX,
  type UpFork,
  type UpstreamModel,
} from "../model/upstream.ts";
import { names, plural, stamp, whose } from "../util.ts";

export type UpTone = "bad" | "warn" | "ok" | "neutral" | "run";

export interface UpText {
  text: string;
  tone: UpTone;
}

export interface UpTile {
  label: string;
  value: string;
  sub: string;
  tone: UpTone;
  meter?: { busy: number; cap: number };
}

export interface UpRow {
  fork: string;
  inspect: string;
  // pilot, wave 1, held, stopped, done
  tag: string;
  behind: string;
  carries: string;
  ready: UpText;
  plan: UpText & { kind: "pilot" | "wave" | "held" | "none" };
  // Sync PR, Cascade, Sync to Main, Main run.
  line: UpText[];
  next: UpText & { strong: boolean };
  detail: { title: string; lines: string[] };
}

export interface UpstreamView {
  mode: UpstreamModel["mode"];
  headline: string;
  sub: string;
  tiles: UpTile[];
  rows: UpRow[];
  plan: {
    title: string;
    lines: { label: string; text: string }[];
    note: string;
    button: string;
  };
  // What the schedule does if nobody presses anything.
  schedule?: { title: string; text: string };
  // quiet: nothing waits on a press, so the button only opens the plan.
  next: { title: string; text: string; button: string; quiet: boolean };
  also: { text: string; inspect?: string }[];
  inspect: string;
}

export const LINE_COLUMNS = ["Sync PR", "Cascade", "Sync to Main", "Main run"];

const TONE: Record<CellTone, UpTone> = {
  ok: "ok",
  run: "run",
  warn: "warn",
  bad: "bad",
  idle: "neutral",
};

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function list(xs: readonly string[]): string {
  return xs.join(", ");
}

// "os-core-common" when every move names the same library, else "a toolchain".
function library(u: UpstreamModel): string {
  const libs = new Set(u.moves.map((m) => m.value.split(" ")[0]));
  return libs.size === 1 ? ([...libs][0] as string) : "their toolchain";
}

function heldWhy(f: UpFork): string {
  return f.held === "snapshot" ? "SNAPSHOT" : "filter rule";
}

export function tag(f: UpFork): string {
  if (f.role === "pilot") return "pilot";
  if (f.wave) return `wave ${f.wave}`;
  if (f.role === "held") return "held";
  if (f.role === "stopped") return "stopped";
  if (f.role === "done") return "done";
  return "";
}

export function carriesText(f: UpFork): string {
  if (f.halt?.entry && f.phase === "halted") return f.halt.entry;
  if (f.snapshot) return f.snapshot;
  if (f.moves === undefined) return "toolchain unread";
  const move = f.moves.find((v) => !/SNAPSHOT/i.test(v));
  return move ?? "no toolchain move";
}

function readyText(u: UpstreamModel, f: UpFork): UpText {
  if (f.phase === "halted") {
    return {
      text: f.halt?.open ? "halted · add a filter rule" : "halts · add a filter rule",
      tone: "bad",
    };
  }
  if (f.held === "snapshot") return { text: "hold · SNAPSHOT toolchain", tone: "warn" };
  if (f.templatePr) return { text: `template PR #${f.templatePr.number} first`, tone: "warn" };
  if (f.heldBy.length > 0) return { text: `after ${list(f.heldBy)}`, tone: "neutral" };
  if (f.moves === undefined) return { text: "toolchain unread", tone: "neutral" };
  if ((f.moves?.length ?? 0) > 0) {
    return {
      text:
        f.service === u.reference ? "toolchain move · the pilot" : "toolchain move · pilot decides",
      tone: "warn",
    };
  }
  return { text: "ready", tone: "ok" };
}

function planText(f: UpFork): UpRow["plan"] {
  if (f.role === "pilot") return { text: "Pilot", tone: "ok", kind: "pilot" };
  if (f.role === "held") return { text: "Held", tone: "neutral", kind: "held" };
  if (f.wave) {
    return { text: `Wave ${f.wave}`, tone: "neutral", kind: "wave" };
  }
  return { text: f.phase === "current" ? "current" : "·", tone: "neutral", kind: "none" };
}

function nextText(u: UpstreamModel, f: UpFork, step: ReturnType<typeof planStep>): UpRow["next"] {
  const strong = (text: string, tone: UpTone = "neutral") => ({ text, tone, strong: true });
  const plain = (text: string) => ({ text, tone: "neutral" as UpTone, strong: false });
  const chosen = step.forks.includes(f);
  switch (f.phase) {
    case "done":
      return plain(f.releasePr ? "done · release PR waits" : "done");
    case "main":
      return plain("main run · lane");
    case "red":
      return strong("main red · open", "bad");
    case "review":
      if (f.verb === "review") return strong("Review · GitHub", "warn");
      if (f.toMain?.red) return strong("Sync to Main red · open", "bad");
      return plain(f.toMain?.validating ? "auto-merges when green" : "auto-merges");
    case "stopped":
      return f.verb === "rerun" && !f.wait
        ? strong("Re-run cascade · rib", "warn")
        : strong("Stopped · open", "bad");
    case "cascading":
      return plain("cascade running");
    case "merged":
      return strong("Dispatch cascade · rib", "warn");
    case "prepared":
      if (chosen && step.kind === "start") return strong("Start · rib", "warn");
      if (f.held) return plain(`held · ${heldWhy(f)}`);
      if (u.paused) return plain("absorb first");
      return plain(f.wait ?? f.planWait ?? "prepared");
    case "preparing":
      return plain("Sync Upstream running");
    case "halted":
      return plain(f.halt?.open ? "filter rule first" : "add a filter rule");
    case "idle":
      if (chosen && (step.kind === "prepare" || step.kind === "early")) {
        return strong("Prepare · rib", "warn");
      }
      if (f.held) return plain(`held · ${heldWhy(f)}`);
      return plain(f.wave ? `wave ${f.wave}` : (f.wait ?? "prepare"));
    case "current":
      return plain("current");
    default:
      return plain("unread");
  }
}

function detailOf(f: UpFork, row: Omit<UpRow, "detail">): UpRow["detail"] {
  const lines: string[] = [];
  if (f.behind !== undefined) {
    lines.push(
      f.behind > 0
        ? `${plural(f.behind, "upstream commit")} not yet in fork_upstream · carries ${row.carries}.`
        : "fork_upstream carries every upstream commit.",
    );
  }
  lines.push(
    `Line: ${LINE_COLUMNS.map((c, i) => `${c} ${row.line[i]?.text ?? "·"}`).join(" · ")}.`,
  );
  if (f.held === "snapshot") {
    lines.push(
      `Held: upstream moved to ${f.snapshot}, and a SNAPSHOT can change under the same version. Taking it anyway is your call.`,
    );
  }
  if (f.held === "halt") {
    lines.push(
      `Held: the sync halts on ${f.halt?.entry ?? "an unlisted entry"}. It clears once the fork's filter carries a rule for it.`,
    );
  }
  if (f.wait) lines.push(`Waits: ${f.wait}.`);
  else if (f.planWait) lines.push(`The plan waits: ${f.planWait}.`);
  if (f.stop?.error) lines.push(`First error: ${f.stop.error}`);
  return { title: `${f.service}${row.tag ? ` · ${row.tag}` : ""}`, lines };
}

function rowOf(u: UpstreamModel, f: UpFork, step: ReturnType<typeof planStep>): UpRow {
  const line = [f.cells.sync, f.cells.cascade, f.cells.toMain, f.cells.main].map((c) => ({
    text: c.text,
    tone: TONE[c.tone],
  }));
  const row: Omit<UpRow, "detail"> = {
    fork: f.service,
    inspect: `${UPSTREAM_PREFIX}${f.service}`,
    tag: tag(f),
    behind: f.behind === undefined ? "?" : String(f.behind),
    carries: carriesText(f),
    ready: readyText(u, f),
    plan: planText(f),
    line,
    next: nextText(u, f, step),
  };
  return { ...row, detail: detailOf(f, row) };
}

function stepTitle(u: UpstreamModel, step: ReturnType<typeof planStep>): string {
  const forks = names(step.forks.map((f) => f.service));
  const group = step.forks.every((f) => f.role === "pilot") ? "the pilot" : forks;
  switch (step.kind) {
    case "start":
      return `Start ${forks}`;
    case "dispatch":
      return `Dispatch the cascade on ${forks}`;
    case "prepare":
      return `Prepare ${group}: open sync PRs on ${forks}`;
    case "rerun":
      return `Re-run the cascade on ${forks}`;
    case "paused":
      return `Absorb the move: ${names(u.paused?.forks ?? [])} failed the cascade the same way`;
    case "env":
      return `Wait for the environment: ${u.envHeld}`;
    case "early":
      return `Prepare ${forks} early`;
    default:
      return u.reviews.length > 0
        ? `Review ${names(u.reviews.map((f) => f.service))} on GitHub`
        : u.startWaits.length > 0
          ? `Wait for a lane: ${names(u.startWaits.map((f) => f.service))} ${u.startWaits.length === 1 ? "is" : "are"} ready`
          : "Nothing waits on you";
  }
}

export function stepWhy(u: UpstreamModel, step: ReturnType<typeof planStep>, now: Date): string {
  const at = stamp(u.schedule.upstream, now);
  switch (step.kind) {
    case "start":
      return `${step.forks.length === 1 ? "Its sync PR is" : "Their sync PRs are"} green. Merging starts the cascade at once; the rib dispatches it with the tracking issue instead of waiting up to 6 hours for the monitor.`;
    case "dispatch":
      return "The sync PR merged and no cascade ran. Nothing moves until the cascade runs.";
    case "prepare":
      return `Dispatches Sync Upstream${at ? ` now instead of at ${at}` : ""}. Each opens a sync PR into fork_upstream with the filtered tree. Nothing merges.`;
    case "rerun":
      return "A fix landed on fork_integration after the failed cascade, so it can run again.";
    case "paused":
      return `${names(u.paused?.forks ?? [])} stopped in cascade on the same first error, so the move is the toolchain, not one fork. The rest absorb it before their cascade; forks already past it carry on.`;
    case "env":
      return "A green cascade opens a Sync to Main that deploys to the shared environment, so Start and Re-run cascade wait until it reads deployable.";
    case "early":
      return `Preparing takes no lane and merges nothing. Their Start still waits: ${step.forks[0]?.planWait ?? "for their wave"}.`;
    default:
      return u.forks.some((f) => f.phase === "cascading")
        ? "Cascades build on GitHub runners and take no lane."
        : "";
  }
}

function waveCount(u: UpstreamModel): number {
  return (u.pilot.length > 0 ? 1 : 0) + u.waves.length;
}

function planCard(u: UpstreamModel): UpstreamView["plan"] {
  const planned = u.pilot.length + u.waves.reduce((n, w) => n + w.forks.length, 0);
  const lines = [
    ...(u.pilot.length > 0 ? [{ label: "Pilot", text: list(u.pilot) }] : []),
    ...u.waves.map((w) => ({ label: w.name, text: list(w.forks) })),
    ...(u.held.length > 0
      ? [
          {
            label: "Held",
            text: list(u.held.map((f) => `${f.service} (${heldWhy(f)})`)),
          },
        ]
      : []),
  ];
  const notes: string[] = [];
  if (u.lanes.cap !== null) notes.push(`Waves size to ${u.lanes.cap} lanes.`);
  for (const o of u.ordering) {
    notes.push(`${cap(o.service)} goes after ${names(o.after)}, per rollout.json.`);
  }
  if (u.forks.some((f) => f.templatePr && f.verb === "start")) {
    notes.push("A fork with a template PR open waits for it to merge first.");
  } else if (u.forks.some((f) => f.templatePr)) {
    notes.push("Each fork waits for its template PR to merge first.");
  }
  return {
    title: `${plural(planned, "fork")} in ${plural(waveCount(u), "wave")}${u.held.length ? `, ${u.held.length} held` : ""}`,
    lines,
    note: notes.join(" "),
    button: "Open in inspector · Plan upstream syncs",
  };
}

function scheduleCard(u: UpstreamModel, now: Date): UpstreamView["schedule"] {
  const at = stamp(u.schedule.upstream, now);
  if (!at) return undefined;
  const s = u.schedule;
  const parts: string[] = [];
  if (s.opens.length > 0) parts.push(`Sync Upstream opens ${plural(s.opens.length, "sync PR")}`);
  if (s.halts.length > 0) {
    parts.push(
      `${parts.length > 0 ? "and " : "Sync Upstream opens "}a sync-failed issue on ${names(s.halts)}`,
    );
  }
  const text =
    parts.length > 0
      ? `${parts.join(" ")}. They wait for you; the rib adopts them into the plan.${s.updates.length > 0 ? ` ${plural(s.updates.length, "prepared PR")} update in place.` : ""}`
      : s.updates.length > 0
        ? `Sync Upstream updates ${plural(s.updates.length, "prepared PR")} in place.`
        : "Sync Upstream has nothing queued.";
  return { title: `At ${at} if you do nothing`, text };
}

function planningWords(u: UpstreamModel): { headline: string; sub: string } {
  const moving = u.moving.length;
  const unread = u.unread > 0 ? ` ${plural(u.unread, "fork")} unread.` : "";
  const lead =
    u.unread > 0 && u.unread === u.forks.length
      ? "Upstream isn't read yet, so nothing is planned."
      : u.behind === 0
        ? u.unread > 0
          ? `No fork read so far is behind upstream.${unread}`
          : "Every fork carries upstream."
        : `${plural(u.commits, "upstream commit")} ${u.commits === 1 ? "waits" : "wait"} across ${plural(u.behind, "fork")}.${unread}`;
  const pilot =
    moving > 1
      ? ` ${moving} forks move ${library(u)}, so start with one pilot.`
      : moving === 1
        ? ` ${u.moving[0]?.service} moves ${library(u)}.`
        : "";
  const prepared = u.forks.filter((f) => f.phase === "prepared").length;
  return {
    headline: `${lead}${pilot}`,
    sub:
      prepared > 0
        ? `${plural(prepared, "sync PR")} ${prepared === 1 ? "is" : "are"} prepared. Nothing syncs until you merge one.`
        : "Nothing syncs until you merge a sync PR. The schedule only prepares them.",
  };
}

function flightWords(u: UpstreamModel): { headline: string; sub: string } {
  const gates = [
    ...u.startNext.map((f) => `start ${f.service}`),
    ...u.dispatches.map((f) => `dispatch ${whose(f.service)} cascade`),
    ...u.reruns.map((f) => `re-run ${whose(f.service)} cascade`),
    ...u.reviews.map((f) => `review ${f.service}`),
  ];
  const parts: string[] = [];
  if (gates.length > 0) {
    parts.push(
      `${cap(plural(gates.length, "gate"))} ${gates.length === 1 ? "waits" : "wait"} on you: ${list(gates)}.`,
    );
  }
  const stopped = u.stops.filter((f) => !u.reruns.includes(f));
  if (stopped.length > 0) {
    parts.push(`${cap(names(stopped.map((f) => f.service)))} stopped in cascade.`);
  }
  if (u.paused) parts.push("The wave is paused.");
  const total = u.forks.filter((f) => f.phase !== "current" && f.phase !== "unread").length;
  if (parts.length === 0) {
    const cascading = u.forks.filter((f) => f.phase === "cascading" || f.phase === "merged");
    parts.push(
      cascading.length > 0
        ? `${cap(names(cascading.map((f) => f.service)))} ${cascading.length === 1 ? "is" : "are"} in cascade; nothing waits on you. ${u.done.length} of ${total} forks are on main.`
        : `Nothing waits on you. ${u.done.length} of ${total} forks are on main.`,
    );
  }
  const ref = u.forks.find((f) => f.service === u.reference);
  const sub: string[] = [];
  if (ref?.phase === "done") sub.push("The pilot is on main.");
  else if (u.gate === "open") sub.push(`${cap(whose(u.reference))} cascade is green.`);
  else if (u.gate === "failed")
    sub.push(`${cap(whose(u.reference))} cascade failed; wave 1 waits on its fix.`);
  else if (ref && ["merged", "cascading"].includes(ref.phase)) sub.push("The pilot is in cascade.");
  const moving = u.forks.filter((f) => f.wave === 1 && f.role === "flight").length;
  if (moving > 0 && u.gate === "open") sub.push("Wave 1 is moving.");
  const prepared = u.forks.filter((f) => f.phase === "prepared" && !u.startNext.includes(f));
  if (prepared.length > 0) {
    sub.push(
      `${plural(prepared.length, "sync PR")} ${prepared.length === 1 ? "is" : "are"} prepared and ${prepared.length === 1 ? "waits" : "wait"}.`,
    );
  }
  return { headline: parts.join(" "), sub: sub.join(" ") };
}

function tilesOf(u: UpstreamModel): UpTile[] {
  const lanes: UpTile = {
    label: "Lanes",
    value:
      u.lanes.cap === null
        ? `${u.lanes.busy} busy`
        : u.lanes.unread
          ? "?"
          : `${u.lanes.busy} of ${u.lanes.cap}`,
    sub: u.lanes.unread
      ? `unknown until ${u.lanes.unread} are read`
      : u.lanes.holders.length > 0
        ? `${list(u.lanes.holders)}${u.lanes.claims ? ` · ${u.lanes.claims} cascade claiming` : ""}`
        : "shared with the template rollout",
    tone: "neutral",
    ...(u.lanes.cap !== null && !u.lanes.unread
      ? { meter: { busy: u.lanes.busy, cap: u.lanes.cap } }
      : {}),
  };
  if (u.mode !== "flight") {
    const values = u.moves.map((m) => {
      const forks = m.forks.length;
      return /SNAPSHOT/i.test(m.value)
        ? `${m.forks.join(", ")} to a SNAPSHOT`
        : `${forks} to ${m.value}`;
    });
    return [
      {
        label: "Behind upstream",
        value: u.unread === u.forks.length ? "?" : `${u.behind} of ${u.forks.length}`,
        sub: u.range
          ? `${u.range[0] === u.range[1] ? u.range[0] : `${u.range[0]} to ${u.range[1]}`} commits · ${u.commits} in all${u.unread ? ` · ${u.unread} unread` : ""}`
          : u.unread
            ? `${u.unread} unread`
            : "nothing queued",
        tone: "neutral",
      },
      {
        label: "Toolchain move",
        value: String(u.moving.length),
        sub: values.length > 0 ? values.join(" · ") : "none queued",
        tone: u.moving.length > 0 ? "warn" : "neutral",
      },
      {
        label: "Will halt",
        value: String(u.halts.length),
        sub:
          u.halts.length > 0
            ? `${list(u.halts.map((f) => f.service))}${u.halts[0]?.halt?.entry ? ` · ${u.halts[0].halt.entry} has no filter rule` : ""}`
            : "every filter carries its entries",
        tone: u.halts.length > 0 ? "bad" : "neutral",
      },
      lanes,
    ];
  }
  const total = u.forks.filter((f) => f.phase !== "current" && f.phase !== "unread").length;
  const gates = u.startNext.length + u.dispatches.length + u.reruns.length;
  return [
    {
      label: "On main",
      value: `${u.done.length} of ${total}`,
      sub: u.done.length > 0 ? `${list(u.done.map((f) => f.service))} · main green` : "none yet",
      tone: u.done.length > 0 ? "ok" : "neutral",
    },
    lanes,
    {
      label: "Waiting on you",
      value: String(gates + u.reviews.length),
      sub: `${plural(gates, "press", "presses")} in the rib · ${plural(u.reviews.length, "review")} on GitHub`,
      tone: gates + u.reviews.length > 0 ? "warn" : "neutral",
    },
    {
      label: "Stopped",
      value: String(u.stops.length),
      sub:
        u.stops.length > 0
          ? list(u.stops.map((f) => `${f.service} · cascade ${f.stop?.label ?? "stopped"}`))
          : "no cascade stopped",
      tone: u.stops.length > 0 ? "bad" : "neutral",
    },
  ];
}

// Board order: what moves first reads first, held and current forks last.
export function planOrder(u: UpstreamModel): UpFork[] {
  const rank = (f: UpFork) =>
    f.phase === "done"
      ? 0
      : f.role === "pilot"
        ? 1
        : f.wave
          ? 1 + f.wave
          : f.role === "stopped"
            ? 50
            : f.role === "held"
              ? 60
              : 70;
  return u.forks
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i)
    .map((x) => x.f);
}

export function upstreamView(u: UpstreamModel, now: Date): UpstreamView {
  const step = planStep(u);
  const words = u.mode === "flight" ? flightWords(u) : planningWords(u);
  const also: UpstreamView["also"] = [
    ...u.reviews
      .filter((f) => !step.forks.includes(f))
      .map((f) => ({
        text: `Review ${whose(f.service)} Sync to Main PR on GitHub`,
        inspect: `${UPSTREAM_PREFIX}${f.service}`,
      })),
    ...u.stops.map((f) => ({
      text: `${f.service} stopped in cascade`,
      inspect: `${UPSTREAM_PREFIX}${f.service}`,
    })),
    ...u.forks
      .filter((f) => f.heldBy.length > 0 && f.phase !== "current")
      .map((f) => ({ text: `${f.service} holds for ${names(f.heldBy)}` })),
  ];
  const title = stepTitle(u, step);
  return {
    mode: u.mode,
    ...words,
    tiles: tilesOf(u),
    rows: planOrder(u)
      .filter((f) => f.phase !== "unread" || u.mode === "quiet")
      .map((f) => rowOf(u, f, step)),
    plan: planCard(u),
    ...(() => {
      const s = scheduleCard(u, now);
      return s ? { schedule: s } : {};
    })(),
    next: {
      title,
      text: stepWhy(u, step, now),
      ...(step.kind === "wait" && u.reviews.length === 0 && u.startWaits.length === 0
        ? { button: "Open the plan", quiet: true }
        : { button: `Open in inspector · ${title.split(":")[0]}`, quiet: false }),
    },
    also,
    inspect: UPSTREAM_ITEM,
  };
}
