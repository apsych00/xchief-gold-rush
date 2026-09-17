/**
 * Live gold price feed.
 *
 * The client owns exactly one WebSocket - the game socket in src/api/socket.js - and every
 * price it shows comes from that socket's own `hello`/`price` frames. Ticket U1 removed the
 * direct upstream sources (the relay, Finnhub and the PAXG exchange sockets) and the local
 * REST/demo fallback with them: the server reads the market itself and settles every round on
 * the price it read, so a client-side feed could only ever disagree with the verdict. There is
 * no second socket to open.
 *
 * While the socket is not open/authed the mode is 'connecting'; the play screen stays in that
 * state (no price, direction buttons disabled) until the server's hello arrives. mode is then
 * 'live' (a tick within the last 3 s) or 'quiet' (none for 3 s) - see src/api/socket.js's
 * onStatus. The server decides every outcome; this file only reports what the socket pushed.
 */
import { connect as connectSocket, onPrice as onSocketPrice, onStatus as onSocketStatus } from './api/socket.js';

/**
 * @param {{ onPrice: (price:number, meta:{source:string, mode:'live'|'quiet'}) => void,
 *           onStatus: (s:{mode:'connecting'|'live'|'quiet', source:string|null, quiet:boolean, connectionRefused?:boolean}) => void }} opts
 * @returns {() => void} stop
 */
export function startPriceFeed({ onPrice, onStatus }) {
  let stopped = false;
  let mode = 'connecting';
  // Ticket OD1: whether socket.js's own connectionRefused signature (see its comment) is
  // currently up - reported alongside mode, but on its own change, not mode's: it can flip
  // while mode stays 'connecting' the whole time, which report()'s mode-equality guard would
  // otherwise swallow.
  let connectionRefused = false;

  const emit = () => onStatus({ mode, source: null, symbol: 'XAU/USD', quiet: mode === 'quiet', connectionRefused });

  const report = (next) => {
    if (stopped || mode === next) return;
    mode = next;
    emit();
  };

  const offPrice = onSocketPrice((price) => {
    if (stopped) return;
    report('live');
    onPrice(price, { source: 'server', mode: 'live' });
  });

  const offStatus = onSocketStatus((s) => {
    if (stopped) return;
    const nextMode = !s.connected ? 'connecting' : s.quiet ? 'quiet' : 'live';
    const refused = Boolean(s.connectionRefused);
    const changed = nextMode !== mode || refused !== connectionRefused;
    mode = nextMode;
    connectionRefused = refused;
    if (changed) emit();
  });

  onStatus({ mode, source: null, symbol: 'XAU/USD', quiet: false, connectionRefused: false });
  connectSocket();

  return () => {
    stopped = true;
    offPrice();
    offStatus();
  };
}
