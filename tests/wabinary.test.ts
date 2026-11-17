// src/content/wabinary.ts: WhatsApp Web's binary nodes and the one-byte edits that hide a signal.
// Nodes are built the way Baileys encodes them (as in tests/e2e/apps.e2e.mjs). Tokens: receipt 7,
// type 4, to 17, id 8, read 42, played 202, inactive 198, chatstate 46, composing 52, paused 154,
// media 55, audio 161, status 11, broadcast 13, s.whatsapp.net 3, message 19.
import { expect, test, vi } from "vitest";
import type { Kind, Signals } from "../src/shared";
import { T, editStanza, readNode, readString, tok } from "../src/content/wabinary";

const ALL: Signals = { seen: true, stories: true, typing: true };
const reporter = () => vi.fn<(kind: Kind, key: string) => void>();

const STR = (s: string) => [252, Buffer.byteLength(s), ...Buffer.from(s)];
const JID = (user: string) => [250, ...STR(user), 3];
const STATUS = [250, 11, 13];
const node = (tag: number, attrs: number[][], children?: number[][]) => [
  248,
  1 + 2 * attrs.length + (children ? 1 : 0),
  tag,
  ...attrs.flat(),
  ...(children ? [248, children.length, ...children.flat()] : []),
];
const frame = (n: number[]) => new Uint8Array([0, ...n]);
const receipt = (type: number, to = JID("6591234567")) =>
  frame(
    node(T.receipt, [
      [T.id, ...STR("3EB0A1")],
      [T.to, ...to],
      [T.type, type],
    ]),
  );
const chatstate = (child: number[]) =>
  frame(node(T.chatstate, [[T.to, ...JID("6591234567")]], [child]));
const composing = node(T.composing, []);
const recording = node(T.composing, [[55, 161]]);

/** Bytes that differ between two equal-length arrays, as [offset, before, after]. */
const diff = (a: Uint8Array, b: Uint8Array) =>
  [...a].flatMap((byte, i) => (byte === b[i] ? [] : [[i, byte, b[i]]]));

test("readString: tokens, BINARY_8 text and JID pairs", () => {
  expect(readString(new Uint8Array([42]), 0)).toEqual([tok(42), 1]);
  expect(readString(new Uint8Array(STR("héllo")), 0)).toEqual(["héllo", 8]);
  expect(readString(new Uint8Array(JID("6591234567")), 0)).toEqual([`6591234567@${tok(3)}`, 14]);
  expect(readString(new Uint8Array(STATUS), 0)[0]).toBe(`${tok(T.status)}@${tok(T.broadcast)}`);
});

test("readNode: tag, attributes with offsets, children, and where the node ends", () => {
  const bytes = receipt(T.read);
  const { node: n, end } = readNode(bytes, 1);
  expect(end).toBe(bytes.length);
  expect(n.tag).toBe(tok(T.receipt));
  expect(n.attrs[tok(T.id)]?.value).toBe("3EB0A1");
  const type = n.attrs[tok(T.type)];
  expect(type?.value).toBe(tok(T.read));
  expect(bytes[type?.at ?? -1]).toBe(T.read);
  const state = readNode(chatstate(recording), 1).node;
  expect(state.children.map((c) => c.tag)).toEqual([tok(T.composing)]);
  expect(state.children[0].attrs[tok(55)]?.value).toBe(tok(161));
});

test("readNode: not a node throws, so the caller sends the data as is", () => {
  expect(() => readNode(new Uint8Array([7, 1, 2]), 0)).toThrow();
  expect(() => editStanza(new Uint8Array([0, 248, 1, 240]), ALL, reporter())).toThrow();
});

test("seen: a read receipt becomes a delivery receipt (inactive), one byte changed", () => {
  const report = reporter();
  const bytes = receipt(T.read);
  const out = editStanza(bytes, ALL, report);
  expect(out).not.toBeNull();
  const type = readNode(bytes, 1).node.attrs[tok(T.type)];
  expect(diff(bytes, out as Uint8Array)).toEqual([[type?.at, T.read, T.inactive]]);
  expect(report).toHaveBeenCalledWith("seen", `6591234567@${tok(3)}:3EB0A1`);
  expect(bytes[type?.at ?? -1]).toBe(T.read); // the caller's buffer is never changed
});

test("seen: a played receipt (voice note) is hidden too", () => {
  const out = editStanza(receipt(T.played), ALL, reporter()) as Uint8Array;
  expect(readNode(out, 1).node.attrs[tok(T.type)]?.value).toBe(tok(T.inactive));
});

test("stories: a read receipt to status@broadcast counts as a story view", () => {
  const report = reporter();
  const out = editStanza(receipt(T.read, STATUS), ALL, report) as Uint8Array;
  expect(readNode(out, 1).node.attrs[tok(T.type)]?.value).toBe(tok(T.inactive));
  expect(report.mock.calls[0][0]).toBe("stories");
  expect(editStanza(receipt(T.read, STATUS), { ...ALL, stories: false }, reporter())).toBeNull();
  expect(editStanza(receipt(T.read, STATUS), { ...ALL, seen: false }, reporter())).not.toBeNull();
});

test("typing and recording: composing becomes paused, one byte changed", () => {
  for (const child of [composing, recording]) {
    const report = reporter();
    const bytes = chatstate(child);
    const out = editStanza(bytes, ALL, report) as Uint8Array;
    const tagAt = readNode(bytes, 1).node.children[0].tagAt;
    expect(diff(bytes, out)).toEqual([[tagAt, T.composing, T.paused]]);
    expect(report).toHaveBeenCalledWith("typing", "chatstate");
  }
});

test("signals that are shown, other receipts and other stanzas pass unchanged", () => {
  const report = reporter();
  expect(editStanza(receipt(T.read), { ...ALL, seen: false }, report)).toBeNull();
  expect(editStanza(chatstate(composing), { ...ALL, typing: false }, report)).toBeNull();
  expect(editStanza(chatstate(node(T.paused, [])), ALL, report)).toBeNull();
  expect(editStanza(receipt(T.inactive), ALL, report)).toBeNull();
  // A message whose content bytes look like a receipt: the tag is "message", so nothing changes.
  const message = frame([248, 4, 19, 17, ...JID("6591234567"), 252, 3, 7, 4, 42]);
  expect(editStanza(message, ALL, report)).toBeNull();
  expect(editStanza(new Uint8Array([2, 248, 1, 7]), ALL, report)).toBeNull(); // compressed
  expect(report).not.toHaveBeenCalled();
});
