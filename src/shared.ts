// Types and small helpers shared by the background worker, the popup and the content scripts. The
// build bundles what each script uses into that script, so nothing is shared at run time.

/** The three signals Lurk hides. */
export type Kind = "seen" | "stories" | "typing";
export const KINDS: readonly Kind[] = ["seen", "stories", "typing"];
export const isKind = (value: unknown): value is Kind => KINDS.includes(value as Kind);

export type Signals = Record<Kind, boolean>;

/** How the popup's status and the toolbar title name each signal. */
export const KIND_WORDS: Record<Kind, string> = {
  seen: "Seen",
  stories: "story views",
  typing: "typing",
};

/** "a", "a and b", "a, b and c". */
export const listWords = (words: string[]) =>
  words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

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

/** The stored keys that change what is blocked (a change re-applies them; stats and theme do not). */
export const SETTINGS = ["enabled", "signals", "pauseUntil"] as const;
export const isSetting = (key: string) => (SETTINGS as readonly string[]).includes(key);

export const readLocal = <K extends keyof Stored>(keys: K[]) =>
  chrome.storage.local.get<Pick<Stored, K>>(keys);

/** content/bridge.ts -> background.ts: one blocked signal, already de-duplicated. */
export interface CountMessage {
  type: "lurk:count";
  kind: Kind;
}

/** How long "Let receipts through" lets them through. */
export const PAUSE_MS = 10_000;

/**
 * popup -> background.ts. Writes that read before they write (a new pause, a stats reset) run on
 * the worker's queue, so they never interleave with the worker's own writes to the same key.
 */
export type PopupMessage = { type: "lurk:pause" } | { type: "lurk:reset-stats" };
