import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatRequestScope } from '../src/features/client-chat/chatRequestScope';

test('chat request follows cancellation from any parent without AbortSignal.any', () => {
  const first = new AbortController();
  const second = new AbortController();
  const request = createChatRequestScope([first.signal, undefined, second.signal], 60_000);
  assert.equal(request.signal.aborted, false);
  second.abort();
  assert.equal(request.signal.aborted, true);
  request.dispose();
});

test('already cancelled chat request cannot be started and disposal detaches parents', () => {
  const cancelled = new AbortController();
  cancelled.abort();
  const request = createChatRequestScope([cancelled.signal], 60_000);
  assert.equal(request.signal.aborted, true);
  request.dispose();
  const parent = new AbortController();
  const completed = createChatRequestScope([parent.signal], 60_000);
  completed.dispose();
  parent.abort();
  assert.equal(completed.signal.aborted, false);
});

test('chat request deadline cancels stalled reads and history loads', async () => {
  const request = createChatRequestScope([], 5);
  await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }));
  assert.equal(request.signal.aborted, true);
  request.dispose();
});
