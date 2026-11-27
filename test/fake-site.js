// A stand-in for a Clankoff site, for the tests: the three things a bridge talks to (README.md, "Protocol").
//   GET  /api/bridge/whoami   200 {name} for a known token; 401 otherwise ({pairing: 'pending'} while a link waits)
//   POST /api/bridge/pair     takes {tokenHash}, answers {code, expiresIn}
//   GET  /api/bridge/connect  the WebSocket: JSON messages both ways
// Node has a WebSocket client but no server, so the few frames the bridge uses are read and written here by hand
// (RFC 6455: text, ping, pong and close; nothing fragmented, nothing compressed).
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n])
    : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, payload]);
}

/** One bridge connection, from the site's side. */
class Connection {
  constructor(socket, req) {
    this.socket = socket;
    this.authorization = req.headers.authorization || '';
    this.received = [];   // parsed JSON messages, in order
    this.pings = 0;       // the bridge's own "ping" text messages (not JSON)
    this.waiting = [];    // {match, resolve} of next() calls not answered yet
    this.closed = new Promise((res) => { this.onClosed = res; }); // resolves with the close code (1006: dropped)
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 0x7f;
        let at = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
        const masked = !!(buf[1] & 0x80);
        if (buf.length < at + (masked ? 4 : 0) + len) return;
        const mask = masked ? buf.subarray(at, at + 4) : null;
        at += masked ? 4 : 0;
        const payload = Buffer.from(buf.subarray(at, at + len));
        if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
        const opcode = buf[0] & 0x0f;
        buf = buf.subarray(at + len);
        this.onFrame(opcode, payload);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => this.onClosed(this.closeCode ?? 1006));
  }

  onFrame(opcode, payload) {
    if (opcode === 0x8) { // close: answer it (unless this side started), then hang up
      this.closeCode ??= payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      if (!this.closing) this.socket.write(frame(0x8, payload.subarray(0, 2)));
      this.socket.end();
    } else if (opcode === 0x9) this.socket.write(frame(0xA, payload));
    else if (opcode === 0x1) {
      const text = payload.toString('utf8');
      if (text === 'ping') { this.pings++; this.socket.write(frame(0x1, Buffer.from('pong'))); return; }
      const msg = JSON.parse(text);
      const i = this.waiting.findIndex((w) => w.match(msg));
      if (i >= 0) this.waiting.splice(i, 1)[0].resolve(msg);
      else this.received.push(msg);
    }
  }

  send(msg) { this.socket.write(frame(0x1, Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg)))); }

  /** The next message the bridge sent that `match` accepts (one already here, or the next to arrive). */
  next(match = () => true, ms = 5000) {
    const i = this.received.findIndex(match);
    if (i >= 0) return Promise.resolve(this.received.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { match, resolve: (m) => { clearTimeout(timer); resolve(m); } };
      const timer = setTimeout(() => { this.waiting.splice(this.waiting.indexOf(w), 1); reject(new Error(`no such message from the bridge within ${ms} ms`)); }, ms);
      this.waiting.push(w);
    });
  }

  /** Close the WebSocket the way a site does, with a code (4001: token revoked, 4000: replaced by another bridge). */
  close(code = 1000) {
    this.closing = true;
    this.closeCode = code;
    const b = Buffer.alloc(2);
    b.writeUInt16BE(code);
    this.socket.write(frame(0x8, b));
  }

  /** Cut the connection without a word, as a network drop does. */
  drop() { this.socket.destroy(); }
}

/**
 * Start a site on a free port of this machine.
 * @param {object} [o]
 * @param {Record<string, string>} [o.tokens]  bridge token -> account name
 * @param {(body: object) => {status?: number, body: object}} [o.pair]  what POST /api/bridge/pair answers
 * @param {boolean} [o.welcome]  answer the bridge's hello with {type: 'welcome', name} (default true)
 */
export async function fakeSite({ tokens = {}, pair, welcome = true } = {}) {
  const site = {
    tokens: new Map(Object.entries(tokens)),
    pending: new Set(),   // tokens whose link waits for a click: whoami answers 401 {pairing: 'pending'}
    whoami: [],           // the Authorization header of every whoami request
    pairings: [],         // every POST /api/bridge/pair body
    connections: [],
    waitingForConnection: [],
  };
  const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');
  const server = createServer((req, res) => {
    const json = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.method === 'GET' && req.url === '/api/bridge/whoami') {
      site.whoami.push(req.headers.authorization || '');
      const token = bearer(req);
      if (site.tokens.has(token)) return json(200, { name: site.tokens.get(token) });
      return json(401, site.pending.has(token) ? { error: 'not approved yet', pairing: 'pending' } : { error: 'unknown token' });
    }
    if (req.method === 'POST' && req.url === '/api/bridge/pair') {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        site.pairings.push(body);
        const out = pair ? pair(body) : { status: 404, body: { error: 'Not found' } };
        json(out.status || 200, out.body);
      });
      return;
    }
    json(404, { error: 'Not found' });
  });
  server.on('upgrade', (req, socket) => {
    if (req.url !== '/api/bridge/connect' || !site.tokens.has(bearer(req))) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = new Connection(socket, req);
    site.connections.push(conn);
    // welcomed: resolves with the bridge's hello, once it has been answered
    conn.welcomed = conn.next((m) => m.type === 'hello', 30_000).then((hello) => {
      conn.hello = hello;
      if (welcome) conn.send({ type: 'welcome', name: site.tokens.get(bearer(req)) });
      return hello;
    });
    conn.welcomed.catch(() => {});
    site.waitingForConnection.shift()?.(conn);
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  site.url = `http://127.0.0.1:${server.address().port}`;
  /** The next bridge to connect (not one already connected). */
  site.connection = (ms = 5000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no bridge connected within ${ms} ms`)), ms);
    site.waitingForConnection.push((c) => { clearTimeout(timer); resolve(c); });
  });
  site.stop = () => new Promise((res) => {
    for (const c of site.connections) c.drop();
    server.closeAllConnections();
    server.close(res);
  });
  return site;
}
