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
// This file only hooks the page's natives; what to block and how to rewrite it is in frames.ts.
import { count, followState } from "./events";
import { classify, editFrame, idleChatStates, requestKey } from "./frames";

const flags = window as unknown as { __lurkPatched?: boolean };
if (!flags.__lurkPatched) {
  Object.defineProperty(window, "__lurkPatched", { value: true });
  patch();
}

function patch() {
  const on = followState();

  // ---- Socket frames (rewritten by frames.ts) -------------------------------------------------
  const nativeSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function send(
    this: WebSocket,
    ...args: Parameters<typeof nativeSend>
  ) {
    try {
      const edited = args.length ? editFrame(args[0], on, count) : null;
      if (edited) args[0] = edited;
    } catch {
      // Not a frame Lurk reads: send it unchanged.
    }
    nativeSend.apply(this, args);
  };

  // ---- Worker messages (end-to-end encrypted Messenger chats) ---------------------------------
  interface Poster {
    postMessage(message: unknown, ...rest: unknown[]): void;
  }
  for (const target of [MessagePort.prototype, Worker.prototype] as unknown as Poster[]) {
    const nativePost = target.postMessage;
    target.postMessage = function postMessage(this: unknown, ...args: unknown[]) {
      try {
        const edited = args.length ? idleChatStates(args[0], on, count) : null;
        if (edited) args[0] = edited;
      } catch {
        // Send it unchanged.
      }
      nativePost.apply(this, args as Parameters<Poster["postMessage"]>);
    };
  }

  // ---- HTTP: story views, Instagram DM seen, Teams (classified by frames.ts) --------------------
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
        count(kind, requestKey(url, bodyText(init?.body), header));
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
              count(later, requestKey(url, body, header));
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
  // The fields a faked answer sets on the request object itself (see send), removed again when the
  // app reuses the object, so its next, real request reports its own state.
  const FAKED = ["readyState", "status", "statusText", "responseText", "response"] as const;
  const fakeFor = (type: XMLHttpRequestResponseType, text: string): unknown =>
    type === "json"
      ? JSON.parse(text)
      : type === "arraybuffer"
        ? new TextEncoder().encode(text).buffer
        : type === "blob"
          ? new Blob([text], { type: "application/json" })
          : type === "document"
            ? null
            : text;

  // Arguments are passed on exactly as given: open(method, url, undefined) would make the request
  // synchronous.
  XMLHttpRequest.prototype.open = function open(this: XMLHttpRequest, ...args: unknown[]) {
    requests.set(this, { url: String(args[1]), header: "", method: String(args[0]) });
    for (const key of FAKED)
      if (Object.hasOwn(this, key)) delete (this as unknown as Record<string, unknown>)[key];
    nativeOpen.apply(this, args as Parameters<typeof nativeOpen>);
  };
  XMLHttpRequest.prototype.setRequestHeader = function setRequestHeader(
    this: XMLHttpRequest,
    ...args: Parameters<typeof nativeSetHeader>
  ) {
    const [name, value] = args;
    const info = requests.get(this);
    if (info && String(name).toLowerCase() === "x-fb-friendly-name") info.header = String(value);
    nativeSetHeader.apply(this, args);
  };
  XMLHttpRequest.prototype.send = function send(this: XMLHttpRequest, ...args: unknown[]) {
    try {
      const info = requests.get(this);
      const body = bodyText(args[0]);
      const kind = info && classify(info.url, body, info.header, info.method);
      if (info && kind && on[kind]) {
        count(kind, requestKey(info.url, body, info.header));
        // Answer with a fake empty success instead of sending.
        const fake = fakeBody();
        for (const [key, value] of Object.entries({
          readyState: 4,
          status: 200,
          statusText: "OK",
          responseText: fake,
          response: fakeFor(this.responseType, fake),
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
