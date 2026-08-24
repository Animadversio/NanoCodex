# NanoCodex

NanoCodex is a native, multi-user Discord front end for the Codex agent loop. It keeps NanoClaw's routing, sessions, mailboxes, roles, and channel UX, but executes each agent through `codex app-server` on the host instead of through Claude in Docker.

This branch is an MVP. The native Codex + Discord path works and is tested; the inherited NanoClaw Docker, Claude, setup, and migration code remains in the tree for compatibility but is not part of the default path.

## What works

- Native Bun agent runners; Docker is not required.
- Durable Codex threads with per-agent-group `CODEX_HOME` state.
- Discord DMs, channels, threads, and multiple authorized participants.
- Codex `workspace-write` sandbox with `on-request` approvals and `auto_review` as the reviewer.
- Guardian review events persisted in session history.
- Human override only after Guardian denies an action; approval is restricted to the designated owner/admin and applies to the exact reviewed action.
- Inbound/outbound mailbox history through `ncl sessions history`.
- Markdown exchange archives under each group workspace.

See [the architecture and context design](docs/nanocodex-architecture.md) for the security boundary, current limitations, and the planned jump/fork/merge context model.

## Native quick start

Requirements:

- macOS or Linux
- Node.js 22+, pnpm 10+, and [Bun](https://bun.sh)
- Codex CLI 0.146.0 or newer, authenticated with `codex login`
- A Discord bot with Message Content Intent enabled and its token

Install dependencies:

```bash
pnpm install
(cd container/agent-runner && bun install)
cp .env.example .env
```

Fill `DISCORD_BOT_TOKEN` in `.env`. `DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY` are supported but are not required for the gateway connection. To reuse credentials without copying them, set `NANOCLAW_DISCORD_ENV_FILE` to an absolute path containing those Discord keys; NanoCodex reads that file directly and does not place the token in an agent child's environment. Then verify the native environment:

Discord thread creation is manual by default: a top-level `@mention` stays in the channel's shared context, while a Discord thread created by a person becomes a context branch when the bot first handles a message there. Set `DISCORD_THREAD_SPAWN_POLICY=mention` in the Discord environment file only if you want the older mention-created-thread behavior.

NanoCodex registers a `/nanocodex` Discord command at startup. Use `/nanocodex where` to inspect the context bound to the current channel or thread, and `/nanocodex tree` to see that channel's trunk and branches. These commands are handled by the host and are never added to the model's conversation history.

```bash
pnpm native:doctor
```

For example, to reuse a stopped NanoClawV2 installation's credentials:

```bash
NANOCLAW_DISCORD_ENV_FILE=/absolute/path/to/nanoclawV2/.env pnpm native:doctor
NANOCLAW_DISCORD_ENV_FILE=/absolute/path/to/nanoclawV2/.env pnpm dev
```

Start NanoCodex in the first terminal:

```bash
pnpm dev
```

Enable Discord Developer Mode, copy your numeric user ID, and wire the first owner from a second terminal. Replace the example ID and names:

```bash
NANOCLAW_PICKED_PROVIDER=codex pnpm exec tsx scripts/init-first-agent.ts \
  --channel discord \
  --user-id 123456789012345678 \
  --platform-id discord:@me:123456789012345678 \
  --display-name "Your Name" \
  --agent-name "Andy" \
  --role owner
```

The initialization command must run while the service is up because it sends the welcome turn through the service socket. Invite the bot to a server with permission to view channels, send messages, read history, and use threads. Mention it in a shared channel; unknown participants go through NanoClaw's existing authorization flow.

Do not use `nanoclaw.sh` or `pnpm setup:auto` for this MVP: those are inherited container/OneCLI setup paths and have not yet been replaced by the native installer.

## Authority model

```text
Discord participants
        |
        v
NanoClaw routing + roles + per-session mailboxes
        |
        v
native Bun runner -> codex app-server -> Codex tools
                         |
                         +-- safe/approved by auto-review -> continue
                         |
                         +-- Guardian denial -> owner/admin approval card
                                                   |
                                   approve exact action or reject
```

The host process is not a security sandbox. Native agents run with the operator's OS identity and host network. Filesystem command execution is bounded by Codex's `workspace-write` sandbox, and Codex Guardian is the action reviewer. The NanoCodex bridge itself fails closed on direct app-server approval callbacks so a model cannot self-approve around Guardian.

Because this uses a temporary/unstable Guardian app-server API, the CLI version is pinned in `container/cli-tools.json` and the protocol bridge has integration coverage. Upgrading Codex should be followed by the provider test suite.

## Useful commands

```bash
# Host typecheck and tests
pnpm typecheck
pnpm test

# Runner typecheck and tests
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun test)

# Inspect a session's durable mailbox history
pnpm ncl sessions history <session-id> --limit 100
pnpm ncl sessions history <session-id> --limit 100 --json
```

## Provenance

NanoCodex is currently a focused fork/prototype based on [NanoClaw](https://github.com/nanocoai/nanoclaw), with Codex provider behavior grounded in the local [OpenAI Codex](https://github.com/openai/codex) app-server implementation.

## License

MIT
