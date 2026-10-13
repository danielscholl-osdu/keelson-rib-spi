// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { Day } from "../model/history.ts";

type Section = CanvasBoardView["sections"][number];

export interface KeyEntry {
  label: string;
  tone: CanvasTone;
  hollow?: boolean;
}

export function keyGrid(title: string, entries: readonly KeyEntry[]): Section {
  return {
    kind: "grid",
    title,
    cells: entries.map((e) => ({
      label: e.label,
      badge: { text: e.hollow ? "□" : "■", tone: e.tone },
    })),
  };
}

// Until the host draws an axis under a bar, a lane group's title names the window.
export function spanText(days: readonly { day: Day }[], unit: "cell" | "column"): string {
  const first = days[0]?.day.key;
  return first ? `${first} to today, one ${unit} per UTC day` : `one ${unit} per UTC day`;
}
