// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibSurfaceDescriptor } from "@keelson/shared";
import { BADGE_KEY, CONSOLE_KEY, SURFACE_ID } from "./keys.ts";

export const REFRESH_ACTION = "refresh";
export const INSPECT_ACTION = "inspect";

// The console is the whole tab: it says what needs a person and why, and every
// selection opens the side inspector. The rib drives refresh in-process, so no region
// names a workflow.
export const SURFACES: readonly RibSurfaceDescriptor[] = [
  {
    id: SURFACE_ID,
    title: "SPI",
    heading: "Azure OSDU SPI",
    subtitle:
      "Each service as one line from its upstream GitLab project, through its GitHub fork, to the shared stack.",
    badgeKey: BADGE_KEY,
    layout: {
      banner: {
        key: CONSOLE_KEY,
        title: "Console",
        glyph: { char: "⚑", tone: "caution" },
        live: true,
        headActions: [{ type: REFRESH_ACTION, label: "Refresh now" }],
      },
      rows: [],
    },
  },
];
