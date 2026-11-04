// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { FORKS, PLANNED, type ServiceDef, STACK_REPO, TEMPLATE_REPO } from "../config.ts";
import type { Facts } from "../facts.ts";
import { activeRollout } from "../rollout.ts";
import type { DismissEntry } from "./dismiss.ts";
import { buildGates, type Gates } from "./gates.ts";
import { type LaneLoad, laneLoad } from "./lanes.ts";
import { buildLine, type LineModel } from "./lines.ts";
import { withoutNoise } from "./noise.ts";
import { buildQueue, type Queue } from "./queue.ts";
import { buildRadar, predictAll, type RadarModel } from "./radar.ts";
import { buildRepos, type ReposModel } from "./repos.ts";
import { buildRollout, type RolloutModel } from "./rollout.ts";
import { buildStack, heldText, type StackModel } from "./stack.ts";
import { buildTemplate, type TemplateModel } from "./template.ts";
import { buildUpstream, type UpstreamModel } from "./upstream.ts";
import { buildWork, type WorkModel } from "./work.ts";

export interface Model {
  measured: boolean;
  sweptAt?: string;
  // When GitLab was last read; it is read less often than the sweep.
  upstreamAt?: string;
  stack: StackModel;
  lines: LineModel[];
  planned: { service: ServiceDef; exists: boolean }[];
  template: TemplateModel;
  gates: Gates;
  queue: Queue;
  // What the next Sync Upstream does with the queued commits, per fork.
  radar: RadarModel;
  // Every open PR and issue per repository, including work that sits on no line.
  work: WorkModel;
  // The same, with security alerts, sorted by who can fix each item.
  repositories: ReposModel;
  // Forks holding a lane on the shared environment, against the paced buttons' cap.
  lanes: LaneLoad;
  // osdu-spi main on its way to the fleet, while main carries what a fork lacks.
  rollout?: RolloutModel;
  // Each fork's way from upstream to main, and the plan that drives the syncs.
  upstream: UpstreamModel;
  // Checks the built-in noise rules took out of PR state, by rule id.
  noise: Record<string, number>;
}

// Pure: the same facts and clock always give the same model, so every region
// and every tool counts the same things.
export function buildModel(
  facts: Facts,
  now: Date,
  opts: {
    dispatched?: Record<string, string>;
    pressed?: Record<string, string>;
    dismissed?: readonly DismissEntry[];
  } = {},
): Model {
  const { repos, ignored } = withoutNoise(facts.github.data?.repos ?? {});
  const details = facts.details.data ?? {};
  const stack = buildStack(
    repos[STACK_REPO],
    facts.lifecycle.data,
    now,
    FORKS.flatMap((f) => {
      const repo = repos[f.repo];
      return repo ? [{ fork: f.id, deployments: repo.deployments }] : [];
    }),
  );
  const templateRepo = repos[TEMPLATE_REPO];
  const predictions = predictAll(facts.radar.data);
  const lines = FORKS.map((fork) =>
    buildLine({
      fork,
      repo: repos[fork.repo],
      runs: facts.runs.data?.[fork.repo],
      upstream: facts.upstream.data?.[fork.id],
      compares: facts.template.data?.compares ?? {},
      targets: facts.template.data?.targets ?? {},
      templateHead: templateRepo?.head,
      dispatchedAt: opts.dispatched?.[fork.repo],
      details,
      stack,
      radar: predictions[fork.id],
      now,
    }),
  );
  const radar = buildRadar(predictions, lines, facts.radar.data);
  const template = buildTemplate(templateRepo, facts.template.data, lines, {
    syncCrons: [...new Set(FORKS.flatMap((f) => repos[f.repo]?.syncCrons ?? []))],
    now,
    details,
  });
  const repositories = buildRepos({
    repos,
    alerts: facts.security,
    filters: facts.radar.data?.filters,
    synced: facts.template.data?.synced,
  });
  const lanes = laneLoad({
    repos,
    runs: facts.runs.data,
    prsRead: !!facts.github.data,
    dispatched: opts.dispatched,
    pressed: opts.pressed,
  });
  const rollout = buildRollout({
    template,
    lines,
    runs: facts.runs.data,
    lanes,
    ordering: activeRollout()?.ordering,
    held: heldText(stack),
    radar,
    now,
  });
  const upstream = buildUpstream({
    lines,
    radar,
    runs: facts.runs.data,
    lanes,
    ordering: activeRollout()?.ordering,
    held: heldText(stack),
    now,
  });
  const queue = buildQueue({
    stack,
    lines,
    template,
    rollout,
    repos,
    details,
    approvals: facts.approvals.data,
    radar,
    repositories,
    dismissed: opts.dismissed ?? [],
    now,
  });
  return {
    measured: facts.github.data !== undefined,
    sweptAt: facts.sweep?.at,
    upstreamAt: facts.upstream.at,
    stack,
    lines,
    planned: PLANNED.map((service) => ({
      service,
      exists: facts.github.data?.planned[service.id] ?? false,
    })),
    template,
    gates: buildGates(lines, now),
    queue,
    radar,
    work: buildWork(repos),
    repositories,
    lanes,
    ...(rollout ? { rollout } : {}),
    upstream,
    noise: ignored,
  };
}
