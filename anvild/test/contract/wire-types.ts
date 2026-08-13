/**
 * Shared helper for the protocol-surface contract test AND regen-golden.ts. Lives outside the
 * .test.ts file because importing a test file from a plain `bun` script throws ("Cannot use test
 * outside of the test runner") — which silently broke `bun test/contract/regen-golden.ts`.
 */

/** Extract every `type: "wire.name"` literal from the protocol source, sorted + de-duped. */
export function extractWireTypes(src: string): string[] {
  const out = new Set<string>();
  const re = /^\s*type:\s*"([^"]+)"/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[1]!);
  return [...out].sort();
}
