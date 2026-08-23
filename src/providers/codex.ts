/**
 * Host-side runtime config for the `codex` provider.
 *
 * Registers with `providesAgentSurfaces` — codex owns its agent-facing
 * surfaces, so core skips the default (Claude) compose/mounts and this
 * contribution supplies them instead:
 *
 *   - AGENTS.md — codex's project doc, composed fresh every spawn
 *     (see ./codex-agents-md.ts), mounted RO over the RW group dir.
 *   - .agents/skills — codex-native skill links synced to the group's
 *     container.json selection, mounted RO.
 *   - CODEX_HOME — a per-GROUP private state dir (`.codex-shared`), persistent
 *     across sessions so thread metadata and config.toml survive respawns.
 *
 * Credentials: the group's CODEX_HOME contains a symlink to the operator's
 * existing Codex auth.json. The credential is never copied into group state.
 * Native NanoCodex therefore follows `codex login` and Codex's own credential
 * lifecycle rather than the inherited OneCLI/container gateway.
 *
 * Memory and exchange archiving are NOT handled here either. The shared
 * runner scaffolds memory, while the container-side provider registers its
 * native SessionStart hook and persists exchanges through
 * `onExchangeComplete`.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { materializeTemplateSkills } from '../group-skills.js';
import { composeGroupAgentsMd } from './codex-agents-md.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig(
  'codex',
  async (ctx) => {
    // Per-group codex state (config.toml, thread metadata).
    const codexDir = path.join(DATA_DIR, 'v2-sessions', ctx.agentGroupId, '.codex-shared');
    fs.mkdirSync(codexDir, { recursive: true });
    // Reuse the operator's existing Codex login without copying its secret.
    // Each group still gets isolated thread/config state under .codex-shared.
    const hostCodexHome =
      ctx.hostEnv.CODEX_HOME || (ctx.hostEnv.HOME ? path.join(ctx.hostEnv.HOME, '.codex') : undefined);
    const hostAuth = hostCodexHome ? path.join(hostCodexHome, 'auth.json') : undefined;
    const groupAuth = path.join(codexDir, 'auth.json');
    if (hostAuth && fs.existsSync(hostAuth) && !fs.existsSync(groupAuth)) fs.symlinkSync(hostAuth, groupAuth);

    // Compose this group's AGENTS.md and sync codex-native skill links.
    const group = await getAgentGroup(ctx.agentGroupId);
    if (group) await composeGroupAgentsMd(group, ctx.groupDir);
    syncCodexSkillLinks(ctx.groupDir, ctx.selectedSkills);
    // Template skills live on the Claude plane (.claude-shared/skills); codex
    // reads .agents/skills (RO-mounted), so mirror them here, host-side, via the
    // shared provider-agnostic helper. Real dirs survive the symlink-only prune
    // above and coexist with the shared-skill symlinks it creates.
    materializeTemplateSkills(ctx.agentGroupId, path.join(ctx.groupDir, '.agents', 'skills'));

    // CODEX_HOME is consumed directly by the native runner. The legacy mount
    // remains so opting into the Docker driver continues to work.
    const mounts = [{ hostPath: codexDir, containerPath: '/home/node/.codex', readonly: false }];
    const composedAgentsMd = path.join(ctx.groupDir, 'AGENTS.md');
    if (fs.existsSync(composedAgentsMd)) {
      // RO over the RW group dir — regenerated every spawn, agent edits would
      // be clobbered anyway. Memory behavior is edited via memory/system/.
      mounts.push({ hostPath: composedAgentsMd, containerPath: '/workspace/agent/AGENTS.md', readonly: true });
    }
    const agentsDir = path.join(ctx.groupDir, '.agents');
    if (fs.existsSync(agentsDir)) {
      mounts.push({ hostPath: agentsDir, containerPath: '/workspace/agent/.agents', readonly: true });
      // Codex only scans the CWD-level `.agents/skills` when the CWD is inside a
      // git repo; the agent workspace (/workspace/agent) is not one, so skills
      // materialized there are invisible. Codex DOES scan the user-level
      // `$HOME/.agents/skills` unconditionally, so mount the same dir at $HOME
      // to make the group's template + shared skills discoverable. Verified
      // against codex-cli 0.141: user-level `.agents/skills` resolves at a
      // non-git CWD. Skill materialization stays provider-neutral (group-skills.ts).
      mounts.push({ hostPath: agentsDir, containerPath: '/home/node/.agents', readonly: true });
    }

    return { mounts, env: { CODEX_HOME: codexDir } };
  },
  { providesAgentSurfaces: true },
);

/**
 * Sync `.agents/skills/<name>` symlinks to the selected skill set. Targets are
 * host paths in the shared NanoCodex checkout so native Codex can load them.
 */
function syncCodexSkillLinks(groupDir: string, selectedSkills: string[]): void {
  const skillsDir = path.join(groupDir, '.agents', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  const desired = new Set(selectedSkills);
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desired.has(entry)) fs.unlinkSync(entryPath);
  }

  for (const skill of selectedSkills) {
    const linkPath = path.join(skillsDir, skill);
    try {
      fs.lstatSync(linkPath);
    } catch {
      fs.symlinkSync(path.join(process.cwd(), 'container', 'skills', skill), linkPath);
    }
  }
}
