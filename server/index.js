// Reference implementation of docs/sync-contract.md.
//
// Two jobs, and the second one matters as much as the first:
//   1. something for tests/e2e-sync.js to talk to
//   2. an executable specification to hand to whoever implements the real
//      server — the company's does not exist yet
//
// Which is why this is plain Node with **zero dependencies** and a JSON file
// for storage. Running it on Workers/D1/R2 or any other platform primitive
// would be less code and more convenient, and would also bind the contract to
// one vendor's data layer — exactly what splitting the contract from the
// implementation was meant to avoid.
//
// It is not built for production traffic: the whole dataset is read and
// rewritten on every write. That is fine for a few tablets at a trade show and
// it keeps the file readable as a spec. Anyone reimplementing this should use a
// real database and keep the observable behaviour.
//
//   node server/index.js --port 3000 --token dev-token
//   node server/index.js --data ./mydata --token a,b,c
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = { port: 3000, data: path.join(__dirname, 'data'), tokens: [] };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    if (argv[i] === '--port') out.port = Number(next());
    else if (argv[i] === '--data') out.data = path.resolve(next());
    else if (argv[i] === '--token') out.tokens = next().split(',').map(s => s.trim()).filter(Boolean);
  }
  if (!out.tokens.length && process.env.SYNC_TOKENS) {
    out.tokens = process.env.SYNC_TOKENS.split(',').map(s => s.trim()).filter(Boolean);
  }
  return out;
}

// ------------------------------------------------------------------ storage

