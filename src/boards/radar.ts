// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { AZURE_REMOVAL_DUE, FORKS, githubUrl, gitlabUrl, SYNC_UPSTREAM_CRON } from "../config.ts";
import type { Model } from "../model/index.ts";
import {
  type Bucket,
  certainText,
  type RadarService,
  type RadarState,
  type Verdict,
} from "../model/radar.ts";
import { nextFire, toCrons } from "../model/schedule.ts";
import { INSPECT_ACTION } from "../surfaces.ts";
import { clip, plural, short, since, stamp, zoned } from "../util.ts";
import { names } from "./fold.ts";

type Section = CanvasBoardView["sections"][number];
type TableSection = Extract<Section, { kind: "table" }>;
type Cell = TableSection["rows"][number][string];
type Stat = Extract<Section, { kind: "stats" }>["items"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];

export const MR_PREFIX = "mr:";
const FILTER_BLOB = "/blob/main/.github/upstream-filter.yml";
const BREAKS_AT = 12;
const DAY_MS = 86_400_000;

const BREAKING = new Set<RadarState>([
  "halted",
  "toolchain-blocked",
  "will-halt",
  "toolchain-queued",
]);

// One open MR that would halt a fork's next sync or move its toolchain.
export interface Break {
  fork: string;
  iid: number;
  title: string;
  draft: boolean;
  url: string;
  createdAt: string;
  updatedAt: string;
  kind: "halt" | "toolchain";
  // The halt code, or the lead toolchain value.
  bucket: string;
  // The entries it halts on, or every toolchain value it moves.
  items: string[];
  elsewhere: string[];
}

export function nextSyncAt(now: Date): string | undefined {
  const at = nextFire(toCrons([SYNC_UPSTREAM_CRON]), now);
  return at === undefined ? undefined : new Date(at).toISOString();
}

function breaksOf(fork: string, r: RadarService): Break[] {
  const out: Break[] = [];
  const byMr = new Map<number, Verdict[]>();
  for (const v of r.possible) {
    if (!v.mr || (v.bucket !== "Halt" && v.bucket !== "Toolchain")) continue;
    byMr.set(v.mr.iid, [...(byMr.get(v.mr.iid) ?? []), v]);
  }
  for (const verdicts of byMr.values()) {
    const mr = verdicts[0]?.mr;
    if (!mr) continue;
    const halts = verdicts.filter((v) => v.bucket === "Halt");
    const tools = verdicts.filter((v) => v.bucket === "Toolchain");
    const base = { fork, ...mr };
    if (halts.length > 0) {
      out.push({
        ...base,
        kind: "halt",
        bucket: [...new Set(halts.map((v) => v.code))].join(", "),
        items: halts.map((v) => v.entry ?? ""),
        elsewhere: [...new Set(halts.flatMap((v) => v.elsewhere ?? []))],
      });
    }
    if (tools.length > 0) {
      out.push({
        ...base,
        kind: "toolchain",
        bucket: tools[0]?.value ?? "toolchain",
        items: tools.map((v) => v.value ?? ""),
        elsewhere: [],
      });
    }
  }
  return out;
}

// Fork order, then the MR touched last, a halt before a toolchain move.
export function radarBreaks(model: Model): Break[] {
  return FORKS.flatMap((f) => {
    const r = model.radar.services[f.id];
    if (!r) return [];
    return breaksOf(f.id, r).sort(
      (a, b) =>
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
        Number(a.kind === "toolchain") - Number(b.kind === "toolchain"),
    );
  });
}

function measured(model: Model): [string, RadarService][] {
  return FORKS.flatMap((f) => {
    const r = model.radar.services[f.id];
    return r && r.state !== "unmeasured" ? [[f.id, r] as [string, RadarService]] : [];
  });
}

function unread(model: Model): string[] {
  return FORKS.filter(
    (f) => (model.radar.services[f.id]?.state ?? "unmeasured") === "unmeasured",
  ).map((f) => f.id);
}

function status(model: Model): { label: string; tone: CanvasTone } {
  const read = measured(model);
  if (read.length === 0) return { label: "NOT READ", tone: "neutral" };
  const breaking = read.filter(([, r]) => BREAKING.has(r.state)).length;
  const risky = read.filter(([, r]) => r.state === "at-risk").length;
  const dark = unread(model).length;
  const head =
    breaking > 0
      ? { label: `${breaking} WILL BREAK`, tone: "warn" as const }
      : risky > 0
        ? { label: `${risky} AT RISK`, tone: "info" as const }
        : { label: "NEXT SYNC CLEAN", tone: "ok" as const };
  return dark > 0 ? { ...head, label: `${head.label} · ${dark} UNREAD` } : head;
}

