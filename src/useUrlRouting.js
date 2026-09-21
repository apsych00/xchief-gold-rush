import { useEffect, useRef } from 'react';
import { ensureSession } from './api/session.js';

// Five flat screens, no nesting, no params (ticket: real URLs for the bottom-nav screens) - a
// small hand-rolled map is the right size here, same reasoning as src/main.jsx's own
// location.pathname switch for /claim/<token>.
export const SCREEN_PATHS = {
  home: '/',
  game: '/play',
  tasks: '/missions',
  lb: '/board',
  profile: '/profile',
};

const PATH_SCREENS = Object.fromEntries(Object.entries(SCREEN_PATHS).map(([screen, path]) => [path, screen]));

// Each path maps to the same action its nav button already calls (useGame.js's actions object) -
// never a bare screen assignment, so a deep link or a back-tap still runs refreshLeaderboard,
// stopTimer, refreshTasks etc. exactly like tapping the button would.
const ENTER_ACTION = {
  home: 'goHome',
  game: 'startGame',
  tasks: 'goTasks',
  lb: 'goLeaderboard',
  profile: 'goProfile',
};

// Other entry points and server routes that happen to share the browser's history/location
// (AGENTS.md; the ticket's own reserved list) - this hook must never push, rewrite, or read a
// screen out of any of these. Prefix-matched so `/logs` and `/logs/anything` are both left alone.
const RESERVED_PREFIXES = ['/kiosk', '/claim/', '/api/', '/ws', '/health', '/status', '/logs', '/ops', '/ads'];

function isReserved(pathname) {
  return RESERVED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

/**
 * Makes the URL the source of truth for which of the five flat screens is showing. No router
 * library: `pushPath` (returned below) is called by useGame.js's own goHome/startGame/goTasks/
 * goLeaderboard/goProfile after each does its normal work, so every route into a screen - a nav
 * tap, the in-game home button, a result pane's "board" button - leaves a back-able history entry,
 * not just the bottom nav bar. Back/forward and the
 * initial load both route back through those same named actions rather than a bare `screen`
 * assignment (the ticket's own callout: skipping this leaves a stale board or a running timer
 * behind).
 *
 * `currentPathRef` is the single source of "what the URL already says" - both directions
 * (pushPath, and the popstate handler) compare against it before acting. That comparison also
 * means a popstate that does not change the path - a state-only history entry, which is what a
 * "back closes the open modal" scheme would use - is simply ignored rather than mistaken for a
 * real back navigation.
 *
 * Entirely inert for the kiosk (`isKiosk`): a booth device must never accumulate history or let a
 * visitor navigate backwards out of the game.
 *
 * `requestNavRef` (ticket: nav-on-play) is useGame.js's own guard against leaving a live round -
 * back/forward can walk off the play screen exactly as a nav tap can, so a popstate that would
 * change screen is routed through the same requestNav rather than dispatching straight into
 * actionsRef. See its `onQueued` callback below for how the address bar is put back once the
 * browser has already moved it.
 */
export function useUrlRouting(actionsRef, isKiosk, requestNavRef) {
  const currentPathRef = useRef(typeof window === 'undefined' ? '/' : window.location.pathname);
  // React StrictMode's dev-only double-invoke runs this effect's setup twice (mount, cleanup,
  // mount again) - refs survive that, unlike a plain local variable, so this guard keeps the boot
  // dispatch below to exactly one call instead of firing goLeaderboard/goTasks/etc. twice and
  // tripping the server's own per-socket query rate limit (server/limits.js's QUERY_MIN_INTERVAL_MS).
  const bootedRef = useRef(false);

  useEffect(() => {
    if (isKiosk) return undefined;

    const enterUnknown = () => {
      currentPathRef.current = '/';
      history.replaceState(null, '', '/');
      actionsRef.current.goHome();
    };

    // Boot: enter whatever the URL already names, through the same action a nav tap would use -
    // /board typed into the address bar must land on a freshly loaded board, not a bare screen
    // flip. currentPathRef already equals this path (set at the ref's own initial value above),
    // so the action's own pushPath call below is a no-op here.
    //
    // A nav tap only ever happens well after the socket has had time to connect, so goLeaderboard/
    // goTasks calling straight into fetchLeaderboard/refreshTasks (src/useGame.js) has never had
    // to wait for anything - those just send over whatever socket already exists. Called this
    // early instead, before ensureSession's own connect+auth round trip has even started, that
    // same send silently drops (src/api/socket.js's send() no-ops without an OPEN socket) and the
    // request sits pending until it times out. ensureSession() is already what the session
    // hydrate effect (useGame.js) waits on for exactly this connect+auth handshake, and resolves
    // immediately once it has already happened - waiting on it here first is a no-op for
    // goHome/startGame/goProfile and the only fix that matters for goLeaderboard/goTasks.
    if (!bootedRef.current) {
      bootedRef.current = true;
      const boot = window.location.pathname;
      if (!isReserved(boot)) {
        const screen = PATH_SCREENS[boot];
        if (!screen) {
          enterUnknown();
        } else if (screen !== 'home') {
          // Home needs no dispatch at all: it is already the initial screen, and goHome's own
          // stopTimer/reset have nothing to undo this early. Skipping it also keeps the wait
          // below off the common path.
          //
          // The wait matters because ensureSession takes as long as the network does. On a local
          // stack it resolves in a few milliseconds, always before a human could tap anything;
          // over the real domain it is hundreds, and a visitor who taps Missions in the meantime
          // would otherwise be yanked back to the screen the URL named when the page opened -
          // pushing a bogus history entry on the way, which then made back skip a screen. So
          // only dispatch if the URL still says what it said at boot.
          ensureSession().then(() => {
            if (currentPathRef.current !== boot || window.location.pathname !== boot) return;
            actionsRef.current[ENTER_ACTION[screen]]();
          });
        }
      }
    }

    const onPopState = () => {
      const pathname = window.location.pathname;
      // Unchanged path: not a screen back-navigation (a modal opening/closing its own state-only
      // history entry looks exactly like this) - nothing to route.
      if (pathname === currentPathRef.current || isReserved(pathname)) return;
      const screen = PATH_SCREENS[pathname];
      // A live round guards this exactly like a nav tap does (useGame.js's requestNav), but the
      // browser has already moved the address bar to `pathname` by the time popstate fires -
      // onQueued below pushes it straight back to where the app still is, so the confirmation
      // modal opens over the play screen's own URL rather than one that no longer matches what is
      // on screen. `wasQueued` tracks whether that happened: unguarded, the browser is already at
      // `pathname` when `run` executes, so it only needs to sync currentPathRef to match: calling
      // the action's own pushPath would be a no-op anyway. Queued-then-confirmed, the address bar
      // was moved back in the meantime, so currentPathRef must stay put and the action's own
      // pushPath does the real forward push, exactly like a delayed nav-tap confirm does.
      let wasQueued = false;
      const run = () => {
        if (screen) {
          if (!wasQueued) currentPathRef.current = pathname;
          actionsRef.current[ENTER_ACTION[screen]]();
        } else {
          enterUnknown();
        }
      };
      requestNavRef.current(run, () => {
        wasQueued = true;
        history.pushState(null, '', currentPathRef.current);
      });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
    // Mount-once: actionsRef is a stable ref and isKiosk never changes after boot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pushPath = (path) => {
    if (isKiosk || currentPathRef.current === path) return;
    history.pushState(null, '', path);
    currentPathRef.current = path;
  };

  return { pushPath };
}
