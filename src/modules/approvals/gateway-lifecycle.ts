import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { configuredGatewayProviderKind } from '../../gateway-providers/index.js';
import { startOneCLIApprovalHandler, stopOneCLIApprovalHandler } from './onecli-approvals.js';

/** Start approval plumbing owned by the configured credential gateway. */
export function startGatewayApprovalHandler(adapter: ChannelDeliveryAdapter): void {
  if (configuredGatewayProviderKind() !== 'onecli') return;
  startOneCLIApprovalHandler(adapter);
}

/** Stop any optional gateway approval plumbing during host shutdown. */
export function stopGatewayApprovalHandler(): void {
  stopOneCLIApprovalHandler();
}
