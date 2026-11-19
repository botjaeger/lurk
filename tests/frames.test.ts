// src/content/frames.ts: socket-frame edits, worker messages and HTTP classification for Facebook,
// Messenger, Instagram and Teams. Frame shapes match the e2e suites (tests/e2e/social.e2e.mjs, from
// mautrix/meta's Lightspeed requests); the browser hooks themselves are tested there.
import { expect, test, vi } from "vitest";
import type { Kind, Signals } from "../src/shared";
import { classify, editFrame, escapeTimes, idleChatStates } from "../src/content/frames";

const ALL: Signals = { seen: true, stories: true, typing: true };
const NONE: Signals = { seen: false, stories: false, typing: false };
const reporter = () => vi.fn<(kind: Kind, key: string) => void>();

// ---- Frame builders ------------------------------------------------------------------------------
// `extra`: more fields in the innermost object (depth 2).
const typingRequest = (isTyping: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    app_id: "2220391788200892",
    payload: JSON.stringify({
      label: "3",
      payload: JSON.stringify({
        thread_key: 1234567,
        is_group_thread: 0,
        is_typing: isTyping,
        ...extra,
      }),
      version: "8965252033599985",
    }),
    request_id: 7,
    type: 4,
  }).replace("1234567", "9007199254740993"); // 64-bit id: would round if parsed and re-encoded
const markRead = (ts: number | string) =>
  JSON.stringify({
    app_id: "2220391788200892",
    payload: JSON.stringify({
      epoch_id: 7262871617430370,
      tasks: [
        {
          label: "21",
          payload: JSON.stringify({ thread_id: 100001234567890, last_read_watermark_ts: ts }),
          queue_name: "100001234567890",
          task_id: 3,
        },
      ],
    }),
    request_id: 8,
    type: 3,
  });
const sendMessage = (text: string) =>
  JSON.stringify({
    payload: JSON.stringify({
      tasks: [{ label: "46", payload: JSON.stringify({ text, thread_id: 1 }) }],
    }),
    type: 3,
  });
// Lightspeed binary part: 0x0d, 2 bytes, 24-bit LE length (JSON + 2), 2 bytes, JSON.
const lightspeed = (json: string) => {
  const body = Buffer.from(json, "utf8");
  const len = body.length + 2;
  return Buffer.concat([
    Buffer.from([0x0d, 0, 0, len & 0xff, (len >> 8) & 0xff, len >> 16, 0, 0]),
    body,
  ]);
};
// MQTT PUBLISH (QoS 1) to /ls_req; the packet id 123 is the byte "{".
const mqtt = (json: string) =>
  Buffer.concat([
    Buffer.from([0x32, 0, 0, 7]),
    Buffer.from("/ls_req"),
    Buffer.from([0, 123]),
    Buffer.from(json),
  ]);

/** The innermost payload of a typing request or a mark-read frame, parsed. */
const inner = (frame: string) => {
  const outer = JSON.parse(frame) as { payload: string };
  const middle = JSON.parse(outer.payload) as { payload?: string; tasks?: { payload: string }[] };
  return JSON.parse(middle.payload ?? middle.tasks?.[0].payload ?? "") as Record<string, unknown>;
};
const bytesToText = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

// ---- Typing --------------------------------------------------------------------------------------
test("typing: is_typing 1 becomes 0 at its real depth, same length, 64-bit ids kept", () => {
  const report = reporter();
  const frame = typingRequest(1);
  const out = editFrame(frame, ALL, report);
  expect(typeof out).toBe("string");
  expect((out as string).length).toBe(frame.length);
  expect(out).toContain("9007199254740993");
  expect(inner(out as string).is_typing).toBe(0);
  expect(out).toBe(frame.replace(escapeTimes('"is_typing":1', 2), escapeTimes('"is_typing":0', 2)));
  expect(report).toHaveBeenCalledWith("typing", "socket");
});

test("typing: is_typing 0, other keys that start with is_typing, and 10 are left alone", () => {
  const report = reporter();
  expect(editFrame(typingRequest(0), ALL, report)).toBeNull();
  expect(editFrame('{"is_typing_enabled":1,"is_typing_x":1}', ALL, report)).toBeNull();
  expect(editFrame('{"is_typing":10}', ALL, report)).toBeNull();
  expect(report).not.toHaveBeenCalled();
});

test("typing: with typing shown, the frame is sent as is", () => {
  const report = reporter();
  expect(editFrame(typingRequest(1), { ...ALL, typing: false }, report)).toBeNull();
  expect(report).not.toHaveBeenCalled();
});

// ---- Seen ----------------------------------------------------------------------------------------
test("seen: last_read_watermark_ts becomes the oldest time with as many digits", () => {
  const report = reporter();
  const frame = markRead(1763290000123);
  const out = editFrame(frame, ALL, report) as string;
  expect(out.length).toBe(frame.length);
  expect(inner(out).last_read_watermark_ts).toBe(1000000000000);
  expect(report).toHaveBeenCalledWith("seen", "1763290000123");
});

