// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibSurfaceBadge } from "@keelson/shared";
import type { Model } from "../model/index.ts";
import { plural } from "../util.ts";

export function verdictLabel(model: Model): string {
  const { verdict, incidents } = model.queue;
  if ((verdict === "BLOCKED" || verdict === "ATTENTION") && incidents > 0) {
    return `${verdict} · ${plural(incidents, "INCIDENT", "INCIDENTS")}`;
  }
  return verdict;
}

export function badge(model: Model): RibSurfaceBadge {
  if (!model.measured) return { count: 0 };
  const { p0, p1 } = model.queue.counts;
  const count = p0 + p1;
  return count > 0 ? { count, title: `SPI · ${p0} P0 · ${p1} P1` } : { count: 0 };
}
