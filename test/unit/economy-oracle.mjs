// Pure JS reference implementation of the economy rules, written ONLY from
// the "Economy rules" section of docs/test-contract.md. No implementation
// file was consulted (blind test oracle).

export const INITIAL = Object.freeze({
  coins: 1000,
  record: 1000,
  streak: 0,
  wins: 0,
  rounds: 0,
  refill_used: false,
});

export function newPlayer() {
  return { ...INITIAL };
}

// Combo multiplier depends on the streak BEFORE the round:
// 0 -> 1x, 1 -> 1.5x, 2 -> 2x, 3 or more -> 3x.
export function comboMult(streak) {
  if (streak <= 0) return 1;
  if (streak === 1) return 1.5;
  if (streak === 2) return 2;
  return 3;
}

// Stake = 100 x lever, lever in {1, 2, 5}.
export function stakeFor(lever) {
  if (lever !== 1 && lever !== 2 && lever !== 5) {
    throw new Error(`bad_lever: ${lever}`);
  }
  return 100 * lever;
}

// Win: coins += round(stake x multiplier) [multiplier from pre-round streak],
// streak += 1, wins += 1, record = max(record, coins).
export function applyWin(player, stake) {
  const mult = comboMult(player.streak);
  const coins = player.coins + Math.round(stake * mult);
  const streak = player.streak + 1;
  const wins = player.wins + 1;
  const record = Math.max(player.record, coins);
  return { ...player, coins, streak, wins, record };
}

// Lose: coins = max(0, coins - stake), streak = 0, record unchanged.
export function applyLose(player, stake) {
  return {
    ...player,
    coins: Math.max(0, player.coins - stake),
    streak: 0,
  };
}

// Flat (end price equals start price): coins, streak, record unchanged.
export function applyFlat(player) {
  return { ...player };
}

// Free refill: +300 coins, once per player, only when coins < 100.
// Ineligible calls are a no-op and do not consume the one-time flag.
// Ambiguity note: the contract does not name the flag; "refill_used" is a
// literal stand-in for "once per player".
export function refill(player) {
  if (player.coins >= 100 || player.refill_used) return { ...player };
  return {
    ...player,
    coins: player.coins + 300,
    refill_used: true,
  };
}

// A round cannot open if coins < stake.
// Rate limit: at most 60 rounds per player per rolling hour.
// roundsInLastHour is read as the total number of rounds the player would
// have in the current rolling hour including the one being opened:
// the 60th round is allowed, the 61st is refused. See the ambiguity note in
// test/unit/economy-contract.test.mjs.
export function canOpen(player, lever, roundsInLastHour = 0) {
  if (roundsInLastHour > 60) return false;
  return player.coins >= stakeFor(lever);
}
