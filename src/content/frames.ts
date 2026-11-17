// What content/page.ts decides, without touching the page: which socket frames, worker messages and
// HTTP requests carry a "Seen", typing or story-view signal on Facebook, Messenger, Instagram and
// Teams, and how a frame is rewritten. Pure functions, unit-tested in tests/frames.test.ts.
import type { Kind, Signals } from "../shared";

/** Called once per blocked signal; `key` lets the bridge count a repeat of the same one once. */
export type Report = (kind: Kind, key: string) => void;

// ---- Socket frames -------------------------------------------------------------------------------
// A frame holds one or more JSON objects (after an MQTT or Lightspeed header) whose payloads are JSON
// nested inside strings, so a key at nesting depth d appears escaped d times. Each object is parsed
// to find where a real `is_typing: 1` or `last_read_watermark_ts` key sits; only that exact escaped
// form is edited. Text someone typed (say, the words "is_typing":1 in a message) is a string value,
// not a key, and is never touched. Edits swap ASCII digits, so lengths never change.

/** `text` as it appears after being JSON-encoded inside a string `depth` times. */
export const escapeTimes = (text: string, depth: number) => {
  for (let i = 0; i < depth; i++) text = JSON.stringify(text).slice(1, -1);
  return text;
};

interface Found {
  typing: Set<number>;
  seen: Set<number>;
}

// Records the string-nesting depths at which each signal key occurs.
function findKeys(value: unknown, depth: number, found: Found) {
  if (typeof value === "string") {
    if (value[0] === "{" || value[0] === "[") {
      try {
        findKeys(JSON.parse(value), depth + 1, found);
      } catch {
        // Plain text that starts with a brace.
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) findKeys(item, depth, found);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.is_typing === 1) found.typing.add(depth);
    if (/^[0-9]+$/.test(String(record.last_read_watermark_ts ?? ""))) found.seen.add(depth);
    for (const item of Object.values(record)) findKeys(item, depth, found);
  }
}

// Index just past the "}" closing the object that opens at `start`, or -1.
function objectEnd(text: string, start: number) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92)
        i++; // backslash: skip the escaped character
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 123) depth++;
    else if (c === 125 && --depth === 0) return i + 1;
  }
  return -1;
}

// Replaces what follows each `key` with edit(rest) -> [matchedLength, replacement] or null.
function editAfter(segment: string, key: string, edit: (rest: string) => [number, string] | null) {
  let out = segment;
  for (let at = out.indexOf(key); at !== -1; at = out.indexOf(key, at + key.length)) {
    const hit = edit(out.slice(at + key.length, at + key.length + 40));
    if (hit) out = out.slice(0, at + key.length) + hit[1] + out.slice(at + key.length + hit[0]);
  }
  return out;
}

// `text` is the frame as one character per string unit (bytes for binary frames); `decode(a, b)`
// returns the real text of that range. Returns the edited text, or null when nothing changed.
function editText(
  text: string,
  decode: (a: number, b: number) => string,
  on: Signals,
  report: Report,
) {
  const typing = on.typing && text.includes("is_typing");
  const seen = on.seen && text.includes("last_read_watermark_ts");
  if (!typing && !seen) return null;
  let out = text;
  for (let start = text.indexOf("{"); start !== -1;) {
    const end = objectEnd(text, start);
    let value: unknown;
    try {
      value = end > 0 ? JSON.parse(decode(start, end)) : undefined;
    } catch {
      value = undefined;
    }
    if (value === undefined) {
      start = text.indexOf("{", start + 1); // a "{" byte in a binary header, or a broken object
      continue;
    }
    const found: Found = { typing: new Set(), seen: new Set() };
    findKeys(value, 0, found);
    let segment = out.slice(start, end);
    if (typing) {
      for (const depth of found.typing) {
        segment = editAfter(segment, escapeTimes('"is_typing":', depth), (rest) => {
          if (!/^1(?![0-9])/.test(rest)) return null;
          report("typing", "socket");
          return [1, "0"];
        });
      }
    }
    if (seen) {
      for (const depth of found.seen) {
        const quote = escapeTimes('"', depth);
        segment = editAfter(segment, escapeTimes('"last_read_watermark_ts":', depth), (rest) => {
          const lead = rest.startsWith(quote) ? quote : "";
          const digits = /^[0-9]+/.exec(rest.slice(lead.length))?.[0];
          if (!digits) return null;
          report("seen", digits); // the read mark: a resend of the same read counts once
          return [lead.length + digits.length, lead + "1" + "0".repeat(digits.length - 1)];
        });
      }
    }
    out = out.slice(0, start) + segment + out.slice(end);
    start = text.indexOf("{", end);
  }
  return out === text ? null : out;
}

