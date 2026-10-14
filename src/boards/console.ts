// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { designTokenCssBlock } from "@keelson/shared";
import type { BriefFact, Briefing, FocusItem, ReadyLine, Tone } from "../brief/index.ts";
import { INSPECT_ACTION } from "../surfaces.ts";
import { zoned } from "../util.ts";

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
${evidence ? `<p class="dl">Evidence</p><p class="ev">${evidence}</p>` : ""}
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
    b.more > 0
      ? `<p class="more">${b.more} more in the queue; the panels below list them.</p>`
      : "";
  const list = `<div class="focus">${rows}${more}${readyHtml(b.ready)}</div>`;
  const details = b.focus.map((f) => detail(f, f.id === first)).join("");
  return `<div class="facts">${b.facts.map(factHtml).join("")}</div>
${b.focus.length > 0 ? `<div class="split">${list}<div class="pane">${details}</div></div>` : list}`;
}

const STYLE = `
.wrap { padding: 16px 18px 20px; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 16px; font-family: var(--mono); font-size: 11px; color: var(--muted); letter-spacing: .04em; margin-bottom: 10px; }
.meta .right { margin-left: auto; }
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
.ready b { color: var(--fg-strong); font-weight: 600; }
.link { background: none; border: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.pane { min-width: 0; }
.detail { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px 14px; }
.detail h3 { margin: 2px 0 0; font-size: 15px; color: var(--fg-strong); }
.detail .dl { margin-top: 10px; }
.detail p { margin: 2px 0 0; font-size: 13.5px; }
.detail .ev { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.open { margin-top: 12px; font: inherit; font-size: 13px; font-weight: 600; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--accent); color: var(--accent); background: none; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 720px) {
  .split, .facts { grid-template-columns: minmax(0, 1fr); }
  .fact + .fact { border-left: 3px solid transparent; border-top: 1px solid var(--border); }
}`;

const SCRIPT = `(function () {
  var k = window.keelson || {};
  function show(id) {
    var found = false;
    document.querySelectorAll("[data-detail]").forEach(function (d) {
      var on = d.getAttribute("data-detail") === id;
      d.hidden = !on;
      if (on) found = true;
    });
    if (!found) return false;
    document.querySelectorAll("[data-sel]").forEach(function (r) {
      var on = r.getAttribute("data-sel") === id;
      r.classList.toggle("on", on);
      r.setAttribute("aria-pressed", on ? "true" : "false");
    });
    return true;
  }
  if (k.onRestore) k.onRestore(function (s) { if (s && typeof s.sel === "string") show(s.sel); });
  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target.closest("[data-sel],[data-inspect]") : null;
    if (!t) return;
    var sel = t.getAttribute("data-sel");
    if (sel !== null) {
      if (show(sel) && k.saveState) k.saveState({ sel: sel });
      return;
    }
    if (k.action) k.action(${JSON.stringify(INSPECT_ACTION)}, { id: t.getAttribute("data-inspect") });
  });
})();`;

// Markup only: the briefing has already decided every word, so this lays it out and adds
// selection. The frame cannot open links; evidence and verbs live in the inspector.
export function consoleHtml(b: Briefing, now: Date): string {
  const swept = zoned(b.sweptAt, now);
  const read =
    b.doctor.state === "clear"
      ? "every source read"
      : b.doctor.state === "partial"
        ? "some sources unread"
        : b.doctor.state === "dark"
          ? "GitHub unread"
          : "first sweep running";
  const meta = `<div class="meta"><span>${swept ? `swept ${esc(swept)} · ` : ""}${read}</span>${
    b.nextSyncAt
      ? `<span class="right">next Sync Upstream ${esc(zoned(b.nextSyncAt, now) ?? "")}</span>`
      : ""
  }</div>`;
  const body = b.facts.length > 0 ? todayHtml(b) : "";
  return `<style>${designTokenCssBlock()}${STYLE}</style>
<div class="wrap">${meta}
<h2>${esc(b.headline)}</h2>
${b.summary ? `<p class="summary">${esc(b.summary)}</p>` : ""}
${body}
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
