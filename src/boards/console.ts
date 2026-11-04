// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { designTokenCssBlock } from "@keelson/shared";
import type {
  BriefFact,
  Briefing,
  EnvEvent,
  EnvLane,
  EnvState,
  Flow,
  FlowCell,
  FlowRow,
  FocusItem,
  ReadyLine,
  Theme,
  Tone,
} from "../brief/index.ts";
import type { ReleaseLine } from "../brief/release.ts";
import type { RepoCell, RepoEntry, RepoLine, RepoSection } from "../brief/repos.ts";
import { INSPECT_ACTION } from "../surfaces.ts";
import { span, stamp, zoned } from "../util.ts";
import { DOCTOR_ID } from "./doctor.ts";
import { releasesPaneHtml } from "./release.ts";

// A console past this size means the briefing stopped folding.
export const CONSOLE_MAX_BYTES = 256_000;

const TONE_CLASS: Record<Tone, string> = { bad: "t-bad", warn: "t-warn", ok: "t-ok", neutral: "" };

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function factHtml(f: BriefFact): string {
  return `<div class="fact ${TONE_CLASS[f.tone]}"><div class="k">${esc(f.label)}</div><div class="v">${esc(f.figure)}</div><div class="s">${keepPairs(f.sub)}</div></div>`;
}

function rungClass(f: FocusItem): string {
  return f.rung === 0 ? "t-bad" : f.cls === "PORT" ? "" : "t-warn";
}

function focusRow(f: FocusItem, selected: boolean): string {
  return `<button type="button" class="row${selected ? " on" : ""}" data-sel="${esc(f.id)}" aria-pressed="${selected}">
<span class="rung ${rungClass(f)}">P${f.rung}</span>
<span class="body"><span class="tt">${esc(f.title)}</span> <span class="scope">${esc(f.scope)}</span> <span class="chip ${rungClass(f)}">${esc(f.cls)}</span>
<span class="ss">${keepPairs(f.sub)}</span></span></button>`;
}

function keepPairs(text: string): string {
  return text
    .split(" · ")
    .map((p) => (p.length <= 24 ? `<span class="nw">${esc(p)}</span>` : esc(p)))
    .join("&nbsp;· ");
}

function detail(f: FocusItem, selected: boolean): string {
  const evidence = f.evidence.map((e) => esc(e.label)).join(" · ");
  return `<section class="detail" data-detail="${esc(f.id)}"${selected ? "" : " hidden"}>
<p class="eyebrow"><span class="rung ${rungClass(f)}">P${f.rung}</span> ${esc(f.scope)} <span class="chip ${rungClass(f)}">${esc(f.cls)}</span></p>
<h3>${esc(f.title)}</h3>
<dl class="kv"><dt>Cause</dt><dd>${esc(f.cause)}</dd><dt>Effect</dt><dd>${esc(f.effect)}</dd><dt>Next</dt><dd class="next">${esc(f.next)}</dd>${evidence ? `<dt>Evidence</dt><dd class="evidence">${evidence}</dd>` : ""}</dl>
<button type="button" class="open" data-inspect="${esc(f.id)}">Open in inspector · ${esc(f.verb)}</button>
</section>`;
}

function readyHtml(ready: readonly ReadyLine[]): string {
  if (ready.length === 0) return "";
  const items = ready
    .map(
      (r) =>
        `<button type="button" class="link" data-inspect="${esc(r.id)}">${esc(r.text)}</button>`,
    )
    .join(" · ");
  return `<p class="ready"><b>Ready, no rush:</b> ${items}</p>`;
}

function todayHtml(b: Briefing): string {
  const first = b.focus[0]?.id;
  const rows = b.focus.map((f) => focusRow(f, f.id === first)).join("");
  const more =
    b.rest.length > 0
      ? `<details class="more"><summary>${b.rest.length} more in the queue</summary>${b.rest.map((f) => focusRow(f, false)).join("")}</details>`
      : "";
  const list = `<div class="focus">${rows}${more}${readyHtml(b.ready)}</div>`;
  const details = [...b.focus, ...b.rest].map((f) => detail(f, f.id === first)).join("");
  return `<div class="facts">${b.facts.map(factHtml).join("")}</div>
${b.focus.length > 0 ? `<div class="split">${list}<div class="pane">${details}</div></div>` : list}`;
}

function themeRow(t: Theme, selected: boolean): string {
  return `<button type="button" class="row trow${selected ? " on" : ""}" data-theme-sel="${esc(t.id)}" aria-pressed="${selected}">
<span class="body"><span class="tt">${esc(t.title)}</span> <span class="chip ${TONE_CLASS[t.tone]}">${esc(t.kind.toUpperCase())}</span>
<span class="ss">${esc(t.sub)}</span></span>${t.when ? `<span class="when">${esc(t.when)}</span>` : ""}</button>`;
}

function themeDetail(t: Theme, selected: boolean): string {
  const rows = [
    ...t.certain.map(
      (f) => `<li><span>${esc(f.fork)}</span><span class="ps">${esc(f.state)}</span></li>`,
    ),
    ...t.possible.map(
      (f) =>
        `<li class="maybe"><span>${esc(f.fork)}</span><span class="ps">${f.inspect ? `<button type="button" class="link" data-inspect="${esc(f.inspect)}">possible · ${esc(f.state)}</button>` : `possible · ${esc(f.state)}`}</span></li>`,
    ),
  ].join("");
  return `<section class="detail" data-theme-detail="${esc(t.id)}"${selected ? "" : " hidden"}>
<p class="eyebrow"><span class="chip ${TONE_CLASS[t.tone]}">${esc(t.kind.toUpperCase())}</span>${t.when ? ` ${esc(t.when)}` : ""}</p>
<h3>${esc(t.title)}</h3>
${rows ? `<p class="dl">Exposure by fork</p><ul class="pairs">${rows}</ul>` : ""}
<dl class="kv">${t.exposed.length > 0 ? `<dt>Exposed</dt><dd>${t.exposed.map(esc).join(", ")}</dd>` : ""}<dt>Next</dt><dd class="next">${esc(t.next)}</dd></dl>
${t.inspect ? `<button type="button" class="open" data-inspect="${esc(t.inspect)}">Open in inspector</button>` : ""}
</section>`;
}

