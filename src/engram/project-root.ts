import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';

/**
 * Deterministic per-project worker port range. Disjoint from upstream's
 * UID-derived default (37700-37799, see SettingsDefaultsManager) so an Engram
 * per-project worker never collides with a legacy global claude-mem worker.
 */
export const PORT_BASE = 37800;
export const PORT_RANGE = 150; // ports 37800..37949

/** `<root>/.mem/.runtime` — git-ignored per-project DB/chroma/logs/pid live here. */
export function projectDataDir(root: string): string {
  return join(root, '.mem', '.runtime');
}

/** Human-readable project label (directory name). Not a stable identity. */
export function projectSlug(root: string): string {
  return basename(root);
}

/**
 * Deterministic worker port derived from the absolute project root. The root
 * path differs per machine (different absolute paths), which is correct — the
 * port is a local runtime concern and is never synced. Same root on the same
 * machine always maps to the same port.
 */
export function projectWorkerPort(root: string): number {
  const digest = createHash('sha1').update(resolve(root)).digest();
  return PORT_BASE + (digest.readUInt32BE(0) % PORT_RANGE);
}
