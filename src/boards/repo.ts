// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { Tone } from "../brief/index.ts";
import {
  alertLine,
  changeLine,
  dependencyLine,
  KIND_LABEL,
  REPO_PREFIX,
  type RepoLine,
  repositoriesOf,
} from "../brief/repos.ts";
import type { Model } from "../model/index.ts";
import type { AlertGroup, RepoRow } from "../model/repos.ts";
import { plural, stamp } from "../util.ts";

type Section = CanvasBoardView["sections"][number];
type Tab = Extract<Section, { kind: "tabs" }>["tabs"][number];
type TabSection = Tab["sections"][number];
type Rows = Extract<TabSection, { kind: "rows" }>;
type Row = Rows["items"][number];

const LIST_MAX = 25;

const TONE: Record<Tone, CanvasTone> = {
  bad: "error",
  warn: "warn",
  ok: "ok",
  neutral: "neutral",
};

function row(line: RepoLine, href?: string, trailing?: string): Row {
  return {
    chip: { label: line.tag, tone: TONE[line.tone] },
    text: line.text,
    detail: line.sub,
    ...(trailing ? { trailing } : {}),
    ...(href ? { href } : {}),
  };
}

// What the row says without opening: the fix, or the scanner for a code finding.
function fixMark(g: AlertGroup): string {
  if (g.source === "code") return g.tool || "code scanning";
  const fix = g.fix ? `fix ${g.fix}` : "no fix";
  return g.pr ? `${fix} · PR #${g.pr}` : fix;
}

// One alert opens on itself; a group opens GitHub's list filtered to it.
export function groupUrl(r: RepoRow, g: AlertGroup): string {
  if (g.count === 1) return g.url;
  const q =
    g.source === "dependabot"
      ? `is:open package:${g.name} manifest:${g.where}`
      : `is:open${g.tool ? ` tool:${g.tool}` : ""}${g.rule ? ` rule:${g.rule}` : ""}`;
  const page = g.source === "dependabot" ? "dependabot?q=" : "code-scanning?query=";
  return `${r.url}/security/${page}${encodeURIComponent(q)}`;
}

function capped(title: string, items: Row[], more: string): Rows | undefined {
  if (items.length === 0) return undefined;
  const shown = items.slice(0, LIST_MAX);
  if (items.length > LIST_MAX) {
    shown.push({ glyph: "neutral", text: `${items.length - LIST_MAX} more on GitHub`, href: more });
  }
  return { kind: "rows", title: `${title} · ${items.length}`, items: shown };
}

function alertsTab(r: RepoRow, source: AlertGroup["source"]): Tab {
  const groups = r.alerts.filter((g) => g.source === source);
  const rows = (keep: (g: AlertGroup) => boolean) =>
    groups.filter(keep).map((g) => row(alertLine(g), groupUrl(r, g), fixMark(g)));
  const list = `${r.url}/security/${source === "dependabot" ? "dependabot" : "code-scanning"}`;
  const sections = [
    capped(
      "Ours",
      rows((g) => g.owner !== "upstream" && g.reach !== "tests"),
      list,
    ),
    capped(
      "Upstream",
      rows((g) => g.owner === "upstream" && g.reach !== "tests"),
      list,
    ),
    capped(
      "Tests",
      rows((g) => g.reach === "tests"),
      list,
    ),
  ].filter((s): s is Rows => s !== undefined);
  const read = source === "dependabot" ? r.dependabotAlerts : r.codeAlerts;
  if (read === undefined) {
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "neutral",
          text: `${source === "dependabot" ? "Dependabot alerts" : "Code-scanning alerts"} are not readable with this token, or not read yet.`,
        },
      ],
    });
  } else if (sections.length === 0) {
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "ok",
          text: `No open ${source === "dependabot" ? "vulnerabilities" : "code-scanning alerts"}.`,
        },
      ],
    });
  }
  return { label: KIND_LABEL[source], badge: String(groups.length), sections };
}

