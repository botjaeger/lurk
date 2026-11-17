// npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rules = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const re = new RegExp(rules[0].condition.regexFilter);

test("blocks the read-receipt call for every account and host", () => {
  for (const url of [
    "https://chat.google.com/u/0/api/mark_group_readstate?c=29", // captured live 2026-11-16
    "https://chat.google.com/u/2/api/mark_group_readstate?c=1",
    "https://chat.google.com/u/12/api/mark_group_readstate",
    "https://chat.google.com/api/mark_group_readstate",
    "https://mail.google.com/chat/u/0/api/mark_group_readstate?c=3",
  ]) {
    assert.ok(re.test(url), url);
  }
});

test("leaves every other Chat call alone", () => {
  for (const url of [
    "https://chat.google.com/u/0/api/get_group?c=28",
    "https://chat.google.com/u/0/api/list_members?c=23",
    "https://chat.google.com/u/0/api/create_message?c=40",
    "https://chat.google.com/u/0/_/DynamiteWebUi/data/batchexecute?rpcids=qL7xZc",
    "https://chat.google.com/u/0/api/get_smart_replies?c=37",
    "https://evil.example/chat.google.com/u/0/api/mark_group_readstate",
    "https://chat.google.com/u/0/api/mark_group_readstate_v2?c=1",
  ]) {
    assert.ok(!re.test(url), url);
  }
});

test("rule shapes are valid for declarativeNetRequest", () => {
  assert.equal(rules.length, 2);
  assert.deepEqual(
    rules.map((rule) => rule.id),
    [1, 2],
  );
  for (const rule of rules) {
    assert.equal(rule.action.type, "block");
    assert.deepEqual(rule.condition.resourceTypes, ["xmlhttprequest", "ping", "other"]);
  }
});

test("Teams read-receipt rule: PUT to the consumption horizon on Teams hosts only", () => {
  const { condition } = rules[1];
  assert.equal(
    condition.urlFilter,
    "/v1/users/ME/conversations/*/properties?name=consumptionhorizon",
  );
  assert.deepEqual(condition.requestMethods, ["put"]);
  assert.deepEqual(condition.requestDomains, [
    "teams.microsoft.com",
    "teams.live.com",
    "teams.cloud.microsoft",
  ]);
});

const typingRules = JSON.parse(
  readFileSync(new URL("../rules-typing.json", import.meta.url), "utf8"),
);
const typingRe = new RegExp(typingRules[0].condition.regexFilter);
const rpc = (ids, base = "https://chat.google.com/u/0") =>
  `${base}/_/DynamiteWebUi/data/batchexecute?rpcids=${ids}&source-path=%2Fu%2F0%2Fapp%2Fhome&hl=en&rt=c`;

test("blocks the Chat typing call (rpcids=uQwtvc) for every account and host", () => {
  for (const url of [
    rpc("uQwtvc"), // captured live 2026-11-16
    rpc("uQwtvc", "https://chat.google.com/u/2"),
    rpc("uQwtvc", "https://chat.google.com"),
    rpc("uQwtvc", "https://mail.google.com/chat/u/0"),
    "https://chat.google.com/u/0/_/DynamiteWebUi/data/batchexecute?source-path=x&rpcids=uQwtvc",
  ]) {
    assert.ok(typingRe.test(url), url);
  }
});

test("leaves other batchexecute calls alone, including batches that carry more than typing", () => {
  for (const url of [
    rpc("qL7xZc"),
    rpc("uQwtvc,qL7xZc"),
    rpc("qL7xZc,uQwtvc"),
    rpc("uQwtvcX"),
    rpc("XuQwtvc"),
    "https://evil.example/chat.google.com/u/0/_/DynamiteWebUi/data/batchexecute?rpcids=uQwtvc",
  ]) {
    assert.ok(!typingRe.test(url), url);
  }
});

test("typing rule shape is valid for declarativeNetRequest", () => {
  assert.equal(typingRules.length, 1);
  assert.equal(typingRules[0].action.type, "block");
  assert.ok(typingRules[0].condition.resourceTypes.includes("xmlhttprequest"));
});
