import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttachmentRef } from "@protocol";
import { newId } from "../util/ids";

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
};

/** Best-effort media type from a filename when the client couldn't supply one (common on mobile,
 *  where the Android content picker often hands back a File with an empty `type`). */
const MEDIA_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "text/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  ts: "text/x-typescript",
  tsx: "text/x-typescript",
  js: "text/javascript",
  py: "text/x-python",
  sh: "text/x-shellscript",
  rs: "text/x-rust",
  go: "text/x-go",
  java: "text/x-java",
  kt: "text/x-kotlin",
  swift: "text/x-swift",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  html: "text/html",
  css: "text/css",
};

/** Resolve a usable media type, inferring from the filename when the upload omitted one. */
export function inferMediaType(mediaType: string | undefined, name: string): string {
  if (mediaType && mediaType !== "application/octet-stream") return mediaType;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return MEDIA_BY_EXT[ext] ?? mediaType ?? "application/octet-stream";
}

// [SEC-M2] The stored filename is `<id>.<ext>` where `ext` derives from the client-supplied name.
// Reduce it to a leading run of lowercase alphanumerics so it can never contain a path separator or
// `..` and escape the attachments dir. Falls back to the media-type map / "bin" via the caller.
export function sanitizeExt(raw: string): string {
  const m = /^[a-z0-9]{1,12}/.exec(raw.toLowerCase());
  return m ? m[0] : "";
}

// [SEC-M2] `sessionId` / `id` become path segments (`sessions/<sessionId>/attachments/<id>.<ext>`),
// so reject anything that isn't a single safe segment before it reaches the filesystem.
function assertSafeSegment(value: string, label: string): void {
  if (!value || value.includes("/") || value.includes("\\") || value.includes("\0") || value.split(/[/\\]/).includes("..") || value === "." || value === "..") {
    throw new Error(`invalid ${label}: ${JSON.stringify(value)}`);
  }
}

/**
 * Per-session attachment store (arch §6.5). Pasted/dropped images are written under
 * `~/.anvil/sessions/<id>/attachments/` with a small `.json` sidecar (so serving survives a
 * daemon restart). The driver base64-loads them into the user message as image blocks.
 */
export class AttachmentStore {
  constructor(private readonly stateDir: string) {}

  private dir(sessionId: string): string {
    assertSafeSegment(sessionId, "sessionId"); // [SEC-M2] containment before it becomes a path
    const d = join(this.stateDir, "sessions", sessionId, "attachments");
    mkdirSync(d, { recursive: true });
    return d;
  }

