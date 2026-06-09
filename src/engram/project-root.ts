import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
  // resolve() here so callers may pass a raw path; idempotent on absolute paths.
  const digest = createHash('sha1').update(resolve(root)).digest();
  return PORT_BASE + (digest.readUInt32BE(0) % PORT_RANGE);
}

/**
 * Resolve the project root for a cwd: the git toplevel if the cwd is inside a
 * repo, otherwise the cwd itself. Always returned as an absolute, normalized
 * path (`resolve`) so downstream hashing/joining is platform-stable (git emits
 * forward slashes on Windows).
 */
export function resolveProjectRoot(cwd: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000, // bound worst-case stall on slow/network FS; catch → resolve(cwd)
    }).trim();
    return out ? resolve(out) : resolve(cwd);
  } catch {
    return resolve(cwd);
  }
}

export interface ProjectRuntime {
  /** Absolute project root (git toplevel or cwd). */
  root: string;
  /** `<root>/.mem/.runtime` — git-ignored per-project runtime data. */
  dataDir: string;
  /**
   * Candidate per-project worker port (deterministic hash of the root).
   * Plan B2 may increment on bind collision and persist the actual chosen port
   * to `<dataDir>/worker.port`; read that for the authoritative bound port.
   */
  port: number;
  /** Directory-name label. */
  slug: string;
}

/** Map a cwd to its full project-local runtime descriptor. */
export function resolveProjectRuntime(cwd: string): ProjectRuntime {
  const root = resolveProjectRoot(cwd);
  return {
    root,
    dataDir: projectDataDir(root),
    port: projectWorkerPort(root),
    slug: projectSlug(root),
  };
}