function horizonHtml(b: Briefing): string {
  const first = b.themes[0]?.id;
  const rows = b.themes.map((t) => themeRow(t, t.id === first)).join("");
  const details = b.themes.map((t) => themeDetail(t, t.id === first)).join("");
  return `<h2>${esc(b.horizon.headline)}</h2>
${b.themes.length > 0 ? `<div class="split"><div class="focus">${rows}</div><div class="pane">${details}</div></div>` : ""}`;
}

function cellKey(row: FlowRow, c: FlowCell): string {
  return `${row.fork}:${c.id}`;
}

function flowCell(row: FlowRow, c: FlowCell, selected: boolean): string {
  return `<td><button type="button" class="cell s-${c.state}${selected ? " on" : ""}" data-cell="${esc(cellKey(row, c))}" aria-pressed="${selected}">${esc(c.text)}</button></td>`;
}

function cellDetail(f: Flow, row: FlowRow, c: FlowCell, i: number, selected: boolean): string {
  const items = row.items.map((t) => `<li>${esc(t)}</li>`).join("");
  return `<section class="detail" data-cell-detail="${esc(cellKey(row, c))}"${selected ? "" : " hidden"}>
<p class="eyebrow">${esc(row.fork)} · ${esc(f.columns[i] ?? c.id)}</p>
<h3 class="${TONE_CLASS[c.tone]}">${esc(c.full ?? c.text)}</h3>
<div class="dbody"><p class="dl">In the queue</p>${items ? `<ul class="items">${items}</ul>` : `<p>Nothing for ${esc(row.fork)}.</p>`}</div>
${row.inspect ? `<button type="button" class="open" data-inspect="${esc(row.inspect)}">Open in inspector</button>` : ""}
</section>`;
}

// The first stopped cell of the first fork, else its first cell that is not quiet.
function firstCell(f: Flow): string | undefined {
  const row = f.rows[0];
  if (!row) return undefined;
  const c =
    row.cells.find((x) => x.state === "stopped") ??
    row.cells.find((x) => x.state === "waiting") ??
    row.cells[0];
  return c ? cellKey(row, c) : undefined;
}

function flowHtml(b: Briefing): string {
  const f = b.flow;
  const env = f.environment;
  const envBand = env.inspect
    ? `<button type="button" class="envband ${TONE_CLASS[env.tone]}" data-inspect="${esc(env.inspect)}">${esc(env.text)}</button>`
    : `<div class="envband ${TONE_CLASS[env.tone]}">${esc(env.text)}</div>`;
  const first = firstCell(f);
  const span = f.columns.length;
  const head = `<thead><tr><th>Fork</th>${f.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>`;
  const rows = f.rows
    .map(
      (r) =>
        `<tr><th scope="row">${esc(r.fork)}</th>${r.cells.map((c) => flowCell(r, c, cellKey(r, c) === first)).join("")}</tr>`,
    )
    .join("");
  const bands = f.bands
    .map((band) => {
      const text = band.inspect
        ? `<button type="button" class="link" data-inspect="${esc(band.inspect)}">${esc(band.text)}</button>`
        : esc(band.text);
      return `<tr class="band ${TONE_CLASS[band.tone]}"><th scope="row">${esc(band.column)}</th><td colspan="${Math.max(span, 1)}">${text}</td></tr>`;
    })
    .join("");
  const matrix =
    rows || bands
      ? `<div class="matrix"><table class="flow">${head}<tbody>${rows}${bands}</tbody></table></div>`
      : "";
  const fold = f.fold
    ? `<p class="fold"><span class="k">${f.fold.forks.length} quiet</span> ${f.fold.forks.map(esc).join(", ")} <span class="ss">${esc(f.fold.text)}</span></p>`
    : "";
  const details = f.rows
    .flatMap((r) => r.cells.map((c, i) => cellDetail(f, r, c, i, cellKey(r, c) === first)))
    .join("");
  return `<h2>${esc(f.headline)}</h2>
${envBand}
${matrix}${fold}
${details ? `<div class="pane cells">${details}</div>` : ""}`;
}

// The timeline's narrowest width; past it the box scrolls, so label room is planned against it.
const TRACK_MIN_PX = 960;
const CHAR_PX = 6.6;
const BAR_MIN_PX = 10;
const TIER_PX = 22;
const MAX_TIERS = 6;

const EVENT_GLYPH: Record<EnvState, string> = {
  ok: "✓",
  failed: "✕",
  cancelled: "⊘",
  running: "●",
  held: "",
};

const EVENT_WORD: Record<EnvState, string> = {
  ok: "green",
  failed: "failed",
  cancelled: "cancelled",
  running: "running",
  held: "held",
};

const EVENT_TONE: Record<EnvState, string> = {
  ok: "t-ok",
  failed: "t-bad",
  cancelled: "",
  running: "t-warn",
  held: "t-warn",
};

function eventKey(lane: EnvLane, e: EnvEvent): string {
  return `${lane.id}:${e.id}`;
}

function pctOf(t: number, from: number, to: number): number {
  return Math.min(100, Math.max(0, ((t - from) / Math.max(1, to - from)) * 100));
}