test("seen: a quoted (string) read mark keeps its quotes", () => {
  const out = editFrame(markRead("1763290000123"), ALL, reporter()) as string;
  expect(inner(out).last_read_watermark_ts).toBe("1000000000000");
});

test("seen: with Seen shown, or every signal shown, the frame is sent as is", () => {
  expect(editFrame(markRead(1763290000123), { ...ALL, seen: false }, reporter())).toBeNull();
  expect(editFrame(markRead(1763290000123), NONE, reporter())).toBeNull();
});

// ---- Never touch user content ---------------------------------------------------------------------
test("a message that quotes the keys is never edited", () => {
  const report = reporter();
  const text = '"is_typing":1 and "last_read_watermark_ts":1763290000123 in a message 😀';
  expect(editFrame(sendMessage(text), ALL, report)).toBeNull();
  expect(report).not.toHaveBeenCalled();
});

test("a quoted key in a string beside the real key is left alone", () => {
  const note = 'I typed "is_typing":1 on purpose';
  const frame = typingRequest(1, { note });
  const out = editFrame(frame, ALL, reporter()) as string;
  expect(out.length).toBe(frame.length);
  expect(inner(out)).toMatchObject({ is_typing: 0, note });
});

test("a batch of several objects edits each one by its own keys", () => {
  const report = reporter();
  const mixed = typingRequest(1) + sendMessage('"is_typing":1') + markRead(1763290000123);
  const out = editFrame(mixed, ALL, report) as string;
  expect(Buffer.byteLength(out)).toBe(Buffer.byteLength(mixed));
  expect(out).toContain(sendMessage('"is_typing":1'));
  expect(report.mock.calls.map(([kind]) => kind).sort()).toEqual(["seen", "typing"]);
});

// ---- Binary frames -------------------------------------------------------------------------------
test("binary Lightspeed frame: edited byte for byte, header and UTF-8 text kept", () => {
  const bytes = lightspeed(typingRequest(1, { note: "ünïcödé 😀" }));
  const out = editFrame(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    ALL,
    reporter(),
  );
  expect(out).toBeInstanceOf(Uint8Array);
  const edited = out as Uint8Array;
  expect(edited.length).toBe(bytes.length);
  expect([...edited.subarray(0, 8)]).toEqual([...bytes.subarray(0, 8)]);
  expect(inner(bytesToText(edited.subarray(8))).is_typing).toBe(0);
  expect(inner(bytesToText(edited.subarray(8))).note).toBe("ünïcödé 😀");
});

test("binary MQTT frame: a { byte in the header does not stop the edit", () => {
  const bytes = mqtt(markRead(1763290000123));
  const edited = editFrame(new Uint8Array(bytes), ALL, reporter()) as Uint8Array;
  expect(edited.length).toBe(bytes.length);
  expect(edited[12]).toBe(123);
  expect(inner(bytesToText(edited.subarray(13))).last_read_watermark_ts).toBe(1000000000000);
});

test("a typed-array view is read from its own offset", () => {
  const bytes = lightspeed(typingRequest(1));
  const padded = new Uint8Array(bytes.length + 10);
  padded.set(bytes, 5);
  const edited = editFrame(padded.subarray(5, 5 + bytes.length), ALL, reporter()) as Uint8Array;
  expect(edited.length).toBe(bytes.length);
  expect(inner(bytesToText(edited.subarray(8))).is_typing).toBe(0);
});

test("frames with nothing to hide, broken JSON and Blobs are sent as is", () => {
  expect(editFrame('{"type":3,"payload":"{}"}', ALL, reporter())).toBeNull();
  expect(editFrame('{"is_typing":1', ALL, reporter())).toBeNull();
  expect(editFrame(new Blob(['{"is_typing":1}']), ALL, reporter())).toBeNull();
});

// ---- Worker messages -----------------------------------------------------------------------------
const chatState = (state: string) => ({
  type: "request",
  content: { name: "sendChatStateFromComposer", arg: { state, threadId: "1" } },
});

test("worker: composer states other than idle become idle; other items are kept", () => {
  const report = reporter();
  const other = { type: "request", content: { name: "sendMessage", arg: { text: "hi" } } };
  const out = idleChatStates([chatState("composing"), other], ALL, report);
  expect(out).toEqual([chatState("idle"), other]);
  expect(report).toHaveBeenCalledWith("typing", "worker");
});

test("worker: idle states, other messages and typing shown are left alone", () => {
  expect(idleChatStates([chatState("idle")], ALL, reporter())).toBeNull();
  expect(idleChatStates({ content: chatState("composing").content }, ALL, reporter())).toBeNull();
  expect(
    idleChatStates([chatState("composing")], { ...ALL, typing: false }, reporter()),
  ).toBeNull();
});

// ---- HTTP ----------------------------------------------------------------------------------------
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const HORIZON =
  "https://teams.microsoft.com/api/chatsvc/emea/v1/users/ME/conversations/19%3Aabc%40thread.v2/properties?name=consumptionhorizon";