// `seq` is the pull cursor: a monotonically increasing counter the server
// assigns, never a timestamp. Tablet clocks drift and a clock-based cursor
// silently skips rows when they do — and the skipped rows never come back.
//
// It is persisted with the data, so a restart cannot make it go backwards. A
// cursor that rewinds would make clients re-fetch rows they already applied;
// worse, a cursor that jumps forward would make them miss rows for good.
function createStore(dir) {
  const file = path.join(dir, 'records.json');
  const photoDir = path.join(dir, 'photos');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(photoDir, { recursive: true });

  // Records and events keep separate sequence spaces. One shared counter would
  // make a burst of records advance the event cursor past events a tablet had
  // not fetched yet, and a cursor that skips never comes back for what it
  // skipped.
  let state = { seq: 0, records: {}, eventSeq: 0, events: {} };
  if (fs.existsSync(file)) {
    try { state = { eventSeq: 0, events: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
    catch (e) { throw new Error(`資料檔毀損，請先處理：${file}\n${e.message}`); }
  }

  const flush = () => fs.writeFileSync(file, JSON.stringify(state, null, 2));

  return {
    get seq() { return state.seq; },

    // Last-write-wins on updatedAt, ties broken by deviceId string order. The
    // tie-break carries no meaning beyond making both sides pick the same
    // winner without talking to each other.
    isNewer(incoming, existing) {
      if (!existing) return true;
      if (incoming.updatedAt !== existing.updatedAt) return incoming.updatedAt > existing.updatedAt;
      return String(incoming.deviceId || '') > String(existing.deviceId || '');
    },

    // Idempotent by id. A client that never saw our response will send the same
    // rows again; that has to land on the same state as sending them once.
    upsert(incoming) {
      const existing = state.records[incoming.id];
      if (!this.isNewer(incoming, existing)) {
        return { status: 'superseded', record: strip(existing) };
      }
      state.seq += 1;
      state.records[incoming.id] = { ...incoming, _seq: state.seq };
      flush();
      // A tombstone takes the photo with it. The client drops the photo when it
      // tombstones a record locally, for the plain reason that a deleted record
      // has no business still holding a visitor's business card — that reason
      // does not stop applying at the network boundary. No separate endpoint:
      // the delete is implied by the record, and an endpoint nobody remembers
      // to call is how these files end up living forever.
      if (incoming.deletedAt) this.deletePhoto(incoming.id);
      return { status: 'accepted' };
    },

    deletePhoto(id) {
      const f = path.join(photoDir, id + '.jpg');
      if (fs.existsSync(f)) fs.unlinkSync(f);
    },

    hasPhoto(id) { return fs.existsSync(path.join(photoDir, id + '.jpg')); },

    since(seq, limit) {
      const rows = Object.values(state.records)
        .filter(r => r._seq > seq)
        .sort((a, b) => a._seq - b._seq);
      const page = rows.slice(0, limit);
      return {
        records: page.map(strip),
        seq: page.length ? page[page.length - 1]._seq : seq,
        hasMore: rows.length > page.length,
      };
    },

    all() { return Object.values(state.records).map(strip); },

    get eventSeq() { return state.eventSeq; },

    allEvents() { return Object.values(state.events).map(strip); },

    // Field definitions may only be changed by the event's owner. Everything
    // else about an event (its status, a takeover) is accepted from anybody.
    //
    // This is the same kind of guard as the admin PIN: it prevents the accident
    // — a colleague edits fields on their own tablet and silently replaces
    // everyone's setup — not an attacker. With one shared token the server
    // cannot tell a deliberate takeover from an impersonation.
    upsertEvent(incoming) {
      const existing = state.events[incoming.id];
      if (!this.isNewer(incoming, existing)) {
        return { status: 'superseded', event: strip(existing) };
      }
      let next = { ...incoming };
      const owner = existing ? existing.ownerDeviceId : incoming.ownerDeviceId;
      const ownerChanged = existing && incoming.ownerDeviceId !== existing.ownerDeviceId;
      if (incoming.fieldDefs && !ownerChanged && owner && incoming.deviceId !== owner) {
        // Keep the event, drop the definitions, and say so rather than failing
        // the whole row — the status change it also carried is still valid.
        next = { ...next, fieldDefs: existing ? existing.fieldDefs : undefined };
        state.eventSeq += 1;
        state.events[incoming.id] = { ...next, _seq: state.eventSeq };
        flush();
        return { status: 'accepted', fieldDefsRejected: true };
      }
      state.eventSeq += 1;
      state.events[incoming.id] = { ...next, _seq: state.eventSeq };
      flush();
      // A deleted event takes its records' photos with it, for the same reason
      // a deleted record does.
      if (incoming.deletedAt) {
        for (const r of Object.values(state.records)) {
          if (r.eventId === incoming.id) this.deletePhoto(r.id);
        }
      }
      return { status: 'accepted' };
    },

    eventsSince(seq, limit) {
      const rows = Object.values(state.events)
        .filter(e => e._seq > seq)
        .sort((a, b) => a._seq - b._seq);
      const page = rows.slice(0, limit);
      return {
        events: page.map(strip),
        seq: page.length ? page[page.length - 1]._seq : seq,
        hasMore: rows.length > page.length,
      };
    },

    putPhoto(id, buf) { fs.writeFileSync(path.join(photoDir, id + '.jpg'), buf); },
  };
}

// `_seq` is the server's bookkeeping; clients neither need it nor should
// depend on its shape.
function strip(r) {
  if (!r) return r;
  const { _seq, ...rest } = r;
  return rest;
}

// -------------------------------------------------------------------- server

const MAX_BATCH = 50;
const MAX_BODY = 32 * 1024 * 1024;   // photos are the large case

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createServer(opts) {
  const store = createStore(opts.data);
  const tokens = new Set(opts.tokens);

  const json = (res, code, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      // Tablets load the app from a different origin (GitHub Pages), so every
      // sync request is cross-origin.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    });
    res.end(payload);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') { json(res, 204, {}); return; }

    // 401 must be its own answer, never a 200 with an error message inside:
    // the client has to tell "the network is broken" apart from "the token is
    // wrong", because those need completely different things from the user.
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokens.has(token)) { json(res, 401, { error: 'invalid token' }); return; }

    try {
      if (req.method === 'POST' && url.pathname === '/v1/records') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const rows = Array.isArray(body.records) ? body.records : [];
        if (rows.length > MAX_BATCH) {
          json(res, 400, { error: `batch too large (max ${MAX_BATCH})` });
          return;
        }
        // Per-row results, never all-or-nothing: one malformed row must not
        // hold up the other 49.
        const results = rows.map((r) => {
          if (!r || !r.id || !r.updatedAt) {
            return { id: r && r.id, status: 'rejected', error: 'id and updatedAt are required' };
          }
          return { id: r.id, ...store.upsert(r) };
        });
        json(res, 200, { results, seq: store.seq });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/events') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const rows = Array.isArray(body.events) ? body.events : [];
        if (rows.length > MAX_BATCH) {
          json(res, 400, { error: `batch too large (max ${MAX_BATCH})` });
          return;
        }
        const results = rows.map((e) => {
          if (!e || !e.id || !e.updatedAt) {
            return { id: e && e.id, status: 'rejected', error: 'id and updatedAt are required' };
          }
          return { id: e.id, ...store.upsertEvent({ ...e, deviceId: body.deviceId }) };
        });
        json(res, 200, { results, seq: store.eventSeq });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/events') {
        const since = Number(url.searchParams.get('since') || 0);
        const limit = Math.min(Number(url.searchParams.get('limit') || 200), 500);
        json(res, 200, store.eventsSince(since, limit));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/records') {
        const since = Number(url.searchParams.get('since') || 0);
        const limit = Math.min(Number(url.searchParams.get('limit') || 200), 500);
        json(res, 200, store.since(since, limit));
        return;
      }

      // Implemented even though the v3.13 client does not call it yet — this
      // file is the spec, and a spec with a hole in it is not one.
      const photo = url.pathname.match(/^\/v1\/photos\/([^/]+)$/);
      if (req.method === 'PUT' && photo) {
        store.putPhoto(decodeURIComponent(photo[1]), await readBody(req));
        json(res, 200, { status: 'stored' });
        return;
      }

      // Not part of the contract. Only for looking at what the tests did.
      if (req.method === 'GET' && url.pathname === '/debug/all') {
        json(res, 200, { seq: store.seq, records: store.all(),
          eventSeq: store.eventSeq, events: store.allEvents() });
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: String(e && e.message || e) });
    }
  });

  return server;
}

module.exports = { createServer, createStore };

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.tokens.length) {
    console.error('需要至少一組權杖：--token <token>[,<token>…] 或環境變數 SYNC_TOKENS');
    process.exit(1);
  }
  createServer(opts).listen(opts.port, () => {
    console.log(`同步伺服器：http://localhost:${opts.port}/v1`);
    console.log(`資料目錄：${opts.data}`);
    console.log(`已載入 ${opts.tokens.length} 組權杖`);
  });
}
