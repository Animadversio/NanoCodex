/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile, resolveEnvFilePath } from '../env.js';
import { log } from '../log.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import { handleNanoCodexDiscordCommand, registerNanoCodexDiscordCommand } from './discord-context-controls.js';

/**
 * Dedicated bot app on a threaded platform. Group conversations require a
 * fresh platform mention for every response by default; always-on or sticky
 * engagement must be an explicit per-wiring choice. dm.threads:false — DM
 * replies land top-level, one session per DM.
 */
const DISCORD_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

export type DiscordThreadSpawnPolicy = 'manual' | 'mention';

/**
 * A mention addresses the bot; it does not imply a new conversation branch.
 * Keep the adapter's historical behavior available as an explicit opt-in for
 * installations that still want mention-created public threads.
 */
export function resolveDiscordThreadSpawnPolicy(value: string | undefined): DiscordThreadSpawnPolicy {
  const normalized = value?.trim().toLowerCase() || 'manual';
  if (normalized === 'manual' || normalized === 'mention') return normalized;
  throw new Error(`DISCORD_THREAD_SPAWN_POLICY must be "manual" or "mention", got "${value}"`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

/**
 * Discord message forwards carry their content in `message_snapshots`, not
 * `content` (`message_reference.type === 1` means FORWARD; 0 is a normal
 * reply). The adapter only reads `content`/`attachments`, so without this the
 * agent sees an empty message. Unwrap the snapshot back into the payload so
 * text, attachment download, and formatting all ride the existing path.
 * Note: snapshots contain no author, so the original sender is unavailable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapForwardedSnapshot(data: Record<string, any>): void {
  if (data.message_reference?.type !== 1) return;
  const snaps = (data.message_snapshots ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((s: any) => s?.message)
    .filter(Boolean);
  if (snaps.length === 0) return;
  const text = snaps
    .map((m: any) => m.content)
    .filter(Boolean)
    .join('\n');
  const label = '[Forwarded message]';
  data.content = text ? `${label}\n${text}` : data.content || label;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fwdAttachments = snaps.flatMap((m: any) => m.attachments ?? []);
  if (fwdAttachments.length > 0) {
    data.attachments = [...(data.attachments ?? []), ...fwdAttachments];
  }
}

/**
 * When mention-created threads are explicitly enabled, Discord DMs still
 * cannot host those guild threads. Clear the adapter's mention hint in DMs to
 * avoid a noisy `Unknown Guild` request before falling back to the DM.
 * A DM is already unambiguously addressed to the bot; clear only the adapter's
 * mention hint while preserving the original message text.
 */
export function suppressDiscordDmMentionThread(data: Record<string, unknown>): void {
  if (data.guild_id) return;
  data.is_mention = false;
  data.mentions = [];
}

function unwrapForwards(adapter: ReturnType<typeof createDiscordAdapter>): void {
  const a = adapter as unknown as {
    handleForwardedMessage: (data: Record<string, unknown>, options?: unknown) => Promise<void>;
  };
  const orig = a.handleForwardedMessage.bind(adapter);
  a.handleForwardedMessage = async (data, options) => {
    unwrapForwardedSnapshot(data);
    suppressDiscordDmMentionThread(data);
    return orig(data, options);
  };
}

registerChannelAdapter('discord', {
  factory: () => {
    const discordEnvFile = resolveEnvFilePath('NANOCLAW_DISCORD_ENV_FILE');
    const env = readEnvFile(
      ['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID', 'DISCORD_THREAD_SPAWN_POLICY'],
      discordEnvFile,
    );
    if (!env.DISCORD_BOT_TOKEN) return null;
    const threadSpawnPolicy = resolveDiscordThreadSpawnPolicy(env.DISCORD_THREAD_SPAWN_POLICY);
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      publicKey: env.DISCORD_PUBLIC_KEY,
      applicationId: env.DISCORD_APPLICATION_ID,
      autoCreateThreadsOnMention: threadSpawnPolicy === 'mention',
    });
    unwrapForwards(discordAdapter);
    const bridge = createChatSdkBridge({
      adapter: discordAdapter,
      concurrency: 'concurrent',
      botToken: env.DISCORD_BOT_TOKEN,
      extractReplyContext,
      supportsThreads: true,
      defaults: DISCORD_DEFAULTS,
      slashCommands: {
        commands: [
          '/nanocodex help',
          '/nanocodex where',
          '/nanocodex tree',
          '/nanocodex lineage',
          '/nanocodex status',
          '/nanocodex history',
          '/nanocodex speed',
          '/nanocodex thinking',
        ],
        handle: handleNanoCodexDiscordCommand,
      },
      // Discord rejects messages over 2000 chars; without this the bridge
      // would let long agent replies fail instead of splitting them.
      maxTextLength: 2000,
    });
    const setup = bridge.setup.bind(bridge);
    bridge.setup = async (hostConfig) => {
      try {
        await registerNanoCodexDiscordCommand({
          applicationId: env.DISCORD_APPLICATION_ID,
          botToken: env.DISCORD_BOT_TOKEN,
        });
        log.info('Discord application command registered', { command: 'nanocodex' });
        // eslint-disable-next-line no-catch-all/no-catch-all -- command sync must not take the Discord gateway offline
      } catch (err) {
        log.warn('Discord application command registration failed; gateway will still start', { err });
      }
      await setup(hostConfig);
    };
    return bridge;
  },
  defaults: DISCORD_DEFAULTS,
});
