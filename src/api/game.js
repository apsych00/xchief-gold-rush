/**
 * Web round play and the client-callable game actions. The server decides every round; this
 * module is a thin delegate over src/api/socket.js so useGame.js's call sites (api.playRound,
 * api.getMe, ...) keep the same shape they had against the old Supabase edge functions.
 */
import * as socket from './socket.js';

/** Sends play {dir, lever}; resolves with round_opened, not a verdict - see socket.js. */
export const playRound = (dir, lever) => socket.play(dir, lever);

export const getMe = () => socket.getMe();

export const claimTask = (id) => socket.claimTask(id);

export const freeRefill = () => socket.freeRefill();

/** Task definitions plus this player's own claimed state, computed server-side. */
export const getTasks = () => socket.getTasks();

/** Video watch progress (ticket B6): reports {seconds, duration}; the server releases the
 * reward itself once 90% is crossed. */
export const reportTaskProgress = (task, seconds, duration) => socket.reportTaskProgress(task, seconds, duration);

/** Redirect and return (ticket B7): opens the 5 s window before the destination is opened. */
export const startTaskVisit = (task) => socket.startTaskVisit(task);

/** Redirect and return (ticket B7): reports the tab regaining focus. */
export const returnTaskVisit = (task) => socket.returnTaskVisit(task);

/** One page of one tournament's board, ranked by peak balance, plus its header, the switcher
 * list, the pager and this player's own row (tickets B1, B2). `opts.tournament` (past or
 * upcoming id) and `opts.page` both default to the current tournament's first page. */
export const getLeaderboard = (opts) => socket.getLeaderboard(opts);
