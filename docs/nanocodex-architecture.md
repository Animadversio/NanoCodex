# NanoCodex architecture and context design

## The integration boundary

NanoClaw and Codex solve different halves of the product:

| Concern                | NanoClaw contribution                           | Codex contribution                      |
| ---------------------- | ----------------------------------------------- | --------------------------------------- |
| Multi-person UI        | Discord adapter, threads, mentions, delivery    | None                                    |
| Identity and authority | Users, owner/admin/member roles, approval cards | Tool/action review                      |
| Durable routing        | Messaging group -> agent group -> session       | Durable thread ID within a session      |
| Agent loop             | Wake, mailbox polling, response delivery        | Model turns, tools, sandbox, compaction |
| History                | Inbound/outbound SQLite mailboxes               | Rollout JSONL and resumable thread      |

The difficult mismatch is that NanoClaw originally treated a Claude container as both the execution unit and isolation boundary, while Codex owns a long-lived thread and its own approval/sandbox protocol. NanoCodex keeps the host/router and replaces the per-session execution realization with a native Bun runner plus `codex app-server`.

## Runtime flow

1. A Discord event is normalized and routed to a NanoClaw session.
2. The host writes the event to that session's `inbound.db` and starts or wakes its native runner.
3. The runner starts `codex app-server`, continuing the session's persisted Codex thread when available.
4. Codex performs the turn with `sandboxMode=workspace-write`, `approvalPolicy=on-request`, and `approvalsReviewer=auto_review`.
5. Text and system events are written to `outbound.db`; the host delivers them to Discord.
6. The provider archives the exchange as Markdown and Codex persists its rollout under the group's private `CODEX_HOME`.

One agent group can have multiple sessions. Each session has independent channel history and a Codex thread; group instructions, skills, and workspace memory are shared at the agent-group level.

## Guardian and human override

The app-server client handlers decline direct command/file/patch approval requests. That makes the bridge fail closed: only Codex's auto-review path can allow normal execution.

Completed Guardian reviews are persisted as system history. An allowed review needs no human interaction. A denied assessment produces an approval card containing its risk level, rationale, and exact reviewed action. NanoClaw's approval primitive verifies that the responder is the targeted approver and is still an authorized owner/admin. Approval sends the original assessment to `thread/approveGuardianDeniedAction`, then asks Codex to retry only that exact action. Rejection records a negative response and does not grant or retry anything.

This is an authority bridge, not a second policy engine: Codex remains the judge; Discord supplies the authorized human override.

## Security boundary

Native mode intentionally has the host user's filesystem identity and network. It does not claim Docker isolation, network containment, resource limits, or encrypted per-session volumes. Its effective controls are:

- Codex `workspace-write` sandbox for command/file execution.
- Codex Guardian automatic review.
- Fail-closed app-server approval callbacks.
- NanoClaw role checks for human overrides and participant admission.
- Per-group Codex state and per-session mailboxes.

An allowlisted host mount still expands what a session can read or write. Treat owner/admin assignment and mount configuration as privileged operations.

## History now

There are three durable layers:

- Session mailboxes: complete routed inbound/outbound records, viewable with `ncl sessions history`.
- Exchange archives: readable Markdown in `groups/<group>/conversations/`.
- Codex rollouts: model-visible thread state and compaction history in `data/v2-sessions/<group>/.codex-shared/sessions/`.

The NanoClaw session ID and Codex thread ID should remain separate identifiers. That lets channel sessions be rewired without rewriting model history, and lets future context operations create new thread lineage safely.

## Future context operations

The app-server already exposes primitives such as thread read, fork, rollback, and item injection. NanoCodex should build user-facing context control as immutable lineage metadata rather than editing history in place:

- **Jump**: create or select a pointer to an earlier turn, then fork a new Codex thread from that point.
- **Split**: fork one session/thread into two named branches while retaining a common ancestor.
- **Merge**: create a new thread with bounded summaries or selected items from two source branches; do not splice two rollout files.
- **Attach context**: inject a bounded, provenance-labelled reference to another session or branch.

A future lineage table should record source session/thread IDs, source turn/item IDs, operation type, actor, timestamp, and the derived thread ID. Raw source history remains immutable. Every injected fragment must have a hard size cap so context merging cannot create unbounded prompts or destroy model-cache locality.

## Remaining MVP gaps

- The inherited automated installer is still container/OneCLI-oriented; native bootstrap is currently documented/manual.
- A real Discord/model turn needs operator credentials and cannot be covered by the hermetic test suite.
- Guardian app-server APIs are unstable and must be revalidated when Codex CLI is upgraded.
- Native runners are in-memory child processes, so host restart adoption cannot recover already-running processes the way the Docker driver can; durable mailboxes allow pending work to be restarted.
- Jump/split/merge controls are designed but not implemented.
