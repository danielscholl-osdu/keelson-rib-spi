// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { type CanvasBoardView, type CanvasTone, designTokenCssBlock } from "@keelson/shared";
import {
  type DocAction,
  type DocArea,
  type DocHighlight,
  type DocVisual,
  NOTES_LABEL,
  type NotesState,
  type ReleaseDoc,
  type ReleaseLine,
} from "../brief/release.ts";
import type { ChangeType } from "../model/releases.ts";

type Section = CanvasBoardView["sections"][number];

export const RELEASE_OPEN_ACTION = "release-open";
export const RELEASE_PDF_ACTION = "release-pdf";
export const RELEASE_NOTES_ACTION = "release-notes-file";

// A changelog area or manifest group this short prints on one page rather than splitting.
const KEEP_WHOLE = 6;

const TYPES: readonly ChangeType[] = ["breaking", "new", "improved", "fixed", "security"];

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const DOC_STYLE = `
.doc { max-width: 920px; margin: 0 auto; padding: 24px 22px 40px; display: grid; gap: 40px; }
.doc h1, .doc h2, .doc h3 { margin: 0; color: var(--fg-strong); line-height: 1.2; text-wrap: balance; }
.doc p, .doc ul { margin: 0; }
.doc a { color: var(--accent); text-underline-offset: 2px; }
.mono, .eyebrow, .k, .sub, th, .tag, .count { font-family: var(--mono); }
.eyebrow { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.draft { display: flex; gap: 10px; align-items: baseline; padding: 8px 12px; border: 1px dashed var(--warn); border-radius: 8px; color: var(--warn); font-size: 13px; }
.draft b { font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
.over { display: grid; gap: 20px; }
.titlerow { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin-top: 10px; }
.relname { font-size: clamp(38px, 6vw, 56px); font-weight: 800; letter-spacing: -.02em; line-height: 1; }
.pill { font-family: var(--mono); font-size: 11.5px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
.pill.open { color: var(--warn); border-color: var(--warn); }
.pill.closed { color: var(--good); border-color: var(--good); }
.headline { font-size: clamp(20px, 2.6vw, 25px); font-weight: 650; color: var(--fg-strong); max-width: 40ch; line-height: 1.3; }
.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.stat { display: grid; gap: 2px; align-content: start; padding: 12px 14px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; color: inherit; text-decoration: none; font: inherit; text-align: left; }
button.stat { cursor: pointer; }
button.stat:hover { border-color: var(--accent); }
button.stat:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.stat b { font-family: var(--mono); font-size: 28px; font-weight: 600; color: var(--fg-strong); font-variant-numeric: tabular-nums; line-height: 1.15; }
.stat span { font-size: 12.5px; color: var(--muted); }
.stat.bad { border-color: var(--crit); box-shadow: inset 3px 0 0 var(--crit); }
.stat.bad b { color: var(--crit); }
.k { font-size: 10.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.keys { display: grid; gap: 8px; }
.keys ul { list-style: none; padding: 0; display: grid; gap: 6px; max-width: 72ch; }
.keys li { position: relative; padding-left: 18px; font-size: 15px; }
.keys li::before { content: ""; position: absolute; left: 0; top: .6em; width: 7px; height: 7px; border-radius: 2px; background: var(--accent); }
.sec { display: grid; gap: 14px; min-width: 0; scroll-margin-top: 16px; }
.sec > h2 { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; font-size: 21px; font-weight: 700; }
.count { font-size: 12px; font-weight: 400; color: var(--muted); }
.quiet { color: var(--muted); font-size: 14px; }
.acts { display: grid; gap: 10px; }
.act { display: grid; grid-template-columns: minmax(0, 1fr) 230px; gap: 20px; padding: 16px 18px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; }
.act.solo { grid-template-columns: minmax(0, 1fr); }
.act.required { border-color: var(--crit); box-shadow: inset 4px 0 0 var(--crit); }
.act.recommended { border-color: var(--warn); box-shadow: inset 4px 0 0 var(--warn); }
.act .main { display: grid; gap: 4px; align-content: start; min-width: 0; }
.act h3 { font-size: 16px; font-weight: 650; }
.act p { color: var(--fg); font-size: 14px; }
.act dl { margin: 0; display: grid; gap: 10px; align-content: start; padding-left: 18px; border-left: 1px solid var(--border); }
.act dt { font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.act dd { margin: 0; font-size: 13.5px; font-weight: 600; color: var(--fg-strong); }
.level { justify-self: start; font-family: var(--mono); font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding: 1px 7px; border-radius: 4px; color: var(--bg); }
.level.required { background: var(--crit); } .level.recommended { background: var(--warn); }
.list { display: grid; background: var(--card); border: 1px solid var(--border); border-radius: 10px; }
.list .li { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 12px; align-items: baseline; padding: 10px 16px; border-top: 1px solid var(--border); font-size: 14px; }
.list .li:first-child { border-top: none; }
.list .li p { color: var(--fg); }
.list .li b { color: var(--fg-strong); font-weight: 600; }
.chip { justify-self: start; font-family: var(--mono); font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
.chip.warn { color: var(--warn); border-color: var(--warn); } .chip.good { color: var(--good); border-color: var(--good); }
.hls { display: grid; gap: 12px; }
.hl { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: 22px; align-items: center; padding: 18px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; }
.hl.solo { grid-template-columns: minmax(0, 1fr); }
.hl .text { display: grid; gap: 6px; min-width: 0; }
.hl h3 { font-size: 18px; }
.hl p { color: var(--fg); }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); gap: 6px; }
.tile { display: grid; gap: 1px; padding: 7px 9px; border-radius: 6px; background: var(--card-2); border: 1px solid var(--border); }
.tile b { font-size: 12.5px; font-weight: 600; color: var(--fg-strong); }
.tile span { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.tile.fresh { border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; font-size: 12px; color: var(--muted); }
.legend i { display: inline-block; width: 10px; height: 10px; margin-right: 5px; border-radius: 2px; vertical-align: -1px; border: 1px solid var(--border); background: var(--card-2); }
.legend i.fresh { border-color: var(--accent); background: var(--accent); }
.libbar { display: flex; gap: 2px; height: 30px; border-radius: 5px; overflow: hidden; }
.libbar div { display: flex; align-items: center; justify-content: center; min-width: 0; font-family: var(--mono); font-size: 11.5px; font-weight: 600; }
.libkey { display: grid; gap: 4px; margin-top: 10px; font-size: 12.5px; }
.libkey div { display: grid; grid-template-columns: 12px 56px minmax(0, 1fr); gap: 8px; align-items: baseline; }
.libkey i { width: 10px; height: 10px; border-radius: 2px; }
.libkey span { color: var(--muted); }
.cmds { display: grid; gap: 6px; }
.cmd { display: grid; gap: 2px; padding: 8px 10px; background: var(--card-2); border-radius: 6px; }
.cmd code { font-family: var(--mono); font-size: 13px; color: var(--fg-strong); }
.cmd code::before { content: "$ "; color: var(--muted); }
.cmd span { font-size: 12px; color: var(--muted); }
.steps { display: flex; flex-wrap: wrap; gap: 6px; }
.step { flex: 1 1 100px; display: grid; gap: 2px; align-content: start; min-width: 0; padding: 10px; background: var(--card-2); border-radius: 8px; }
.step .n { font-family: var(--mono); font-size: 11px; color: var(--accent); }
.step b { font-size: 14px; color: var(--fg-strong); }
.step span { font-size: 12px; color: var(--muted); }
details.fold { background: var(--card); border: 1px solid var(--border); border-radius: 10px; }
details.fold > summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; padding: 12px 16px; cursor: pointer; list-style: none; }
details.fold > summary::-webkit-details-marker { display: none; }
details.fold > summary::before { content: "+"; width: 12px; font-family: var(--mono); color: var(--muted); }
details.fold[open] > summary::before { content: "−"; }
details.fold > summary b { color: var(--fg-strong); font-weight: 600; }
.total { margin-left: auto; font-family: var(--mono); font-size: 12px; color: var(--muted); }
.inner { padding: 0 16px 12px; }
.items { list-style: none; padding: 0; border-top: 1px solid var(--border); }
.items li { display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 12px; align-items: baseline; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 14px; }
.items li:last-child { border-bottom: none; }
.tag { justify-self: start; font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding: 1px 6px; border-radius: 4px; border: 1px solid currentColor; white-space: nowrap; }
.tag.new { color: var(--good); } .tag.improved { color: var(--info); } .tag.fixed { color: var(--warn); }
.tag.security { color: var(--crit); } .tag.breaking { color: var(--bg); background: var(--crit); border-color: var(--crit); }
.areas { display: grid; gap: 8px; }
.tagcounts { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.sub { font-size: 10.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.comps { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 6px; }
.comp { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; min-width: 0; padding: 8px 12px; background: var(--card); border: 1px solid var(--border); border-radius: 8px; font-size: 13.5px; }
.comp.platform { background: var(--card-2); }
.comp b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-strong); font-weight: 600; }
.comp span { font-family: var(--mono); font-size: 12px; white-space: nowrap; color: var(--fg-strong); }
.comp span s { text-decoration: none; color: var(--muted); }
.tablebox { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { font-size: 10.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
tr:last-child td { border-bottom: none; }
td.svc { font-weight: 600; color: var(--fg-strong); }
td.m { font-family: var(--mono); font-size: 12.5px; font-variant-numeric: tabular-nums; }
td.dim { color: var(--muted); }
td.m s { text-decoration: none; color: var(--muted); }
td.m b { font-weight: 700; color: var(--fg-strong); }
td.m .tag { font-size: 9px; padding: 0 5px; vertical-align: 1px; }
tr.group td { font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); background: var(--card-2); padding: 3px 10px; }
.foot { display: grid; gap: 10px; padding-top: 18px; border-top: 1px solid var(--border); font-size: 12.5px; color: var(--muted); }
.links { display: flex; flex-wrap: wrap; gap: 4px 12px; font-family: var(--mono); font-size: 12px; }
.links a, .links span { color: var(--muted); }
@media (max-width: 720px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .act, .hl { grid-template-columns: minmax(0, 1fr); }
  .act dl { padding: 10px 0 0; border-left: none; border-top: 1px solid var(--border); }
  .list .li { grid-template-columns: minmax(0, 1fr); gap: 4px; }
}`;