// "entitlements halts on schemathesis-tests", "legal carries Java 25"
function worstText(fork: string, certain: readonly Verdict[]): string | undefined {
  const halts = certain.filter((v) => v.bucket === "Halt" && v.entry);
  if (halts.length > 0) return `${fork} halts on ${names(halts.map((v) => v.entry as string))}`;
  const tool = certain.find((v) => v.bucket === "Toolchain" && v.value);
  return tool ? `${fork} carries ${tool.value}` : undefined;
}

function tiles(model: Model, breaks: readonly Break[], now: Date): Section {
  const read = measured(model);
  const at = nextSyncAt(now);
  const worst = read.flatMap(([fork, r]) => {
    const text = worstText(fork, r.certain);
    return text ? [text] : [];
  });
  const next: Stat =
    read.length === 0 || !at
      ? { label: "Next sync", value: "?", sub: "upstream unread" }
      : {
          label: "Next sync",
          clock: { at, mode: "until" },
          tone: worst.length > 0 ? "warn" : "ok",
          sub: worst.length > 0 ? worst.join(" · ") : "nothing queued breaks",
        };
  const ready = [
    ...new Map(breaks.filter((b) => !b.draft).map((b) => [`${b.fork}!${b.iid}`, b])).values(),
  ];
  const drafts = new Set(breaks.filter((b) => b.draft).map((b) => `${b.fork}!${b.iid}`)).size;
  const top = ready.slice(0, 2).map((b) => `${b.fork} !${b.iid}`);
  const willBreak: Stat =
    read.length === 0
      ? { label: "Will break", value: "?", sub: "upstream unread" }
      : {
          label: "Will break",
          value: String(ready.length),
          tone: ready.length > 0 ? "info" : "ok",
          sub:
            [
              ready.length > 0 ? top.join(" · ") : "no open MR breaks a fork",
              drafts > 0 ? `+${plural(drafts, "draft")}` : undefined,
            ]
              .filter(Boolean)
              .join(" · ") || "no open MR breaks a fork",
        };
  const days = Math.ceil((Date.parse(AZURE_REMOVAL_DUE) - now.getTime()) / DAY_MS);
  const removal: Stat = {
    label: "M28 · Azure removal",
    value: days >= 0 ? `${days} d` : "due",
    tone: days <= 14 ? "warn" : "info",
    sub: "stages land in R4",
  };
  return { kind: "stats", items: [next, willBreak, removal] };
}

function cell(text: string, tone?: CanvasTone, href?: string): Cell {
  return { value: text.replace(/ /g, " "), ...(tone ? { tone } : {}), ...(href ? { href } : {}) };
}

const STATE_TONE: Partial<Record<RadarState, CanvasTone>> = {
  halted: "error",
  "toolchain-blocked": "warn",
  "will-halt": "warn",
  "toolchain-queued": "warn",
  "port-owed": "info",
  "at-risk": "info",
};

