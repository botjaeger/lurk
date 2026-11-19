// scripts/cws-publish.mjs: tag check, credentials and upload states.
import { expect, test } from "vitest";
import { credentials, tagProblem, uploadOutcome } from "../scripts/cws-publish.mjs";

test("the tag must be v + manifest version", () => {
  expect(tagProblem("v0.2.0", "0.2.0")).toBeNull();
  expect(tagProblem("v0.2.1", "0.2.0")).toMatch(/does not match/);
  expect(tagProblem("0.2.0", "0.2.0")).toMatch(/does not match/);
  expect(tagProblem("main", "0.2.0")).toMatch(/does not match/);
  expect(tagProblem(undefined, "0.2.0")).toMatch(/no tag/);
});

const oauth = { CWS_CLIENT_ID: "id", CWS_CLIENT_SECRET: "secret", CWS_REFRESH_TOKEN: "refresh" };

test("credentials: access token first, else refresh token, else a clear error", () => {
  expect(credentials({ CWS_ACCESS_TOKEN: "ya29.x", ...oauth })).toEqual({ token: "ya29.x" });
  const { refresh } = credentials(oauth);
  expect(Object.fromEntries(refresh ?? [])).toEqual({
    grant_type: "refresh_token",
    client_id: "id",
    client_secret: "secret",
    refresh_token: "refresh",
  });
  expect(() => credentials({ CWS_CLIENT_ID: "id" })).toThrow(/No credentials/);
  expect(() => credentials({ CWS_ACCESS_TOKEN: "" })).toThrow(/No credentials/);
});

test("upload states (v2 UploadState)", () => {
  expect(uploadOutcome("SUCCEEDED")).toBe("done");
  expect(uploadOutcome("IN_PROGRESS")).toBe("wait");
  for (const state of ["FAILED", "NOT_FOUND", "UPLOAD_STATE_UNSPECIFIED", undefined])
    expect(uploadOutcome(state)).toBe("failed");
});
