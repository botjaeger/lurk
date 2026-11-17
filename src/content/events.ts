// The page scripts' side of the DOM events they share with content/bridge.ts (isolated world).
// Details cross the boundary as JSON strings: Firefox's Xray wrappers hide object details sent
// from a content script.
import { KINDS, type Kind, type Signals } from "../shared";

/** Tells content/bridge.ts a signal was blocked, for the popup's Stats (kept on this computer). */
export const count = (kind: Kind, key: string) =>
  document.dispatchEvent(new CustomEvent("lurk:count", { detail: JSON.stringify({ kind, key }) }));

/**
 * The live settings, kept up to date from bridge.ts's "lurk:state" events. Until the first one
 * arrives everything is blocked. Announces "lurk:ready" so the bridge sends the state even when it
 * ran first.
 */
export function followState(): Signals {
  const on: Signals = { seen: true, stories: true, typing: true };
  document.addEventListener("lurk:state", (event) => {
    try {
      const next = JSON.parse((event as CustomEvent<string>).detail) as Partial<Signals>;
      for (const key of KINDS) on[key] = next[key] !== false;
    } catch {
      // Malformed state: keep the previous (blocking by default) settings.
    }
  });
  document.dispatchEvent(new CustomEvent("lurk:ready"));
  return on;
}
