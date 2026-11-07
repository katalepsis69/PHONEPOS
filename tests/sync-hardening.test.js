// phone-repair-pos/tests/sync-hardening.test.js
// Behavioral checks for the sync agent's guard rails. These run the real
// src/sync.js against an in-memory database. A configured URL always reaches
// the network (the empty-outbox heartbeat is the point of two tests below);
// the rejection tests prove validation fires before any push.
const assert = require('node:assert');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const sync = require('../src/sync');

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE shop_settings (key TEXT PRIMARY KEY, value TEXT)');
  sync.ensureSyncTables(db);
  return db;
}

function withSyncUrl(value, fn) {
  const prev = process.env.SYNC_URL;
  if (value === undefined) delete process.env.SYNC_URL;
  else process.env.SYNC_URL = value;
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env.SYNC_URL;
    else process.env.SYNC_URL = prev;
  });
}

test('no SYNC_URL and no setting: agent skips instead of failing', async () => {
  const db = makeDb();
  await withSyncUrl(undefined, async () => {
    const res = await sync.drainOutbox(db);
    assert.equal(res.skipped, true);
  });
});

test('env SYNC_URL to a private plaintext host is rejected before any push', async () => {
  const db = makeDb();
  await withSyncUrl('http://192.168.1.50:8443', async () => {
    await assert.rejects(
      () => sync.drainOutbox(db),
      err => /SYNC_URL invalid/.test(err.message)
    );
  });
});

test('env SYNC_URL to a non-https public host is rejected', async () => {
  const db = makeDb();
  await withSyncUrl('http://example.com/sync', async () => {
    await assert.rejects(
      () => sync.drainOutbox(db),
      err => /SYNC_URL invalid/.test(err.message)
    );
  });
});

test('env SYNC_URL to loopback http stays allowed for local cloud testing', async () => {
  // Real stub: the empty-outbox heartbeat must get all the way through.
  const server = require('node:http').createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => res.end(JSON.stringify({ ok: true, ok_ids: [] })));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const db = makeDb();
  await withSyncUrl(`http://127.0.0.1:${server.address().port}`, async () => {
    const res = await sync.drainOutbox(db);
    assert.equal(res.synced, 0);
    assert.equal(res.heartbeat, true);
  });
  server.close();
});

test('env SYNC_URL https host passes validation', async () => {
  const db = makeDb();
  await withSyncUrl('https://example.invalid/sync', async () => {
    // .invalid never resolves: the failure must be the fetch itself, proving
    // validation passed and the heartbeat reached the network stage.
    await assert.rejects(
      () => sync.drainOutbox(db),
      err => !/SYNC_URL invalid/.test(err.message)
    );
  });
});
