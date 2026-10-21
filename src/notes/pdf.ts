// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RibExec } from "@keelson/shared";

const MAC_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const PATH_BROWSERS = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
];

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, name);
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}

export function findBrowser(): string | undefined {
  const set = process.env.RIB_SPI_CHROME;
  if (set) return existsSync(set) ? set : undefined;
  if (process.platform === "darwin") {
    const mac = MAC_BROWSERS.find((p) => existsSync(p));
    if (mac) return mac;
  }
  for (const name of PATH_BROWSERS) {
    const p = onPath(name);
    if (p) return p;
  }
  return undefined;
}

export function pdfDir(dataDir: string | undefined): string {
  const set = process.env.RIB_SPI_PDF_DIR;
  if (set) return set;
  const downloads = join(homedir(), "Downloads");
  return existsSync(downloads) ? downloads : join(dataDir ?? homedir(), "release-notes", "pdf");
}

export function pdfName(name: string, approved: boolean): string {
  return `SPI Release Notes ${name}${approved ? "" : " (draft)"}.pdf`;
}

export interface PdfJob {
  html: string;
  name: string;
  approved: boolean;
  workDir: string;
  outDir: string;
}

// Each job gets its own page and throwaway profile, so exports never share a browser.
export async function writePdf(
  exec: RibExec,
  job: PdfJob,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const browser = findBrowser();
  if (!browser)
    return { ok: false, error: "no Chrome, Chromium or Edge found; set RIB_SPI_CHROME" };
  mkdirSync(job.workDir, { recursive: true });
  mkdirSync(job.outDir, { recursive: true });
  const work = mkdtempSync(join(job.workDir, `${job.name}-`));
  try {
    return await print(exec, browser, job, work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function print(
  exec: RibExec,
  browser: string,
  job: PdfJob,
  work: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const page = join(work, `${job.name}.html`);
  writeFileSync(page, job.html);
  const printed = join(work, "out.pdf");
  const res = await exec.runText(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-pdf-header-footer",
      `--user-data-dir=${join(work, "profile")}`,
      `--print-to-pdf=${printed}`,
      pathToFileURL(page).href,
    ],
    { timeoutMs: 90_000, acceptNonZeroExit: true },
  );
  let size = 0;
  try {
    size = statSync(printed).size;
  } catch {
    size = 0;
  }
  if (size === 0) {
    return {
      ok: false,
      error: res.ok ? "the browser wrote no PDF" : `the browser failed: ${res.error}`,
    };
  }
  const out = join(job.outDir, pdfName(job.name, job.approved));
  copyFileSync(printed, out);
  return { ok: true, path: out };
}