function cssString(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ")}"`;
}

// Margin boxes resolve in the page context, so they take literal fonts and colors, not tokens.
function printStyle(d: ReleaseDoc): string {
  const box = `font-family: ui-monospace, Menlo, monospace; font-size: 8pt; letter-spacing: .06em; color: #77748a;`;
  const right = `${d.name} · ${NOTES_LABEL[d.notes]}`.toUpperCase();
  return `
@page { size: Letter; margin: 16mm 13mm 15mm;
  @top-left { content: "SPI / RELEASE NOTES"; ${box} }
  @top-right { content: ${cssString(right)}; ${box} }
  @bottom-left { content: ${cssString(d.eyebrow[0] ?? d.name)}; ${box} }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); ${box} }
}
@page :first { @top-left { content: none; } @top-right { content: none; } }
:root[data-theme="light"] {
  --bg: #ffffff; --card: #ffffff; --card-2: #f3f4f6; --border: #d3d6dc;
  --fg: #23262d; --fg-strong: #111318; --muted: #5d6270; --accent: #0f6cbd;
  --good: #1d7344; --warn: #9a5800; --crit: #b3261e; --info: #1f5aa6;
  --sans: "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif;
  --mono: Menlo, "DejaVu Sans Mono", Consolas, monospace;
}
html, body { background: #ffffff; font-family: var(--sans); }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-size: 13px; }
.doc, .over, .sec, .acts, .hls, .areas { display: block; }
.doc { max-width: none; padding: 0; }
.doc > * + * { margin-top: 24px; }
.over > * + *, .sec > * + * { margin-top: 10px; }
.acts > * + *, .hls > * + *, .areas > * + * { margin-top: 8px; }
.relname { font-size: 44px; }
.headline { font-size: 21px; }
.act { grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 12px 16px; }
.act.required, .act.recommended, .stat.bad { border-color: var(--border); }
.act.required, .stat.bad { box-shadow: inset 3px 0 0 var(--crit); }
.act.recommended { box-shadow: inset 3px 0 0 var(--warn); }
.tag, .chip.warn, .chip.good { border-color: transparent; background: color-mix(in srgb, currentColor 11%, #ffffff); }
.tag.breaking { background: var(--crit); }
.hl { grid-template-columns: minmax(0, .8fr) minmax(0, 1.3fr); }
.tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
.tile { padding: 4px 7px; }
.tile b { font-size: 11.5px; }
.tile span { font-size: 10px; }
.act dl { display: flex; flex-wrap: wrap; gap: 4px 22px; padding: 8px 0 0; border-left: none; border-top: 1px solid var(--border); }
.act dd { font-size: 12.5px; }
.hl { padding: 14px 16px; }
.items li { padding: 5px 0; font-size: 13px; }
.list .li { padding: 8px 14px; }
.act, .hl, .stat, .list .li, .items li, tr, .comp, .tile, .draft { break-inside: avoid; }
.sec > h2, .k, .sub, details.fold > summary { break-after: avoid; }
.items li:nth-child(-n+2), tbody tr:nth-child(-n+4) { break-after: avoid; }
details.fold.keep, tbody.keep { break-inside: avoid; }
.list { border: none; background: none; }
.list .li { border: 1px solid var(--border); border-top: none; }
.list .li:first-child { border-top: 1px solid var(--border); border-radius: 10px 10px 0 0; }
.list .li:last-child { border-radius: 0 0 10px 10px; }
.list .li:only-child { border-radius: 10px; }
.keys ul { max-width: none; }
.items li:nth-last-child(-n+2), tbody tr:nth-last-child(-n+2) { break-before: avoid; }
thead { display: table-header-group; }
details.fold > summary::before, details.fold[open] > summary::before { content: none; }
.stats { grid-template-columns: repeat(4, minmax(0, 1fr)); }
td.svc a { color: inherit; text-decoration: none; }`;
}

