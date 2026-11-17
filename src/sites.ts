// The apps Lurk works on: one list for the popup ("This site", Stats) and the background worker
// (which app a blocked signal came from). Keep in step with rules.json, rules-typing.json, the
// manifest's content_scripts and the README table.
import type { Kind } from "./shared";

export interface Site {
  id: string;
  hosts: RegExp;
  name: string;
  /** true = Lurk hides it there, false = not yet, null = the app has no such thing. */
  covers: Record<Kind, boolean | null>;
  note?: string;
}

export const SITES: readonly Site[] = [
  {
    id: "gchat",
    hosts: /^(chat|mail)\.google\.com$/,
    name: "Google Chat",
    covers: { seen: true, stories: null, typing: true },
  },
  {
    id: "meta",
    hosts: /(^|\.)(facebook|messenger)\.com$/,
    name: "Facebook and Messenger",
    covers: { seen: true, stories: true, typing: true },
    note: "End-to-end encrypted chats still send Seen.",
  },
  {
    id: "instagram",
    hosts: /(^|\.)instagram\.com$/,
    name: "Instagram",
    covers: { seen: true, stories: true, typing: true },
  },
  {
    id: "whatsapp",
    hosts: /^web\.whatsapp\.com$/,
    name: "WhatsApp",
    covers: { seen: true, stories: true, typing: true },
    note: "Covers blue ticks, voice-note plays, status views and typing. Your phone still shows chats as read.",
  },
  {
    id: "teams",
    hosts: /^(teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft)$/,
    name: "Teams",
    covers: { seen: true, stories: null, typing: true },
  },
];

export const siteFor = (host: string): Site | null =>
  SITES.find((site) => site.hosts.test(host)) ?? null;
