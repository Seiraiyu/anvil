/**
 * userMessage / attachment block shaping (arch §6.5) — formerly the non-queue half of
 * input-queue.test.ts; the InputQueue class died with the SDK driver (cc plan 7).
 */
import { test, expect } from "bun:test";
import { userMessage } from "../../src/agent/attachments";

test("userMessage inlines text with no attachments as a bare string", () => {
  const m = userMessage("hello");
  expect(m.message.content).toBe("hello");
  expect(m.type).toBe("user");
});

test("attachments become typed content blocks (image / pdf / text / binary)", () => {
  const png = Buffer.from("fakepng").toString("base64");
  const txt = Buffer.from("const x = 1;\n").toString("base64");
  const bin = Buffer.from([0, 1, 2, 3, 0]).toString("base64"); // NUL → binary
  const m = userMessage("look", [
    { mediaType: "image/png", name: "a.png", data: png },
    { mediaType: "application/pdf", name: "b.pdf", data: png },
    { mediaType: "text/plain", name: "c.ts", data: txt },
    { mediaType: "application/octet-stream", name: "d.bin", data: bin },
  ]);
  const blocks = m.message.content as Array<Record<string, any>>;
  expect(blocks[0]).toEqual({ type: "text", text: "look" });
  expect(blocks[1]!.type).toBe("image");
  expect(blocks[2]!.type).toBe("document");
  expect(blocks[3]!.type).toBe("text");
  expect(blocks[3]!.text).toContain('Attached file "c.ts"');
  expect(blocks[4]!.text).toContain("binary, not inlined");
});
