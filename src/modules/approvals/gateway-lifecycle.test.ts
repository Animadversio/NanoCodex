import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { configuredGatewayProviderKind } from '../../gateway-providers/index.js';
import { startGatewayApprovalHandler, stopGatewayApprovalHandler } from './gateway-lifecycle.js';
import { startOneCLIApprovalHandler, stopOneCLIApprovalHandler } from './onecli-approvals.js';

vi.mock('../../gateway-providers/index.js', () => ({
  configuredGatewayProviderKind: vi.fn(),
}));

vi.mock('./onecli-approvals.js', () => ({
  startOneCLIApprovalHandler: vi.fn(),
  stopOneCLIApprovalHandler: vi.fn(),
}));

const adapter = { deliver: vi.fn() } as unknown as ChannelDeliveryAdapter;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gateway approval lifecycle', () => {
  it('does not start OneCLI approvals for the native direct gateway', () => {
    vi.mocked(configuredGatewayProviderKind).mockReturnValue('direct');

    startGatewayApprovalHandler(adapter);

    expect(startOneCLIApprovalHandler).not.toHaveBeenCalled();
  });

  it('starts OneCLI approvals only when the OneCLI gateway is selected', () => {
    vi.mocked(configuredGatewayProviderKind).mockReturnValue('onecli');

    startGatewayApprovalHandler(adapter);

    expect(startOneCLIApprovalHandler).toHaveBeenCalledWith(adapter);
  });

  it('stops optional gateway approval plumbing safely', () => {
    stopGatewayApprovalHandler();

    expect(stopOneCLIApprovalHandler).toHaveBeenCalledOnce();
  });
});
