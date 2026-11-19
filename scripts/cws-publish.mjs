// Uploads dist/lurk-chrome.zip to the Chrome Web Store and submits it for review (API v2).
// Run by .github/workflows/release.yml on a version tag; locally: node scripts/cws-publish.mjs [--dry-run]
//
// Environment:
//   CWS_PUBLISHER_ID, CWS_EXTENSION_ID      Developer Dashboard ids
//   CWS_ACCESS_TOKEN                        an access token with the chromewebstore scope (the workflow
//                                           gets one for a service account through Workload Identity
//                                           Federation, so no key file exists), or
//   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN   an OAuth client and refresh token
//   CWS_PUBLISH_TYPE                        DEFAULT_PUBLISH (live after review) or STAGED_PUBLISH
//   GITHUB_REF_NAME                         the tag; must be "v" + manifest.json's version
// --dry-run checks the tag, the zip and the settings, and sends nothing.
//
// The first version must be uploaded and its listing filled in by hand in the Developer Dashboard;
// the API only updates an existing item. An upload whose manifest version is not higher fails.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://chromewebstore.googleapis.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const PUBLISH_TYPES = ["DEFAULT_PUBLISH", "STAGED_PUBLISH"];

/** The tag that releases `version`; null when it matches, else what is wrong. */
export function tagProblem(tag, version) {
  if (!tag) return "no tag (GITHUB_REF_NAME is empty)";
  return tag === `v${version}`
    ? null
    : `tag ${tag} does not match manifest.json version ${version}`;
}

/**
 * How to authenticate: `{ token }` when the environment already holds an access token, else
 * `{ refresh }`, the token request body for an OAuth refresh token.
 */
export function credentials(env) {
  if (env.CWS_ACCESS_TOKEN) return { token: env.CWS_ACCESS_TOKEN };
  const { CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN } = env;
  if (CWS_CLIENT_ID && CWS_CLIENT_SECRET && CWS_REFRESH_TOKEN) {
    return {
      refresh: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CWS_CLIENT_ID,
        client_secret: CWS_CLIENT_SECRET,
        refresh_token: CWS_REFRESH_TOKEN,
      }),
    };
  }
  throw new Error(
    "No credentials: set CWS_ACCESS_TOKEN, or CWS_CLIENT_ID + CWS_CLIENT_SECRET + CWS_REFRESH_TOKEN",
  );
}

/** "done", "wait" or "failed" for an upload state (UploadState in the v2 reference). */
export function uploadOutcome(state) {
  if (state === "SUCCEEDED") return "done";
  if (state === "IN_PROGRESS") return "wait";
  return "failed";
}

async function call(url, init, what) {
  // A hung connection would otherwise hold the job until GitHub's 6-hour limit.
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${what}: HTTP ${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const { version } = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const zip = join(root, "dist/lurk-chrome.zip");
  const env = process.env;
  const publishType = env.CWS_PUBLISH_TYPE || "DEFAULT_PUBLISH";

  const problems = [
    tagProblem(env.GITHUB_REF_NAME, version),
    existsSync(zip) ? null : "dist/lurk-chrome.zip missing: run pnpm build:chrome",
    env.CWS_PUBLISHER_ID ? null : "CWS_PUBLISHER_ID is not set",
    env.CWS_EXTENSION_ID ? null : "CWS_EXTENSION_ID is not set",
    PUBLISH_TYPES.includes(publishType)
      ? null
      : `CWS_PUBLISH_TYPE must be ${PUBLISH_TYPES.join(" or ")}`,
  ].filter(Boolean);
  let auth;
  try {
    auth = credentials(env);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (problems.length || !auth) {
    for (const problem of problems) console.error(`cws-publish: ${problem}`);
    process.exit(1);
  }
  const item = `publishers/${env.CWS_PUBLISHER_ID}/items/${env.CWS_EXTENSION_ID}`;
  if (dryRun) {
    console.log(`cws-publish: dry run ok, would upload v${version} to ${item} (${publishType})`);
    return;
  }

  const token =
    auth.token ??
    (await call(TOKEN_URL, { method: "POST", body: auth.refresh }, "access token")).access_token;
  const headers = { authorization: `Bearer ${token}` };

  let upload = await call(
    `${API}/upload/v2/${item}:upload`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/zip" },
      body: readFileSync(zip),
    },
    "upload",
  );
  let state = upload.uploadState;
  for (let tries = 0; uploadOutcome(state) === "wait" && tries < 60; tries++) {
    await wait(5000);
    upload = await call(`${API}/v2/${item}:fetchStatus`, { headers }, "fetchStatus");
    state = upload.lastAsyncUploadState;
  }
  if (uploadOutcome(state) !== "done") {
    throw new Error(`upload did not succeed (${state}): ${JSON.stringify(upload)}`);
  }
  console.log(`cws-publish: uploaded v${upload.crxVersion || version}`);

  const published = await call(
    `${API}/v2/${item}:publish`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ publishType }),
    },
    "publish",
  );
  console.log(`cws-publish: submitted, state ${published.state}`);
  for (const warning of published.warningInfo?.warnings || [])
    console.log(`cws-publish: warning ${warning.reason}: ${warning.description}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`cws-publish: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
