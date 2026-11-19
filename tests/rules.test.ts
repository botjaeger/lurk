// The static declarativeNetRequest rulesets: rules.json (Seen) and rules-typing.json (typing).
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

interface Rule {
  id: number;
  action: { type: string };
  condition: {
    regexFilter?: string;
    urlFilter?: string;
    requestMethods?: string[];
    requestDomains?: string[];
    resourceTypes: string[];
  };
}
const load = (file: string) =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")) as Rule[];

const rules = load("rules.json");
const re = new RegExp(rules[0].condition.regexFilter ?? "");

test("blocks the read-receipt call for every account and host", () => {
  for (const url of [
    "https://chat.google.com/u/0/api/mark_group_readstate?c=29", // captured live 2026-11-16
    "https://chat.google.com/u/2/api/mark_group_readstate?c=1",
    "https://chat.google.com/u/12/api/mark_group_readstate",
    "https://chat.google.com/api/mark_group_readstate",
    "https://mail.google.com/chat/u/0/api/mark_group_readstate?c=3",
  ]) {
    expect(re.test(url), url).toBe(true);
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
    expect(re.test(url), url).toBe(false);
  }
});

test("rule shapes are valid for declarativeNetRequest", () => {
  expect(rules.map((rule) => rule.id)).toEqual([1, 2]);
  for (const rule of rules) {
    expect(rule.action.type).toBe("block");
    expect(rule.condition.resourceTypes).toEqual(["xmlhttprequest", "ping", "other"]);
  }
});

test("Teams read-receipt rule: PUT to the consumption horizon on Teams hosts only", () => {
  const { condition } = rules[1];
  expect(condition.urlFilter).toBe(
    "/v1/users/ME/conversations/*/properties?*name=consumptionhorizon^",
  );
  expect(condition.requestMethods).toEqual(["put"]);
  expect(condition.requestDomains).toEqual([
    "teams.microsoft.com",
    "teams.live.com",
    "teams.cloud.microsoft",
  ]);
});

const typingRules = load("rules-typing.json");
const typingRe = new RegExp(typingRules[0].condition.regexFilter ?? "");
const rpc = (ids: string, base = "https://chat.google.com/u/0") =>
  `${base}/_/DynamiteWebUi/data/batchexecute?rpcids=${ids}&source-path=%2Fu%2F0%2Fapp%2Fhome&hl=en&rt=c`;

test("blocks the Chat typing call (rpcids=uQwtvc) for every account and host", () => {
  for (const url of [
    rpc("uQwtvc"), // captured live 2026-11-16
    rpc("uQwtvc", "https://chat.google.com/u/2"),
    rpc("uQwtvc", "https://chat.google.com"),
    rpc("uQwtvc", "https://mail.google.com/chat/u/0"),
    "https://chat.google.com/u/0/_/DynamiteWebUi/data/batchexecute?source-path=x&rpcids=uQwtvc",
  ]) {
    expect(typingRe.test(url), url).toBe(true);
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
    expect(typingRe.test(url), url).toBe(false);
  }
});

test("typing rule shape is valid for declarativeNetRequest", () => {
  expect(typingRules).toHaveLength(1);
  expect(typingRules[0].action.type).toBe("block");
  expect(typingRules[0].condition.resourceTypes).toContain("xmlhttprequest");
});
