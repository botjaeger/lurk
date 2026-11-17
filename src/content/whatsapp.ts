// Runs in WhatsApp Web's own JavaScript world (MAIN), before its scripts.
//
// WhatsApp Web sends every stanza as a binary node, encrypted with AES-GCM (the Noise transport)
// through crypto.subtle.encrypt, over one WebSocket. Nothing about a read receipt is visible on the
// network, so Lurk looks at each outgoing node just before it is encrypted and swaps one token byte
// (read receipt -> delivery receipt, composing -> paused; the parser and edits are in wabinary.ts).
//
// One byte for one byte, so the frame keeps its length, the server answers normally and nothing
// waits on a missing reply. "read-self" (tells your own phone you read it) is left alone: the
// sender never sees it.
//
// Newer WhatsApp builds may run the socket in a Web Worker, out of reach of page scripts. The
// app's own WAWebCommsGating.isCommsInWorker switch is set to false so the socket stays here.
import { count, followState } from "./events";
import { editStanza } from "./wabinary";

interface WhatsAppWindow {
  __lurkWhatsApp?: boolean;
  __onAfterModuleFactory?: (module: { exports?: unknown } | undefined) => unknown;
  require?: (name: string) => unknown;
}
const page = window as unknown as WhatsAppWindow;
if (!page.__lurkWhatsApp) {
  Object.defineProperty(window, "__lurkWhatsApp", { value: true });
  patch();
}

function patch() {
  const on = followState();

  const toBytes = (data: unknown) =>
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : null;

  const subtle = crypto.subtle;
  const nativeEncrypt = subtle.encrypt;
  subtle.encrypt = function encrypt(this: SubtleCrypto, ...args: Parameters<typeof nativeEncrypt>) {
    const [algorithm, key, data] = args;
    let edited: ReturnType<typeof editStanza> = null;
    try {
      const name = typeof algorithm === "string" ? algorithm : algorithm?.name;
      const bytes = name === "AES-GCM" ? toBytes(data) : null;
      if (bytes) edited = editStanza(bytes, on, count);
    } catch {
      edited = null; // not a node (handshake, other data): leave it alone
    }
    return nativeEncrypt.call(this, algorithm, key, edited ?? data);
  };

  // ---- Keep the socket on the page (WAWebCommsGating) -------------------------------------------
  interface Gating {
    isCommsInWorker: () => boolean;
  }
  const isGating = (exports: unknown): exports is Gating => {
    try {
      const fn = (exports as Partial<Gating> | null)?.isCommsInWorker;
      return typeof fn === "function" && String(fn).includes("worker");
    } catch {
      return false;
    }
  };
  let gated = false;
  const gate = (exports: unknown) => {
    if (gated || !isGating(exports)) return;
    exports.isCommsInWorker = () => false;
    gated = true;
  };
  // The module system calls window.__onAfterModuleFactory(module) after building each module.
  let chained: unknown = null;
  try {
    Object.defineProperty(window, "__onAfterModuleFactory", {
      configurable: true,
      get: () => (module: { exports?: unknown } | undefined) => {
        try {
          if (module) gate(module.exports);
        } catch {
          // ignore
        }
        if (typeof chained === "function") return (chained as (m: unknown) => unknown)(module);
      },
      set: (fn: unknown) => {
        chained = fn;
      },
    });
  } catch {
    // Property already locked by the page; the require() fallback below still runs.
  }
  const started = Date.now();
  const poll = setInterval(() => {
    try {
      if (!gated && typeof page.require === "function") gate(page.require("WAWebCommsGating"));
    } catch {
      // Module not defined yet.
    }
    if (gated || Date.now() - started > 60_000) clearInterval(poll);
  }, 50);
}
