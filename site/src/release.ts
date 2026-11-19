// What the site says about the current release. The version is the extension's own (manifest.json at
// the repository root); the store states change when a listing goes live.
import manifest from "../../manifest.json";

export const VERSION: string = manifest.version;

export type Browser = "chrome" | "firefox" | "safari";

// "pending" until the store listing is live; then set state "live" and the listing URL.
export const STORES: Record<
  Browser,
  { name: string; store: string; state: "live" | "pending"; url?: string }
> = {
  chrome: {
    name: "Chrome",
    store: "Chrome Web Store",
    state: "live",
    url: "https://chromewebstore.google.com/detail/lurk/niknnfeppnikjmdeobipmimojaikecfm",
  },
  firefox: { name: "Firefox", store: "Firefox Add-ons", state: "pending" },
  safari: { name: "Safari", store: "Mac App Store", state: "pending" },
};
