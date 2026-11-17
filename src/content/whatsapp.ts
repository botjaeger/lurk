// Runs in WhatsApp Web's own JavaScript world (MAIN), before its scripts.
//
// WhatsApp Web sends every stanza as a binary node, encrypted with AES-GCM (the Noise transport)
// through crypto.subtle.encrypt, over one WebSocket. Nothing about a read receipt is visible on the
// network, so Lurk looks at each outgoing node just before it is encrypted and swaps one token byte:
//
// - Seen:    <receipt type="read"> and type="played" (voice notes) become type="inactive", an
//            ordinary delivery receipt the server acknowledges as usual.
// - Stories: the same, for receipts sent to status@broadcast.
// - Typing:  <chatstate><composing/></chatstate> (typing, or recording with media="audio") becomes
//            <paused/>, which is what the app sends when you stop typing.
//
// One byte for one byte, so the frame keeps its length, the server answers normally and nothing
// waits on a missing reply. "read-self" (tells your own phone you read it) is left alone: the
// sender never sees it.
//
// Newer WhatsApp builds may run the socket in a Web Worker, out of reach of page scripts. The
// app's own WAWebCommsGating.isCommsInWorker switch is set to false so the socket stays here.
//
// The node layout (list header, tag, attribute pairs, children; token and JID encodings) follows
// the WABinary decoder in WhiskeySockets/Baileys (MIT, https://github.com/WhiskeySockets/Baileys).
import { count, followState } from "./events";

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

interface WaNode {
  tag: string;
  /** Offset of the tag's first byte. */
  tagAt: number;
  /** `at` is the offset of a value's first byte, so a single-byte token can be swapped in place. */
  attrs: Record<string, { value: string; at: number } | undefined>;
  children: WaNode[];
}

function patch() {
  const on = followState();

  // Single-byte token numbers (index in WhatsApp's token table).
  const T = {
    receipt: 7,
    type: 4,
    id: 8,
    to: 17,
    read: 42,
    played: 202,
    inactive: 198,
    chatstate: 46,
    composing: 52,
    paused: 154,
    status: 11,
    broadcast: 13,
  };
  const tok = (n: number) => `#${n}`;
  const STATUS_JID = `${tok(T.status)}@${tok(T.broadcast)}`;
  const utf8 = new TextDecoder();

  // Reads a string at b[p]; returns [value, next]. Tokens come back as "#n" ("#dK:n" for the
  // two-byte tables), which is all the matching below needs.
  function readString(b: Uint8Array, p: number): [string, number] {
    const tag = b[p++];
    if (tag >= 1 && tag < 236) return [tok(tag), p];
    switch (tag) {
      case 0:
        return ["", p];
      case 236:
      case 237:
      case 238:
      case 239:
        return [`#d${tag - 236}:${b[p]}`, p + 1];
      case 252: // BINARY_8
        return [utf8.decode(b.subarray(p + 1, p + 1 + b[p])), p + 1 + b[p]];
      case 253: {
        // BINARY_20
        const n = ((b[p] & 15) << 16) | (b[p + 1] << 8) | b[p + 2];
        return [utf8.decode(b.subarray(p + 3, p + 3 + n)), p + 3 + n];
      }
      case 254: {
        // BINARY_32
        const n = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
        return [utf8.decode(b.subarray(p + 4, p + 4 + n)), p + 4 + n];
      }
      case 250: {
        // JID_PAIR: user, server
        const [user, q] = readString(b, p);
        const [server, r] = readString(b, q);
        return [`${user}@${server}`, r];
      }
      case 247: {
        // AD_JID: domain type, device, user
        const [user, q] = readString(b, p + 2);
        return [`${user}:${b[p + 1]}@ad${b[p]}`, q];
      }
      case 246: {
        // FB_JID: user, 2-byte device, server
        const [user, q] = readString(b, p);
        const [server, r] = readString(b, q + 2);
        return [`${user}@${server}`, r];
      }
      case 245: {
        // INTEROP_JID: user, 2-byte device, 2-byte integrator, optional server
        const [user, q] = readString(b, p);
        let r = q + 4;
        let server = "interop";
        try {
          [server, r] = readString(b, r);
        } catch {
          r = q + 4;
        }
        return [`${user}@${server}`, r];
      }
      case 251: // HEX_8
      case 255: // NIBBLE_8
        return ["<packed>", p + 1 + (b[p] & 127)];
      default:
        throw new Error("lurk: unknown string tag");
    }
  }

  function listSize(b: Uint8Array, p: number): [number, number] {
    const tag = b[p];
    if (tag === 0) return [0, p + 1];
    if (tag === 248) return [b[p + 1], p + 2];
    if (tag === 249) return [(b[p + 1] << 8) | b[p + 2], p + 3];
    return [-1, p];
  }

  // Parses one node at b[p]; `end` is the offset just past it.
  function readNode(b: Uint8Array, p: number): { node: WaNode; end: number } {
    const [size, q] = listSize(b, p);
    if (size < 1) throw new Error("lurk: not a node");
    p = q;
    const tagAt = p;
    const [tag, afterTag] = readString(b, p);
    p = afterTag;
    const attrs: WaNode["attrs"] = {};
    for (let i = 0; i < (size - 1) >> 1; i++) {
      const [key, k] = readString(b, p);
      const at = k;
      const [value, v] = readString(b, k);
      attrs[key] = { value, at };
      p = v;
    }
    const children: WaNode[] = [];
    if (size % 2 === 0) {
      const [count, c] = listSize(b, p);
      if (count >= 0) {
        p = c;
        for (let i = 0; i < count; i++) {
          const child = readNode(b, p);
          children.push(child.node);
          p = child.end;
        }
      } else if (b[p] === 252) p += 2 + b[p + 1];
      else if (b[p] === 253) p += 4 + (((b[p + 1] & 15) << 16) | (b[p + 2] << 8) | b[p + 3]);
      else if (b[p] === 254)
        p += 5 + (((b[p + 1] << 24) | (b[p + 2] << 16) | (b[p + 3] << 8) | b[p + 4]) >>> 0);
      else [, p] = readString(b, p);
    }
    return { node: { tag, tagAt, attrs, children }, end: p };
  }

  // Returns a copy of the plaintext with blocked signals swapped, or null to send it as is.
  function editStanza(bytes: Uint8Array) {
    // Byte 0 is the frame flag (0 = uncompressed node); compressed nodes are never receipts.
    if (bytes.length < 4 || bytes[0] !== 0 || (bytes[1] !== 248 && bytes[1] !== 249)) return null;
    const { node } = readNode(bytes, 1);
    let out: Uint8Array<ArrayBuffer> | null = null;
    const swap = (at: number, value: number) => {
      out ??= bytes.slice();
      out[at] = value;
    };
    if (node.tag === tok(T.receipt)) {
      const type = node.attrs[tok(T.type)];
      if (type && (type.value === tok(T.read) || type.value === tok(T.played))) {
        const toStatus = node.attrs[tok(T.to)]?.value === STATUS_JID;
        const kind = toStatus ? "stories" : "seen";
        if (on[kind]) {
          swap(type.at, T.inactive);
          count(kind, `${node.attrs[tok(T.to)]?.value}:${node.attrs[tok(T.id)]?.value}`);
        }
      }
    } else if (node.tag === tok(T.chatstate) && on.typing) {
      for (const child of node.children) {
        if (child.tag === tok(T.composing)) {
          swap(child.tagAt, T.paused);
          count("typing", "chatstate");
        }
      }
    }
    return out;
  }

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
      if (bytes) edited = editStanza(bytes);
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
