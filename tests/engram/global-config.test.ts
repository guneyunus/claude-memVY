import { describe, it, expect, afterEach } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  globalConfigDir,
  globalSettingsPath,
  globalEnvPath,
} from '../../src/engram/global-config.js';

const ORIGINAL = process.env.ENGRAM_GLOBAL_DIR;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ENGRAM_GLOBAL_DIR;
  else process.env.ENGRAM_GLOBAL_DIR = ORIGINAL;
});

describe('global-config', () => {
  it('defaults to ~/.engram', () => {
    delete process.env.ENGRAM_GLOBAL_DIR;
    expect(globalConfigDir()).toBe(join(homedir(), '.engram'));
  });

  it('honors the ENGRAM_GLOBAL_DIR override', () => {
    process.env.ENGRAM_GLOBAL_DIR = join('/custom', 'engram-home');
    expect(globalConfigDir()).toBe(join('/custom', 'engram-home'));
  });

  it('settings + env paths hang off the config dir', () => {
    process.env.ENGRAM_GLOBAL_DIR = join('/custom', 'engram-home');
    expect(globalSettingsPath()).toBe(join('/custom', 'engram-home', 'settings.json'));
    expect(globalEnvPath()).toBe(join('/custom', 'engram-home', '.env'));
  });
});
