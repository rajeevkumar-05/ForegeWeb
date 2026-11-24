import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer, stopServer } from './engine.mjs';

function sample(f, variant = 0) {
  if (f.type === 'email') return 'qa' + variant + '@example.test';
  if (f.type === 'date') return '2030-01-' + (variant ? '02' : '01');
  if (f.type === 'text') return 'Sample ' + f.label + ' ' + variant;
  const low = f.min ?? Math.min(0, f.max ?? 0);
  return Math.min(f.max ?? Infinity, (f.type === 'integer' ? Math.ceil(low) : low) + variant);
}
export async function verifyCrud(plan, open) {
  const dir = await mkdtemp(join(tmpdir(), 'forgeweb-crud-'));
  const path = join(dir, 'acceptance.sqlite');
  let session, base, checks = 0;
  const request = async (method, path, expected, body) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, expected, method + ' ' + path + ' expected ' + expected + ', received ' + response.status);
    checks++;
    return expected === 204 ? undefined : response.json();
  };
  const boot = async () => { session = open(path); base = await startServer(session.server); };
  const stop = async () => { if (session) { try { await stopServer(session.server); } finally { session.db.close(); session = undefined; } } };
  try {
    await boot();
    assert.deepEqual(await request('GET', '/schema.json', 200), plan);
    const html = await (await fetch(base)).text();
    assert.match(html, /id="record-form"/);
    assert.match(await (await fetch(base + '/app.js')).text(), /\/schema\.json/);
    const saved = [];
    for (const r of plan.resources) {
      const url = '/api/' + r.key;
      const initial = Object.fromEntries(r.fields.map(f => [f.key, sample(f)]));
      assert.deepEqual(await request('GET', url, 200), []);
      const row = await request('POST', url, 201, initial);
      assert.ok(row.id);
      assert.deepEqual(row, { id: row.id, ...initial });
      const item = url + '/' + row.id;
      for (const f of r.fields) {
        const bad = f.type === 'date' ? '2030-02-30' : f.type === 'email' ? 'invalid' : f.type === 'integer' ? 1.5 : f.type === 'number' ? 'abc' : {};
        await request('PATCH', item, 422, { [f.key]: bad });
        if (f.required) { const missing = { ...initial }; delete missing[f.key]; await request('POST', url, 422, missing); }
        else { await request('PATCH', item, 200, { [f.key]: null }); await request('PATCH', item, 200, { [f.key]: initial[f.key] }); }
        if (f.min !== undefined) await request('PATCH', item, 422, { [f.key]: f.min - 1 });
        if (f.max !== undefined) await request('PATCH', item, 422, { [f.key]: f.max + 1 });
        if (f.unique) {
          const dup = Object.fromEntries(r.fields.map(other => [other.key, other === f ? initial[f.key] : sample(other, 1)]));
          await request('POST', url, 409, dup);
        }
      }
      await request('PATCH', item, 422, { id: 'replacement' });
      await request('PATCH', item, 422, {});
      assert.deepEqual(await request('GET', item, 200), row);
      const changed = Object.fromEntries(r.fields.map(f => [f.key, sample(f, 1)]));
      const updated = await request('PATCH', item, 200, changed);
      assert.deepEqual(updated, { id: row.id, ...changed });
      assert.deepEqual(await request('GET', url + '?q=' + encodeURIComponent(String(changed[r.fields[0].key])), 200), [updated]);
      assert.deepEqual(await request('GET', url + '?q=does-not-match-any-record', 200), []);
      saved.push({ url, item, updated });
    }
    await stop(); await boot();
    for (const { url, item, updated } of saved) {
      assert.deepEqual(await request('GET', item, 200), updated);
      assert.deepEqual(await request('GET', url, 200), [updated]);
      await request('DELETE', item, 204);
      await request('GET', item, 404);
      await request('PATCH', item, 404, { [Object.keys(updated)[1]]: 'x' });
      await request('DELETE', item, 404);
      assert.deepEqual(await request('GET', url, 200), []);
    }
    return checks;
  } finally { try { await stop(); } finally { await rm(dir, { recursive: true, force: true }); } }
}
