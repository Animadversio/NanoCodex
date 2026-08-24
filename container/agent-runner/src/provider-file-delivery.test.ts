import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getUndeliveredMessages } from './db/messages-out.js';
import { closeSessionDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { deliverProviderFile } from './provider-file-delivery.js';

let tempDir: string;

beforeEach(() => {
  initTestSessionDb();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocodex-provider-file-'));
});

afterEach(() => {
  closeSessionDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('deliverProviderFile', () => {
  it('copies a generated image to the outbox and routes it to the active Discord thread', async () => {
    const imagePath = path.join(tempDir, 'ig_test.png');
    const outboxDir = path.join(tempDir, 'outbox');
    fs.writeFileSync(imagePath, 'png-bytes');

    const id = await deliverProviderFile(
      imagePath,
      {
        channelType: 'discord',
        platformId: 'channel-1',
        threadId: 'thread-1',
        inReplyTo: 'inbound-1',
        taskRun: false,
      },
      outboxDir,
    );

    expect(fs.readFileSync(path.join(outboxDir, id, 'ig_test.png'), 'utf8')).toBe('png-bytes');
    const messages = getUndeliveredMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id,
      in_reply_to: 'inbound-1',
      kind: 'chat',
      platform_id: 'channel-1',
      channel_type: 'discord',
      thread_id: 'thread-1',
    });
    expect(JSON.parse(messages[0].content)).toEqual({ text: '', files: ['ig_test.png'] });
  });
});