function statsHtml(d: ReleaseDoc, linked: boolean): string {
  return `<div class="stats">${d.stats
    .map((s) => {
      const body = `<b>${esc(s.figure)}</b><span>${esc(s.label)}</span>`;
      const cls = `stat${s.tone ? ` ${s.tone}` : ""}`;
      return linked
        ? `<button type="button" class="${cls}" data-jump="${s.anchor}">${body}</button>`
        : `<div class="${cls}">${body}</div>`;
    })
    .join("")}</div>`;
}

function draftBanner(d: ReleaseDoc): string {
  if (d.notes === "approved") return "";
  const why =
    d.notes === "invalid"
      ? `The notes file does not parse (${d.notesError ?? "invalid"}), so only the computed parts show.`
      : d.notes === "none"
        ? "No one has written or reviewed these notes yet. Everything below is computed from GitHub releases."
        : "These notes are still a draft and have not been approved.";
  return `<div class="draft"><b>Draft</b><span>${esc(why)}</span></div>`;
}

function actionCard(a: DocAction): string {
  const dl = [
    a.owner ? `<div><dt>Owner</dt><dd>${esc(a.owner)}</dd></div>` : "",
    a.when ? `<div><dt>When</dt><dd>${esc(a.when)}</dd></div>` : "",
    a.ifSkipped ? `<div><dt>If skipped</dt><dd>${esc(a.ifSkipped)}</dd></div>` : "",
  ].join("");
  return `<article class="act ${a.level}${dl ? "" : " solo"}"><div class="main"><span class="level ${a.level}">${a.level}</span><h3>${esc(a.title)}</h3>${a.body ? `<p>${esc(a.body)}</p>` : ""}</div>${dl ? `<dl>${dl}</dl>` : ""}</article>`;
}

