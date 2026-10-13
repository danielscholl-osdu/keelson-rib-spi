// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibSurfaceDescriptor } from "@keelson/shared";
import {
  ATTENTION_KEY,
  BADGE_KEY,
  ENGINEERING_KEY,
  LINES_KEY,
  STACK_KEY,
  SURFACE_ID,
} from "./keys.ts";

export const REFRESH_ACTION = "refresh";
export const INSPECT_ACTION = "inspect";

// The banner holds everything that needs a person, so its pill is the tab's
// verdict. The environment and the engineering system sit above the services
// because each is one shared input every line depends on. The rib drives refresh in-process, so no region names a workflow.
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
        key: ATTENTION_KEY,
        title: "Needs attention",
        glyph: { char: "⚑", tone: "caution" },
        live: true,
        headActions: [{ type: REFRESH_ACTION, label: "Refresh now" }],
      },
      rows: [
        {
          columns: [
            {
              key: STACK_KEY,
              title: "Environment",
              byline: "shared · osdu-spi-stack · where every fork lane deploys",
              glyph: { char: "◎", tone: "info" },
              live: true,
            },
          ],
        },
        {
          columns: [
            {
              key: ENGINEERING_KEY,
              title: "Engineering system",
              byline: "osdu-spi · the workflows, actions and images every fork runs",
              glyph: { char: "⚙", tone: "brand" },
              live: true,
            },
          ],
        },
        {
          columns: [
            {
              key: LINES_KEY,
              title: "Services",
              byline: "one line per fork, from upstream GitLab to the shared environment",
              glyph: { char: "⫶", tone: "brand" },
              live: true,
            },
          ],
        },
      ],
    },
  },
];
