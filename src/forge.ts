// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibExec } from "@keelson/shared";
import { GITLAB_HOST } from "./config.ts";

// Every read goes through the operator's own gh and glab sign-ins. Both
// clients only issue GETs; the rib holds no token of its own.

export class ForgeError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

export interface GqlError {
  type?: string;
  path?: (string | number)[];
  message: string;
}

export interface CallCounter {
  calls: number;
}

export class Gh {
  constructor(
    private readonly exec: RibExec,
    private readonly counter: CallCounter = { calls: 0 },
  ) {}

  async rest<T>(path: string, jq?: string): Promise<T> {
    this.counter.calls++;
    const args = ["api", path];
    if (jq) args.push("--jq", jq);
    const res = await this.exec.runJSON<T>("gh", args, { timeoutMs: 45_000 });
    if (!res.ok) throw new ForgeError(`gh api ${path}: ${res.error}`, res.code);
    return res.data;
  }

  async text(path: string): Promise<string> {
    this.counter.calls++;
    const res = await this.exec.runText("gh", ["api", "--allow-escape-sequences", path], {
      timeoutMs: 60_000,
    });
    if (!res.ok) throw new ForgeError(`gh api ${path}: ${res.error}`, res.code);
    return res.data;
  }

  // A repository that does not exist comes back as a NOT_FOUND error beside the
  // data for the others, and gh exits non-zero, so partial data is kept. GitHub
  // sometimes cuts the response short; gh then exits 1 with nothing on stdout,
  // and one retry nearly always reads it whole.
  async graphql<T>(query: string): Promise<{ data: T; errors: GqlError[] }> {
    let exitCode: number | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      this.counter.calls++;
      const res = await this.exec.runText("gh", ["api", "graphql", "-f", `query=${query}`], {
        timeoutMs: 60_000,
        acceptNonZeroExit: true,
      });
      if (!res.ok) throw new ForgeError(`gh api graphql: ${res.error}`, res.code);
      exitCode = res.exitCode ?? null;
      if (!res.data.trim()) continue;
      let body: { data?: T; errors?: GqlError[] };
      try {
        body = JSON.parse(res.data);
      } catch {
        throw new ForgeError(`gh api graphql: response was not JSON (exit ${res.exitCode})`, null);
      }
      const errors = body.errors ?? [];
      if (!body.data) {
        throw new ForgeError(`gh api graphql: ${errors[0]?.message ?? "no data"}`, null);
      }
      return { data: body.data, errors };
    }
    throw new ForgeError(
      `gh api graphql: GitHub cut the response short twice (exit ${exitCode}, empty response)`,
      exitCode,
    );
  }

  async status(): Promise<{ ok: boolean; detail: string; scopes?: string[] }> {
    const res = await this.exec.runText("gh", ["auth", "status", "--hostname", "github.com"], {
      timeoutMs: 15_000,
      acceptNonZeroExit: true,
    });
    if (!res.ok) return { ok: false, detail: res.error };
    if (res.exitCode !== 0) return { ok: false, detail: "gh is not signed in to github.com" };
    const scopes = tokenScopes(res.data);
    const user = await this.exec.runText("gh", ["api", "user", "--jq", ".login"], {
      timeoutMs: 15_000,
    });
    return {
      ok: true,
      detail: user.ok ? `signed in as ${user.data.trim()}` : "signed in",
      ...(scopes ? { scopes } : {}),
    };
  }
}

export class Glab {
  constructor(
    private readonly exec: RibExec,
    private readonly counter: CallCounter = { calls: 0 },
  ) {}

  async rest<T>(path: string): Promise<T> {
    this.counter.calls++;
    const res = await this.exec.runJSON<T>("glab", ["api", "--hostname", GITLAB_HOST, path], {
      timeoutMs: 45_000,
    });
    if (!res.ok) throw new ForgeError(`glab api ${path}: ${res.error}`, res.code);
    return res.data;
  }

  async status(): Promise<{ ok: boolean; detail: string }> {
    const res = await this.exec.runText("glab", ["auth", "status", "--hostname", GITLAB_HOST], {
      timeoutMs: 15_000,
      acceptNonZeroExit: true,
    });
    if (!res.ok) return { ok: false, detail: res.error };
    return res.exitCode === 0
      ? { ok: true, detail: `signed in to ${GITLAB_HOST}` }
      : { ok: false, detail: `glab is not signed in to ${GITLAB_HOST}` };
  }
}

// "- Token scopes: 'gist', 'repo', 'workflow'"; a fine-grained token lists none.
export function tokenScopes(statusText: string): string[] | undefined {
  const line = /Token scopes:\s*(.*)$/m.exec(statusText)?.[1];
  if (!line) return undefined;
  const scopes = [...line.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? "").filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

export function encodeProject(path: string): string {
  return encodeURIComponent(path);
}
