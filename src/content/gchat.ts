// Runs in Google Chat's own JavaScript world (MAIN). It blocks nothing: rules.json and
// rules-typing.json do that on the network. It only notices when Chat tries to send a receipt or a
// typing update, so the popup's Stats can count it (on this computer only). Chat retries a blocked
// receipt about 18 times; content/bridge.ts counts those repeats once.
import { count } from "./events";

const RECEIPT = /\/api\/mark_group_readstate([?]|$)/;
const TYPING = /\/_\/DynamiteWebUi\/data\/batchexecute[?](.*&)?rpcids=uQwtvc(&|$)/;

const textOf = (body: unknown) =>
  typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : "";

function notice(url: string, body: unknown) {
  if (RECEIPT.test(url)) count("seen", textOf(body).slice(0, 300) || url);
  else if (TYPING.test(url)) count("typing", "chat");
}

const urlOf = (input: unknown) =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : String((input as { url?: unknown } | null)?.url ?? "");

const nativeFetch = window.fetch;
window.fetch = function fetch(this: unknown, ...args: Parameters<typeof nativeFetch>) {
  try {
    notice(urlOf(args[0]), args[1]?.body);
  } catch {
    // Counting must never get in the way of the request.
  }
  return nativeFetch.apply(this, args);
};

const urls = new WeakMap<XMLHttpRequest, string>();
const nativeOpen = XMLHttpRequest.prototype.open;
const nativeSend = XMLHttpRequest.prototype.send;
// Arguments are passed on exactly as given: open(method, url, undefined) would make the request
// synchronous.
XMLHttpRequest.prototype.open = function open(this: XMLHttpRequest, ...args: unknown[]) {
  urls.set(this, String(args[1]));
  nativeOpen.apply(this, args as Parameters<typeof nativeOpen>);
};
XMLHttpRequest.prototype.send = function send(this: XMLHttpRequest, ...args: unknown[]) {
  try {
    notice(urls.get(this) || "", args[0]);
  } catch {
    // Counting must never get in the way of the request.
  }
  nativeSend.apply(this, args as Parameters<typeof nativeSend>);
};

const nativeBeacon = navigator.sendBeacon?.bind(navigator);
if (nativeBeacon) {
  navigator.sendBeacon = function sendBeacon(...args: Parameters<typeof nativeBeacon>) {
    try {
      notice(String(args[0]), args[1]);
    } catch {
      // ignore
    }
    return nativeBeacon(...args);
  };
}
