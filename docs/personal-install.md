# Personal installation on another device

This guide reproduces the native NanoCodex deployment used by this repository. It is intentionally opinionated: one trusted operator, one local checkout, Codex running as that operator's OS user, and Discord as the interface.

The best-tested path is macOS with `launchd`. Linux with a user-level `systemd` service is supported, but has had less live testing.

## Before you start

Use a separate Discord application and bot token for each simultaneously running device. Two NanoCodex hosts connected with the same bot token can both receive the same Discord events and produce duplicate replies. Reusing a token is reasonable only when the old installation is stopped.

You need:

- Git.
- Node.js 22 or newer.
- pnpm 10 or newer.
- [Bun](https://bun.sh/).
- Codex CLI 0.146.0 or newer.
- A Discord application whose bot has Message Content Intent enabled.

Install the current Codex CLI on macOS or Linux using the official installer:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex login
codex login status
```

`codex login` uses the ChatGPT browser flow by default. An API key is also supported, but it is billed through the API account rather than a ChatGPT subscription. On a headless machine, use `codex login --device-auth`.

## 1. Create and invite the Discord bot

In the Discord Developer Portal:

1. Create an application and add a bot.
2. Enable **Message Content Intent** under the bot's privileged gateway intents.
3. Copy the bot token. Treat it as a password.
4. Invite the bot with the `bot` and `applications.commands` scopes.
5. Give it permission to view channels, send messages, read message history, create and use threads, and attach files.

For a personal multi-device setup, name bots by host, such as `NanoCodex-MacBook` and `NanoCodex-Desktop`.

## 2. Clone and install NanoCodex

The repository is private. Authenticate the new device with GitHub first, using either `gh auth login` plus `gh auth setup-git`, or an SSH key attached to your GitHub account.

```bash
gh auth login
gh auth setup-git
git clone https://github.com/Animadversio/NanoCodex.git
cd NanoCodex
pnpm install
(cd container/agent-runner && bun install)
cp .env.example .env
```

Edit `.env` and set at least:

```dotenv
DISCORD_BOT_TOKEN=your-device-specific-token
DEFAULT_AGENT_PROVIDER=codex
NANOCLAW_RUNTIME_DRIVER=native
NANOCLAW_GATEWAY_PROVIDER=direct
ASSISTANT_NAME=Clarinda
TZ=America/New_York
```

`DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY` are optional for the gateway connection. NanoCodex discovers the application ID from the authenticated bot and registers `/nanocodex` at startup.

If the token already lives in another protected env file, keep the token there and put only an absolute pointer in NanoCodex's `.env`:

```dotenv
NANOCLAW_DISCORD_ENV_FILE=/absolute/path/to/discord.env
```

Do not commit `.env`, `data/`, `groups/`, or `logs/`. They are ignored by Git and contain installation-specific state.

## 3. Check the native prerequisites

```bash
pnpm native:doctor
```

Every line should show a check mark. In particular, confirm that Codex is logged in and the Discord token is found.

## 4. Install the background service

Run the focused service step, not the inherited container-oriented automatic setup:

```bash
pnpm exec tsx setup/index.ts --step service
```

This command is idempotent. It:

- builds NanoCodex;
- records the current Git commit for the startup safety check;
- installs or refreshes the checkout-specific `launchd`/`systemd` service;
- preserves the actual Node, Bun, and Codex locations in the service PATH;
- installs `ncl` into `~/.local/bin` when possible; and
- starts or restarts NanoCodex.

Confirm startup:

```bash
tail -n 100 logs/nanoclaw.log
tail -n 100 logs/nanoclaw.error.log
```

The normal log should end with `NanoClaw running` and `Discord Gateway connected`.

On macOS, inspect the exact checkout-specific service with:

```bash
source setup/lib/install-slug.sh
launchctl print "gui/$(id -u)/$(launchd_label)"
```

On Linux with user systemd:

```bash
source setup/lib/install-slug.sh
systemctl --user status "$(systemd_unit)"
```

## 5. Create the first owner and agent

Enable Discord Developer Mode and copy your numeric Discord user ID. Then run this while the NanoCodex service is online:

```bash
NANOCLAW_PICKED_PROVIDER=codex pnpm exec tsx scripts/init-first-agent.ts \
  --channel discord \
  --user-id 123456789012345678 \
  --platform-id discord:@me:123456789012345678 \
  --display-name "Your Name" \
  --agent-name "Clarinda" \
  --role owner
```

The command creates the owner role, agent group, DM binding, native runtime configuration, and first welcome turn. It is safe to rerun: existing records are reused.

Send the bot a DM. In a server channel, mention the bot to address the channel's shared context. Creating a native Discord thread is the deliberate context-branch action; ordinary mentions do not create threads.

Use these host-owned controls to inspect routing without consuming a model turn:

- `/nanocodex where`
- `/nanocodex tree`
- `/nanocodex lineage`
- `/nanocodex history`
- `/nanocodex status`
- `/nanocodex speed` (`normal` or `fast`; owner/admin)
- `/nanocodex thinking` (`default`, `low`, `medium`, `high`, or `xhigh`; owner/admin)

Speed and thinking are stored per context. A server channel and its manually created thread branches can therefore use different latency/depth tradeoffs without losing their Codex conversation history.

## Updating an installed device

Commit or discard local source changes first, then:

```bash
git pull --ff-only
pnpm install
(cd container/agent-runner && bun install)
pnpm native:doctor
pnpm exec tsx setup/index.ts --step service
```

The final service step rebuilds, updates the startup marker, and restarts the correct checkout-specific service. Do not edit `dist/` directly.

## Moving an existing identity instead of creating a new one

For a fresh independent agent, do not copy anything except your desired configuration and use a separate Discord bot.

To move the existing agent and its context to another device:

1. Stop NanoCodex on the old device.
2. Copy `.env`, `data/`, and `groups/` over a private channel.
3. Protect those files as secrets; `data/` contains session and Codex state.
4. Run the dependency, doctor, and service steps on the new device.
5. Keep the old service stopped if both installations use the same Discord token.

Never synchronize a live `data/` directory between two running devices. SQLite mailboxes and Codex runtime state are installation-owned, not a multi-writer database.

## Security notes

NanoCodex native mode runs as your OS user. Codex supplies the `workspace-write` sandbox, automatic Guardian review, and escalation boundary, but this is not Docker or a separate Unix account. Only install it on a device and account you trust.

Codex authentication is stored by the Codex CLI in the OS credential store or under `~/.codex`. Discord credentials remain host-side and are not forwarded into the agent runner.

For current Codex installation and authentication details, see the official [Codex CLI guide](https://developers.openai.com/codex/cli) and [authentication guide](https://developers.openai.com/codex/auth).
