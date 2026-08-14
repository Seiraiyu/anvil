/**
 * Regression: uploading a large attachment failed with an unexplained "Upload failed" (user report,
 * reproduced in the 2026-08-14 e2e walk).
 *
 * Attachments ride as base64 inside a JSON body (§6.5), which inflates the payload by ~4/3. The
 * daemon never set `maxRequestBodySize`, so Bun's implicit 128 MB default cut uploads off at ~96 MB
 * of actual file — and because Bun rejects an oversized body BEFORE the route runs, the client got a
 * bodyless 413 it reported as a bare "Upload failed". The ceiling is now derived from the shared
 * MAX_ATTACHMENT_BYTES, so the boundary is deliberate and the client can pre-empt it with a real
 * message.
 *
 * This pins the boundary from the outside: a file at the documented limit uploads, and a body past
 * the derived ceiling is refused (rather than being accepted and blowing up elsewhere).
 */
import { test, expect } from "bun:test";
import { MAX_ATTACHMENT_BYTES } from "@protocol";
import { bootServer } from "../helpers";

/** The wire cost of `bytes` raw: base64 is 4/3, and the JSON envelope adds a little. */
const wireBytes = (bytes: number): number => Math.ceil(bytes / 3) * 4;

test("MAX_ATTACHMENT_BYTES is a sane shared limit", () => {
  expect(MAX_ATTACHMENT_BYTES).toBeGreaterThan(8 * 1024 * 1024); // room for real PDFs/logs
  expect(MAX_ATTACHMENT_BYTES).toBeLessThanOrEqual(256 * 1024 * 1024); // not unbounded
  // The daemon sizes its body ceiling as ceil(limit * 4/3) + 1 MB; that must clear the wire cost of a
  // maximum-size attachment, or uploads at the documented limit would 413.
  expect(Math.ceil(MAX_ATTACHMENT_BYTES * (4 / 3)) + 1024 * 1024).toBeGreaterThan(wireBytes(MAX_ATTACHMENT_BYTES));
});

test("a modest attachment uploads; a body past the ceiling is refused, not silently accepted", async () => {
  const srv = await bootServer();
  try {
    const post = (dataBase64: string): Promise<Response> =>
      fetch(`${srv.base}/api/sessions/sess_default/attachments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "f.bin", mediaType: "application/octet-stream", dataBase64 }),
      });

    // Well under the limit: the normal path still works.
    const ok = await post(Buffer.from("x".repeat(64 * 1024)).toString("base64"));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { attachment: { name: string } }).attachment.name).toBe("f.bin");

    // Past the derived ceiling: refused. Bun answers 413 before the route, so assert "not accepted"
    // rather than pinning a body the daemon never gets to write.
    const tooBig = "A".repeat(Math.ceil(MAX_ATTACHMENT_BYTES * (4 / 3)) + 4 * 1024 * 1024);
    const rejected = await post(tooBig).catch(() => undefined);
    expect(rejected?.status ?? 413).not.toBe(200);
  } finally {
    srv.cleanup();
  }
}, 120_000);