function nextSync(model: Model, breaks: readonly Break[]): Section[] {
  const sections: Section[] = [];
  const read = measured(model);
  const shown = read.filter(([, r]) => r.queued > 0);
  const risky = read.filter(([, r]) => r.queued === 0 && r.state === "at-risk");
  const clean = read.filter(([, r]) => r.queued === 0 && r.state !== "at-risk");
  if (shown.length > 0) {
    sections.push({
      kind: "table",
      caption: "Next sync · one row per fork with something queued",
      columns: [
        { key: "fork", label: "fork" },
        { key: "queued", label: "queued" },
        { key: "next", label: "next sync" },
        { key: "mrs", label: "open MRs" },
        { key: "filter", label: "filter" },
      ],
      rows: shown.map(([fork, r]) => {
        const def = FORKS.find((f) => f.id === fork);
        const would = new Set(breaks.filter((b) => b.fork === fork && !b.draft).map((b) => b.iid))
          .size;
        const verdict = certainText(r.certain) ?? (r.queued > 0 ? "lagging" : "clean");
        return {
          fork: {
            value: fork,
            ...(def ? { href: gitlabUrl(def.upstream, "/-/commits/master") } : {}),
          },
          queued: r.queued > 0 ? cell(plural(r.queued, "commit")) : cell("none", "neutral"),
          next: cell(verdict, STATE_TONE[r.state] ?? "neutral"),
          mrs: cell(
            `${r.mrs}${would > 0 ? ` · ${would} would break` : ""}`,
            would > 0 ? "info" : "neutral",
            def ? gitlabUrl(def.upstream, "/-/merge_requests") : undefined,
          ),
          filter: r.filterSha
            ? cell(
                short(r.filterSha),
                "neutral",
                def ? githubUrl(def.repo, FILTER_BLOB) : undefined,
              )
            : "?",
        };
      }),
    });
  }
  const folds: Row[] = [];
  if (risky.length > 0) {
    folds.push({
      glyph: "info",
      text: `${plural(risky.length, "fork")} at risk · ${names(risky.map(([f]) => f))} · open MRs below`,
      trailing: "nothing queued breaks it",
    });
  }
  if (clean.length > 0) {
    folds.push({
      glyph: "ok",
      text: `${plural(clean.length, "fork")} clean · ${names(clean.map(([f]) => f))}`,
      trailing: "nothing queued, no open MR breaks it",
    });
  }
  const dark = unread(model);
  if (dark.length > 0) {
    folds.push({
      glyph: "neutral",
      text: `${plural(dark.length, "fork")} unread · ${names(dark)}`,
      trailing: "no filter or upstream read",
    });
  }
  if (folds.length > 0) sections.push({ kind: "rows", items: folds });
  return sections;
}

// Past three forks the row counts them; the inspector names every one.
function alsoIn(forks: readonly string[]): string {
  return forks.length <= 3 ? names(forks) : plural(forks.length, "other fork");
}

function breakText(b: Break): string {
  const what = b.kind === "halt" ? `${b.bucket}: ${b.items.join(", ")}` : b.items.join(", ");
  return `!${b.iid} ${clip(b.title, 48)}${b.draft ? " · draft" : ""} · ${clip(what, 72)}`;
}

function breaksSection(
  breaks: readonly Break[],
  now: Date,
  selected: string | undefined,
): Section | undefined {
  if (breaks.length === 0) return undefined;
  const shown = breaks.slice(0, BREAKS_AT);
  const items: Row[] = shown.map((b) => {
    const id = `${MR_PREFIX}${b.fork}:${b.iid}`;
    return {
      chip: { label: b.fork, tone: b.draft ? "neutral" : b.kind === "halt" ? "warn" : "info" },
      text: breakText(b),
      trailing: [
        b.elsewhere.length > 0 ? `also in ${alsoIn(b.elsewhere)}` : undefined,
        since(b.createdAt, now),
      ]
        .filter(Boolean)
        .join(" · "),
      action: { type: INSPECT_ACTION, payload: { id } },
      ...(id === selected ? { selected: true } : {}),
    };
  });
  const rest = breaks.length - shown.length;
  if (rest > 0) {
    const def = FORKS.find((f) => f.id === breaks[BREAKS_AT]?.fork);
    items.push({
      icon: "↗",
      text: `and ${rest} more`,
      ...(def ? { href: gitlabUrl(def.upstream, "/-/merge_requests") } : {}),
    });
  }
  return { kind: "rows", title: `Open MRs that would break a fork · ${breaks.length}`, items };
}

export interface RadarOptions {
  selected?: string;
  stale?: string;
  // When the radar area last read GitLab.
  readAt?: string;
}

export function radarBoard(model: Model, now: Date, opts: RadarOptions = {}): CanvasBoardView {
  const breaks = radarBreaks(model);
  const sections: Section[] = [tiles(model, breaks, now), ...nextSync(model, breaks)];
  const list = breaksSection(breaks, now, opts.selected);
  if (list) sections.push(list);
  const gitlab = stamp(opts.readAt, now);
  return {
    view: "board",
    header: {
      status: status(model),
      chip: [
        opts.stale,
        gitlab ? `GitLab read ${gitlab}` : undefined,
        opts.stale ? undefined : (zoned(model.sweptAt, now) ?? "not swept"),
      ]
        .filter(Boolean)
        .join(" · "),
    },
    sections,
  };
}

function parseId(id: string): { fork: string; iid: number } | undefined {
  const m = /^mr:([\w-]+):(\d+)$/.exec(id);
  return m?.[1] && m[2] ? { fork: m[1], iid: Number(m[2]) } : undefined;
}