function prsTab(r: RepoRow, now: Date): Tab {
  const changes = r.changes.map((c) => row(changeLine(c, now), c.pr.url, c.state));
  const bumps = [...r.dependabot]
    .sort((a, b) => b.closes - a.closes)
    .map((d) => row(dependencyLine(d), d.pr.url, d.state));
  const sections = [
    capped("Change PRs", changes, `${r.url}/pulls`),
    capped("Dependabot PRs", bumps, `${r.url}/pulls/app%2Fdependabot`),
  ].filter((s): s is Rows => s !== undefined);
  const notes: Row[] = [];
  if (r.pipeline > 0) {
    notes.push({
      glyph: "neutral",
      text: `${plural(r.pipeline, "pipeline PR")} (sync, template, release), on Flow.`,
    });
  }
  if (sections.length === 0 && notes.length === 0) {
    notes.push({ glyph: "ok", text: "No change or Dependabot PRs open." });
  }
  const all: TabSection[] = [...sections];
  if (notes.length > 0) all.push({ kind: "rows", items: notes });
  return { label: "PRs", badge: String(r.changes.length + r.dependabot.length), sections: all };
}

function issuesTab(r: RepoRow, now: Date): Tab {
  const kinds: [keyof RepoRow["issues"], string][] = [
    ["bug", "bug"],
    ["enhancement", "enhancement"],
    ["other", "issue"],
    ["automation", "sync engine"],
  ];
  const items: Row[] = kinds.flatMap(([kind, tag]) =>
    r.issues[kind].map((i) => {
      const since = stamp(i.createdAt, now);
      return {
        chip: { label: tag, tone: "neutral" },
        text: `${i.title} · #${i.number}`,
        detail: [
          since ? `opened ${since}` : undefined,
          plural(i.comments, "comment"),
          kind === "automation" ? "on Today" : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        href: i.url,
      };
    }),
  );
  const list = capped("Open", items, `${r.url}/issues`);
  return {
    label: "Issues",
    badge: String(items.length),
    sections: [list ?? { kind: "rows", items: [{ glyph: "ok", text: "No issues open." }] }],
  };
}

function find(model: Model, id: string): RepoRow | undefined {
  return model.repositories.rows.find((r) => `${REPO_PREFIX}${r.name}` === id);
}

export function repoTitle(model: Model, id: string): string | undefined {
  const r = find(model, id);
  return r ? r.repo.split("/")[1] : undefined;
}

export function repoBoard(model: Model, id: string, now: Date): CanvasBoardView {
  const r = find(model, id);
  const entry = repositoriesOf(model, now).rows.find((e) => e.id === id);
  if (!r || !entry) {
    return {
      view: "board",
      header: { status: { label: "UNKNOWN", tone: "neutral" } },
      sections: [
        { kind: "rows", items: [{ glyph: "neutral", text: `${id} is not a watched repository.` }] },
      ],
    };
  }
  const read = model.repositories.alertsAt ? stamp(model.repositories.alertsAt, now) : undefined;
  return {
    view: "board",
    title: entry.title,
    header: {
      status: { label: r.group === "program" ? "PROGRAM" : "FORK", tone: TONE[entry.tone] },
      chip: [r.repo, read ? `alerts read ${read}` : "alerts not read yet"].join(" · "),
    },
    sections: [
      { kind: "rows", items: [{ glyph: "info", text: entry.sub }] },
      {
        kind: "tabs",
        tabs: [alertsTab(r, "dependabot"), alertsTab(r, "code"), prsTab(r, now), issuesTab(r, now)],
      },
      {
        kind: "rows",
        title: "On GitHub",
        items: [
          { icon: "↗", text: "Security overview", href: `${r.url}/security` },
          { icon: "↗", text: "Pull requests", href: `${r.url}/pulls` },
          { icon: "↗", text: "Issues", href: `${r.url}/issues` },
        ],
      },
    ],
  };
}
