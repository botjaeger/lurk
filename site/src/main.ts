import "@fontsource-variable/bricolage-grotesque";
import "./style.css";
import { STORES, VERSION, type Browser } from "./release";

function detectBrowser(): Browser {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("firefox")) return "firefox";
  // Safari's user agent has "safari" but not "chrome"/"chromium"/"edg"; Chrome's has both.
  if (ua.includes("safari") && !/chrome|chromium|crios|edg/.test(ua)) return "safari";
  return "chrome";
}

// Primary buttons name the visitor's browser. While a listing is pending they lead to #get,
// which says where each version stands; once live they go straight to the store.
const browser = detectBrowser();
const entry = STORES[browser];
for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-cta]")) {
  const label = link.querySelector("[data-cta-label]") ?? link;
  if (entry.state === "live" && entry.url) {
    link.href = entry.url;
    label.textContent = `Add to ${entry.name}${link.dataset.ctaSuffix ?? ""}`;
  } else {
    link.href = "#get";
    label.textContent = `Get Lurk for ${entry.name}`;
  }
}

// The "Get Lurk" cards: one per browser, store link when live.
for (const card of document.querySelectorAll<HTMLElement>("[data-store]")) {
  const store = STORES[card.dataset.store as Browser];
  const status = card.querySelector("[data-store-status]");
  const link = card.querySelector<HTMLAnchorElement>("[data-store-link]");
  if (card.dataset.store === browser) card.classList.add("is-yours");
  if (store.state === "live" && store.url && link) {
    link.href = store.url;
    link.hidden = false;
    if (status) status.textContent = `On the ${store.store}`;
  }
}

for (const el of document.querySelectorAll("[data-version]")) el.textContent = `v${VERSION}`;