// Binary frames are read one byte per character, so offsets are byte offsets; each object is decoded
// as UTF-8 only to parse it. Edits are ASCII, so they map straight back onto the bytes.
const utf8 = new TextDecoder();
function editBytes(bytes: Uint8Array, on: Signals, report: Report) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  const edited = editText(text, (a, b) => utf8.decode(bytes.subarray(a, b)), on, report);
  if (edited === null) return null;
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < edited.length; i++) out[i] = edited.charCodeAt(i);
  return out;
}

/**
 * An outgoing WebSocket frame with the blocked signals rewritten in place (same length), or null to
 * send it unchanged.
 */
export function editFrame(data: unknown, on: Signals, report: Report) {
  if (typeof data === "string") return editText(data, (a, b) => data.slice(a, b), on, report);
  if (data instanceof ArrayBuffer) return editBytes(new Uint8Array(data), on, report);
  if (ArrayBuffer.isView(data))
    return editBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), on, report);
  return null; // Blob: never used by these sites for outgoing frames.
}

// ---- Worker messages (end-to-end encrypted Messenger chats) -------------------------------------
// Typing state goes to Messenger's worker as [{type: "request", content: {name, arg: {state}}}].
interface ChatRequest {
  content: { name?: unknown; arg?: { state?: unknown } };
}
const isTyping = (item: unknown): item is ChatRequest => {
  const content = (item as Partial<ChatRequest> | null)?.content;
  return content?.name === "sendChatStateFromComposer" && content.arg?.state !== "idle";
};

/** A worker message with every composer state forced to "idle", or null to send it unchanged. */
export function idleChatStates(message: unknown, on: Signals, report: Report) {
  if (!on.typing || !Array.isArray(message)) return null;
  const items = message as unknown[];
  if (!items.some(isTyping)) return null;
  report("typing", "worker");
  return items.map((item) =>
    isTyping(item)
      ? { ...item, content: { ...item.content, arg: { ...item.content.arg, state: "idle" } } }
      : item,
  );
}

// ---- HTTP: story views, Instagram DM seen, Teams ------------------------------------------------
const STORY_IDS = [
  "xdt_mark_story_reel_seen",
  "xdt_api__v1__stories__reel__seen",
  "forceseenstoryid",
];
const SEEN_NAME = /markasseen|markthread(as)?(seen|read)|directseen|markitemsseen/i;

function friendlyName(body: string, header: string) {
  if (header) return header;
  const match = /(?:^|&)fb_api_req_friendly_name=([^&]*)/.exec(body);
  return match ? decodeURIComponent(match[1]) : "";
}

// Teams: read receipts move your "consumption horizon" (PUT …/properties?name=consumptionhorizon);
// typing is a message whose messagetype is Control/Typing (or Control/ClearTyping when you stop).
const TEAMS_HORIZON =
  /\/v1\/users\/ME\/conversations\/[^/?]+\/properties\?(.*&)?name=consumptionhorizon(&|$)/;
const TEAMS_TYPING = /"messagetype"\s*:\s*"Control\/(Clear)?Typing"/i;

/**
 * The signal an HTTP request carries, or null. `header` is the x-fb-friendly-name request header;
 * without it the name is read from the form body.
 */
export function classify(url: string, body: string, header: string, method = "GET"): Kind | null {
  if (TEAMS_HORIZON.test(url) && method.toUpperCase() === "PUT") return "seen";
  if (body.length < 2000 && TEAMS_TYPING.test(body)) return "typing";
  const name = friendlyName(body, header);
  const lowerBody = body.toLowerCase();
  if (
    (/seen/i.test(name) && /stor(y|ies)|reel/i.test(name)) ||
    /\/stories\/reel\/seen/.test(url) ||
    STORY_IDS.some((id) => lowerBody.includes(id))
  ) {
    return "stories";
  }
  if (SEEN_NAME.test(name) || /\/direct_v2\/threads\/.*(seen|mark_read)/.test(url)) return "seen";
  return null;
}
