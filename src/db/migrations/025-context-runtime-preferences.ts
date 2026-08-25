import type { Migration } from './index.js';

/**
 * Durable, per-context Codex runtime preferences.
 *
 * NULL means "inherit the agent/runtime default". Branches snapshot their
 * parent's explicit preferences when the surface is first bound, so a thread
 * can diverge without later trunk changes rewriting its behavior.
 */
export const migration025: Migration = {
  version: 25,
  name: 'context-runtime-preferences',
  async up(db) {
    await db.exec(`
      ALTER TABLE context_nodes ADD COLUMN service_tier TEXT;
      ALTER TABLE context_nodes ADD COLUMN reasoning_effort TEXT;
    `);
  },
};
