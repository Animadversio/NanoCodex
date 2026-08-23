import { describe, expect, it } from 'vitest';

import { NativeSessionDriver } from './native-driver.js';
import { FIXTURE_POLICY, fixtureAuxContainer, fixtureSpec } from './spec-fixture.js';

function nativeSpec() {
  const spec = fixtureSpec({ runtimeTier: 'native', resources: {} });
  spec.containers[0].mounts.push({
    class: 'group-state',
    hostPath: '/install/groups/agent-one',
    containerPath: '/workspace/agent',
    mode: 'rw',
    groupScope: 'g1',
  });
  return spec;
}

describe('NativeSessionDriver', () => {
  it('reports the native host boundary honestly', () => {
    const driver = new NativeSessionDriver(FIXTURE_POLICY);
    expect(driver.capabilities()).toEqual({
      isolationTiers: ['native'],
      admissionEnforced: false,
      networkPolicy: 'host',
      encryptedVolumes: false,
      unrealized: ['memoryMb', 'cpus', 'pidsLimit', 'shmSizeMb'],
      sharedNetworkNamespace: true,
      auxiliaryContainers: false,
      imageBuild: false,
    });
  });

  it('prepares idempotently and exposes native commands without spawning', async () => {
    const driver = new NativeSessionDriver(FIXTURE_POLICY);
    const spec = nativeSpec();
    const first = await driver.prepare(spec);
    const second = await driver.prepare(spec);

    expect(second.name).toBe(first.name);
    expect(await first.status()).toEqual({ phase: 'ready' });
    expect(first.execSpec(['pwd'])).toEqual({ bin: 'pwd', argsTty: [], argsPlain: [] });
  });

  it('refuses container-tier and auxiliary-container specs', async () => {
    const driver = new NativeSessionDriver(FIXTURE_POLICY);
    await expect(driver.prepare(fixtureSpec())).rejects.toThrow(/runtimeTier 'container'/);

    const spec = nativeSpec();
    spec.containers.push(fixtureAuxContainer());
    await expect(driver.prepare(spec)).rejects.toThrow(/auxiliary role 'egress-proxy'/);
  });
});
