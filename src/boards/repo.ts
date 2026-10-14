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

function securityTab(r: RepoRow): Tab {
  const alerts = (keep: (g: AlertGroup) => boolean) =>
    r.alerts.filter(keep).map((g) => row(alertLine(g), groupUrl(r, g)));
  const overview = `${r.url}/security`;
  const sections = [
    capped(
      "Ours",
      alerts((g) => g.owner !== "upstream" && g.reach !== "tests"),
      overview,
    ),
    capped(
      "Upstream",
      alerts((g) => g.owner === "upstream" && g.reach !== "tests"),
      overview,
    ),
    capped(
      "Tests",
      alerts((g) => g.reach === "tests"),
      overview,
    ),
  ].filter((s): s is Rows => s !== undefined);
  const hidden = [
    r.dependabotAlerts === undefined ? "Dependabot alerts" : undefined,
    r.codeAlerts === undefined ? "Code-scanning alerts" : undefined,
  ].filter((x): x is string => !!x);
  if (hidden.length > 0) {
    sections.push({
      kind: "rows",
      items: hidden.map((h) => ({
        glyph: "neutral",
        text: `${h} are not readable with this token, or not read yet.`,
      })),
    });
  }
  if (sections.length === 0) {
    sections.push({ kind: "rows", items: [{ glyph: "ok", text: "No open security alerts." }] });
  }
  return { label: "Security", badge: String(r.alerts.length), sections };
}

function changesTab(r: RepoRow, now: Date): Tab {
  const items = r.changes.map((c) => row(changeLine(c, now), c.pr.url, c.state));
  const sections: TabSection[] = [];
  const list = capped("Open", items, `${r.url}/pulls`);
  if (list) sections.push(list);
  if (r.pipeline > 0) {
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "neutral",
          text: `${plural(r.pipeline, "pipeline PR")} (sync, template, release), on Flow.`,
        },
      ],
    });
  }
  if (sections.length === 0) {
    sections.push({ kind: "rows", items: [{ glyph: "ok", text: "No change PRs open." }] });
  }
  return { label: "Changes", badge: String(r.changes.length), sections };
}

function dependabotTab(r: RepoRow): Tab {
  const items = [...r.dependabot]
    .sort((a, b) => b.closes - a.closes)
    .map((d) => row(dependencyLine(d), d.pr.url, d.state));
  const list = capped("Open", items, `${r.url}/pulls/app%2Fdependabot`);
  return {
    label: "Dependabot",
    badge: String(r.dependabot.length),
    sections: [list ?? { kind: "rows", items: [{ glyph: "ok", text: "No Dependabot PRs open." }] }],
  };
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
        tabs: [securityTab(r), changesTab(r, now), dependabotTab(r), issuesTab(r, now)],
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
