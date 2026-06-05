// Prints whoamiInfo() for the current env (CLAUDE_MEM_DATA_DIR / ENGRAM_GLOBAL_DIR).
import { whoamiInfo } from '../../../src/services/server/whoami.js';
process.stdout.write(JSON.stringify(whoamiInfo()));
