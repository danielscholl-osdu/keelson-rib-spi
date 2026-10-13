// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { type CanvasBoardView, z } from "@keelson/shared";

type ActionsSection = Extract<CanvasBoardView["sections"][number], { kind: "actions" }>;
export type ActionItem = ActionsSection["items"][number];

export const ACT_ACTION = "act";

// What a verb writes to, as the board saw it when it drew the button. `sha` and
// `state` are what revalidation compares; a target without them is not re-checked.
// A run's `pr` makes `sha` that PR's head, so a push after the draw refuses it.
export const targetSchema = z
  .object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    kind: z.enum(["pr", "run", "issue", "repo", "workflow"]),
    number: z.number().int().positive().optional(),
    pr: z.number().int().positive().optional(),
    sha: z.string().optional(),
    state: z.string().optional(),
    label: z.string().min(1),
  })
  .strict();
export type Target = z.infer<typeof targetSchema>;

export const bindingSchema = z
  .object({
    verb: z.string().min(1),
    item: z.string().min(1),
    swept: z.string().min(1),
    targets: z.array(targetSchema).min(1),
  })
  .strict();
export type Binding = z.infer<typeof bindingSchema>;

export interface Verb {
  id: string;
  label: string;
  // The gh arguments that write to one target, shown verbatim in the confirmation.
  command(target: Target): string[];
}

// Why no verb can write now, before any one verb's own reason.
export function writeBlocked(sweptAt: string | undefined, scopes: string[] | undefined) {
  if (!sweptAt) return "no sweep has read GitHub yet";
  if (scopes && !scopes.includes("repo")) {
    return "gh's token lacks the repo scope; run gh auth refresh -s repo";
  }
  return undefined;
}

const VERBS = new Map<string, Verb>();

export function registerVerb(verb: Verb): () => void {
  if (VERBS.has(verb.id)) throw new Error(`verb ${verb.id} is already registered`);
  VERBS.set(verb.id, verb);
  return () => {
    VERBS.delete(verb.id);
  };
}

export function verbOf(id: string): Verb | undefined {
  return VERBS.get(id);
}

function quote(arg: string): string {
  return /^[\w./:=@#-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

export function commandText(verb: Verb, target: Target): string {
  return ["gh", ...verb.command(target)].map(quote).join(" ");
}

export interface ButtonOptions {
  primary?: boolean;
  disabled?: string;
  label?: string;
  title?: string;
  // Sentences the operator weighs before the commands; the host collapses line breaks.
  detail?: string[];
  // Typed before confirm enables, for a write that is hard to take back.
  subject?: { value: string; label: string };
}

// The button an inspector draws: the binding rides outside the payload so no form
// field can overwrite it, and the confirmation lists the exact command per target.
export function verbAction(
  verb: Verb,
  binding: Omit<Binding, "verb">,
  opts: ButtonOptions = {},
): ActionItem {
  const n = binding.targets.length;
  const commands = binding.targets.map((t) => commandText(verb, t));
  const label = opts.label ?? (n > 1 ? `${verb.label} ${n}` : verb.label);
  return {
    type: ACT_ACTION,
    label,
    ...(opts.primary ? { tone: "accent" as const } : {}),
    binding: { ...binding, verb: verb.id },
    ...(opts.disabled
      ? { disabled: true, reason: opts.disabled }
      : {
          confirm: {
            title:
              opts.title ??
              (n > 1
                ? `${verb.label} · ${n} targets`
                : `${verb.label} · ${binding.targets[0]?.label}`),
            body: [
              ...(opts.detail?.length ? [opts.detail.join(" ")] : []),
              `Calls: ${commands.join("; ")}.`,
              "Each target is read again first; one that changed since the board drew it is skipped and named in the result.",
            ].join("\n\n"),
            confirmLabel: label,
            ...(opts.subject
              ? { irreversible: true, subject: opts.subject.value, label: opts.subject.label }
              : {}),
          },
        }),
  };
}