function reviewed(d: ReleaseDoc): boolean {
  return d.notes === "draft" || d.notes === "approved";
}

function actionHtml(d: ReleaseDoc): string {
  const cards =
    d.required.length > 0
      ? `<div class="acts">${d.required.map(actionCard).join("")}</div>`
      : `<p class="quiet">${reviewed(d) ? "No action required." : "Not reviewed yet: there is no notes file for this month."}</p>`;
  const info =
    d.info.length > 0
      ? `<div class="list">${d.info
          .map(
            (a) =>
              `<div class="li"><span class="chip">${esc(a.owner ?? "For everyone")}</span><p><b>${esc(a.title)}</b>${a.body ? ` ${esc(a.body)}` : ""}</p></div>`,
          )
          .join("")}</div>`
      : "";
  return `<section class="sec" id="action"><h2>Action required <span class="count">${d.required.length} to act on · ${d.info.length} informational</span></h2>${cards}${info}</section>`;
}

// Newest version strongest: an ordinal ramp, so age reads as weight rather than hue.
function shade(i: number, n: number): { bg: string; ink: string } {
  const pct = n <= 1 ? 100 : Math.round(100 - (i * 70) / (n - 1));
  return {
    bg: `color-mix(in srgb, var(--accent) ${pct}%, var(--card-2))`,
    ink: pct >= 60 ? "#fff" : "var(--fg-strong)",
  };
}

