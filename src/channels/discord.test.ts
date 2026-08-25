import { createDiscordAdapter } from '@chat-adapter/discord';
import { describe, expect, it, vi } from 'vitest';

import { resolveDiscordThreadSpawnPolicy, suppressDiscordDmMentionThread } from './discord.js';

describe('Discord thread spawn policy', () => {
  it('defaults to manual and keeps mention-created threads as an explicit opt-in', () => {
    expect(resolveDiscordThreadSpawnPolicy(undefined)).toBe('manual');
    expect(resolveDiscordThreadSpawnPolicy(' manual ')).toBe('manual');
    expect(resolveDiscordThreadSpawnPolicy('MENTION')).toBe('mention');
    expect(() => resolveDiscordThreadSpawnPolicy('always')).toThrow(/must be "manual" or "mention"/);
  });

  it('keeps a top-level guild mention on the channel when auto creation is disabled', async () => {
    const adapter = createDiscordAdapter({
      botToken: 'token',
      publicKey: 'a'.repeat(64),
      applicationId: 'bot-id',
      autoCreateThreadsOnMention: false,
    });
    const createThread = vi.fn();
    const handleIncomingMessage = vi.fn();
    const internals = adapter as unknown as {
      chat: { handleIncomingMessage: typeof handleIncomingMessage };
      createDiscordThread: typeof createThread;
      handleForwardedMessage: (data: Record<string, unknown>) => Promise<void>;
    };
    internals.chat = { handleIncomingMessage };
    internals.createDiscordThread = createThread;

    await internals.handleForwardedMessage({
      id: 'message-id',
      guild_id: 'guild-id',
      channel_id: 'channel-id',
      content: '<@bot-id> hello',
      timestamp: '2026-08-24T00:00:00.000Z',
      author: { id: 'user-id', username: 'user', bot: false },
      attachments: [],
      mentions: [{ id: 'bot-id' }],
      mention_roles: [],
      is_mention: true,
    });

    expect(createThread).not.toHaveBeenCalled();
    expect(handleIncomingMessage).toHaveBeenCalledOnce();
    expect(handleIncomingMessage.mock.calls[0]?.[1]).toBe('discord:guild-id:channel-id');
    expect(handleIncomingMessage.mock.calls[0]?.[2]).toMatchObject({ isMention: true });
  });
});

describe('Discord slash command parsing', () => {
  it('keeps optionless subcommands in the command path', () => {
    const adapter = createDiscordAdapter({
      botToken: 'token',
      publicKey: 'a'.repeat(64),
      applicationId: 'bot-id',
    });
    const { parseSlashCommand } = adapter as unknown as {
      parseSlashCommand: (
        name: string,
        options: Array<{ type: number; name: string; value?: string; options?: unknown[] }>,
      ) => { command: string; text: string };
    };

    expect(parseSlashCommand.call(adapter, 'nanocodex', [{ type: 1, name: 'tree' }])).toEqual({
      command: '/nanocodex tree',
      text: '',
    });
    expect(
      parseSlashCommand.call(adapter, 'project', [
        { type: 2, name: 'issue', options: [{ type: 1, name: 'create', options: [] }] },
      ]),
    ).toEqual({ command: '/project issue create', text: '' });
  });

  it('passes string choices through as host-command text', () => {
    const adapter = createDiscordAdapter({
      botToken: 'token',
      publicKey: 'a'.repeat(64),
      applicationId: 'bot-id',
    });
    const { parseSlashCommand } = adapter as unknown as {
      parseSlashCommand: (
        name: string,
        options: Array<{ type: number; name: string; value?: string; options?: unknown[] }>,
      ) => { command: string; text: string };
    };

    expect(
      parseSlashCommand.call(adapter, 'nanocodex', [
        { type: 1, name: 'speed', options: [{ type: 3, name: 'mode', value: 'fast' }] },
      ]),
    ).toEqual({ command: '/nanocodex speed', text: 'fast' });
  });
});

describe('Discord DM mention handling', () => {
  it('keeps DM text but clears the adapter hint that creates an invalid guild thread', () => {
    const data = {
      content: '<@bot-id> hello',
      is_mention: true,
      mentions: [{ id: 'bot-id' }],
    };

    suppressDiscordDmMentionThread(data);

    expect(data).toEqual({
      content: '<@bot-id> hello',
      is_mention: false,
      mentions: [],
    });
  });

  it('leaves guild mention metadata intact so mentions still address the bot', () => {
    const data = {
      guild_id: 'guild-id',
      content: '<@bot-id> hello',
      is_mention: true,
      mentions: [{ id: 'bot-id' }],
    };

    suppressDiscordDmMentionThread(data);

    expect(data).toEqual({
      guild_id: 'guild-id',
      content: '<@bot-id> hello',
      is_mention: true,
      mentions: [{ id: 'bot-id' }],
    });
  });
});
