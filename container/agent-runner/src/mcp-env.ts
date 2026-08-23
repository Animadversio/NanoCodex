const NANOCLAW_MCP_ENV_KEYS = [
  'NANOCLAW_SESSION_DIR',
  'NANOCLAW_AGENT_DIR',
  'NANOCLAW_GLOBAL_DIR',
  'NANOCLAW_SKILLS_DIR',
  'NANOCLAW_CONFIG_PATH',
  'NANOCLAW_INBOUND_DB',
  'NANOCLAW_OUTBOUND_DB',
  'NANOCLAW_HEARTBEAT_PATH',
  'NANOCLAW_OUTBOX_DIR',
  'NANOCLAW_ADDITIONAL_DIRECTORIES',
] as const;

/** Explicitly pass native session paths to the built-in MCP subprocess. */
export function builtinMcpEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    NANOCLAW_MCP_ENV_KEYS.flatMap((key) => {
      const value = source[key];
      return value ? [[key, value]] : [];
    }),
  );
}
