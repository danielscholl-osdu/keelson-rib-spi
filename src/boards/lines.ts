// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { gitlabUrl } from "../config.ts";
import type { Model } from "../model/index.ts";
import type { LineModel, StationState } from "../model/lines.ts";
import { age, stamp } from "../util.ts";

type CardsSection = Extract<CanvasBoardView["sections"][number], { kind: "cards" }>;
type Card = CardsSection["items"][number];

const STATION_TONE: Record<Exclude<StationState, "unknown">, CanvasTone> = {
  idle: "neutral",
  moving: "info",
  waiting: "warn",
  stopped: "error",
};

const STATION_LABEL: Record<string, string> = {
  upstream: "upstream",
  sync: "sync",
  cascade: "cascade",
  main: "main",
  release: "release",
  lane: "stack lane",
};

function lineCard(line: LineModel, now: Date): Card {
  const stopped = line.stations.filter((s) => s.state === "stopped");
  const lag = line.upstream?.lag;
  const fields: NonNullable<Card["fields"]> = [
    {
      label: "upstream",
      value:
        lag === undefined
          ? null
          : `${lag} behind${line.upstream?.head?.at ? ` · master ${age(line.upstream.head.at, now)}` : ""}`,
      href: gitlabUrl(line.fork.upstream),
    },
    {
      label: "release",
      value: line.release ? `${line.release.tag} · ${age(line.release.at, now)}` : "none yet",
      ...(line.release ? { href: line.release.url } : {}),
    },
    {
      label: "template",
      value:
        line.template.behind === undefined
          ? null
          : `${line.template.label ?? "?"} · ${line.template.behind === 0 ? "current" : `${line.template.behind} behind`}`,
      ...(line.templatePr ? { href: line.templatePr.pr.url } : {}),
    },
    {
      label: "lane 21d",
      value: `${line.lane.ok} ok · ${line.lane.failed} failed`,
      tone: line.lane.failed > line.lane.ok ? "warn" : undefined,
    },
  ];
  return {
    title: line.fork.id,
    href: line.url,
    dot: line.pill.tone,
    ...(line.pill.tone === "error" ? { edge: "error" as const } : {}),
    pill: line.pill,
    bar: {
      segments: line.stations.map((s) => ({
        label: `${STATION_LABEL[s.id]}: ${s.text}`,
        n: s.state === "unknown" ? null : 1,
        ...(s.state === "unknown" ? {} : { tone: STATION_TONE[s.state] }),
      })),
      label: "line",
      trailing:
        stopped.length > 0
          ? `stopped at ${stopped.map((s) => STATION_LABEL[s.id]).join(", ")}`
          : "nothing stopped",
    },
    fields,
    ...(line.why ? { reason: { label: "why", text: line.why } } : {}),
  };
}

export function linesBoard(model: Model, now: Date): CanvasBoardView {
  if (!model.measured) {
    return {
      view: "board",
      header: { status: { label: "NOT READ", tone: "neutral" } },
      sections: [],
    };
  }
  const n = model.lines.length;
  const current = model.lines.filter((l) => l.current).length;
  const anyRed = model.lines.some((l) => l.pill.tone === "error");
  const ghosts: Card[] = model.planned.map(({ service, exists }) => ({
    title: service.id,
    ghost: true,
    footnote: exists ? "repository exists; add it to the service map" : "no fork yet",
  }));
  return {
    view: "board",
    header: {
      status: {
        label: `${current} OF ${n} CURRENT`,
        tone: current === n ? "ok" : anyRed ? "error" : "warn",
      },
      chip: `${n} forks · ${model.planned.length} planned${model.sweptAt ? ` · ${stamp(model.sweptAt, now)}` : ""}`,
    },
    sections: [
      {
        kind: "cards",
        grid: true,
        columns: 4,
        items: [...model.lines.map((l) => lineCard(l, now)), ...ghosts],
      },
    ],
  };
}
