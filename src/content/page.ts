// Runs in the page's own JavaScript world (MAIN) on Facebook, Messenger, Instagram and Teams,
// before the page's scripts. These sites send "Seen", typing and story-view signals inside WebSocket
// frames and POST bodies, which declarativeNetRequest cannot see, so they are caught here instead.
// (WhatsApp Web has its own script, content/whatsapp.ts.)
//
// - Teams: the read-receipt call (PUT …/properties?name=consumptionhorizon) and typing messages
//   (messagetype Control/Typing) get a fake success and are never sent.
//
// - Typing:  an `is_typing: 1` key in a socket frame becomes `0`; encrypted Messenger chats hand the
//            composer state to a worker, where it is forced to "idle".
// - Seen:    `last_read_watermark_ts` in a socket frame is rewritten to the oldest time with the same
//            number of digits, so the server never moves your read mark past their messages.
// - Stories: GraphQL / REST calls that mark a story as viewed get a fake empty 200 response.
//
// Socket edits keep the frame's byte length, so MQTT and Lightspeed length headers stay valid, and
// nothing is dropped, so the page never waits on or retries a missing request.
// Settings arrive from content/bridge.ts as a "lurk:state" event; until then everything is blocked.
import type { Kind } from "../shared";
import { count, followState } from "./events";

const flags = window as unknown as { __lurkPatched?: boolean };
if (!flags.__lurkPatched) {
  Object.defineProperty(window, "__lurkPatched", { value: true });
  patch();
}

