import path from 'path';
import { fileURLToPath } from 'url';

export const SESSION_DIR = process.env.NANOCLAW_SESSION_DIR || '/workspace';
export const AGENT_DIR = process.env.NANOCLAW_AGENT_DIR || '/workspace/agent';
export const GLOBAL_DIR = process.env.NANOCLAW_GLOBAL_DIR || '/workspace/global';
export const RUNNER_SRC_DIR =
  process.env.NANOCLAW_RUNNER_SRC || path.dirname(fileURLToPath(import.meta.url));
export const SKILLS_DIR = process.env.NANOCLAW_SKILLS_DIR || '/app/skills';
export const CONFIG_PATH = process.env.NANOCLAW_CONFIG_PATH || path.join(AGENT_DIR, 'container.json');
export const INBOUND_DB_PATH = process.env.NANOCLAW_INBOUND_DB || path.join(SESSION_DIR, 'inbound.db');
export const OUTBOUND_DB_PATH = process.env.NANOCLAW_OUTBOUND_DB || path.join(SESSION_DIR, 'outbound.db');
export const HEARTBEAT_PATH = process.env.NANOCLAW_HEARTBEAT_PATH || path.join(SESSION_DIR, '.heartbeat');
export const OUTBOX_DIR = process.env.NANOCLAW_OUTBOX_DIR || path.join(SESSION_DIR, 'outbox');

export function additionalDirectoriesFromEnv(): string[] {
  const raw = process.env.NANOCLAW_ADDITIONAL_DIRECTORIES;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === 'string' && value.length > 0);
    }
  } catch {
    // Hand-written values may use the platform path delimiter.
  }
  return raw.split(path.delimiter).filter(Boolean);
}
