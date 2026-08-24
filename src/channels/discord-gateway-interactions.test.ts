import { describe, expect, it, vi } from 'vitest';

import { handleForwardedDiscordApplicationCommand } from './discord-gateway-interactions.js';

describe('forwarded Discord application commands', () => {
  it('acknowledges the interaction before dispatching it through Chat SDK', async () => {
    const sequence: string[] = [];
    const fetchImpl = vi.fn(async () => {
      sequence.push('acknowledge');
      return new Response(null, { status: 204 });
    });
    const handleApplicationCommandInteraction = vi.fn(
      (_interaction: Record<string, unknown>, options?: { waitUntil?: (task: Promise<unknown>) => void }) => {
        sequence.push('dispatch');
        options?.waitUntil?.(
          Promise.resolve().then(() => {
            sequence.push('complete');
          }),
        );
      },
    );
    const interaction = { type: 2, id: 'interaction-id', token: 'interaction-token' };

    await expect(
      handleForwardedDiscordApplicationCommand(interaction, { handleApplicationCommandInteraction }, fetchImpl),
    ).resolves.toBe(true);

    expect(sequence).toEqual(['acknowledge', 'dispatch', 'complete']);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://discord.com/api/v10/interactions/interaction-id/interaction-token/callback',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 5 }),
      },
    );
    expect(handleApplicationCommandInteraction).toHaveBeenCalledWith(interaction, {
      waitUntil: expect.any(Function),
    });
  });

  it('leaves non-command interactions for the existing component path', async () => {
    const fetchImpl = vi.fn();
    const handleApplicationCommandInteraction = vi.fn();

    await expect(
      handleForwardedDiscordApplicationCommand(
        { type: 3, id: 'interaction-id', token: 'interaction-token' },
        { handleApplicationCommandInteraction },
        fetchImpl,
      ),
    ).resolves.toBe(false);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(handleApplicationCommandInteraction).not.toHaveBeenCalled();
  });

  it('does not dispatch when Discord rejects the acknowledgement', async () => {
    const fetchImpl = vi.fn(async () => new Response('expired interaction', { status: 404 }));
    const handleApplicationCommandInteraction = vi.fn();

    await expect(
      handleForwardedDiscordApplicationCommand(
        { type: 2, id: 'interaction-id', token: 'interaction-token' },
        { handleApplicationCommandInteraction },
        fetchImpl,
      ),
    ).rejects.toThrow('Discord interaction acknowledgement failed (404): expired interaction');

    expect(handleApplicationCommandInteraction).not.toHaveBeenCalled();
  });
});
