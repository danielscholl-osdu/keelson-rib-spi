// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

export const RIB_ID = "spi";
export const SURFACE_ID = "spi";

export const ATTENTION_KEY = "rib:spi:attention";
export const BADGE_KEY = "rib:spi:badge";
export const STACK_KEY = "rib:spi:stack";
export const ENGINEERING_KEY = "rib:spi:engineering";
export const RADAR_KEY = "rib:spi:radar";
export const LINES_KEY = "rib:spi:lines";
// The side inspector has no region; an inspect action opens it in the canvas drawer.
export const INSPECT_KEY = "rib:spi:inspect";

export const BOARD_KEYS = [
  ATTENTION_KEY,
  STACK_KEY,
  ENGINEERING_KEY,
  RADAR_KEY,
  LINES_KEY,
] as const;
