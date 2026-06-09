import { DATA_DIR, DB_PATH } from '../../shared/paths.js';
import { getWorkerPort } from '../../shared/worker-utils.js';

export interface WhoamiInfo {
  /** The per-project data dir this worker is bound to. */
  dataDir: string;
  /** The per-project SQLite db file. */
  dbPath: string;
  /** The port this worker resolves to. */
  port: number;
}

/** Identity of THIS worker — used by claimPort to verify port ownership. */
export function whoamiInfo(): WhoamiInfo {
  return { dataDir: DATA_DIR, dbPath: DB_PATH, port: getWorkerPort() };
}
