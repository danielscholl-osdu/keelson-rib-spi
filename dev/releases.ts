// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// One live release read, then one month's notes as html and PDF. Usage:
//   bun dev/releases.ts [YYYY-MM] [out-dir]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runJSON, runText } from "@keelson/shared/exec";
import { expectHtml } from "../src/boards/console.ts";
import { releaseDocHtml, releasePrintHtml } from "../src/boards/release.ts";
import { releaseDoc } from "../src/brief/release.ts";
import { ReleaseReader } from "../src/collect/releases.ts";
import { Gh } from "../src/forge.ts";
import { monthFacts, releaseMonths } from "../src/model/releases.ts";
import { notesDir, readNotes } from "../src/notes/file.ts";
import { writePdf } from "../src/notes/pdf.ts";
import { Store } from "../src/store.ts";

const now = new Date();
const month = process.argv[2] ?? now.toISOString().slice(0, 7);
const out = process.argv[3] ?? join(process.cwd(), ".releases");
mkdirSync(out, { recursive: true });
const exec = { runJSON, runText };
const reader = new ReleaseReader(new Gh(exec), new Store(out), () => now);
const t0 = Date.now();
await reader.read({ force: true });
console.log(`read in ${Date.now() - t0} ms; errors: ${JSON.stringify(reader.data.errors)}`);
console.log(`months: ${releaseMonths(reader.data, now).join(", ")}`);
const doc = releaseDoc(
  monthFacts(reader.data, month, now),
  readNotes(process.env.RIB_SPI_NOTES_DIR ? notesDir(undefined) : out, month),
  now,
);
const screen = releaseDocHtml(doc);
expectHtml(screen);
writeFileSync(join(out, `${month}.html`), screen);
console.log(`${doc.name}: ${doc.headline} (${screen.length} bytes, notes ${doc.notes})`);
const pdf = await writePdf(exec, {
  html: releasePrintHtml(doc),
  name: doc.name,
  approved: doc.notes === "approved",
  workDir: join(out, "print"),
  outDir: out,
});
console.log(pdf.ok ? `pdf: ${pdf.path}` : `pdf failed: ${pdf.error}`);