  add(sessionId: string, name: string, mediaType: string, dataBase64: string): AttachmentRef {
    const id = newId("att");
    const resolved = inferMediaType(mediaType, name);
    // Prefer the original filename's extension so the stored blob stays recognizable for any
    // type; fall back to the media-type map, then "bin". [SEC-M2] sanitize so the client's name
    // can't inject path separators into `<id>.<ext>`.
    const nameExt = name.includes(".") ? sanitizeExt(name.slice(name.lastIndexOf(".") + 1)) : "";
    const ext = nameExt || EXT[resolved] || "bin";
    const dir = this.dir(sessionId);
    const binPath = join(dir, `${id}.${ext}`);
    writeFileSync(binPath, Buffer.from(dataBase64, "base64"));
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ mediaType: resolved, name, ext }));
    return { id, kind: resolved.startsWith("image/") ? "image" : "file", name, path: binPath };
  }

  /**
   * Streaming upload (§6.5): write the request body straight to disk instead of carrying the bytes
   * as base64 inside a JSON envelope. Base64 inflates the wire by 4/3 AND forces both sides to hold
   * the whole file in memory — the client read it with `readAsDataURL` and re-encoded it into a JSON
   * string (2-3x the file, brutal on a phone), which is what made a large upload fail. `Bun.write`
   * consumes the body as a stream, so peak memory no longer scales with the file.
   */
  async addStream(sessionId: string, name: string, mediaType: string, body: ReadableStream<Uint8Array> | null): Promise<AttachmentRef> {
    const { id, binPath, resolved } = this.prepare(sessionId, name, mediaType);
    // Pump the stream through a FileSink chunk by chunk. NOTE: `Bun.write(path, new Response(body))`
    // reads like the obvious way to do this and DEADLOCKS on Bun 1.3.14 — the request never
    // completes, at any size. Keep the explicit reader loop.
    const sink = Bun.file(binPath).writer();
    try {
      if (body) {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          sink.write(value);
        }
      }
    } finally {
      await sink.end();
    }
    writeFileSync(join(this.dir(sessionId), `${id}.json`), JSON.stringify({ mediaType: resolved, name, ext: binPath.slice(binPath.lastIndexOf(".") + 1) }));
    return { id, kind: resolved.startsWith("image/") ? "image" : "file", name, path: binPath };
  }

  /** The id/extension/media-type decisions shared by the JSON and streaming upload paths. */
  private prepare(sessionId: string, name: string, mediaType: string): { id: string; binPath: string; resolved: string } {
    const id = newId("att");
    const resolved = inferMediaType(mediaType, name);
    const nameExt = name.includes(".") ? sanitizeExt(name.slice(name.lastIndexOf(".") + 1)) : "";
    const ext = nameExt || EXT[resolved] || "bin";
    return { id, binPath: join(this.dir(sessionId), `${id}.${ext}`), resolved };
  }

  private resolve(sessionId: string, id: string): { binPath: string; mediaType: string; name: string } | undefined {
    assertSafeSegment(id, "attachment id"); // [SEC-M2] id arrives from the REST GET path
    const metaPath = join(this.dir(sessionId), `${id}.json`);
    if (!existsSync(metaPath)) return undefined;
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { mediaType: string; name: string; ext: string };
    const ext = sanitizeExt(meta.ext) || "bin"; // defensive: never trust a stored ext into a path
    return { binPath: join(this.dir(sessionId), `${id}.${ext}`), mediaType: meta.mediaType, name: meta.name };
  }

  ref(sessionId: string, id: string): AttachmentRef | undefined {
    const r = this.resolve(sessionId, id);
    if (!r) return undefined;
    return { id, kind: r.mediaType.startsWith("image/") ? "image" : "file", name: r.name, path: r.binPath };
  }

  /** For the REST GET endpoint. */
  bytes(sessionId: string, id: string): { mediaType: string; path: string } | undefined {
    const r = this.resolve(sessionId, id);
    return r && existsSync(r.binPath) ? { mediaType: r.mediaType, path: r.binPath } : undefined;
  }

  /**
   * For feeding the agent — name + media type + base64 of at most `maxBytesFor(mediaType)` bytes.
   *
   * The budget matters: this used to `readFileSync` the WHOLE file and base64 it on every prompt
   * carrying the attachment, even for a binary whose only fate is a one-line "not inlined" note. A
   * large upload therefore spiked multiples of its size in memory for nothing. Now we read only what
   * the content block can actually use, and report the real `size` so the block can say how much was
   * left out.
   */
  loadForAgent(
    sessionId: string,
    id: string,
    maxBytesFor: (mediaType: string) => number,
  ): { mediaType: string; name: string; data: string; size: number; truncated: boolean } | undefined {
    const r = this.resolve(sessionId, id);
    if (!r || !existsSync(r.binPath)) return undefined;
    const size = statSync(r.binPath).size;
    const budget = Math.max(0, maxBytesFor(r.mediaType));
    const take = Math.min(size, budget);
    const buf = Buffer.alloc(take);
    if (take > 0) {
      const fd = openSync(r.binPath, "r");
      try {
        readSync(fd, buf, 0, take, 0);
      } finally {
        closeSync(fd);
      }
    }
    return { mediaType: r.mediaType, name: r.name, data: buf.toString("base64"), size, truncated: size > take };
  }
}
