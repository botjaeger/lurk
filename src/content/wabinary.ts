// WhatsApp Web's binary nodes, as content/whatsapp.ts sees them just before encryption: a reader for
// the node layout and the one-byte edits that hide a signal. Pure functions, unit-tested in
// tests/wabinary.test.ts.
//
// - Seen:    <receipt type="read"> and type="played" (voice notes) become type="inactive", an
//            ordinary delivery receipt the server acknowledges as usual.
// - Stories: the same, for receipts sent to status@broadcast.
// - Typing:  <chatstate><composing/></chatstate> (typing, or recording with media="audio") becomes
//            <paused/>, which is what the app sends when you stop typing.
//
// The node layout (list header, tag, attribute pairs, children; token and JID encodings) follows the
// WABinary decoder in WhiskeySockets/Baileys (MIT, https://github.com/WhiskeySockets/Baileys).
import type { Signals } from "../shared";
import type { Report } from "./frames";

export interface WaNode {
  tag: string;
  /** Offset of the tag's first byte. */
  tagAt: number;
  /** `at` is the offset of a value's first byte, so a single-byte token can be swapped in place. */
  attrs: Record<string, { value: string; at: number } | undefined>;
  children: WaNode[];
}

/** Single-byte token numbers (index in WhatsApp's token table). */
export const T = {
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
/** How readString returns a single-byte token. */
export const tok = (n: number) => `#${n}`;
const STATUS_JID = `${tok(T.status)}@${tok(T.broadcast)}`;
const utf8 = new TextDecoder();

/**
 * Reads a string at b[p]; returns [value, next]. Tokens come back as "#n" ("#dK:n" for the two-byte
 * tables), which is all the matching below needs.
 */
export function readString(b: Uint8Array, p: number): [string, number] {
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

/** Parses one node at b[p]; `end` is the offset just past it. Throws on anything else. */
export function readNode(b: Uint8Array, p: number): { node: WaNode; end: number } {
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

/**
 * A copy of the plaintext stanza with blocked signals swapped (same length), or null to send it as
 * is. Throws when the bytes are not a node (handshake, other data); the caller sends those as is.
 */
export function editStanza(
  bytes: Uint8Array,
  on: Signals,
  report: Report,
): Uint8Array<ArrayBuffer> | null {
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
        report(kind, `${node.attrs[tok(T.to)]?.value}:${node.attrs[tok(T.id)]?.value}`);
      }
    }
  } else if (node.tag === tok(T.chatstate) && on.typing) {
    for (const child of node.children) {
      if (child.tag === tok(T.composing)) {
        swap(child.tagAt, T.paused);
        report("typing", "chatstate");
      }
    }
  }
  return out;
}
