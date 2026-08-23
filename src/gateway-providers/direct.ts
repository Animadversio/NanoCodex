/**
 * Direct native gateway.
 *
 * Codex authenticates from the per-group CODEX_HOME prepared by the Codex
 * provider. No proxy variables, credential stubs, or container mounts are
 * added to the session spec.
 */
import { registerGatewayProvider } from './gateway-provider-registry.js';

registerGatewayProvider('direct', () => ({
  kind: 'direct',
  contribute: async () => ({}),
}));
