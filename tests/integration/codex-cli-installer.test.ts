import { describe, expect, it } from 'bun:test';
import {
  setTomlFeatureEnabled,
  setTomlPluginEnabled,
} from '../../src/services/integrations/CodexCliInstaller.js';

describe('Codex CLI installer config repair', () => {
  it('adds engram plugin enablement when missing', () => {
    const result = setTomlPluginEnabled('model = "gpt-5.5"\n', 'engram@engram-local', true);

    expect(result).toContain('[plugins."engram@engram-local"]');
    expect(result).toContain('enabled = true');
  });

  it('updates existing plugin enablement in place', () => {
    const input = [
      '[plugins."engram@engram"]',
      'enabled = true',
      '',
      '[marketplaces.engram-local]',
      'source_type = "git"',
      '',
    ].join('\n');

    const result = setTomlPluginEnabled(input, 'engram@engram', false);

    expect(result).toContain('[plugins."engram@engram"]\nenabled = false');
    expect(result).toContain('[marketplaces.engram-local]');
  });

  it('inserts enabled into an existing plugin section without touching the next section', () => {
    const input = [
      '[plugins."engram@engram-local"]',
      '',
      '[hooks.state]',
      '',
    ].join('\n');

    const result = setTomlPluginEnabled(input, 'engram@engram-local', true);

    expect(result).toContain('[plugins."engram@engram-local"]\nenabled = true\n');
    expect(result).toContain('[hooks.state]');
  });

  it('enables the current Codex hooks feature flag', () => {
    const input = [
      '[features]',
      'shell_snapshot = true',
      '',
      '[plugins."engram@engram-local"]',
      'enabled = true',
      '',
    ].join('\n');

    const result = setTomlFeatureEnabled(input, 'hooks', true);

    expect(result).toContain('[features]\nhooks = true\nshell_snapshot = true');
    expect(result).toContain('[plugins."engram@engram-local"]');
    expect(result).not.toContain('codex_hooks');
  });
});
