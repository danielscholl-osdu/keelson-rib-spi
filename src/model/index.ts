// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { FORKS, PLANNED, type ServiceDef, STACK_REPO, TEMPLATE_REPO } from "../config.ts";
import type { Facts } from "../facts.ts";
import { buildLine, type LineModel } from "./lines.ts";
import { buildQueue, type Queue } from "./queue.ts";
import { buildStack, type StackModel } from "./stack.ts";
import { buildTemplate, type TemplateModel } from "./template.ts";

export interface Model {
  measured: boolean;
  sweptAt?: string;
  stack: StackModel;
  lines: LineModel[];
  planned: { service: ServiceDef; exists: boolean }[];
  template: TemplateModel;
  queue: Queue;
}

// Pure: the same facts and clock always give the same model, so every region
// and every tool counts the same things.
export function buildModel(facts: Facts, now: Date): Model {
  const repos = facts.github.data?.repos ?? {};
  const details = facts.details.data ?? {};
  const stack = buildStack(repos[STACK_REPO], facts.lifecycle.data, now);
  const lines = FORKS.map((fork) =>
    buildLine({
      fork,
      repo: repos[fork.repo],
      runs: facts.runs.data?.[fork.repo],
      upstream: facts.upstream.data?.[fork.id],
      compares: facts.template.data?.compares ?? {},
      targets: facts.template.data?.targets ?? {},
      templateHead: repos[TEMPLATE_REPO]?.head,
      details,
      stack,
      now,
    }),
  );
  const template = buildTemplate(repos[TEMPLATE_REPO], facts.template.data, lines);
  const queue = buildQueue({
    stack,
    lines,
    template,
    repos,
    details,
    approvals: facts.approvals.data,
    now,
  });
  return {
    measured: facts.github.data !== undefined,
    sweptAt: facts.sweep?.at,
    stack,
    lines,
    planned: PLANNED.map((service) => ({
      service,
      exists: facts.github.data?.planned[service.id] ?? false,
    })),
    template,
    queue,
  };
}
