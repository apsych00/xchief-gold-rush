// Liveness comparison of price sources: ticks per second, distinct changes per 5 s at 3 and 2
// decimals, and inter-tick gaps. Usage: FINNHUB_TOKEN=... node demo/feed-compare.mjs --seconds 30
import { WebSocket } from 'ws';
const SECS = Number((process.argv.find((a) => a.startsWith('--seconds=')) || '--seconds=30').split('=')[1]);
const KEY = process.env.FINNHUB_TOKEN || '';
const stats = {};
function track(name, url, subscribe, parse) {
  const s = (stats[name] = { msgs: 0, ch3: 0, ch2: 0, last3: null, last2: null, gaps: [], lastAt: null, err: null });
  const ws = new WebSocket(url);
  ws.on('open', () => subscribe.forEach((m) => ws.send(m)));
  ws.on('message', (b) => {
    let m; try { m = JSON.parse(b.toString()); } catch { return; }
    const p = parse(m); if (typeof p !== 'number' || !Number.isFinite(p)) return;
    const now = Date.now(); s.msgs++;
    if (s.lastAt) s.gaps.push(now - s.lastAt); s.lastAt = now;
    const p3 = Math.round(p * 1000) / 1000, p2 = Math.round(p * 100) / 100;
    if (s.last3 !== null && p3 !== s.last3) s.ch3++; if (s.last2 !== null && p2 !== s.last2) s.ch2++;
    s.last3 = p3; s.last2 = p2;
  });
  ws.on('error', (e) => { s.err = e.message; });
  setTimeout(() => ws.close(), SECS * 1000);
}
if (KEY) {
  track('finnhub OANDA XAU', `wss://ws.finnhub.io?token=${KEY}`, [JSON.stringify({ type: 'subscribe', symbol: 'OANDA:XAU_USD' })], (m) => (m.type === 'trade' ? m.data?.find((d) => d.s === 'OANDA:XAU_USD')?.p : null));
}
track('okx PAXG ticker mid', 'wss://ws.okx.com:8443/ws/v5/public', [JSON.stringify({ op: 'subscribe', args: [{ channel: 'tickers', instId: 'PAXG-USDT' }] })], (m) => { const d = m.data?.[0]; return d ? (Number(d.bidPx) + Number(d.askPx)) / 2 : null; });
track('okx PAXG trades', 'wss://ws.okx.com:8443/ws/v5/public', [JSON.stringify({ op: 'subscribe', args: [{ channel: 'trades', instId: 'PAXG-USDT' }] })], (m) => { const d = m.data?.[0]; return d ? Number(d.px) : null; });
track('binance PAXG book', 'wss://data-stream.binance.vision/ws/paxgusdt@bookTicker', [], (m) => (m.b && m.a ? (Number(m.b) + Number(m.a)) / 2 : null));
track('kraken PAXG ticker', 'wss://ws.kraken.com/v2', [JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: ['PAXG/USD'] } })], (m) => { const d = m.data?.[0]; return d && d.bid && d.ask ? (Number(d.bid) + Number(d.ask)) / 2 : null; });
setTimeout(() => {
  const pct = (arr, q) => { if (!arr.length) return '-'; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; };
  console.log(`${'source'.padEnd(22)} msgs/s  changes/5s@3dp  changes/5s@2dp  gap p50  gap p95  max gap`);
  for (const [k, s] of Object.entries(stats)) console.log(`${k.padEnd(22)} ${(s.msgs / SECS).toFixed(1).padStart(6)}  ${(s.ch3 / SECS * 5).toFixed(1).padStart(14)}  ${(s.ch2 / SECS * 5).toFixed(1).padStart(14)}  ${String(pct(s.gaps, 0.5)).padStart(7)}  ${String(pct(s.gaps, 0.95)).padStart(7)}  ${String(pct(s.gaps, 1)).padStart(7)}${s.err ? '  ERR ' + s.err : ''}`);
  process.exit(0);
}, SECS * 1000 + 1000);