function patch() {
  const on = followState();

  // ---- Socket frames -------------------------------------------------------------------------
  // A frame holds one or more JSON objects (after an MQTT or Lightspeed header) whose payloads are
  // JSON nested inside strings, so a key at nesting depth d appears escaped d times. Each object is
  // parsed to find where a real `is_typing: 1` or `last_read_watermark_ts` key sits; only that exact
  // escaped form is edited. Text someone typed (say, the words "is_typing":1 in a message) is a
  // string value, not a key, and is never touched. Edits swap ASCII digits, so lengths never change.
  const escapeTimes = (text: string, depth: number) => {
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
  function editAfter(
    segment: string,
    key: string,
    edit: (rest: string) => [number, string] | null,
  ) {
    let out = segment;
    for (let at = out.indexOf(key); at !== -1; at = out.indexOf(key, at + key.length)) {
      const hit = edit(out.slice(at + key.length, at + key.length + 40));
      if (hit) out = out.slice(0, at + key.length) + hit[1] + out.slice(at + key.length + hit[0]);
    }
    return out;
  }

  // `text` is the frame as one character per string unit (bytes for binary frames); `decode(a, b)`
  // returns the real text of that range. Returns the edited text, or null when nothing changed.
  function editText(text: string, decode: (a: number, b: number) => string) {
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
            count("typing", "socket");
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
            count("seen", digits); // the read mark: a resend of the same read counts once
            return [lead.length + digits.length, lead + "1" + "0".repeat(digits.length - 1)];
          });
        }
      }
      out = out.slice(0, start) + segment + out.slice(end);
      start = text.indexOf("{", end);
    }
    return out === text ? null : out;
  }

  // Binary frames are read one byte per character, so offsets are byte offsets; each object is
  // decoded as UTF-8 only to parse it. Edits are ASCII, so they map straight back onto the bytes.
  const utf8 = new TextDecoder();
  function editBytes(bytes: Uint8Array) {
    let text = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    const edited = editText(text, (a, b) => utf8.decode(bytes.subarray(a, b)));
    if (edited === null) return null;
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < edited.length; i++) out[i] = edited.charCodeAt(i);
    return out;
  }

  function editFrame(data: unknown) {
    if (typeof data === "string") return editText(data, (a, b) => data.slice(a, b));
    if (data instanceof ArrayBuffer) return editBytes(new Uint8Array(data));
    if (ArrayBuffer.isView(data))
      return editBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return null; // Blob: never used by these sites for outgoing frames.
  }

  const nativeSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function send(
    this: WebSocket,
    data: Parameters<typeof nativeSend>[0],
  ) {
    let edited: ReturnType<typeof editFrame>;
    try {
      edited = editFrame(data);
    } catch {
      edited = null;
    }
    nativeSend.call(this, edited ?? data);
  };

  // ---- Worker messages (end-to-end encrypted Messenger chats) ---------------------------------
  // Typing state goes to Messenger's worker as [{type: "request", content: {name, arg: {state}}}].
  interface ChatRequest {
    content: { name?: unknown; arg?: { state?: unknown } };
  }
  const isTyping = (item: unknown): item is ChatRequest => {
    const content = (item as Partial<ChatRequest> | null)?.content;
    return content?.name === "sendChatStateFromComposer" && content.arg?.state !== "idle";
  };

  function idleChatStates(message: unknown) {
    if (!on.typing || !Array.isArray(message)) return null;
    const items = message as unknown[];
    if (!items.some(isTyping)) return null;
    count("typing", "worker");
    return items.map((item) =>
      isTyping(item)
        ? { ...item, content: { ...item.content, arg: { ...item.content.arg, state: "idle" } } }
        : item,
    );
  }

  interface Poster {
    postMessage(message: unknown, ...rest: unknown[]): void;
  }
  for (const target of [MessagePort.prototype, Worker.prototype] as unknown as Poster[]) {
    const nativePost = target.postMessage;
    target.postMessage = function postMessage(this: unknown, message: unknown, ...rest: unknown[]) {
      let edited: unknown[] | null;
      try {
        edited = idleChatStates(message);
      } catch {
        edited = null;
      }
      nativePost.call(this, edited ?? message, ...rest);
    };
  }

  // ---- HTTP: story views and Instagram DM seen --------------------------------------------------
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

  function classify(url: string, body: string, header: string, method = "GET"): Kind | null {
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

  function bodyText(body: unknown) {
    if (typeof body === "string") return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      const params = new URLSearchParams();
      for (const [key, value] of body) if (typeof value === "string") params.append(key, value);
      return params.toString();
    }
    return "";
  }

  function headerValue(headers: HeadersInit | undefined, name: string) {
    try {
      return new Headers(headers || {}).get(name) || "";
    } catch {
      return "";
    }
  }

  const fakeBody = () => JSON.stringify({ data: {}, status: "ok" });

  const fakeResponse = () =>
    new Response(fakeBody(), { status: 200, headers: { "content-type": "application/json" } });
  // A Request object carries its body inside; read a copy when it is small text (JSON or a form).
  const readsRequestBody = (input: unknown, init: RequestInit | undefined): input is Request =>
    input instanceof Request &&
    init?.body === undefined &&
    !/^(GET|HEAD)$/i.test(init?.method || input.method) &&
    /json|x-www-form-urlencoded|text\/plain/i.test(input.headers.get("content-type") || "");

  const nativeFetch = window.fetch;
  window.fetch = function fetch(this: unknown, ...args: Parameters<typeof nativeFetch>) {
    const [input, init] = args;
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : String((input as { url?: unknown } | null)?.url ?? "");
      const method = init?.method || (input instanceof Request ? input.method : "GET");
      const header = headerValue(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
        "x-fb-friendly-name",
      );
      const kind = classify(url, bodyText(init?.body), header, method);
      if (kind && on[kind]) {
        count(kind, url + bodyText(init?.body).slice(0, 200));
        return Promise.resolve(fakeResponse());
      }
      if (!kind && readsRequestBody(input, init)) {
        return input
          .clone()
          .text()
          .then(
            (body) => {
              const later = classify(url, body, header, method);
              if (!later || !on[later]) return nativeFetch.apply(window, args);
              count(later, url + body.slice(0, 200));
              return fakeResponse();
            },
            () => nativeFetch.apply(window, args),
          );
      }
    } catch {
      // Fall through to the real request.
    }
    return nativeFetch.apply(this, args);
  };

  interface RequestInfo {
    url: string;
    header: string;
    method: string;
  }
  const requests = new WeakMap<XMLHttpRequest, RequestInfo>();
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const nativeXhrSend = XMLHttpRequest.prototype.send;

  // Arguments are passed on exactly as given: open(method, url, undefined) would make the request
  // synchronous.
  XMLHttpRequest.prototype.open = function open(this: XMLHttpRequest, ...args: unknown[]) {
    requests.set(this, { url: String(args[1]), header: "", method: String(args[0]) });
    nativeOpen.apply(this, args as Parameters<typeof nativeOpen>);
  };
  XMLHttpRequest.prototype.setRequestHeader = function setRequestHeader(
    this: XMLHttpRequest,
    name: string,
    value: string,
  ) {
    const info = requests.get(this);
    if (info && String(name).toLowerCase() === "x-fb-friendly-name") info.header = String(value);
    nativeSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function send(this: XMLHttpRequest, ...args: unknown[]) {
    try {
      const info = requests.get(this);
      const body = bodyText(args[0]);
      const kind = info && classify(info.url, body, info.header, info.method);
      if (info && kind && on[kind]) {
        count(kind, info.url + body.slice(0, 200));
        // Answer with a fake empty success instead of sending.
        const fake = fakeBody();
        for (const [key, value] of Object.entries({
          readyState: 4,
          status: 200,
          statusText: "OK",
          responseText: fake,
          response: this.responseType === "json" ? (JSON.parse(fake) as unknown) : fake,
        })) {
          Object.defineProperty(this, key, { configurable: true, value });
        }
        setTimeout(() => {
          for (const type of ["readystatechange", "load", "loadend"])
            this.dispatchEvent(new Event(type));
        });
        return;
      }
    } catch {
      // Fall through to the real request.
    }
    nativeXhrSend.apply(this, args as Parameters<typeof nativeXhrSend>);
  };
}
