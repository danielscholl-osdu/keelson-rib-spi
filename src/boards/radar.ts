// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { FORKS, githubUrl, SYNC_UPSTREAM_CRON } from "../config.ts";
import type { Model } from "../model/index.ts";
import type { Bucket, RadarService, Verdict } from "../model/radar.ts";
import { nextFire, toCrons } from "../model/schedule.ts";
import { clip, plural, stamp } from "../util.ts";
import { names } from "./fold.ts";

type Section = CanvasBoardView["sections"][number];

export const MR_PREFIX = "mr:";
const FILTER_BLOB = "/blob/main/.github/upstream-filter.yml";

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
