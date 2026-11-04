#!/usr/bin/env bun
// Writes the rollout states a live sweep cannot show yet as facts files to replay.
//   bun dev/states.ts [out-dir]
// Then start a Keelson with the three variables it prints; nothing writes while it replays.
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectView } from "@keelson/shared";
import { inspectBoard } from "../src/boards/inspect.ts";
import type { Facts } from "../src/facts.ts";
import { INSPECT_KEY } from "../src/keys.ts";
import { Store } from "../src/store.ts";
import { Sweeper } from "../src/sweep.ts";
import {
  doneFacts,
  environmentFacts,
  heldFacts,
  readyFacts,
  rollingFacts,
  stoppedFacts,
} from "../test/states.ts";

const out = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "rib-spi-states-")));
mkdirSync(out, { recursive: true });

const rollout = {
  schema: 1,
  lanes: 2,
  ordering: [
    {
      service: "file",
      after: ["legal", "schema"],
      reason: "a stand-in for search after storage and indexer",
    },
  ],
};
const rolloutFile = join(out, "rollout.json");
writeFileSync(rolloutFile, `${JSON.stringify(rollout, null, 2)}\n`);
const servicesFile = join(out, "services.json");
copyFileSync(new URL("../test/fixtures/services.json", import.meta.url).pathname, servicesFile);

const states: Record<string, () => Facts> = {
  ready: readyFacts,
  rolling: rollingFacts,
  stopped: stoppedFacts,
  environment: environmentFacts,
  held: heldFacts,
  done: doneFacts,
};

const refuse = async () => ({ ok: false as const, error: "dev/states.ts reads nothing", code: 1 });
for (const [name, build] of Object.entries(states)) {
  const file = join(out, `${name}.json`);
  writeFileSync(file, JSON.stringify(build()));
  const s = new Sweeper({
    exec: { runJSON: refuse, runText: refuse } as never,
    store: new Store(mkdtempSync(join(tmpdir(), "rib-spi-replay-"))),
    onChange: () => {},
    replay: file,
    fleetFiles: { services: servicesFile, rollout: rolloutFile },
  });
  await s.sweep();
  const r = s.model.rollout;
  const board = inspectBoard(s.model, { selected: "rollout" }, s.now());
  expectView(INSPECT_KEY, "board")(board);
  console.log(`${name.padEnd(12)} ${r?.phase ?? "none"} · next ${r?.next ?? "-"} · ${board.title}`);
}
console.log(`\n${out}`);
console.log(
  `RIB_SPI_SERVICES_FILE=${servicesFile} RIB_SPI_ROLLOUT_FILE=${rolloutFile} RIB_SPI_FACTS_FILE=${join(out, "<state>.json")}`,
);
