// Prints Engram path resolution for the current env. Run via:
//   bun tests/engram/fixtures/probe-paths.ts
// with CLAUDE_MEM_DATA_DIR (per-project) and ENGRAM_GLOBAL_DIR (global) set.
import { USER_SETTINGS_PATH, DB_PATH, GLOBAL_CONFIG_DIR, DATA_DIR, paths } from '../../../src/shared/paths.js';

process.stdout.write(JSON.stringify({
  globalDir: GLOBAL_CONFIG_DIR,
  dataDir: DATA_DIR,
  settingsConst: USER_SETTINGS_PATH,
  settingsFn: paths.settings(),
  envFile: paths.envFile(),
  db: DB_PATH,
  chroma: paths.chroma(),
}));