export function mrTitle(model: Model, id: string): string | undefined {
  const at = parseId(id);
  const mr = at
    ? model.radar.services[at.fork]?.possible.find((v) => v.mr?.iid === at.iid)?.mr
    : undefined;
  return at && mr ? `${at.fork} · !${mr.iid} ${clip(mr.title, 48)}` : undefined;
}

const BUCKET_ORDER: Bucket[] = ["Halt", "Toolchain", "Port", "Interface", "Shared", "Filtered"];

// One open MR: what it would do to the fork's next sync, its paths by bucket, the forks it reaches.
export function mrBoard(model: Model, id: string, now: Date): CanvasBoardView {
  const at = parseId(id);
  const verdicts = at
    ? (model.radar.services[at.fork]?.possible ?? []).filter((v) => v.mr?.iid === at.iid)
    : [];
  const mr = verdicts[0]?.mr;
  const def = FORKS.find((f) => f.id === at?.fork);
  if (!at || !mr || !def) {
    return {
      view: "board",
      header: { status: { label: "CLOSED", tone: "neutral" } },
      sections: [
        {
          kind: "rows",
          items: [{ glyph: "ok", text: "The MR is no longer open upstream; the panel redrew." }],
        },
      ],
    };
  }
  const halts = verdicts.filter((v) => v.bucket === "Halt");
  const tools = verdicts.filter((v) => v.bucket === "Toolchain");
  const said =
    halts.length > 0
      ? `Merged, it halts ${at.fork}'s next Sync Upstream on ${names(halts.map((v) => v.entry ?? ""))} (${[...new Set(halts.map((v) => v.code))].join(", ")}).`
      : tools.length > 0
        ? `Merged, it carries ${names(tools.map((v) => v.value ?? ""))} into ${at.fork}'s next Sync Upstream.`
        : `Merged, it syncs into ${at.fork} without a halt or a toolchain move.`;
  const sections: Section[] = [
    {
      kind: "rows",
      items: [
        { glyph: halts.length > 0 ? "warn" : tools.length > 0 ? "info" : "ok", text: said },
        ...(mr.draft
          ? [
              {
                glyph: "neutral" as const,
                text: "Draft: it counts toward nothing until it is marked ready.",
              },
            ]
          : []),
      ],
    },
  ];
  for (const bucket of BUCKET_ORDER) {
    const group = verdicts.filter((v) => v.bucket === bucket);
    if (group.length === 0) continue;
    const paths = new Set(group.flatMap((v) => v.paths)).size;
    sections.push({
      kind: "rows",
      title: `${bucket} · ${plural(paths, "path")}`,
      items: group.map((v) => ({
        text: v.value ?? v.entry ?? bucket,
        trailing: [v.code, v.map, plural(v.paths.length, "path")].filter(Boolean).join(" · "),
        detail: clip(v.paths.join(", "), 400),
      })),
    });
  }
  const elsewhere = [...new Set(halts.flatMap((v) => v.elsewhere ?? []))];
  sections.push({
    kind: "rows",
    title: "Forks it reaches",
    items: [
      {
        glyph: halts.length > 0 ? "warn" : "info",
        text: at.fork,
        trailing: "its upstream project",
      },
      ...(elsewhere.length > 0
        ? [
            {
              glyph: "neutral" as const,
              text: names(elsewhere),
              trailing: "their filters lack the entry too",
            },
          ]
        : []),
    ],
  });
  sections.push({
    kind: "rows",
    title: "Evidence",
    items: [
      { icon: "↗", text: "Open MR", trailing: `!${mr.iid}`, href: mr.url },
      {
        icon: "↗",
        text: "Open filter",
        trailing: ".github/upstream-filter.yml",
        href: githubUrl(def.repo, FILTER_BLOB),
      },
    ],
  });
  return {
    view: "board",
    header: {
      status: {
        label: halts.length > 0 ? "HALT" : tools.length > 0 ? "TOOLCHAIN" : "NO BREAK",
        tone: halts.length > 0 ? "warn" : tools.length > 0 ? "info" : "ok",
      },
      chip: [
        `${at.fork} · !${mr.iid}`,
        mr.draft ? "draft" : undefined,
        `opened ${stamp(mr.createdAt, now)}`,
      ]
        .filter(Boolean)
        .join(" · "),
    },
    sections,
  };
}
