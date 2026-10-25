import { useState } from 'react';
import { DEFAULT_ROUNDS, MAX_ROUNDS, MIN_ROUNDS, projectedSessionMinutes } from '../shared/rules.js';
import { RulesSummary } from './Rules.js';
import { navigate } from './common.js';
import { creds, randomToken } from './net.js';

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? 'Request failed.');
  return j;
}

export async function joinRoom(code: string, name: string, hostToken?: string) {
  const c = code.trim().toUpperCase();
  const token = creds.get('player', c) ?? randomToken();
  creds.set('player', c, token);
  return post(`/api/rooms/${encodeURIComponent(c)}/join`, { name, token, hostToken });
}

export function Landing() {
  const [mode, setMode] = useState<'none' | 'host' | 'join'>(location.pathname.startsWith('/join') ? 'join' : 'none');
  const [rounds, setRounds] = useState(DEFAULT_ROUNDS);
  const [devMode, setDevMode] = useState(false);
  const [code, setCode] = useState(location.pathname.match(/^\/join\/([A-Za-z0-9]+)/)?.[1]?.toUpperCase() ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const host = async () => {
    setBusy(true);
    setErr(null);
    try {
      const hostToken = randomToken();
      const r = await post('/api/rooms', { hostToken, rounds, devMode });
      creds.set('host', r.code, hostToken);
      navigate(`/host/${r.code}`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await joinRoom(code, name);
      navigate(`/play/${r.code}`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wrap stack">
      <div className="hero">
        <h1>Dice Upgrade</h1>
        <p className="muted">A live market for dice upgrades. Buy, sell, even sell what you do not own, then roll.</p>
      </div>
      <div className="row">
        <button className="btn primary" onClick={() => setMode('host')} aria-pressed={mode === 'host'}>
          Host Game
        </button>
        <button className="btn primary" onClick={() => setMode('join')} aria-pressed={mode === 'join'}>
          Join Game
        </button>
      </div>
      {err && <div className="banner bad">{err}</div>}
      {mode === 'host' && (
        <div className="card stack">
          <h2>Host a room</h2>
          <div>
            <label htmlFor="rounds">Rounds</label>
            <select id="rounds" value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
              {Array.from({ length: MAX_ROUNDS - MIN_ROUNDS + 1 }, (_, i) => i + MIN_ROUNDS).map((n) => (
                <option key={n} value={n}>
                  {n} round{n > 1 ? 's' : ''} · about {projectedSessionMinutes(n)} minutes
                </option>
              ))}
            </select>
          </div>
          <label className="row" style={{ color: 'inherit' }}>
            <input type="checkbox" checked={devMode} onChange={(e) => setDevMode(e.target.checked)} />
            Test mode (allows bots and skipping phases; not for a live event)
          </label>
          <button className="btn primary big" disabled={busy} onClick={host}>
            Create room
          </button>
        </div>
      )}
      {mode === 'join' && (
        <form className="card stack" onSubmit={join}>
          <h2>Join a room</h2>
          <div>
            <label htmlFor="code">Room code</label>
            <input id="code" type="text" autoCapitalize="characters" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={8} required />
          </div>
          <div>
            <label htmlFor="name">Display name</label>
            <input id="name" type="text" autoComplete="nickname" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} required />
          </div>
          <button className="btn primary big" disabled={busy || !code || !name.trim()}>
            Join
          </button>
        </form>
      )}
      <div className="card">
        <RulesSummary />
      </div>
    </div>
  );
}
