import type { ClientMessage, Command, Receipt, ServerMessage, Snapshot } from '../shared/types.js';

export type ConnState = 'connecting' | 'open' | 'closed';

export interface Toast {
  id: number;
  ok: boolean;
  text: string;
}

export interface ClientState {
  snapshot: Snapshot | null;
  conn: ConnState;
  error: string | null;
  /** serverTime - Date.now(), so countdowns follow the authoritative clock. */
  offset: number;
  toasts: Toast[];
}

export function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function newRequestId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : randomToken();
}

/** Credentials are kept per room on this device so a refresh reconnects the same identity. */
export const creds = {
  get(kind: 'player' | 'host', code: string): string | null {
    try {
      return localStorage.getItem(`fc:${kind}:${code.toUpperCase()}`);
    } catch {
      return null;
    }
  },
  set(kind: 'player' | 'host', code: string, token: string): void {
    try {
      localStorage.setItem(`fc:${kind}:${code.toUpperCase()}`, token);
    } catch {
      /* private mode: session works until the tab closes */
    }
  },
};

export class GameClient {
  state: ClientState = { snapshot: null, conn: 'connecting', error: null, offset: 0, toasts: [] };
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private pending = new Map<string, { resolve: (r: Receipt) => void; msg: ClientMessage; timer: number }>();
  private retryMs = 500;
  private stopped = false;
  private toastId = 0;
  private pingTimer: number | undefined;

  constructor(
    private code: string,
    private token: string | null,
    private asHost: boolean,
  ) {
    this.connect();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = () => this.state;

  private set(patch: Partial<ClientState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private connect() {
    if (this.stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    this.set({ conn: 'connecting' });
    ws.onopen = () => {
      this.retryMs = 500;
      this.raw({ t: 'hello', code: this.code, token: this.token ?? undefined, asHost: this.asHost });
      // Re-send in-flight commands with their original request IDs; the server dedupes.
      for (const p of this.pending.values()) this.raw(p.msg);
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.raw({ t: 'ping', clientTime: Date.now() }), 15_000);
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data) as ServerMessage);
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      this.set({ conn: 'closed' });
      if (!this.stopped) setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(5000, this.retryMs * 2);
    };
  }

  private raw(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(msg: ServerMessage) {
    switch (msg.t) {
      case 'snapshot':
        if (this.state.snapshot && msg.data.revision < this.state.snapshot.revision) return;
        this.set({ snapshot: msg.data, conn: 'open', error: null, offset: msg.data.serverTime - Date.now() });
        return;
      case 'receipt': {
        const p = this.pending.get(msg.receipt.requestId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.receipt.requestId);
          p.resolve(msg.receipt);
        }
        return;
      }
      case 'pong':
        this.set({ offset: msg.serverTime - (msg.clientTime + Date.now()) / 2 });
        return;
      case 'error':
        this.set({ error: msg.error });
        return;
    }
  }

  /** Send a command; retries after a timeout reuse the same request ID. */
  command(cmd: Command, opts: { toast?: boolean } = {}): Promise<Receipt> {
    const requestId = newRequestId();
    const msg: ClientMessage = { t: 'cmd', requestId, cmd };
    return new Promise<Receipt>((resolve) => {
      const arm = (): number =>
        window.setTimeout(() => {
          const p = this.pending.get(requestId);
          if (!p) return;
          this.raw(msg);
          p.timer = arm();
        }, 4000);
      this.pending.set(requestId, { resolve, msg, timer: arm() });
      this.raw(msg);
    }).then((r) => {
      if (opts.toast !== false && (r.message || r.error)) this.toast(r.ok, r.ok ? r.message! : r.error!);
      return r;
    });
  }

  toast(ok: boolean, text: string) {
    const id = ++this.toastId;
    this.set({ toasts: [...this.state.toasts.slice(-3), { id, ok, text }] });
    setTimeout(() => this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) }), ok ? 2500 : 5000);
  }

  close() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
  }
}
