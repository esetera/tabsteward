// Minimal Marionette client used for the real-Firefox smoke test (not part of vitest).
import net from 'node:net';

export class Marionette {
  constructor(port = 2828) { this.port = port; this.id = 0; this.pending = new Map(); this.buf = Buffer.alloc(0); }
  connect() {
    return new Promise((resolve, reject) => {
      const tryConnect = (attempt) => {
        const sock = net.createConnection({ port: this.port, host: '127.0.0.1' });
        sock.once('error', (e) => { if (attempt < 60) setTimeout(() => tryConnect(attempt + 1), 500); else reject(e); });
        sock.once('connect', () => { this.sock = sock; sock.on('data', (d) => this.onData(d)); });
        this.onHello = resolve;
      };
      tryConnect(0);
    });
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const colon = this.buf.indexOf(0x3a);
      if (colon < 0) return;
      const len = parseInt(this.buf.subarray(0, colon).toString('latin1'), 10);
      if (this.buf.length < colon + 1 + len) return;
      const msg = JSON.parse(this.buf.subarray(colon + 1, colon + 1 + len).toString('utf8'));
      this.buf = this.buf.subarray(colon + 1 + len);
      if (msg.applicationType) { this.onHello && this.onHello(msg); continue; }
      const [, id, err, result] = msg;
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      err ? p.reject(new Error(err.message || JSON.stringify(err))) : p.resolve(result);
    }
  }
  send(cmd, params = {}, timeoutMs = 45000) {
    const id = ++this.id;
    const payload = Buffer.from(JSON.stringify([0, id, cmd, params]), 'utf8');
    this.sock.write(Buffer.concat([Buffer.from(`${payload.length}:`, 'latin1'), payload]));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`Marionette ${cmd} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    });
  }
  async newSession() { return this.send('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } }); }
  chrome() { return this.send('Marionette:SetContext', { value: 'chrome' }); }
  content() { return this.send('Marionette:SetContext', { value: 'content' }); }
  async exec(script, args = []) { return (await this.send('WebDriver:ExecuteScript', { script, args })).value; }
  async execAsync(script, args = [], timeout = 60000) { return (await this.send('WebDriver:ExecuteAsyncScript', { script, args, scriptTimeout: timeout }, timeout + 5000)).value; }
  close() { this.sock.end(); }
}
