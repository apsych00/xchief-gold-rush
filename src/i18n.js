import { createContext, useContext } from 'react';

export const ENABLED_LANGS = ['en'];
export const DEFAULT_LANG = 'en';
export const LANGS = ['en'];
export const LANG_KEY = 'xchief.lang';

const dict = {
  en: {
    dir: 'ltr',
    coins: 'coins',
    record: 'Record',
    streak: 'Combo',
    combo: {
      label: 'Combo',
      idle: 'Streak bonus',
      next: 'Next win ×{mult}',
      max: 'Max combo ×{mult}',
      reset: 'Combo reset',
    },
    level: { rookie: 'Rookie', trader: 'Trader', pro: 'Pro', chief: 'Gold Chief' },
    home: {
      question: 'In 5 seconds, does gold go up or down?',
      start: 'Start the challenge',
      note: 'Each round stakes {base} coins × lever',
      rules: 'Call it right, win your stake. Wins in a row raise your combo up to ×{max}.',
      more: 'Get coins',
      toNext: '{n} coins to {level}',
      maxLevel: 'Top level',
    },
    game: {
      home: '← Home',
      after: 'Up or down in 5s?',
      help: 'Choose a multiplier, then tap Up or Down',
      stake: 'Stake',
      win: 'win',
      locked: 'Prediction locked',
      lever: 'lever',
      up: 'Up ▲',
      down: 'Down ▼',
      brokeTitle: 'Out of coins',
      brokeSub: 'Do a quick task, get coins, come back',
      brokeCta: 'Get coins',
      freeTitle: 'Out of coins',
      freeSub: 'Here is a one-time refill on us',
      freeCta: 'Claim +{n} coins',
    },
    feed: {
      live: 'LIVE',
      poll: 'LIVE',
      connecting: 'Connecting…',
      demo: 'DEMO',
      quiet: 'QUIET MARKET',
      waiting: 'Waiting for market price…',
      note: 'Live gold price ({symbol})',
      noteQuiet: 'Market is flat; micro-moves simulated on the last price',
    },
    conn: {
      lostTitle: 'Connection lost',
      refusedTitle: 'Too many players on this network',
      reconnecting: 'Reconnecting',
    },
    result: {
      winTitle: 'You called it!',
      winDelta: '+{n} coins',
      winSub: 'Stake {stake} × {mult}',
      streakTag: 'Combo {n} · stake {stake} × {mult}',
      nextCombo: 'Next win pays ×{mult}',
      maxCombo: 'Max combo! Every win pays ×{mult}',
      missTitle: 'Not this time',
      missDelta: '−{n} coins',
      missSub: 'Combo reset. Go again',
      tieTitle: 'Price did not move',
      tieSub: 'Stake returned. Combo kept',
      start: 'Start',
      end: 'End',
      again: 'Next round',
      lb: 'Leaderboard',
      tasks: 'Get coins',
      newRecord: 'New record!',
      badge: { high_roller: 'High Roller badge', hot_streak: 'Hot Streak badge', comeback: 'Comeback badge' },
    },
    body: {
      lever: 'Lever',
      win: 'win',
      hintIdle: 'Drag the lever, then pick a direction',
      hintRunning: 'Locked until the round ends',
      hintWin: 'Balance: {bal} coins',
      hintLose: 'Start the next round',
      cantAfford: 'Not enough coins',
    },
    lb: {
      title: 'Leaderboard',
      you: 'You',
      byRecord: 'by record',
      guestNote: "You're playing as guest - add your email to be ranked",
    },
    tournament: {
      none: 'No tournament running',
      ended: 'Ended',
      daysLeft: '{n}d left',
      hoursLeft: '{n}h left',
    },
    identity: {
      playingAs: 'Playing as {email}',
      savedNote: 'Your score and rank are saved to this email',
      signOut: 'Sign out',
      welcomeBack: 'Welcome back',
    },
    otp: {
      title: 'Verify your email',
      emailSub: "We'll send you an 8-digit code",
      emailPlaceholder: 'you@email.com',
      send: 'Send code',
      codeTitle: 'Enter the code',
      codeSub: 'We sent an 8-digit code to {email}',
      verify: 'Verify',
      resend: 'Resend code',
      resendWait: 'Resend in {s}s',
      cancel: 'Not now',
      doneTitle: "You're verified",
      doneRecord: 'Record: {n} coins',
      close: 'Done',
      errors: {
        invalid_email: 'Enter a valid email',
        invalid_code: 'That code is not right. Try again',
        expired_code: 'That code expired. Send a new one',
        too_many_attempts: 'Too many tries. Send a new code',
        default: 'Something went wrong. Try again',
      },
    },
    nav: { home: 'Home', play: 'Play', tasks: 'Missions', lb: 'Board' },
    profile: {
      open: 'Your profile',
      guest: 'You',
      toNext: '{n} coins to {level}',
      coins: 'Coins',
      rounds: 'Rounds',
      winRate: 'Win rate',
      bestCombo: 'Best combo',
      combo: 'Combo now',
      badges: 'Badges',
      earned: 'Earned',
      badge: { high_roller: 'High Roller', hot_streak: 'Hot Streak', comeback: 'Comeback' },
      badgeHint: {
        high_roller: 'Win a round at ×5',
        hot_streak: 'Win 4 in a row',
        comeback: 'Set a record right after going broke',
      },
      account: 'Account',
      email: 'Email',
      addEmail: 'Add email · +200',
      xchief: 'xChief account',
      linked: 'Linked ✓',
      openAccount: 'Open account · +{n}',
      share: 'Share my record',
      shareText: 'My record in the xChief Gold Rush: {record} coins ({level}). Can you beat it? {url}',
      foot: 'Progress is saved on this device.',
    },
    share: {
      // Modal chrome
      heading: 'Share my record',
      preparing: 'Preparing your badge…',
      shareBtn: 'Share',
      download: 'Download image',
      joinLabel: 'Play the challenge',
      close: 'Close',
      // Toasts
      failed: 'Could not share. Try again',
      saved: 'Image saved',
      // Text drawn onto the badge itself (the canvas pass reads these)
      badgeEyebrow: 'GOLD RUSH RECORD',
      badgeUnit: 'COINS',
      badgeTagline: 'Can you beat it?',
      badgeScan: 'Scan to play',
    },
    tasks: {
      title: 'Missions',
      sub: 'Each mission pays once. Come back and beat your record',
      reward: '+{n}',
      start: 'Start',
      open: 'Open',
      waiting: '{s}s…',
      signupWaiting: '{t} left',
      done: 'Done ✓',
      claimed: 'Claimed',
      again: 'Again in {t}',
      verify: 'Staff check',
      pinTitle: 'Booth staff check',
      pinSub: 'Enter the 4-digit PIN',
      pinWrong: 'Wrong PIN',
      pinOk: 'Confirm',
      cancel: 'Cancel',
      videoTitle: 'Meet xChief',
      videoSub: 'A few seconds and your coins arrive',
      videoWatchNote: 'Watch for 30 seconds or more to get the reward',
      videoBlockedHint: 'This video could not be loaded. Please skip and try again later.',
      videoStep: '{n} of {total}',
      videoCooldown: 'Next video in {t}',
      skip: 'Skip',
      shareText: 'My record in the xChief Gold Rush: {record} coins. Can you beat it? {url}',
      copied: 'Text copied. Post it to your story',
      instagramDone: 'Followed! +300 coins',
      instagramFailed: 'Instagram did not confirm. Try again.',
      instagramComingSoon: 'Instagram rewards are coming soon',
      instagramHandleTitle: 'Your Instagram handle',
      instagramHandleSub: 'Enter your handle, then follow @{handle} to earn the reward',
      instagramHandlePlaceholder: 'yourhandle',
      instagramFollowCta: 'Follow @{handle}',
      instagramFollowTitle: 'Follow @{handle}',
      instagramFollowSub: 'Follow @{handle} on Instagram, then come back and tap Check.',
      instagramOpenAgain: 'Open Instagram',
      instagramCheckCta: 'I followed, check',
      instagramChecking: 'Checking…',
      instagramCheckingCount: 'Checking… {n}',
      instagramNotFollowing: 'We could not see the follow yet. Follow @{handle} and tap check again.',
      instagramNotConfirmed: 'Not confirmed yet. Tap check again.',
      instagramPrivate: 'Your account is private; make it public for a moment or ask the booth staff.',
      instagramNotFound: 'We could not find that handle. Check the spelling and try again.',
      instagramHandleTaken: 'That handle is already linked to another player.',
      instagramAlreadyVerified: 'You already claimed this reward.',
      instagramInvalidHandle: 'That does not look like a valid Instagram handle.',
      instagramRateLimited: 'One moment - please wait a few seconds and check again.',
      items: {
        video: { title: 'Watch the xChief video', desc: '15 s, every 5 min' },
        email: { title: 'Save your email', desc: 'Keeps your score' },
        instagram: { title: 'Follow on Instagram', desc: '@{handle}' },
        telegram: { title: 'Join the Telegram channel', desc: 'News & signals' },
        youtube: { title: 'Subscribe on YouTube', desc: 'Trading lessons' },
        story: { title: 'Share your record', desc: 'Tag xChief · once a day' },
        review_trustpilot: { title: 'Review on Trustpilot', desc: 'Tell your experience' },
        review_google: { title: 'Review on Google', desc: 'Tell your experience' },
        review_fpa: { title: 'Review on Forex Peace Army', desc: 'Tell your experience' },
        youtube_videos: { title: 'Watch xChief videos', desc: 'Watch each to earn coins' },
        signup: { title: 'Open an xChief account', desc: 'Biggest reward · email' },
      },
    },
    lead: {
      title: 'Save your score',
      sub: 'Drop your email to keep your points and get rewards',
      placeholder: 'you@email.com',
      cta: 'Save',
      done: 'Saved ✓ your score is safe',
      invalid: 'Enter a valid email',
      privacy: 'No spam. Unsubscribe anytime.',
      lbTitle: 'Want to stay on the board?',
      lbSub: 'Add your email to lock in your rank',
      winTitle: 'Save this score',
      winSub: 'Your email keeps your record and rank',
      skip: 'Not now',
    },
    signup: {
      title: 'Open your xChief account',
      sub: 'Fill this in, get +{n} coins now, then finish on xchief.com',
      email: 'you@email.com',
      privacy: 'xChief will contact you about your account. No spam.',
      cta: 'Get +{n} coins',
      notNow: 'Not now',
      errEmail: 'Enter a valid email',
      doneTitle: 'Coins added ✓',
      doneSub: 'Finish your registration on xchief.com to activate the account',
      open: 'Open xchief.com',
      back: 'Back to the game',
      brokeTitle: 'Out of coins',
      brokeSub: 'Open an xChief account and jump back in with +{n} coins',
      brokeAlt: 'or claim {n} free coins',
      brokeAltUsed: 'or get coins with a quick task',
      traderTitle: 'You play like a Trader',
      traderSub: 'Get a real xChief account and +{n} coins',
    },
    toast: { limit: '60 rounds per hour max. Take a breather', coins: '+{n} coins' },
    update: { text: 'A new version of the game is ready', cta: 'Update' },
    // ticket C11: the web first-visit tour (A5), three cards shown one at a time. next/gotIt/skip
    // are the controls the shared E2E helper (tests/e2e/first-visit.js) drives.
    tour: {
      card1: {
        title: 'Call the next 5 seconds',
        body: 'Gold goes up or down. Pick one before the round starts.',
      },
      card2: {
        title: 'Win coins, climb the board',
        body: 'Every right call adds to your record; the top of the board wins the prize.',
      },
      card3: {
        title: 'Verify your email to be ranked',
        body: 'Anonymous play is fine; only verified emails appear on the leaderboard.',
      },
      next: 'Next',
      gotIt: 'Got it',
      skip: 'Skip',
    },
    kioskWin: {
      qrTitleEn: 'Congratulations! You won the xChief $100 bonus. Scan to claim your gift:',
      scannedBtnEn: "I've scanned it",
    },
    // ticket C11: the kiosk intro (A6). kioskIntro.en is read directly by key (never through
    // the active-lang lookup). {n} is the streak target from the server's kiosk_session frame,
    // never a number baked into the client.
    kioskIntro: {
      en: 'Predict gold for 5 seconds. Win {n} in a row and take home the $100 bonus.',
    },
    claim: {
      title: 'Your xChief $100 bonus',
      step1: 'Enter the email you want the bonus sent to',
      step2: 'Your gift card appears here',
      step3: 'We also email it to you',
      emailPlaceholder: 'you@email.com',
      cta: 'Get my code',
      cardNote: 'Screenshot this or check your inbox',
      sentTo: 'Sent to {email}',
      copy: 'Copy',
      copied: 'Copied',
      claimedBy: 'This gift was claimed by {email}',
      expired: 'This link has expired. Ask the booth staff.',
      invalid: 'This link is not valid.',
      errInvalidEmail: 'Enter a valid email',
      errDefault: 'Something went wrong. Try again',
    },
  },
};

export function num(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function money(v) {
  return Number(v)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function interpolate(str, vars) {
  return str.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export function makeT(lang) {
  const d = dict[lang] || dict.en;
  return (path, vars) => {
    const val = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), d);
    if (typeof val !== 'string') return path;
    return vars ? interpolate(val, vars) : val;
  };
}

export function readStoredLang() {
  if (ENABLED_LANGS.length < 2) return DEFAULT_LANG;
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (ENABLED_LANGS.includes(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_LANG;
}

export const LangContext = createContext({ lang: DEFAULT_LANG, t: makeT(DEFAULT_LANG), setLang: () => {} });
export const useLang = () => useContext(LangContext);