function visualHtml(v: DocVisual): string {
  if (v.kind === "coverage") {
    return `<div class="tiles">${v.tiles
      .map(
        (t) =>
          `<div class="tile${t.fresh ? " fresh" : ""}"><b>${esc(t.id)}</b><span>${esc(t.version)}</span></div>`,
      )
      .join(
        "",
      )}</div><div class="legend"><span><i></i>forked earlier</span><span><i class="fresh"></i>forked this month</span></div>`;
  }
  if (v.kind === "library") {
    const total = v.shares.reduce((n, s) => n + s.services.length, 0);
    return `<div class="libbar" role="img" aria-label="core-lib-azure versions across ${total} services">${v.shares
      .map(
        (s, i) =>
          `<div style="flex:${s.services.length};background:${shade(i, v.shares.length).bg};color:${shade(i, v.shares.length).ink}">${s.services.length}</div>`,
      )
      .join("")}</div><div class="libkey">${v.shares
      .map(
        (s, i) =>
          `<div><i style="background:${shade(i, v.shares.length).bg}"></i><code class="mono">${esc(s.version)}</code><span>${esc(s.services.join(", "))}</span></div>`,
      )
      .join("")}</div>`;
  }
  if (v.kind === "commands") {
    return `<div class="cmds">${v.items
      .map(
        (x) =>
          `<div class="cmd"><code>${esc(x.text)}</code>${x.sub ? `<span>${esc(x.sub)}</span>` : ""}</div>`,
      )
      .join("")}</div>`;
  }
  return `<div class="steps">${v.items
    .map(
      (x, i) =>
        `<div class="step"><span class="n">${i + 1}</span><b>${esc(x.text)}</b>${x.sub ? `<span>${esc(x.sub)}</span>` : ""}</div>`,
    )
    .join("")}</div>`;
}

function highlightHtml(h: DocHighlight): string {
  return `<article class="hl${h.visual ? "" : " solo"}"><div class="text"><h3>${esc(h.title)}</h3>${h.body ? `<p>${esc(h.body)}</p>` : ""}</div>${h.visual ? `<div>${visualHtml(h.visual)}</div>` : ""}</article>`;
}

function issuesHtml(d: ReleaseDoc): string {
  const body =
    d.issues.length > 0
      ? `<div class="list">${d.issues
          .map(
            (i) =>
              `<div class="li"><span class="chip ${i.state === "open" ? "warn" : "good"}">${i.state}</span><p><b>${esc(i.title)}</b>${i.body ? ` ${esc(i.body)}` : ""}</p></div>`,
          )
          .join("")}</div>`
      : `<p class="quiet">${reviewed(d) ? "No known issues recorded for this month." : "Not reviewed yet: there is no notes file for this month."}</p>`;
  return `<section class="sec" id="issues"><h2>Known issues <span class="count">${d.openIssues} open · ${d.issues.length - d.openIssues} resolved</span></h2>${body}</section>`;
}

function areaHtml(a: DocArea, open: boolean): string {
  const counts = TYPES.map((t) => [t, a.items.filter((i) => i.type === t).length] as const)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `<span class="tag ${t}">${n} ${t}</span>`)
    .join("");
  const items = a.items
    .map((i) => `<li><span class="tag ${i.type}">${i.type}</span><span>${esc(i.text)}</span></li>`)
    .join("");
  const keep = a.items.length <= KEEP_WHOLE ? " keep" : "";
  return `<details class="fold${keep}"${open ? " open" : ""}><summary><b>${esc(a.area)}</b><span class="tagcounts">${counts}</span><span class="total">${a.items.length} ${a.items.length === 1 ? "change" : "changes"}</span></summary><div class="inner"><ul class="items">${items}</ul></div></details>`;
}

