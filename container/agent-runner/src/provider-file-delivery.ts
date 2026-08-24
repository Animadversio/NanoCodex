import fs from 'fs';
import path from 'path';

import { writeMessageOut } from './db/messages-out.js';
import type { RoutingContext } from './formatter.js';
import { OUTBOX_DIR } from './paths.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Stage a provider-produced artifact in the session outbox for channel delivery. */
export async function deliverProviderFile(
  sourcePath: string,
  routing: RoutingContext,
  outboxDir = OUTBOX_DIR,
): Promise<string> {
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) throw new Error(`Provider artifact is not a file: ${sourcePath}`);
  if (!routing.channelType || !routing.platformId) {
    throw new Error('Provider artifact has no channel destination');
  }

  const id = generateId();
  const filename = path.basename(sourcePath);
  const messageOutbox = path.join(outboxDir, id);
  fs.mkdirSync(messageOutbox, { recursive: true });
  fs.copyFileSync(sourcePath, path.join(messageOutbox, filename));

  await writeMessageOut({
    id,
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text: '', files: [filename] }),
  });
  return id;
}
