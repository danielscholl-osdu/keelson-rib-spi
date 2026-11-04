#!/usr/bin/env bun
// Writes the upstream sync states, built on a recorded 13-fork sweep, as facts files to replay.
//   bun dev/upstream-states.ts [out-dir]
// Then start a Keelson with the three variables it prints; nothing writes while it replays.
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectView } from "@keelson/shared";
import { inspectBoard } from "../src/boards/inspect.ts";
import { INSPECT_KEY } from "../src/keys.ts";
import { UPSTREAM_ITEM } from "../src/model/upstream.ts";
import { Store } from "../src/store.ts";
import { Sweeper } from "../src/sweep.ts";
import { UPSTREAM_SERVICES, UPSTREAM_STATES, upstreamFacts } from "../test/upstream-states.ts";

const out = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "rib-spi-upstream-")));
mkdirSync(out, { recursive: true });

const rolloutFile = join(out, "rollout.json");
writeFileSync(rolloutFile, String(upstreamFacts().fleet.data?.rollout ?? "{}"));
const servicesFile = join(out, "services.json");
copyFileSync(UPSTREAM_SERVICES, servicesFile);

const refuse = async () => ({
  ok: false as const,
  error: "dev/upstream-states.ts reads nothing",
  code: 1,
});
for (const [name, build] of Object.entries(UPSTREAM_STATES)) {
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
  const board = inspectBoard(s.model, { selected: UPSTREAM_ITEM }, s.now());
  expectView(INSPECT_KEY, "board")(board);
  console.log(`${name.padEnd(14)} ${s.model.upstream.mode.padEnd(8)} · ${board.title}`);
}
console.log(`\n${out}`);
console.log(
  `RIB_SPI_SERVICES_FILE=${servicesFile} RIB_SPI_ROLLOUT_FILE=${rolloutFile} RIB_SPI_FACTS_FILE=${join(out, "<state>.json")}`,
);