function changelogHtml(d: ReleaseDoc, print: boolean): string {
  const total = d.changelog.reduce((n, a) => n + a.items.length, 0);
  const areas =
    d.changelog.length > 0
      ? `<div class="areas">${d.changelog.map((a) => areaHtml(a, print)).join("")}</div>`
      : `<p class="quiet">No user-facing changes recorded.</p>`;
  const deps =
    d.deps > 0
      ? `<p class="quiet">Plus ${d.deps} dependency ${d.deps === 1 ? "update" : "updates"}, not listed.</p>`
      : "";
  return `<section class="sec" id="changes"><h2>Changelog <span class="count">${total} ${total === 1 ? "change" : "changes"} in ${d.changelog.length} ${d.changelog.length === 1 ? "area" : "areas"}</span></h2>${areas}${deps}</section>`;
}

function versionCell(r: ReleaseDoc["rows"][number]): string {
  if (!r.to) return esc(r.version);
  const was = r.from ? `<s>${esc(r.from)} → </s>` : `<span class="tag new">new</span> `;
  return `${was}<b>${esc(r.to)}</b>`;
}

function componentsHtml(d: ReleaseDoc, print: boolean): string {
  const name = (id: string, url: string | undefined) =>
    print && url ? `<a href="${esc(url)}">${esc(id)}</a>` : esc(id);
  const chips = d.chips
    .map(
      (c) =>
        `<div class="comp${c.platform ? " platform" : ""}"><b>${esc(c.id)}</b><span><s>${esc(c.from ?? "new")} → </s>${esc(c.to)}</span></div>`,
    )
    .join("");
  const row = (r: ReleaseDoc["rows"][number]) => {
    const lib = r.group === "Services" ? (r.lib === undefined ? "–" : (r.lib ?? "?")) : "–";
    const java = r.group === "Services" ? (r.java === undefined ? "–" : (r.java ?? "?")) : "–";
    return `<tr><td class="svc">${name(r.id, r.url)}</td><td class="m${r.state === "unreleased" ? " dim" : ""}">${versionCell(r)}</td><td class="m">${r.releases || "–"}</td><td class="m">${esc(r.upstream ?? "–")}</td><td class="m">${esc(lib)}</td><td class="m">${esc(java)}</td></tr>`;
  };
  const group = (g: "Services" | "Platform") => {
    const rows = d.rows.filter((r) => r.group === g);
    return rows.length > 0
      ? `<tbody${rows.length <= KEEP_WHOLE ? ' class="keep"' : ""}><tr class="group"><td colspan="6">${g}</td></tr>${rows.map(row).join("")}</tbody>`
      : "";
  };
  const count = `${d.chips.length} changed${d.unchanged.length > 0 ? ` · ${d.unchanged.join(", ")} unchanged` : ""}`;
  return `<section class="sec" id="components"><h2>Components <span class="count">${esc(count)}</span></h2>
${chips ? (print ? "" : `<p class="sub">Version summary</p><div class="comps">${chips}</div>`) : `<p class="quiet">No component released this month.</p>`}
<details class="fold"${print ? " open" : ""}><summary><b>Full manifest</b><span class="count">version, releases, upstream base, core-lib-azure, Java</span></summary><div class="inner"><div class="tablebox"><table><thead><tr><th>Component</th><th>Version</th><th>Releases</th><th>Upstream base</th><th>core-lib-azure</th><th>Java</th></tr></thead>${group("Services")}${group("Platform")}</table></div></div></details></section>`;
}

