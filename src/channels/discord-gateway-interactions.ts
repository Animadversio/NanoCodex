import { log } from '../log.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const APPLICATION_COMMAND_TYPE = 2;
const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface ForwardedApplicationCommandAdapter {
  handleApplicationCommandInteraction?: (
    interaction: Record<string, unknown>,
    options?: { waitUntil?: (task: Promise<unknown>) => void },
  ) => void;
}

/**
 * Acknowledge and dispatch an application command received through the raw
 * Gateway forwarding path. Discord does not accept the local webhook's HTTP
 * response as the interaction acknowledgement, so the callback must be sent
 * directly before Chat SDK runs the command handler.
 */
export async function handleForwardedDiscordApplicationCommand(
  interaction: Record<string, unknown>,
  adapter: ForwardedApplicationCommandAdapter,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  if (interaction.type !== APPLICATION_COMMAND_TYPE) return false;

  const interactionId = interaction.id;
  const interactionToken = interaction.token;
  if (typeof interactionId !== 'string' || typeof interactionToken !== 'string') {
    log.warn('Forwarded Discord application command is missing its interaction identity');
    return true;
  }
  if (!adapter.handleApplicationCommandInteraction) {
    throw new Error('Discord adapter cannot dispatch forwarded application commands');
  }

  const response = await fetchImpl(
    `${DISCORD_API_BASE}/interactions/${encodeURIComponent(interactionId)}/${encodeURIComponent(interactionToken)}/callback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE }),
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Discord interaction acknowledgement failed (${response.status}): ${detail}`);
  }

  let commandTask: Promise<unknown> | undefined;
  adapter.handleApplicationCommandInteraction(interaction, {
    waitUntil: (task) => {
      commandTask = task;
    },
  });
  await commandTask;
  return true;
}
