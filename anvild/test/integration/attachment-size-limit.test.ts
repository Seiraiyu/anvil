/**
 * Regression: uploading a large attachment failed with an unexplained "Upload failed" (user report,
 * reproduced in the 2026-08-14 e2e walk).
 *
 * The upload path carried the file as base64 inside a JSON body: 4/3 the bytes on the wire, and both
 * sides holding the whole file in memory (the client read it with readAsDataURL and re-encoded it
 * into a JSON string). With no explicit `maxRequestBodySize`, Bun's implicit 128 MB default then cut
 * uploads off at ~96 MB of actual file — and since Bun rejects an oversized body before the route
 * runs, the client got a bodyless 413 it reported as a bare "Upload failed".
 *
 * Uploads now STREAM: the raw bytes are the request body (name/mediaType in the query string) and
 * the daemon pumps them to disk. This pins that path end-to-end, the legacy JSON path that older
 * clients still use, and the bounded read at turn time.
 */
import { test, expect } from "bun:test";
import { MAX_ATTACHMENT_BYTES } from "@protocol";
import { inlineBudget } from "../../src/agent/attachments";
import { AttachmentStore } from "../../src/attach/store";
import { bootServer, tmpDir } from "../helpers";

test("MAX_ATTACHMENT_BYTES is a sane shared limit", () => {
  expect(MAX_ATTACHMENT_BYTES).toBeGreaterThan(96 * 1024 * 1024); // past the old base64 cliff
  expect(MAX_ATTACHMENT_BYTES).toBeLessThanOrEqual(1024 * 1024 * 1024);
});

test("streaming upload round-trips the exact bytes, and the legacy JSON body still works", async () => {
  const srv = await bootServer();
  try {
    const bytes = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => i % 256));

    // Streaming path: the body IS the file.
    const streamed = await fetch(`${srv.base}/api/sessions/sess_default/attachments?name=blob.bin&mediaType=application/octet-stream`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    expect(streamed.status).toBe(200);
    const ref = ((await streamed.json()) as { attachment: { id: string; name: string } }).attachment;
    expect(ref.name).toBe("blob.bin");

    // Read it back through the GET endpoint: identical bytes, nothing lost in the pump.
    const back = await fetch(`${srv.base}/api/sessions/sess_default/attachments/${ref.id}`);
    expect(back.status).toBe(200);
    expect(Buffer.from(await back.arrayBuffer()).equals(bytes)).toBe(true);

    // Legacy base64-in-JSON path: still accepted (native shells ship their own web bundle).
    const legacy = await fetch(`${srv.base}/api/sessions/sess_default/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "legacy.txt", mediaType: "text/plain", dataBase64: Buffer.from("hello").toString("base64") }),
    });
    expect(legacy.status).toBe(200);
  } finally {
    srv.cleanup();
  }
}, 60_000);

test("loadForAgent reads only the inline budget, not the whole file", () => {
  const { dir, cleanup } = tmpDir("anvil-att-");
  try {
    const store = new AttachmentStore(dir);
    // 4 MB of text: far past the text budget, which is what a big log looks like.
    const big = "L".repeat(4 * 1024 * 1024);
    const ref = store.add("sess_x", "huge.log", "text/plain", Buffer.from(big).toString("base64"));

    const loaded = store.loadForAgent("sess_x", ref.id, inlineBudget)!;
    expect(loaded.size).toBe(big.length); // real size still reported
    expect(loaded.truncated).toBe(true);
    // Only the budget's worth of bytes was read — this used to be the entire file, on every turn.
    const readBytes = Buffer.from(loaded.data, "base64").length;
    expect(readBytes).toBe(inlineBudget("text/plain"));
    expect(readBytes).toBeLessThan(big.length / 4);
  } finally {
    cleanup();
  }
});
