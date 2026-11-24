import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

function reject(status, message) { throw Object.assign(new Error(message), { status }); }

function clean(field, input) {
  if (input === null || input === undefined || (typeof input === 'string' && !input.trim())) {
    if (field.required) reject(422, field.label + ' is required.');
    return null;
  }
  if (field.type === 'number' || field.type === 'integer') {
    if (!Number.isFinite(input) || (field.type === 'integer' && !Number.isSafeInteger(input))) reject(422, 'Enter a valid ' + field.type + ' for ' + field.label + '.');
    if (input < field.min || input > field.max) reject(422, field.label + ' is outside the allowed range.');
    return input;
  }
  if (typeof input !== 'string' || input.length > 2000) reject(422, field.label + ' must be text of at most 2000 characters.');
  const value = input.trim();
  if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) reject(422, 'Enter a valid email address.');
  if (field.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) reject(422, 'Enter a valid calendar date.');
  return value;
}

export function openRecords(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, collection TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS collection_idx ON records(collection); CREATE TABLE IF NOT EXISTS unique_values (collection TEXT, field TEXT, value TEXT, record_id TEXT REFERENCES records(id) ON DELETE CASCADE, PRIMARY KEY(collection,field,value))');
  return db;
}

function record(db, collection, id) {
  const row = db.prepare('SELECT payload FROM records WHERE collection=? AND id=?').get(collection, id);
  if (!row) reject(404, 'Record not found.');
  return JSON.parse(row.payload);
}

function write(db, resource, id, incoming, create) {
  if (!incoming || Array.isArray(incoming) || typeof incoming !== 'object') reject(422, 'Expected a JSON object.');
  if (!Object.keys(incoming).length || Object.keys(incoming).some(k => !resource.fields.some(f => f.key === k))) reject(422, 'Empty update or unknown field.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = create ? {} : record(db, resource.key, id);
    const result = { id };
    for (const f of resource.fields) result[f.key] = clean(f, Object.hasOwn(incoming, f.key) ? incoming[f.key] : previous[f.key]);
    if (create) db.prepare('INSERT INTO records(id,collection,payload) VALUES(?,?,?)').run(id, resource.key, JSON.stringify(result));
    else db.prepare('UPDATE records SET payload=? WHERE collection=? AND id=?').run(JSON.stringify(result), resource.key, id);
    db.prepare('DELETE FROM unique_values WHERE record_id=?').run(id);
    for (const f of resource.fields.filter(f => f.unique && result[f.key] !== null)) {
      const inserted = db.prepare('INSERT OR IGNORE INTO unique_values VALUES(?,?,?,?)').run(resource.key, f.key, String(result[f.key]).toLowerCase(), id);
      if (!inserted.changes) reject(409, f.label + ' must be unique.');
    }
    db.exec('COMMIT');
    return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

async function body(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') reject(415, 'Use application/json.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) reject(413, 'Record is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(400, 'Invalid JSON.'); }
}

export function createCrudServer(plan, db, html, script) {
  return createServer(async (req, res) => {
    const send = (status, data, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'" });
      res.end(status === 204 ? undefined : type === 'application/json' ? JSON.stringify(data) : data);
    };
    try {
      const base = 'http://127.0.0.1:' + req.socket.localPort;
      if (req.headers.host !== new URL(base).host && req.headers.host !== 'localhost:' + req.socket.localPort) reject(403, 'Local requests only.');
      if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) reject(403, 'Cross-origin request.');
      if (req.method !== 'GET' && req.headers['sec-fetch-site'] === 'cross-site') reject(403, 'Cross-site change.');
      const url = new URL(req.url, base);
      if (req.method === 'GET') {
        if (url.pathname === '/') return send(200, html, 'text/html');
        if (url.pathname === '/app.js') return send(200, script, 'text/javascript');
        if (url.pathname === '/schema.json') return send(200, plan);
        if (url.pathname === '/health') return send(200, { status: 'ok' });
      }
      const match = /^\/api\/([a-z][a-z0-9_]*)(?:\/([\w-]+))?$/.exec(url.pathname);
      const resource = match && plan.resources.find(r => r.key === match[1]);
      if (!resource) reject(404, 'Collection not found.');
      const id = match[2];
      if (req.method === 'GET' && id) return send(200, record(db, resource.key, id));
      if (req.method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
        const rows = db.prepare('SELECT payload FROM records WHERE collection=? ORDER BY rowid DESC').all(resource.key).map(row => JSON.parse(row.payload));
        return send(200, rows.filter(row => resource.fields.some(f => String(row[f.key] ?? '').toLowerCase().includes(q))));
      }
      if (req.method === 'POST' && !id) return send(201, write(db, resource, randomUUID(), await body(req), true));
      if (req.method === 'PATCH' && id) return send(200, write(db, resource, id, await body(req), false));
      if (req.method === 'DELETE' && id) {
        if (!db.prepare('DELETE FROM records WHERE collection=? AND id=?').run(resource.key, id).changes) reject(404, 'Record not found.');
        return send(204);
      }
      reject(405, 'Method not allowed.');
    } catch (error) { send(error.status ?? 500, { error: error.status ? error.message : 'Database operation failed.' }); }
  });
}

export function startServer(server, port = 0) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)); });
}
export async function stopServer(server) {
  const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await stopped;
}
