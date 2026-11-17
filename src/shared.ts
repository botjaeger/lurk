// Types and small helpers shared by the background worker, the popup and the content scripts. The
// build bundles what each script uses into that script, so nothing is shared at run time.

/** The three signals Lurk hides. */
export type Kind = "seen" | "stories" | "typing";
export const KINDS: readonly Kind[] = ["seen", "stories", "typing"];
export const isKind = (value: unknown): value is Kind => KINDS.includes(value as Kind);

export type Signals = Record<Kind, boolean>;

/** local.stats: counts of hidden signals per app (sites.ts id). */
export interface Stats {
  since: number;
  sites: Partial<Record<string, Partial<Record<Kind, number>>>>;
}

/** Everything Lurk keeps in chrome.storage.local (see AGENTS.md, "Storage"). */
export interface Stored {
  /** Main switch, default true. */
  enabled?: boolean;
  /** Each signal defaults to true (hidden). */
  signals?: Partial<Signals>;
  /** Epoch ms while "Let receipts through" runs. */
  pauseUntil?: number;
  stats?: Stats;
  /** Absent: follow the system. */
  theme?: "light" | "dark";
}

export const readLocal = <K extends keyof Stored>(keys: K[]) =>
  chrome.storage.local.get<Pick<Stored, K>>(keys);

/** content/bridge.ts -> background.ts: one blocked signal, already de-duplicated. */
export interface CountMessage {
  type: "lurk:count";
  kind: Kind;
}
