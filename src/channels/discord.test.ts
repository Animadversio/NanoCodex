import { describe, expect, it } from 'vitest';

import { suppressDiscordDmMentionThread } from './discord.js';

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

  it('leaves guild mention metadata intact so channel mentions can create threads', () => {
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
