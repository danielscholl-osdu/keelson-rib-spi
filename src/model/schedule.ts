// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Five-field cron as GitHub Actions reads it: UTC, with day-of-month and
// day-of-week OR'ed when both are restricted.
export interface Cron {
  text: string;
  minutes: number[];
  hours: number[];
  dom?: Set<number>;
  months?: Set<number>;
  dow?: Set<number>;
}

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

function value(token: string, names?: string[], base = 0): number {
  const named = names?.indexOf(token.toLowerCase()) ?? -1;
  return named >= 0 ? named + base : Number(token);
}

function field(
  text: string,
  min: number,
  max: number,
  names?: string[],
  base = 0,
): number[] | undefined {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return undefined;
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a = "", b] = range.split("-");
      lo = value(a, names, base);
      hi = b === undefined ? (stepText === undefined ? lo : max) : value(b, names, base);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi)
      return undefined;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(text: string): Cron | undefined {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [m = "", h = "", dom = "", mon = "", dow = ""] = parts;
  const minutes = field(m, 0, 59);
  const hours = field(h, 0, 23);
  const doms = field(dom, 1, 31);
  const months = field(mon, 1, 12, MONTH_NAMES, 1);
  const dows = field(dow, 0, 7, DAY_NAMES)?.map((d) => d % 7);
  if (!minutes || !hours || !doms || !months || !dows) return undefined;
  return {
    text,
    minutes,
    hours,
    ...(dom === "*" ? {} : { dom: new Set(doms) }),
    ...(mon === "*" ? {} : { months: new Set(months) }),
    ...(dow === "*" ? {} : { dow: new Set(dows) }),
  };
}

// Whether the cron fires on the UTC day that starts at `dayStart`.
export function firesOn(cron: Cron, dayStart: number): boolean {
  const d = new Date(dayStart);
  if (cron.months && !cron.months.has(d.getUTCMonth() + 1)) return false;
  const byDom = cron.dom?.has(d.getUTCDate());
  const byDow = cron.dow?.has(d.getUTCDay());
  if (cron.dom && cron.dow) return !!(byDom || byDow);
  if (cron.dom) return !!byDom;
  if (cron.dow) return !!byDow;
  return true;
}

// The first time the cron fires on that UTC day, or undefined.
export function firstFire(cron: Cron, dayStart: number): number | undefined {
  if (!firesOn(cron, dayStart)) return undefined;
  return dayStart + ((cron.hours[0] ?? 0) * 60 + (cron.minutes[0] ?? 0)) * 60_000;
}

const DAY_MS = 86_400_000;

export function nextFire(crons: readonly Cron[], now: Date): number | undefined {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  for (let i = 0; i < 9; i++) {
    const day = today + i * DAY_MS;
    const times = crons
      .filter((c) => firesOn(c, day))
      .flatMap((c) => c.hours.flatMap((h) => c.minutes.map((m) => day + (h * 60 + m) * 60_000)))
      .filter((t) => t > now.getTime())
      .sort((a, b) => a - b);
    if (times[0] !== undefined) return times[0];
  }
  return undefined;
}

// Every fire time in [from, to), oldest first.
export function firesBetween(crons: readonly Cron[], from: number, to: number): number[] {
  const out: number[] = [];
  for (let day = Math.floor(from / DAY_MS) * DAY_MS; day < to; day += DAY_MS) {
    for (const c of crons) {
      if (!firesOn(c, day)) continue;
      for (const h of c.hours)
        for (const m of c.minutes) {
          const t = day + (h * 60 + m) * 60_000;
          if (t >= from && t < to) out.push(t);
        }
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Weekdays as a reader says them: "daily", "weekdays", "Sun-Thu", "Mon,Wed".
function dayNames(days: readonly number[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b);
  if (set.length === 7) return "daily";
  if (set.join(",") === "1,2,3,4,5") return "weekdays";
  for (let r = 0; r < 7 && set.length >= 3; r++) {
    const run = set.map((d) => (d - r + 7) % 7).sort((a, b) => a - b);
    if (run.every((d, i) => d === (run[0] as number) + i)) {
      const lo = ((run[0] as number) + r) % 7;
      const hi = ((run[run.length - 1] as number) + r) % 7;
      return `${SHORT[lo]}-${SHORT[hi]}`;
    }
  }
  return set.map((d) => SHORT[d]).join(",");
}

// "daily 03:00", "Sun-Thu 23:00" in local time, read from the week after `now`
// so a daylight-time change moves the label with it.
export function cadence(
  crons: readonly Cron[],
  unscheduled = "unscheduled",
  now: Date = new Date(),
): string {
  const cron = crons[0];
  if (!cron) return unscheduled;
  if (cron.dom || cron.months) return "scheduled";
  const fires = firesBetween([cron], now.getTime(), now.getTime() + 7 * DAY_MS).map(
    (t) => new Date(t),
  );
  const times = new Set(fires.map((d) => `${two(d.getHours())}:${two(d.getMinutes())}`));
  const time = times.size === 1 ? [...times][0] : "several times";
  return `${dayNames(fires.map((d) => d.getDay()))} ${time}`;
}

export function toCrons(texts: readonly string[] | undefined): Cron[] {
  return (texts ?? []).flatMap((t) => {
    const c = parseCron(t);
    return c ? [c] : [];
  });
}
