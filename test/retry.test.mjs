import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { fetchWithRetry } from '../src/lib/retry.js';

let statusAttempts = 0;
const statusServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch() {
    statusAttempts += 1;
    if (statusAttempts < 3) return new Response('temporary', { status: 503 });
    return new Response('status-ok');
  },
});

let socketAttempts = 0;
const socketServer = createServer((socket) => {
  socket.once('data', () => {
    socketAttempts += 1;
    if (socketAttempts < 3) {
      socket.destroy();
      return;
    }
    socket.end('HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nsocket-ok');
  });
});

await new Promise((resolve, reject) => {
  socketServer.once('error', reject);
  socketServer.listen(0, '127.0.0.1', resolve);
});

try {
  const statusText = await fetchWithRetry(
    `http://127.0.0.1:${statusServer.port}/`,
    {},
    {
      attempts: 4,
      delaysMs: [5, 10, 15],
      timeoutMs: 1_000,
      label: '状态测试',
      consume: (response) => response.text(),
    }
  );
  assert.equal(statusText, 'status-ok');
  assert.equal(statusAttempts, 3, 'HTTP 503 should succeed on the third attempt');

  const socketPort = socketServer.address().port;
  const socketText = await fetchWithRetry(
    `http://127.0.0.1:${socketPort}/`,
    {},
    {
      attempts: 4,
      delaysMs: [5, 10, 15],
      timeoutMs: 1_000,
      label: '断线测试',
      consume: (response) => response.text(),
    }
  );
  assert.equal(socketText, 'socket-ok');
  assert.equal(socketAttempts, 3, 'socket close should succeed on the third attempt');

  let exhaustedAttempts = 0;
  const exhaustedServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      exhaustedAttempts += 1;
      return new Response('temporary', { status: 503 });
    },
  });
  try {
    await assert.rejects(
      fetchWithRetry(`http://127.0.0.1:${exhaustedServer.port}/`, {}, {
        attempts: 3,
        delaysMs: [5, 10],
        timeoutMs: 1_000,
        label: '耗尽测试',
      }),
      (error) => {
        assert.equal(error.name, 'RetryExhaustedError');
        assert.match(error.message, /已自动重试 2 次/);
        assert.doesNotMatch(error.message, /socket connection|fetch failed/i);
        return true;
      }
    );
    assert.equal(exhaustedAttempts, 3);
  } finally {
    exhaustedServer.stop(true);
  }

  console.log(JSON.stringify({
    ok: true,
    http503Attempts: statusAttempts,
    socketCloseAttempts: socketAttempts,
    exhaustedMessageLocalized: true,
  }, null, 2));
} finally {
  statusServer.stop(true);
  await new Promise((resolve) => socketServer.close(resolve));
}