function docBody(d: ReleaseDoc, print: boolean): string {
  const keys =
    d.keyChanges.length > 0
      ? `<div class="keys"><p class="k">Key changes</p><ul>${d.keyChanges.map((k) => `<li>${esc(k)}</li>`).join("")}</ul></div>`
      : "";
  const highlights =
    d.highlights.length > 0
      ? `<section class="sec" id="highlights"><h2>Highlights</h2><div class="hls">${d.highlights.map(highlightHtml).join("")}</div></section>`
      : "";
  const unread =
    d.unread.length > 0
      ? `<span>Not read on the last pass, so their figures may be stale: ${esc(d.unread.join(", "))}.</span>`
      : "";
  return `<div class="doc">
<section class="over" id="overview">${draftBanner(d)}
<div><div class="eyebrow">${d.eyebrow.map((e) => `<span>${esc(e)}</span>`).join("")}</div>
<div class="titlerow"><h1 class="relname">SPI ${esc(d.name)}</h1><span class="pill ${d.open ? "open" : "closed"}">${esc(d.stateText)}</span></div></div>
<p class="headline">${esc(d.headline)}</p>
${statsHtml(d, !print)}
${keys}</section>
${actionHtml(d)}
${highlights}
${issuesHtml(d)}
${changelogHtml(d, print)}
${componentsHtml(d, print)}
<footer class="foot"><div class="links"><span>Full changelogs on GitHub:</span>${d.links.map((l) => (print ? `<a href="${esc(l.url)}">${esc(l.label)}</a>` : `<span>${esc(l.label)}</span>`)).join("")}</div>
<span>Built ${esc(d.built)} from GitHub releases and each service's poms across the Azure/osdu-spi repositories.</span>${unread}</footer>
</div>`;
}

// The month in the canvas drawer, themed by the host.
// The sandboxed frame cannot follow a link or a fragment, so the tiles scroll by script.
const DOC_SCRIPT = `document.addEventListener("click", function (e) {
  var t = e.target && e.target.closest ? e.target.closest("[data-jump]") : null;
  var to = t && document.getElementById(t.getAttribute("data-jump"));
  if (to) to.scrollIntoView({ behavior: "smooth", block: "start" });
});`;

export function releaseDocHtml(d: ReleaseDoc): string {
  return `<style>${designTokenCssBlock()}${DOC_STYLE}</style>${docBody(d, false)}<script>${DOC_SCRIPT}</script>`;
}

// The same month as a standalone light page for the PDF printer.
export function releasePrintHtml(d: ReleaseDoc): string {
  return `<!doctype html>
<html lang="en" data-theme="light"><head><meta charset="utf-8"><title>SPI ${esc(d.name)} release notes</title>
<style>${designTokenCssBlock()}${DOC_STYLE}${printStyle(d)}</style></head>
<body>${docBody(d, true)}</body></html>`;
}

export function releaseHtmlEmpty(): string {
  return `<style>${designTokenCssBlock()}${DOC_STYLE}</style><div class="doc"><p class="quiet">Pick a month on the Releases tab and open it in the inspector.</p></div>`;
}

// The console's Releases tab: one row per month beside the selected month's summary.
export function releasesPaneHtml(lines: readonly ReleaseLine[], reading: boolean): string {
  if (lines.length === 0) {
    return `<h2>${reading ? "Reading releases…" : "No releases read yet."}</h2>`;
  }
  const first = lines[0]?.id;
  const notesTone = (n: NotesState) =>
    n === "approved" ? "t-ok" : n === "invalid" ? "t-bad" : "t-warn";
  const rows = lines
    .map(
      (
        l,
      ) => `<button type="button" class="row trow${l.id === first ? " on" : ""}" data-rel="${esc(l.id)}" aria-pressed="${l.id === first}">
<span class="body"><span class="tt">SPI ${esc(l.name)}</span> <span class="chip ${notesTone(l.notes)}">${esc(NOTES_LABEL[l.notes].toUpperCase())}</span>
<span class="ss">${esc(l.headline)}</span></span><span class="when">${esc(l.open ? "in progress" : "closed")}</span></button>`,
    )
    .join("");
  const details = lines
    .map((l) => {
      const facts = l.stats
        .map(
          (s) =>
            `<div class="fact${s.tone === "bad" ? " t-bad" : ""}"><div class="v">${esc(s.figure)}</div><div class="s">${esc(s.label)}</div></div>`,
        )
        .join("");
      const keys =
        l.keyChanges.length > 0
          ? `<p class="dl">Key changes</p><ul class="items">${l.keyChanges.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>`
          : "";
      return `<section class="detail" data-rel-detail="${esc(l.id)}"${l.id === first ? "" : " hidden"}>
<p class="eyebrow">${esc(l.stateText)} · ${esc(NOTES_LABEL[l.notes])}</p>
<h3>SPI ${esc(l.name)}</h3>
<p>${esc(l.headline)}</p>
<div class="facts relfacts">${facts}</div>
${keys}
<button type="button" class="open" data-inspect="${esc(l.id)}">Open in inspector · read or download PDF</button>
</section>`;
    })
    .join("");
  return `<h2>Monthly release notes for SPI consumers.</h2>
<p class="summary">Each month is built from the GitHub releases of the template, the stack, core-lib-azure and every service fork, with reviewed notes laid over it.</p>
<div class="split"><div class="focus">${rows}</div><div class="pane">${details}</div></div>`;
}