test("HTTP: story views on Facebook and Instagram", () => {
  const fb = form({ fb_api_req_friendly_name: "storiesUpdateSeenStateMutation", doc_id: "1" });
  expect(classify("https://www.facebook.com/api/graphql/", fb, "", "POST")).toBe("stories");
  expect(
    classify(
      "https://www.instagram.com/graphql/query",
      form({ doc_id: "2" }),
      "PolarisStoriesV3SeenMutation",
      "POST",
    ),
  ).toBe("stories");
  expect(
    classify("https://www.instagram.com/api/v1/stories/reel/seen", "reelMediaId=1", "", "POST"),
  ).toBe("stories");
  expect(
    classify(
      "https://www.instagram.com/graphql/query",
      '{"xdt_mark_story_reel_seen":{}}',
      "",
      "POST",
    ),
  ).toBe("stories");
});

test("HTTP: Instagram DM seen", () => {
  const body = form({ fb_api_req_friendly_name: "usePolarisMarkThreadSeenMutation" });
  expect(classify("https://www.instagram.com/api/graphql", body, "", "POST")).toBe("seen");
  expect(
    classify("https://www.instagram.com/api/v1/direct_v2/threads/1/items/2/seen/", "", "", "POST"),
  ).toBe("seen");
});

test("HTTP: loading an Instagram thread is not a Seen (only the POST that marks it)", () => {
  const thread = "https://www.instagram.com/api/v1/direct_v2/threads/123/";
  expect(
    classify(`${thread}?visual_message_return_type=unseen&cursor=abc`, "", "", "GET"),
  ).toBeNull();
  expect(classify(`${thread}items/2/seen/`, "", "", "GET")).toBeNull();
  expect(classify(`${thread}?seen=1`, "", "", "POST")).toBeNull();
  expect(classify(`${thread}items/2/seen/?x=1`, "", "", "POST")).toBe("seen");
  expect(classify(`${thread}mark_read/`, "", "", "POST")).toBe("seen");
});

test("HTTP: a message or comment quoting a story-view id is sent, not faked", () => {
  for (const id of ["xdt_mark_story_reel_seen", "forceSeenStoryId"]) {
    const dm = form({
      fb_api_req_friendly_name: "IGDirectTextSendMutation",
      variables: JSON.stringify({ text: `look: "${id}":{} ${id}=1` }),
    });
    expect(classify("https://www.instagram.com/api/graphql", dm, "", "POST"), id).toBeNull();
    const json = JSON.stringify({ query: "send", variables: { text: `"${id}": ${id}` } });
    expect(classify("https://www.instagram.com/graphql/query", json, "", "POST"), id).toBeNull();
  }
  // Read-only queries about who has seen a story or a thread load, they do not mark.
  for (const name of ["StoriesSeenByViewersListQuery", "PolarisThreadSeenStateQuery"])
    expect(
      classify(
        "https://www.facebook.com/api/graphql/",
        form({ fb_api_req_friendly_name: name }),
        "",
        "POST",
      ),
      name,
    ).toBeNull();
  // The id as a key of the request itself still marks a story view.
  const keyed = form({ doc_id: "3", variables: JSON.stringify({ forceSeenStoryId: "1" }) });
  expect(classify("https://www.instagram.com/graphql/query", keyed, "", "POST")).toBe("stories");
  expect(
    classify(
      "https://www.instagram.com/graphql/query",
      form({ forceseenstoryid: "1" }),
      "",
      "POST",
    ),
  ).toBe("stories");
});

test("HTTP: Teams read mark only on PUT, typing only as a Control/Typing message", () => {
  expect(classify(HORIZON, '{"consumptionhorizon":"1;2;3"}', "", "PUT")).toBe("seen");
  expect(classify(HORIZON, "", "", "GET")).toBeNull();
  expect(classify(HORIZON.replace("consumptionhorizon", "favorite"), "{}", "", "PUT")).toBeNull();
  const messages =
    "https://teams.microsoft.com/api/chatsvc/emea/v1/users/ME/conversations/19%3Aa/messages";
  expect(classify(messages, '{"content":"","messagetype":"Control/Typing"}', "", "POST")).toBe(
    "typing",
  );
  expect(classify(messages, '{"content":"","messagetype":"Control/ClearTyping"}', "", "POST")).toBe(
    "typing",
  );
  const quoting = JSON.stringify({
    content: 'look: "messagetype":"Control/Typing"',
    messagetype: "RichText/Html",
  });
  expect(classify(messages, quoting, "", "POST")).toBeNull();
});

test("HTTP: feed queries and sending a message pass", () => {
  const feed = form({
    fb_api_req_friendly_name: "CometNewsFeedPaginationQuery",
    variables: '{"seen":1}',
  });
  expect(classify("https://www.facebook.com/api/graphql/", feed, "", "POST")).toBeNull();
  const send = form({ fb_api_req_friendly_name: "IGDirectTextSendMutation" });
  expect(classify("https://www.instagram.com/api/graphql", send, "", "POST")).toBeNull();
});
