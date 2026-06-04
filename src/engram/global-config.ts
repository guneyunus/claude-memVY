import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The GLOBAL Engram config home — holds user-level secrets/config (API keys,
 * model/provider choice, feature flags) that must be shared across all projects.
 * Distinct from a project's per-project runtime dir (`<root>/.mem/.runtime`).
 * Overridable via ENGRAM_GLOBAL_DIR (used by tests and isolated harnesses).
 *
 * Plan B2 will route the secret/provider reads here so a per-project DATA_DIR
 * does not force re-entering API keys per project.
 */
export function globalConfigDir(): string {
  return process.env.ENGRAM_GLOBAL_DIR ?? join(homedir(), '.engram');
}

export function globalSettingsPath(): string {
  return join(globalConfigDir(), 'settings.json');
}

export function globalEnvPath(): string {
  return join(globalConfigDir(), '.env');
}
