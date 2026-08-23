import { describe, expect, it } from 'vitest';

import { configuredGatewayProviderKind, getGatewayProvider, resetGatewayProvider } from './index.js';

describe('direct gateway provider', () => {
  it('is the NanoCodex default and contributes no proxy or credential material', async () => {
    expect(configuredGatewayProviderKind({})).toBe('direct');
    resetGatewayProvider(null);
    const provider = getGatewayProvider();
    expect(provider.kind).toBe('direct');
    await expect(
      provider.contribute({
        key: { installSlug: 'n', agentGroupId: 'g', sessionId: 's' },
        groupName: 'agent',
        capabilities: {
          isolationTiers: ['native'],
          admissionEnforced: false,
          networkPolicy: 'host',
          encryptedVolumes: false,
          unrealized: [],
          sharedNetworkNamespace: true,
          auxiliaryContainers: false,
          imageBuild: false,
        },
      }),
    ).resolves.toEqual({});
  });
});