export interface ReleaseBoardState {
  doc: ReleaseDoc;
  notesPath: string;
  notesExists: boolean;
  lastPdf?: { path: string; at: string };
  readAt?: string;
  errors: string[];
  pdfReady: boolean;
}

const NOTES_TONE: Record<NotesState, CanvasTone> = {
  approved: "ok",
  draft: "warn",
  none: "neutral",
  invalid: "error",
};

export function releaseTitle(d: ReleaseDoc): string {
  return `SPI ${d.name} release notes`;
}

export function releaseBoard(s: ReleaseBoardState): CanvasBoardView {
  const d = s.doc;
  const payload = { month: d.month };
  const actions = [
    { type: RELEASE_OPEN_ACTION, label: "Read release notes", payload },
    ...(s.pdfReady
      ? [
          {
            type: RELEASE_PDF_ACTION,
            label: "Download PDF",
            tone: "brand" as const,
            payload,
            pendingLabel: "Writing PDF…",
            hint: "Writes the month to your Downloads folder as a PDF",
          },
        ]
      : []),
    ...(s.notesExists
      ? []
      : [
          {
            type: RELEASE_NOTES_ACTION,
            label: "Create notes file",
            payload,
            pendingLabel: "Creating…",
          },
        ]),
  ];
  const notesLine =
    d.notes === "approved"
      ? "Approved. The PDF carries no draft banner."
      : d.notes === "draft"
        ? 'Draft. Set "status" to "approved" in the notes file once a person has reviewed it.'
        : d.notes === "invalid"
          ? `The notes file does not parse: ${d.notesError ?? "invalid"}. The document shows only computed parts.`
          : "No notes file yet. The headline, actions, highlights and known issues come from it.";
  const sections: Section[] = [
    {
      kind: "rows",
      items: [{ glyph: NOTES_TONE[d.notes], text: d.headline, trailing: d.stateText }],
    },
    {
      kind: "stats",
      items: d.stats.map((x) => ({
        label: x.short,
        value: x.figure,
        ...(x.tone === "bad" ? { tone: "error" as const } : {}),
      })),
    },
    {
      kind: "cards",
      title: "Release notes",
      items: [
        {
          title: notesLine,
          edge: "brand",
          fields: [
            { label: "Notes file", value: s.notesPath },
            ...(s.lastPdf ? [{ label: "Last PDF", value: s.lastPdf.path }] : []),
          ],
          actions,
        },
      ],
    },
    {
      kind: "rows",
      title: "How the notes are written",
      boxed: true,
      items: [
        {
          glyph: "neutral",
          text: "Versions, the changelog, components and the manifest come from GitHub releases and each service's poms at its release tag.",
        },
        {
          glyph: "neutral",
          text: "The headline, key changes, actions, highlights and known issues come from the notes file. A changelog there replaces the computed one.",
        },
        {
          glyph: "neutral",
          text: "Ask chat to draft the file with spi_release_notes, then review it and set status to approved.",
        },
      ],
    },
  ];
  const problems = [
    ...(s.pdfReady
      ? []
      : ["No Chrome, Chromium or Edge found for the PDF; set RIB_SPI_CHROME to a browser binary."]),
    ...s.errors,
  ];
  if (problems.length > 0) {
    sections.push({
      kind: "rows",
      title: "Problems",
      boxed: true,
      items: problems.map((e) => ({ glyph: "warn" as const, text: e })),
    });
  }
  return {
    view: "board",
    title: releaseTitle(d),
    header: { status: { label: NOTES_LABEL[d.notes].toUpperCase(), tone: NOTES_TONE[d.notes] } },
    sections,
  };
}
