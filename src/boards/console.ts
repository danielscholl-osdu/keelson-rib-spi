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
import type { RepoCell, RepoEntry, RepoLine, RepoSection } from "../brief/repos.ts";
import { INSPECT_ACTION } from "../surfaces.ts";
import { span, stamp, zoned } from "../util.ts";
import { DOCTOR_ID } from "./doctor.ts";

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
  return `<div class="fact ${TONE_CLASS[f.tone]}"><div class="k">${esc(f.label)}</div><div class="v">${esc(f.figure)}</div><div class="s">${esc(f.sub)}</div></div>`;
}

function rungClass(f: FocusItem): string {
  return f.rung === 0 ? "t-bad" : f.cls === "PORT" ? "" : "t-warn";
}

function focusRow(f: FocusItem, selected: boolean): string {
  return `<button type="button" class="row${selected ? " on" : ""}" data-sel="${esc(f.id)}" aria-pressed="${selected}">
<span class="rung ${rungClass(f)}">P${f.rung}</span>
<span class="body"><span class="tt">${esc(f.title)}</span> <span class="scope">${esc(f.scope)}</span> <span class="chip ${rungClass(f)}">${esc(f.cls)}</span>
<span class="ss">${esc(f.sub)}</span></span></button>`;
}

function detail(f: FocusItem, selected: boolean): string {
  const evidence = f.evidence.map((e) => esc(e.label)).join(" · ");
  return `<section class="detail" data-detail="${esc(f.id)}"${selected ? "" : " hidden"}>
<p class="eyebrow">Selected · ${esc(f.scope)}</p>
<h3>${esc(f.title)}</h3>
<p class="dl">Cause</p><p>${esc(f.cause)}</p>
<p class="dl">Effect</p><p>${esc(f.effect)}</p>
<p class="dl">Next</p><p>${esc(f.next)}</p>
${evidence ? `<p class="dl">Evidence</p><p class="evidence">${evidence}</p>` : ""}
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
    ...t.certain.map((f) => `<tr><td>${esc(f.fork)}</td><td>${esc(f.state)}</td></tr>`),
    ...t.possible.map(
      (f) =>
        `<tr class="maybe"><td>${esc(f.fork)}</td><td>${f.inspect ? `<button type="button" class="link" data-inspect="${esc(f.inspect)}">possible · ${esc(f.state)}</button>` : `possible · ${esc(f.state)}`}</td></tr>`,
    ),
  ].join("");
  return `<section class="detail" data-theme-detail="${esc(t.id)}"${selected ? "" : " hidden"}>
<p class="eyebrow">${esc(t.kind)}${t.when ? ` · ${esc(t.when)}` : ""}</p>
<h3>${esc(t.title)}</h3>
${rows ? `<table class="forks"><thead><tr><th>Fork</th><th>Exposure</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
${t.exposed.length > 0 ? `<p class="dl">Exposed</p><p>${t.exposed.map(esc).join(", ")}</p>` : ""}
<p class="dl">Next</p><p>${esc(t.next)}</p>
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
${items ? `<p class="dl">In the queue</p><ul class="items">${items}</ul>` : `<p class="dl">In the queue</p><p>Nothing for ${esc(row.fork)}.</p>`}
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
const BAR_MIN_PX = 5;
const TIER_PX = 20;
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
      return `<button type="button" class="ev s-${p.e.state}${on ? " on" : ""}" data-event="${esc(key)}" aria-pressed="${on}" title="${esc(name)}" aria-label="${esc(name)}" style="left:${fixed(p.left)}%;width:${fixed(p.width)}%;top:${p.tier * TIER_PX + 4}px"><span class="evl${p.flip ? " flip" : ""}">${esc(eventText(p.e))}</span></button>`;
    })
    .join("");
  const empty = placed.length === 0 ? `<span class="none">none in the last day</span>` : "";
  return `<div class="tl-row"><div class="tl-lab">${esc(lane.label)}</div><div class="tl-track" style="height:${tiers * TIER_PX + 6}px">${bars}${empty}</div></div>`;
}

function eventDetail(lane: EnvLane, e: EnvEvent, selected: boolean, now: Date): string {
  return `<section class="detail" data-event-detail="${esc(eventKey(lane, e))}"${selected ? "" : " hidden"}>
<p class="eyebrow">${esc(lane.label)} · ${EVENT_WORD[e.state]}</p>
<h3 class="${EVENT_TONE[e.state]}">${esc(e.label)}</h3>
<p class="dl">When</p><p>${esc(eventWhen(e, now))}</p>
<p class="dl">What happened</p><p>${esc(e.detail)}</p>
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
    .map((t) => `<span class="tick" style="left:${fixed(pctOf(t.at, from, to))}%"></span>`)
    .join("");
  const axis = ticks
    .map((t) => ({ ...t, left: pctOf(t.at, from, to) }))
    .filter((t) => t.left > 2 && t.left < 98)
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
  return `<div class="rl${l.upstream ? " up" : ""}"><span class="tag ${TONE_CLASS[l.tone]}">${esc(l.tag)}</span><span class="rt">${esc(l.text)}</span><span class="rs">${esc(l.sub)}</span></div>`;
}

function repoDetail(r: RepoEntry, selected: boolean): string {
  const block = (s: RepoSection) =>
    `<p class="dl rsec"><span>${esc(s.title)}</span><span>${esc(s.count)}</span></p>${s.lines.map(lineHtml).join("")}`;
  const work = r.sections.filter((s) => !s.quiet);
  const alerts = r.sections.filter((s) => s.quiet);
  const sections = `${work.map(block).join("")}${
    alerts.length > 0 ? `<div class="rquiet">${alerts.map(block).join("")}</div>` : ""
  }`;
  return `<section class="detail" data-repo-detail="${esc(r.id)}"${selected ? "" : " hidden"}>
<p class="eyebrow">Selected · ${esc(r.name)}</p>
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
  const head = `<div class="rhead"><span>Repository</span><span>Issues<small>human · other</small></span><span>Pull Requests</span><span>Dependabot Bumps</span><span>Vulnerabilities<small>ours · upstream</small></span><span>Code scanning<small>ours · upstream</small></span></div>`;
  const table = `<div class="rtable"><div class="rgrid">${head}${group("program", "Program")}${group("fork", "Forks")}</div><p class="note">Vulnerabilities are Dependabot alerts on the libraries a service uses. Code scanning is CodeQL and Scorecard findings in the source itself. Both count critical and high alerts in shipped code only. Pipeline PRs stay on Flow.</p></div>`;
  const details = r.rows.map((x) => repoDetail(x, x.id === first)).join("");
  return `<h2>${esc(r.headline)}</h2>
${r.facts.length > 0 ? `<div class="facts four">${r.facts.map(factHtml).join("")}</div>` : ""}
${r.rows.length > 0 ? `<div class="split">${table}<div class="pane">${details}</div></div>` : ""}`;
}

function tab(view: string, label: string, on: boolean): string {
  return `<button type="button" role="tab" class="tab${on ? " on" : ""}" data-view="${view}" aria-selected="${on}">${label}</button>`;
}

const STYLE = `
.wrap { padding: 16px 18px 20px; }
h2 { margin: 0 0 4px; font-size: 21px; line-height: 1.25; font-weight: 600; color: var(--fg-strong); text-wrap: balance; max-width: 64ch; }
.summary { margin: 0 0 14px; color: var(--fg); font-size: 14px; }
.facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-block: 1px solid var(--border); }
.fact { padding: 10px 14px; border-left: 3px solid transparent; }
.fact + .fact { border-left-color: var(--border); border-left-width: 1px; }
.fact .k, .eyebrow, .dl { font-family: var(--mono); font-size: 10.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin: 0; }
.fact .v { font-family: var(--mono); font-size: 24px; font-weight: 600; color: var(--fg-strong); font-variant-numeric: tabular-nums; line-height: 1.3; }
.fact .s { font-size: 12.5px; color: var(--fg); }
.fact.t-bad .v { color: var(--crit); } .fact.t-warn .v { color: var(--warn); } .fact.t-ok .v { color: var(--good); }
.split { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 16px; margin-top: 14px; }
.focus { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.row { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0 10px; text-align: left; padding: 8px 10px; border: 1px solid transparent; border-radius: 8px; background: none; color: inherit; font: inherit; cursor: pointer; }
.row:hover { background: var(--card-2); }
.row.on { background: var(--card); border-color: var(--accent); }
.rung { font-family: var(--mono); font-size: 11px; font-weight: 600; color: var(--muted); padding-top: 2px; }
.t-bad.rung, .t-bad.chip { color: var(--crit); } .t-warn.rung, .t-warn.chip { color: var(--warn); }
.tt { font-weight: 600; color: var(--fg-strong); font-size: 14px; }
.scope { color: var(--muted); font-size: 13px; }
.chip { display: inline-block; font-family: var(--mono); font-size: 10px; font-weight: 600; letter-spacing: .05em; padding: 0 6px; border: 1px solid var(--border); border-radius: 999px; vertical-align: 1px; color: var(--muted); }
.ss { display: block; font-size: 12.5px; color: var(--fg); }
.ready, .more { margin: 8px 0 0; padding: 8px 10px 0; border-top: 1px dashed var(--border); font-size: 13px; color: var(--fg); }
.more { border-top: none; color: var(--muted); }
.more summary { cursor: pointer; padding: 4px 10px; }
.link.quiet { color: inherit; text-decoration-style: dotted; }
.ready b { color: var(--fg-strong); font-weight: 600; }
.link { background: none; border: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.pane { min-width: 0; }
.tabs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid var(--border); }
.stamp { margin-left: auto; padding: 6px 0; font-family: var(--mono); font-size: 11px; color: var(--muted); letter-spacing: .04em; }
.link.alert { color: var(--warn); text-decoration-style: dotted; }
.tab { font: inherit; font-size: 13px; font-weight: 600; padding: 6px 12px; margin-bottom: -1px; background: none; border: none; border-bottom: 2px solid transparent; color: var(--muted); cursor: pointer; }
.tab.on { color: var(--fg-strong); border-bottom-color: var(--accent); }
.trow { grid-template-columns: minmax(0, 1fr) auto; }
.when { font-family: var(--mono); font-size: 11px; color: var(--muted); padding-top: 2px; white-space: nowrap; }
.t-ok.chip { color: var(--good); }
.forks { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
.forks th { text-align: left; font-family: var(--mono); font-size: 10.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); padding: 0 8px 4px 0; border-bottom: 1px solid var(--border); }
.forks td { padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
.forks .maybe td { color: var(--muted); }
.detail { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px 14px; }
.detail h3 { margin: 2px 0 0; font-size: 15px; color: var(--fg-strong); }
.detail .dl { margin-top: 10px; }
.detail p { margin: 2px 0 0; font-size: 13.5px; }
.detail .evidence { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.open { margin-top: 12px; font: inherit; font-size: 13px; font-weight: 600; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--accent); color: var(--accent); background: none; cursor: pointer; }
.envband { display: block; box-sizing: border-box; width: 100%; text-align: left; font: inherit; font-family: var(--mono); font-size: 12.5px; color: var(--fg-strong); padding: 7px 12px; margin: 10px 0 0; background: var(--card); border: 1px solid var(--border); border-left: 3px solid var(--border); border-radius: 6px; }
button.envband { cursor: pointer; }
.envband.t-bad { border-left-color: var(--crit); } .envband.t-warn { border-left-color: var(--warn); } .envband.t-ok { border-left-color: var(--good); }
.matrix { overflow-x: auto; margin-top: 10px; }
.flow { width: 100%; border-collapse: collapse; font-size: 13px; }
.flow th { text-align: left; font-family: var(--mono); font-size: 10.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border); white-space: nowrap; }
.flow tbody th { text-transform: none; letter-spacing: 0; font-size: 12.5px; color: var(--fg-strong); }
.flow td { padding: 3px 6px 3px 0; border-bottom: 1px solid var(--border); vertical-align: top; }
.cell { display: block; width: 100%; min-width: 9ch; text-align: left; font: inherit; font-size: 12.5px; padding: 5px 8px; border: 1px solid transparent; border-left: 3px solid transparent; border-radius: 6px; background: none; color: var(--muted); cursor: pointer; }
.cell:hover { background: var(--card-2); }
.cell.on { background: var(--card); border-color: var(--accent); }
.cell.s-stopped { color: var(--crit); border-left-color: var(--crit); font-weight: 600; }
.cell.s-waiting { color: var(--warn); border-left-color: var(--warn); }
.band td { color: var(--muted); font-size: 12.5px; padding: 6px 0; }
.band.t-bad td { color: var(--crit); } .band.t-warn td { color: var(--warn); }
.band .link { color: inherit; }
.fold { margin: 8px 0 0; padding: 8px 10px; border: 1px dashed var(--border); border-radius: 6px; font-size: 13px; color: var(--fg); }
.fold .k { font-family: var(--mono); font-size: 10.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin-right: 4px; }
.cells { margin-top: 12px; }
.detail h3.t-bad { color: var(--crit); } .detail h3.t-warn { color: var(--warn); }
.items { margin: 2px 0 0; padding-left: 18px; font-size: 13.5px; }
.tl-box { overflow-x: auto; margin-top: 14px; direction: rtl; }
.tl { direction: ltr; position: relative; min-width: ${TRACK_MIN_PX + 76}px; }
.tl-row { display: grid; grid-template-columns: 76px minmax(0, 1fr); border-bottom: 1px solid var(--border); }
.tl-lab { position: sticky; left: 0; z-index: 2; background: var(--bg); font-family: var(--mono); font-size: 10.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); padding: 7px 8px 0 0; }
.tl-track { position: relative; min-height: 26px; }
.tl-axis .tl-track { height: 18px; min-height: 0; }
.tl-hour { position: absolute; top: 2px; transform: translateX(-50%); font-family: var(--mono); font-size: 10px; color: var(--muted); white-space: nowrap; }
.tl-grid { position: absolute; top: 0; bottom: 0; left: 76px; right: 0; pointer-events: none; }
.tick { position: absolute; top: 18px; bottom: 0; border-left: 1px dashed var(--border); }
.ev { position: absolute; height: 12px; min-width: ${BAR_MIN_PX}px; padding: 0; border: none; border-radius: 3px; background: var(--muted); cursor: pointer; font: inherit; }
.ev.s-ok { background: var(--good); } .ev.s-failed { background: var(--crit); } .ev.s-running, .ev.s-held { background: var(--warn); }
.ev.s-held { opacity: .55; }
.ev.on { outline: 2px solid var(--accent); outline-offset: 2px; }
.evl { position: absolute; left: calc(100% + 4px); top: -2px; font-family: var(--mono); font-size: 11px; line-height: 16px; color: var(--fg); white-space: nowrap; }
.evl.flip { left: auto; right: calc(100% + 4px); }
.ev.s-failed .evl { color: var(--crit); font-weight: 600; }
.ev.on .evl { color: var(--fg-strong); }
.none { position: absolute; left: 6px; top: 5px; font-size: 12px; color: var(--muted); }
.note { margin: 8px 0 0; font-size: 12.5px; color: var(--muted); }
.events { margin-top: 12px; }
.facts.four { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.rtable { min-width: 0; overflow-x: auto; }
.rgrid { min-width: 640px; }
.rhead, .rrow { display: grid; box-sizing: border-box; grid-template-columns: minmax(100px, 1.3fr) minmax(100px, 1fr) repeat(2, minmax(64px, .8fr)) repeat(2, minmax(118px, 1.2fr)); gap: 0 8px; align-items: baseline; }
.rhead { font-family: var(--mono); font-size: 10.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); padding: 0 11px 4px; border-bottom: 1px solid var(--border); align-items: end; line-height: 1.3; }
.rhead small { display: block; white-space: nowrap; font-size: 10px; font-weight: 500; letter-spacing: .02em; text-transform: none; }
.rgrp { font-family: var(--mono); font-size: 10.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin: 10px 0 2px; padding: 0 10px; }
.rrow { width: 100%; text-align: left; padding: 5px 10px; border: 1px solid transparent; border-radius: 6px; background: none; color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
.rrow:hover { background: var(--card-2); }
.rrow.on { background: var(--card); border-color: var(--accent); }
.rn { font-weight: 600; color: var(--fg-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc { font-family: var(--mono); font-size: 12.5px; font-variant-numeric: tabular-nums; color: var(--fg); }
.rc .z { color: var(--muted); }
.rc .t-bad { color: var(--crit); font-weight: 600; } .rc .t-warn { color: var(--warn); }
.rc .rrest { color: var(--fg); }
.rc .rup { color: var(--muted); opacity: .6; }
.rsec { display: flex; justify-content: space-between; gap: 8px; margin-top: 12px; }
.rl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 1px 8px; padding: 5px 0; border-top: 1px solid var(--border); font-size: 13px; }
.rsec + .rl { border-top: none; }
.tag { font-family: var(--mono); font-size: 10.5px; font-weight: 600; padding: 1px 6px; border: 1px solid var(--border); border-radius: 4px; color: var(--muted); align-self: start; margin-top: 1px; }
.tag.t-bad { color: var(--crit); border-color: var(--crit); } .tag.t-warn { color: var(--warn); border-color: var(--warn); } .tag.t-ok { color: var(--good); border-color: var(--good); }
.rt { color: var(--fg-strong); overflow-wrap: anywhere; }
.rs { grid-column: 2; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.rquiet { margin-top: 14px; padding-top: 2px; border-top: 1px dashed var(--border); }
.rquiet .rl { font-size: 12.5px; padding: 4px 0; }
.rquiet .rs { font-size: 11.5px; }
.rl.up { opacity: .55; }
.rl.up .tag { color: var(--muted); border-color: var(--border); }
.rl.up .rt { color: var(--fg); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 720px) {
  .split, .facts, .facts.four { grid-template-columns: minmax(0, 1fr); }
  .fact + .fact { border-left: 3px solid transparent; border-top: 1px solid var(--border); }
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
    var t = e.target && e.target.closest ? e.target.closest("[data-view],[data-sel],[data-theme-sel],[data-cell],[data-event],[data-repo],[data-inspect]") : null;
    if (!t) return;
    for (var i = 0; i < KINDS.length; i++) {
      var c = KINDS[i];
      var id = t.getAttribute(c[1]);
      if (id === null) continue;
      if (show(c[1], c[2], id, c[3])) {
        state[c[0]] = id;
        if (k.saveState) k.saveState({ view: state.view, sel: state.sel, theme: state.theme, cell: state.cell, event: state.event, repo: state.repo });
      }
      return;
    }
    if (k.action) k.action(${JSON.stringify(INSPECT_ACTION)}, { id: t.getAttribute("data-inspect") });
  });
})();`;

// Markup only: the briefing has already decided every word, so this lays it out and adds
// selection. The frame cannot open links; evidence and verbs live in the inspector.
export function consoleHtml(b: Briefing, now: Date): string {
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
      ? `<div class="tabs" role="tablist">${tab("today", "Today", true)}${tab("repositories", "Repositories", false)}${tab("environment", "Environment", false)}${tab("flow", "Flow", false)}${tab("horizon", "Horizon", false)}${meta}</div>
<div data-view-pane="today">${today}</div>
<div data-view-pane="repositories" hidden>${repositoriesHtml(b)}</div>
<div data-view-pane="environment" hidden>${environmentHtml(b, now)}</div>
<div data-view-pane="flow" hidden>${flowHtml(b)}</div>
<div data-view-pane="horizon" hidden>${horizonHtml(b)}</div>`
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
