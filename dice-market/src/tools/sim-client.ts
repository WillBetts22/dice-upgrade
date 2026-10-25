import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { Command, Receipt, ServerMessage, Snapshot } from '../shared/types.js';

/** A headless player that speaks the same protocol as the browser client. */
export class SimClient {
  ws!: WebSocket;
  snapshot: Snapshot | null = null;
  token = randomBytes(24).toString('hex');
  gaps = 0;
  private pending = new Map<string, (r: Receipt) => void>();
  private waiters: (() => void)[] = [];

  constructor(
    public base: string,
    public code: string,
    public opts: { asHost?: boolean; token?: string } = {},
  ) {
    if (opts.token) this.token = opts.token;
  }

  async connect(): Promise<void> {
    const url = this.base.replace(/^http/, 'ws') + '/ws';
    this.ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    this.ws.on('message', (raw) => this.onMessage(JSON.parse(raw.toString())));
    this.ws.send(JSON.stringify({ t: 'hello', code: this.code, token: this.token, asHost: this.opts.asHost }));
    await this.until(() => this.snapshot !== null);
  }

  private onMessage(m: ServerMessage) {
    if (m.t === 'snapshot') this.snapshot = m.data;
    else if (m.t === 'update') {
      const s = this.snapshot;
      if (s && s.round && m.rev === s.revision + 1) {
        const d = m.delta;
        s.revision = m.rev;
        s.round.books = { ...s.round.books, ...d.books };
        s.round.holdings = { ...s.round.holdings, ...d.holdings };
        s.round.upgrades = { ...s.round.upgrades, ...d.upgrades };
        s.round.tape = [...s.round.tape, ...d.trades];
        if (m.account) s.account = m.account;
      } else if (s && m.rev > s.revision) {
        this.gaps++;
        this.ws.send(JSON.stringify({ t: 'snapshot' }));
      }
    } else if (m.t === 'receipt') {
      this.pending.get(m.receipt.requestId)?.(m.receipt);
      this.pending.delete(m.receipt.requestId);
    }
    for (const w of this.waiters.splice(0)) w();
  }

  until(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting for condition')), timeoutMs);
      const check = () => {
        if (pred()) {
          clearTimeout(t);
          res();
        } else this.waiters.push(check);
      };
      this.waiters.push(check);
    });
  }

  command(cmd: Command, requestId = randomUUID()): Promise<Receipt> {
    return new Promise((res) => {
      this.pending.set(requestId, res);
      this.ws.send(JSON.stringify({ t: 'cmd', requestId, cmd }));
    });
  }

  close() {
    this.ws?.close();
  }
}

export async function http(base: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(base + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j;
}