function fixed(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function eventText(e: EnvEvent): string {
  const glyph = EVENT_GLYPH[e.state];
  return glyph ? `${glyph} ${e.label}` : e.label;
}

function eventWhen(e: EnvEvent, now: Date): string {
  const start = stamp(e.start, now) ?? "?";
  const end = e.end ? (stamp(e.end, now) ?? "?") : "now";
  const took = span((e.end ? Date.parse(e.end) : now.getTime()) - Date.parse(e.start));
  return `${start} to ${end}${took ? ` · ${took}` : ""}`;
}

interface Placed {
  e: EnvEvent;
  left: number;
  width: number;
  tier: number;
  // The label sits left of the bar when it would run past the window's end.
  flip: boolean;
}

// Each bar takes the first tier where it and its label clear the one before.
function place(events: readonly EnvEvent[], from: number, to: number): Placed[] {
  const ends: number[] = [];
  const gap = (4 / TRACK_MIN_PX) * 100;
  return [...events]
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .map((e) => {
      const left = pctOf(Date.parse(e.start), from, to);
      const right = pctOf(e.end ? Date.parse(e.end) : to, from, to);
      const width = Math.max(0, right - left);
      const bar = Math.max(width, (BAR_MIN_PX / TRACK_MIN_PX) * 100);
      const label = ((eventText(e).length * CHAR_PX) / TRACK_MIN_PX) * 100;
      const flip = left + bar + gap + label > 100;
      const start = flip ? left - gap - label : left;
      const end = flip ? left + bar : left + bar + gap + label;
      let tier = ends.findIndex((x) => x + gap <= start);
      if (tier < 0) tier = ends.length < MAX_TIERS ? ends.length : ends.indexOf(Math.min(...ends));
      ends[tier] = Math.max(ends[tier] ?? 0, end);
      return { e, left, width, tier, flip };
    });
}

function hourTicks(from: number, to: number): { at: number; text: string }[] {
  const t = new Date(from);
  t.setMinutes(0, 0, 0);
  if (t.getTime() <= from) t.setHours(t.getHours() + 1);
  const out: { at: number; text: string }[] = [];
  for (; t.getTime() < to; t.setHours(t.getHours() + 1)) {
    const hh = String(t.getHours()).padStart(2, "0");
    out.push({ at: t.getTime(), text: `${hh}:00` });
  }
  return out;
}

function laneRow(
  lane: EnvLane,
  from: number,
  to: number,
  selected: string | undefined,
  now: Date,
): string {
  const placed = place(lane.events, from, to);
  const tiers = Math.max(1, ...placed.map((p) => p.tier + 1));
  const bars = placed
    .map((p) => {
      const key = eventKey(lane, p.e);
      const on = key === selected;
      const name = `${lane.label} ${p.e.label}, ${EVENT_WORD[p.e.state]}, ${eventWhen(p.e, now)}`;
      return `<button type="button" class="ev s-${p.e.state}${on ? " on" : ""}" data-event="${esc(key)}" aria-pressed="${on}" title="${esc(name)}" aria-label="${esc(name)}" style="left:${fixed(p.left)}%;width:${fixed(p.width)}%;top:${p.tier * TIER_PX + 10}px"><span class="evl${p.flip ? " flip" : ""}">${esc(eventText(p.e))}</span></button>`;
    })
    .join("");
  const empty = placed.length === 0 ? `<span class="none">none in the last day</span>` : "";
  return `<div class="tl-row"><div class="tl-lab">${esc(lane.label)}</div><div class="tl-track" style="height:${tiers * TIER_PX + 10}px">${bars}${empty}</div></div>`;
}

function eventDetail(lane: EnvLane, e: EnvEvent, selected: boolean, now: Date): string {
  return `<section class="detail" data-event-detail="${esc(eventKey(lane, e))}"${selected ? "" : " hidden"}>
<p class="eyebrow">${esc(lane.label)} · ${EVENT_WORD[e.state]}</p>
<h3 class="${EVENT_TONE[e.state]}">${esc(e.label)}</h3>
<dl class="kv"><dt>When</dt><dd>${esc(eventWhen(e, now))}</dd><dt>What happened</dt><dd>${esc(e.detail)}</dd></dl>
${e.inspect ? `<button type="button" class="open" data-inspect="${esc(e.inspect)}">Open in inspector</button>` : ""}
</section>`;
}

// The newest failed event, else the newest of all.
function firstEvent(lanes: readonly EnvLane[]): string | undefined {
  const all = lanes
    .flatMap((lane) => lane.events.map((e) => ({ key: eventKey(lane, e), e })))
    .sort((a, b) => Date.parse(b.e.start) - Date.parse(a.e.start));
  return (all.find((x) => x.e.state === "failed") ?? all[0])?.key;
}

function environmentHtml(b: Briefing, now: Date): string {
  const env = b.environment;
  const from = Date.parse(env.from);
  const to = Date.parse(env.to);
  const first = firstEvent(env.lanes);
  const ticks = hourTicks(from, to);
  const grid = ticks
    .map(
      (t) =>
        `<span class="tick${new Date(t.at).getHours() % 2 === 0 ? " major" : ""}" style="left:${fixed(pctOf(t.at, from, to))}%"></span>`,
    )
    .join("");
  const axis = ticks
    .map((t) => ({ ...t, left: pctOf(t.at, from, to) }))
    .filter((t) => t.left > 2 && t.left < 98 && new Date(t.at).getHours() % 2 === 0)
    .map((t) => `<span class="tl-hour" style="left:${fixed(t.left)}%">${esc(t.text)}</span>`)
    .join("");
  const rows = env.lanes.map((l) => laneRow(l, from, to, first, now)).join("");
  const timeline =
    env.lanes.length > 0
      ? `<div class="tl-box"><div class="tl"><div class="tl-grid">${grid}</div><div class="tl-row tl-axis"><div class="tl-lab"></div><div class="tl-track">${axis}</div></div>${rows}</div></div>`
      : "";
  const details = env.lanes
    .flatMap((l) => l.events.map((e) => eventDetail(l, e, eventKey(l, e) === first, now)))
    .join("");
  return `<h2>${esc(env.headline)}</h2>
${env.facts.length > 0 ? `<div class="facts">${env.facts.map(factHtml).join("")}</div>` : ""}
${timeline}${env.note ? `<p class="note">${esc(env.note)}</p>` : ""}
${details ? `<div class="pane events">${details}</div>` : ""}`;
}

function cellHtml(c: RepoCell): string {
  const lead = `<span class="${c.text === "0" ? "z" : TONE_CLASS[c.tone]}">${esc(c.text)}</span>`;
  const rest = c.rest
    ? `<span class="${c.fade ? "rup" : c.rest === " · 0" ? "z" : "rrest"}">${esc(c.rest)}</span>`
    : "";
  return `<span class="rc">${lead}${rest}</span>`;
}

function repoRow(r: RepoEntry, selected: boolean): string {
  const c = r.cells;
  return `<button type="button" class="rrow${selected ? " on" : ""}" data-repo="${esc(r.id)}" aria-pressed="${selected}"><span class="rn">${esc(r.name)}</span>${cellHtml(c.issues)}${cellHtml(c.changes)}${cellHtml(c.dependabot)}${cellHtml(c.vulnerabilities)}${cellHtml(c.codeScanning)}</button>`;
}

function lineHtml(l: RepoLine): string {
  return `<div class="rl${l.upstream ? " up" : ""}"><span class="tag ${TONE_CLASS[l.tone]}">${esc(l.tag)}</span><span class="rt">${esc(l.text)}</span><span class="rs">${keepPairs(l.sub)}</span></div>`;
}

function repoDetail(r: RepoEntry, selected: boolean): string {
  const block = (s: RepoSection) =>
    `<p class="dl rsec"><span>${esc(s.title)}</span><span>${esc(s.count)}${s.rest ? `<span class="rup">${esc(s.rest)}</span>` : ""}</span></p>${s.lines.map(lineHtml).join("")}`;
  const work = r.sections.filter((s) => s.weight !== "quiet");
  const alerts = r.sections.filter((s) => s.weight === "quiet");
  const sections = `${work.map((s) => (s.weight === "minor" ? `<div class="rminor">${block(s)}</div>` : block(s))).join("")}${
    alerts.length > 0 ? `<div class="rquiet">${alerts.map(block).join("")}</div>` : ""
  }`;
  return `<section class="detail" data-repo-detail="${esc(r.id)}"${selected ? "" : " hidden"}>
<p class="eyebrow">${esc(r.name)}</p>
<h3 class="${TONE_CLASS[r.tone]}">${esc(r.title)}</h3>
<p>${esc(r.sub)}</p>
${sections}
${r.note ? `<p class="note">${esc(r.note)}</p>` : ""}
<button type="button" class="open" data-inspect="${esc(r.id)}">Open in inspector</button>
</section>`;
}

function repositoriesHtml(b: Briefing): string {
  const r = b.repositories;
  const first = r.first;
  const group = (g: RepoEntry["group"], label: string) => {
    const rows = r.rows.filter((x) => x.group === g);
    return rows.length > 0
      ? `<p class="rgrp">${label}</p>${rows.map((x) => repoRow(x, x.id === first)).join("")}`
      : "";
  };
  const head = `<div class="rhead"><span>Repository</span><span>Issues<small>human<span class="rup"> · other</span></small></span><span>Pull Requests</span><span>Dependabot Bumps</span><span>Vulnerabilities<small>ours<span class="rup"> · upstream</span></small></span><span>Code scanning<small>ours<span class="rup"> · upstream</span></small></span></div>`;
  const table = `<div class="rtable"><div class="rgrid">${head}${group("program", "Program")}${group("fork", "Forks")}</div><p class="note">Vulnerabilities are Dependabot alerts on the libraries a service uses. Code scanning is CodeQL and Scorecard findings in the source itself. Both count critical and high alerts in shipped code only. Pipeline PRs stay on Flow.</p></div>`;
  const details = r.rows.map((x) => repoDetail(x, x.id === first)).join("");
  return `<h2>${esc(r.headline)}</h2>
${r.facts.length > 0 ? `<div class="facts four">${r.facts.map(factHtml).join("")}</div>` : ""}
${r.rows.length > 0 ? `<div class="split rsplit">${table}<div class="pane">${details}</div></div>` : ""}`;
}

function tab(view: string, label: string, on: boolean): string {
  return `<button type="button" role="tab" class="tab${on ? " on" : ""}" data-view="${view}" aria-selected="${on}">${label}</button>`;
}

const STYLE = `
:root {
  --line: color-mix(in srgb, var(--border) 60%, var(--card));
  --sunk: color-mix(in srgb, var(--card-2) 50%, var(--card));
  --hover: color-mix(in srgb, var(--card-2) 70%, var(--card));
  --pick: color-mix(in srgb, var(--accent) 9%, var(--card));
  --tone: var(--muted);
  --soft: color-mix(in srgb, var(--fg) 70%, var(--muted));
  --label: var(--muted);
}
:root:not([data-theme="light"]) {
  --line: color-mix(in srgb, var(--border) 90%, var(--card));
  --label: color-mix(in srgb, var(--fg) 40%, var(--muted));
  --sunk: color-mix(in srgb, var(--card-2) 72%, var(--card));
  --hover: color-mix(in srgb, var(--card-2) 90%, var(--card));
}
[hidden] { display: none !important; }
body { background: var(--card); font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
.t-bad { --tone: var(--crit); } .t-warn { --tone: var(--warn); } .t-ok { --tone: var(--good); }
.wrap { padding: 2px 4px 16px; }
h2 { margin: 18px 0 4px; font-size: 21px; line-height: 1.3; font-weight: 650; letter-spacing: -.01em; color: var(--fg-strong); text-wrap: balance; max-width: 70ch; }
.summary { margin: 0; color: var(--muted); font-size: 14px; max-width: 80ch; }
.eyebrow, .dl, .fact .k, .rgrp, .rhead, .flow thead th, .tl-lab, .fold .k { font-family: var(--sans); font-size: 11.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--label); margin: 0; }

.facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 16px; }
.facts.four { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.fact { position: relative; padding: 12px 14px 13px 26px; background: var(--sunk); border: 1px solid var(--line); border-radius: 10px; min-width: 0; }
.fact .k { position: relative; }
.fact .k::before { content: ""; position: absolute; left: -14px; top: calc(50% - 3.5px); width: 7px; height: 7px; border-radius: 50%; background: transparent; }
.fact.t-bad .k::before, .fact.t-warn .k::before, .fact.t-ok .k::before { background: var(--tone); }
.fact .v { margin-top: 4px; font-size: 26px; font-weight: 650; letter-spacing: -.015em; line-height: 1.2; color: var(--fg-strong); font-variant-numeric: tabular-nums; }
.fact.t-bad .v, .fact.t-warn .v { color: var(--tone); }
.fact .s { margin-top: 3px; font-size: 12.5px; line-height: 1.45; color: var(--soft); text-wrap: balance; }

.split { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 20px; margin-top: 18px; align-items: start; }
.focus { display: flex; flex-direction: column; min-width: 0; }
.row { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0 12px; text-align: left; padding: 11px 12px; border: none; border-bottom: 1px solid var(--line); border-radius: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
.row.trow { grid-template-columns: minmax(0, 1fr) auto; }
.row:hover { background: var(--hover); }
.row.on { background: var(--pick); border-radius: 7px; border-bottom-color: transparent; box-shadow: inset 3px 0 0 var(--accent); }
.focus > .row:has(+ .row.on) { border-bottom-color: transparent; }
.rung { display: inline-block; min-width: 24px; text-align: center; font-family: var(--mono); font-size: 11px; font-weight: 600; line-height: 18px; padding: 0 5px; border-radius: 5px; color: var(--tone); background: transparent; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 45%, transparent); }
.nw { white-space: nowrap; }
:is(.chip, .tag):not(.t-bad, .t-warn, .t-ok) { color: var(--soft); background: color-mix(in srgb, var(--muted) 20%, transparent); }
.row > .rung { margin-top: 1px; align-self: start; }
.tt { font-weight: 600; color: var(--fg-strong); font-size: 14px; }
.scope { color: var(--muted); font-size: 13px; }
.chip { display: inline-block; font-size: 10.5px; font-weight: 600; letter-spacing: .04em; line-height: 18px; padding: 0 7px; border-radius: 5px; vertical-align: 1px; color: var(--tone); background: color-mix(in srgb, var(--tone) 12%, transparent); }
.ss { display: block; margin-top: 2px; font-size: 13px; color: var(--soft); }
.when { font-size: 12px; color: var(--muted); padding-top: 2px; white-space: nowrap; font-variant-numeric: tabular-nums; }

.ready { margin: 12px 0 0; padding: 10px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--sunk); font-size: 13px; color: var(--muted); }
.ready b { color: var(--fg); font-weight: 600; margin-right: 2px; }
.more { margin: 6px 0 0; color: var(--muted); font-size: 13px; }
.more summary { cursor: pointer; padding: 8px 12px; border-radius: 8px; }
.more summary:hover { background: var(--hover); color: var(--fg); }
.link { background: none; border: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; text-decoration: none; }
.link:hover { text-decoration: underline; text-underline-offset: 3px; }
.link.quiet { color: inherit; }
.link.alert { color: var(--warn); font-weight: 600; }

.tabs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; border-bottom: 1px solid var(--line); }
.tab { position: relative; font: inherit; font-size: 13.5px; font-weight: 600; padding: 9px 12px 11px; background: none; border: none; color: var(--muted); cursor: pointer; border-radius: 6px 6px 0 0; }
.tab:hover { color: var(--fg-strong); }
.tab.on { color: var(--fg-strong); }
.tab.on::after { content: ""; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px; border-radius: 2px; background: var(--accent); }
.stamp { margin-left: auto; padding: 8px 2px; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }

.pane { min-width: 0; }
.detail { background: var(--sunk); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px 18px; }
.detail .eyebrow { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--muted); }
.detail h3 { margin: 6px 0 0; font-size: 18px; line-height: 1.35; font-weight: 650; letter-spacing: -.005em; color: var(--fg-strong); text-wrap: balance; }
.detail h3.t-bad, .detail h3.t-warn, .detail h3.t-ok { color: var(--tone); }
.detail > p { margin: 6px 0 0; font-size: 13.5px; color: var(--fg); }
.detail .dl, .detail > p.dl { margin-top: 18px; font-size: 11.5px; color: var(--label); }
.kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px 18px; margin: 14px 0 0; padding-top: 14px; border-top: 1px solid var(--line); font-size: 13.5px; }
.kv dt { font-size: 12px; font-weight: 600; color: var(--muted); padding-top: 1px; }
.kv dd { margin: 0; color: var(--fg); text-wrap: pretty; }
.kv dd.next { color: var(--fg-strong); font-weight: 550; }
.evidence { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.open { justify-self: start; margin-top: 16px; font: inherit; font-size: 13px; font-weight: 600; padding: 7px 14px; border-radius: 7px; border: 1px solid var(--accent); color: var(--card); background: var(--accent); cursor: pointer; }
.open:hover { filter: brightness(1.08); }
:root:not([data-theme="light"]) :is(.tab, .stamp, .when) { color: color-mix(in srgb, var(--fg) 45%, var(--muted)); }
:root:not([data-theme="light"]) .ev.s-held { background: color-mix(in srgb, var(--warn) 30%, transparent); }
:root:not([data-theme="light"]) .relfacts .fact { background: color-mix(in srgb, var(--card-2) 85%, var(--card)); }
:root:not([data-theme="light"]) .tick { border-left-color: color-mix(in srgb, var(--line) 20%, transparent); }
:root:not([data-theme="light"]) .tick.major { border-left-color: color-mix(in srgb, var(--line) 50%, transparent); }
:root[data-theme="light"] .rung { font-weight: 650; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 65%, transparent); }
:root:not([data-theme="light"]) .tab:is(:hover, .on) { color: var(--fg-strong); }
.items { margin: 6px 0 0; padding-left: 18px; font-size: 13.5px; }
.items li + li { margin-top: 3px; }
.note { margin: 10px 0 0; font-size: 12.5px; color: var(--muted); max-width: 90ch; }
.detail > .note { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--muted); }

.pairs { list-style: none; margin: 8px 0 0; padding: 0; columns: 2; column-gap: 36px; column-rule: 1px solid var(--line); font-size: 13px; }
.pairs li { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; break-inside: avoid; }
.pairs .ps { text-align: right; font-variant-numeric: tabular-nums; }
.pairs .maybe { color: var(--muted); }
.pairs + .kv { margin-top: 12px; }

.envband { display: inline-flex; align-items: center; gap: 9px; box-sizing: border-box; max-width: 100%; text-align: left; font: inherit; font-size: 13.5px; font-weight: 550; color: var(--fg-strong); padding: 9px 14px; margin: 14px 0 0; background: var(--sunk); border: 1px solid var(--line); border-radius: 7px; }
.envband::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--tone); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone) 18%, transparent); }
button.envband { cursor: pointer; }
button.envband:hover { background: var(--hover); }
.matrix { overflow-x: auto; margin-top: 12px; }
.flow { width: 100%; border-collapse: collapse; font-size: 13px; }
.flow thead th { text-align: left; padding: 6px 8px 8px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
.flow thead th + th { padding-left: 20px; }
.flow :is(thead th:first-child, tbody th) { width: 1%; padding-right: 32px; }
.flow tbody th { text-align: left; font-weight: 600; font-size: 13.5px; color: var(--fg-strong); padding: 4px 12px 4px 0; white-space: nowrap; }
.flow tbody tr { border-bottom: 1px solid var(--line); }
.flow td { padding: 4px 6px 4px 0; vertical-align: middle; }
.flow tbody tr:first-child > * { padding-top: 8px; }
.cell { position: relative; display: inline-flex; align-items: center; max-width: 100%; text-align: left; font: inherit; font-size: 13px; padding: 6px 10px 6px 20px; border: none; border-radius: 7px; background: none; color: var(--soft); cursor: pointer; }
.cell::before { content: ""; position: absolute; left: 7px; top: calc(50% - 3.5px); width: 7px; height: 7px; border-radius: 50%; background: transparent; }
.cell:hover { background: var(--hover); }
.cell.on { background: color-mix(in srgb, var(--accent) 15%, var(--card)); color: var(--fg-strong); }
.cell.s-stopped { color: var(--crit); font-weight: 600; }
.cell.s-stopped::before { background: var(--crit); }
.cell.s-waiting { color: var(--fg); }
.cell.s-waiting::before { background: color-mix(in srgb, var(--warn) 80%, transparent); }
.flow tbody .band th { font-weight: 550; color: var(--soft); }
.band td { color: var(--muted); font-size: 13px; padding: 9px 0 9px 20px; }
.band.t-bad td { color: var(--crit); } .band.t-warn td { color: var(--warn); }
.band .link { color: inherit; }
.fold { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 12px; align-items: baseline; margin: 12px 0 0; padding: 10px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--sunk); font-size: 13px; color: var(--fg); }
.fold .ss { grid-column: 2; margin-top: 2px; font-size: 12.5px; color: var(--muted); }
.cells { margin-top: 14px; }

.tl-box { overflow-x: auto; margin-top: 16px; padding: 4px 0 2px; direction: rtl; }
.tl { direction: ltr; position: relative; min-width: ${TRACK_MIN_PX + 84}px; }
.tl-row { display: grid; grid-template-columns: 84px minmax(0, 1fr); border-bottom: 1px solid var(--line); }
.tl-row:last-child { border-bottom: none; }
.tl-lab { position: sticky; left: 0; z-index: 2; background: var(--card); padding: 8px 8px 0 0; }
.tl-track { position: relative; min-height: 26px; }
.tl-axis { border-bottom-color: var(--line); }
.tl-axis .tl-track { height: 20px; min-height: 0; }
.tl-hour { position: absolute; top: 1px; transform: translateX(-50%); font-size: 12px; color: var(--soft); white-space: nowrap; font-variant-numeric: tabular-nums; }
.tl-grid { position: absolute; top: 0; bottom: 0; left: 84px; right: 0; pointer-events: none; }
.tick { position: absolute; top: 20px; bottom: 0; border-left: 1px solid color-mix(in srgb, var(--line) 35%, transparent); }
.tick.major { border-left-color: var(--line); }
.tl .tl-lab { color: var(--soft); }
.ev { position: absolute; height: 12px; min-width: ${BAR_MIN_PX}px; padding: 0; border: none; border-radius: 6px; background: var(--muted); cursor: pointer; font: inherit; }
.ev.s-ok { background: var(--good); } .ev.s-failed { background: var(--crit); } .ev.s-running, .ev.s-held { background: var(--warn); }
.ev.s-held { background: color-mix(in srgb, var(--warn) 25%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warn) 55%, transparent); }
.evl { position: absolute; left: calc(100% + 9px); top: -3px; font-size: 12px; line-height: 18px; color: var(--fg); white-space: nowrap; }
.evl.flip { left: auto; right: calc(100% + 9px); }
.ev.s-failed .evl { color: var(--crit); font-weight: 600; }
.ev.s-held .evl { color: var(--muted); }
.ev.on .evl { color: var(--fg-strong); font-weight: 600; text-decoration: underline 2px var(--accent); text-underline-offset: 3px; }
.ev.s-failed.on .evl { color: var(--crit); }
.none { position: absolute; left: 6px; top: 7px; font-size: 12px; color: var(--muted); }
.events { margin-top: 14px; }
.events .detail, .cells .detail { padding-bottom: 16px; display: grid; grid-template-columns: minmax(200px, 280px) minmax(0, 1fr); grid-template-rows: auto auto auto; column-gap: 28px; align-items: start; align-content: start; }
.events .detail > *, .cells .detail > * { grid-column: 1; }
.events .detail > .kv, .cells .detail > .dbody { grid-column: 2; grid-row: 1 / span 3; margin: 0; padding: 5px 0 0 28px; border-top: none; border-left: 1px solid var(--line); align-self: stretch; }
.cells .detail > .dbody { padding-top: 2px; }
.cells .dbody > .dl { margin-top: 0; }
.cells .items { list-style: none; padding-left: 0; }

.facts.relfacts { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
.relfacts .fact { background: var(--card); border-color: var(--line); padding: 12px 14px; }
.relfacts .v { margin-top: 0; font-size: 23px; }
.relfacts .unread .v { color: var(--muted); font-weight: 500; }

.split.rsplit { grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr); }
.rtable { min-width: 0; overflow-x: auto; }
.rgrid { min-width: 600px; }
.rhead, .rrow { display: grid; box-sizing: border-box; grid-template-columns: minmax(120px, 1.25fr) minmax(60px, 1fr) minmax(60px, .9fr) minmax(60px, 1.35fr) minmax(60px, 1fr) minmax(60px, 1fr); gap: 0 8px; align-items: baseline; }
.rhead { padding: 0 12px 8px; border-bottom: 1px solid var(--line); align-items: start; line-height: 1.35; font-size: 12px; letter-spacing: 0; text-transform: none; }
.rhead > span { white-space: nowrap; min-width: 0; }
.rhead small { display: block; white-space: nowrap; font-size: 11px; font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--muted); }
.rgrp { margin: 14px 0 2px; padding: 0 12px; }
.rrow { position: relative; width: 100%; text-align: left; padding: 7px 12px; border: none; border-bottom: 1px solid var(--line); border-radius: 0; background: none; color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
.rrow:hover { background: var(--hover); }
.rrow:has(+ .rrow.on) { border-bottom-color: transparent; }
.rrow.on { background: var(--pick); border-radius: 7px; border-bottom-color: transparent; box-shadow: inset 3px 0 0 var(--accent); }
.rn { font-weight: 600; color: var(--fg-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc { font-size: 13px; font-variant-numeric: tabular-nums; color: var(--fg); }
.rc .z { color: var(--muted); }
.rc .t-bad { color: var(--crit); font-weight: 650; } .rc .t-warn { color: var(--warn); font-weight: 500; }
.rc .rrest { color: var(--fg); }
.rc .rup, .rsec .rup, .rhead .rup { color: var(--muted); }
.rsec { display: flex; justify-content: space-between; gap: 8px; padding-top: 12px; border-top: 1px solid var(--line); }
.detail .dl.rsec, .detail > p.dl.rsec { margin-top: 10px; }
.rl { display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 2px 10px; padding: 8px 0; border-top: 1px solid var(--line); font-size: 13px; }
.rsec + .rl { border-top: none; padding-top: 6px; }
.tag { justify-self: start; font-size: 10.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; line-height: 18px; padding: 0 7px; border-radius: 5px; color: var(--tone); background: color-mix(in srgb, var(--tone) 12%, transparent); align-self: start; margin-top: 1px; white-space: nowrap; }
.rt { color: var(--fg-strong); overflow-wrap: anywhere; }
.rs { grid-column: 2; font-size: 12px; color: var(--soft); overflow-wrap: anywhere; }
.detail > .rl .rt { font-weight: 500; }
.rminor .rl { font-size: 12.5px; padding: 6px 0; }
.rminor .rs { font-size: 11.5px; }
.rminor .rt { color: var(--fg); }
.rminor .tag:not(.t-bad) { color: var(--soft); background: color-mix(in srgb, var(--muted) 20%, transparent); }
.rquiet { margin-top: 0; }
.rquiet .rl { font-size: 12.5px; padding: 6px 0; }
.rquiet .rs { font-size: 11.5px; }
.rl.up { opacity: .6; }
.rl.up .tag { color: var(--soft); background: color-mix(in srgb, var(--muted) 20%, transparent); }
.rl.up .rt { color: var(--fg); }

button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (prefers-reduced-motion: no-preference) {
  .row, .rrow, .cell, .tab, .link, .open { transition: background-color .12s ease, color .12s ease, box-shadow .12s ease; }
}
@media (max-width: 1100px) {
  .facts.four { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 720px) {
  .split, .split.rsplit, .facts, .facts.four { grid-template-columns: minmax(0, 1fr); }
  .events .detail, .cells .detail { display: block; }
  .events .detail > .kv, .cells .detail > .dbody { padding: 14px 0 0; margin-top: 14px; border-left: none; border-top: 1px solid var(--line); }
}`;

const SCRIPT = `(function () {
  var k = window.keelson || {};
  function show(row, pane, id, aria) {
    var found = false;
    document.querySelectorAll("[" + pane + "]").forEach(function (d) {
      var on = d.getAttribute(pane) === id;
      d.hidden = !on;
      if (on) found = true;
    });
    if (!found) return false;
    document.querySelectorAll("[" + row + "]").forEach(function (r) {
      var on = r.getAttribute(row) === id;
      r.classList.toggle("on", on);
      r.setAttribute(aria, on ? "true" : "false");
    });
    return true;
  }
  function current(row) {
    var on = document.querySelector("[" + row + "].on");
    return on ? on.getAttribute(row) : null;
  }
  var KINDS = [
    ["view", "data-view", "data-view-pane", "aria-selected"],
    ["sel", "data-sel", "data-detail", "aria-pressed"],
    ["theme", "data-theme-sel", "data-theme-detail", "aria-pressed"],
    ["cell", "data-cell", "data-cell-detail", "aria-pressed"],
    ["event", "data-event", "data-event-detail", "aria-pressed"],
    ["repo", "data-repo", "data-repo-detail", "aria-pressed"],
    ["rel", "data-rel", "data-rel-detail", "aria-pressed"],
  ];
  var state = {};
  KINDS.forEach(function (c) { state[c[0]] = current(c[1]); });
  if (k.onRestore) k.onRestore(function (s) {
    if (!s) return;
    KINDS.forEach(function (c) {
      var id = s[c[0]];
      if (typeof id === "string" && show(c[1], c[2], id, c[3])) state[c[0]] = id;
    });
  });
  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target.closest("[data-view],[data-sel],[data-theme-sel],[data-cell],[data-event],[data-repo],[data-rel],[data-inspect]") : null;
    if (!t) return;
    for (var i = 0; i < KINDS.length; i++) {
      var c = KINDS[i];
      var id = t.getAttribute(c[1]);
      if (id === null) continue;
      if (show(c[1], c[2], id, c[3])) {
        state[c[0]] = id;
        if (k.saveState) k.saveState({ view: state.view, sel: state.sel, theme: state.theme, cell: state.cell, event: state.event, repo: state.repo, rel: state.rel });
      }
      return;
    }
    if (k.action) k.action(${JSON.stringify(INSPECT_ACTION)}, { id: t.getAttribute("data-inspect") });
  });
})();`;

// Markup only: the briefing has already decided every word, so this lays it out and adds
// selection. The frame cannot open links; evidence and verbs live in the inspector.
export interface ReleasesPane {
  lines: readonly ReleaseLine[];
  reading: boolean;
}

export function consoleHtml(b: Briefing, now: Date, releases?: ReleasesPane): string {
  const swept = zoned(b.sweptAt, now);
  const unread =
    b.doctor.state === "partial"
      ? "some sources unread"
      : b.doctor.state === "dark"
        ? "GitHub unread"
        : b.doctor.state === "clear"
          ? undefined
          : "first sweep running";
  const next = b.nextSyncAt ? zoned(b.nextSyncAt, now) : undefined;
  const doctor = (text: string, cls: string) =>
    `<button type="button" class="link ${cls}" data-inspect="${DOCTOR_ID}">${esc(text)}</button>`;
  const stamp = [
    unread ? doctor(unread, "alert") : undefined,
    swept ? doctor(`swept ${swept}`, "quiet") : undefined,
    next ? `next sync ${esc(next)}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const meta = stamp ? `<span class="stamp">${stamp}</span>` : "";
  const today = `<h2>${esc(b.headline)}</h2>
${b.summary ? `<p class="summary">${esc(b.summary)}</p>` : ""}
${b.facts.length > 0 ? todayHtml(b) : ""}`;
  const views =
    b.facts.length > 0
      ? `<div class="tabs" role="tablist">${tab("today", "Today", true)}${tab("repositories", "Repositories", false)}${tab("environment", "Environment", false)}${tab("flow", "Flow", false)}${tab("horizon", "Horizon", false)}${releases ? tab("releases", "Releases", false) : ""}${meta}</div>
<div data-view-pane="today">${today}</div>
<div data-view-pane="repositories" hidden>${repositoriesHtml(b)}</div>
<div data-view-pane="environment" hidden>${environmentHtml(b, now)}</div>
<div data-view-pane="flow" hidden>${flowHtml(b)}</div>
<div data-view-pane="horizon" hidden>${horizonHtml(b)}</div>
${releases ? `<div data-view-pane="releases" hidden>${releasesPaneHtml(releases.lines, releases.reading)}</div>` : ""}`
      : `${meta ? `<div class="tabs">${meta}</div>` : ""}${today}`;
  return `<style>${designTokenCssBlock()}${STYLE}</style>
<div class="wrap">
${views}
</div>
<script>${SCRIPT}</script>`;
}

export function expectHtml(data: unknown): string {
  if (typeof data !== "string" || data.length === 0) throw new Error("console frame must be html");
  if (new TextEncoder().encode(data).byteLength > CONSOLE_MAX_BYTES) {
    throw new Error(`console frame exceeds ${CONSOLE_MAX_BYTES} bytes`);
  }
  return data;
}
