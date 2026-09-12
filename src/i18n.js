import { createContext, useContext } from 'react';

export const LANGS = ['fa', 'en'];
export const LANG_KEY = 'xchief.lang';

const dict = {
  fa: {
    dir: 'rtl',
    pts: 'امتیاز',
    langToggle: 'EN',
    home: {
      question: '۵ ثانیه بعد، طلا بالاتر می‌ره یا پایین‌تر؟',
      start: 'شروع چالش',
      note: 'امتیاز پایه هر برد: {base} × اهرم',
    },
    game: {
      home: '→ خانه',
      after: '۵ ثانیه بعد؟',
      help: 'اهرم رو با اسلایدر انتخاب کن، بعد جهت رو بزن',
      levPill: 'اهرم امتیاز',
      win: 'برد =',
      locked: 'پیش‌بینی قفل شد',
      lever: 'اهرم',
      up: 'صعود ▲',
      down: 'نزول ▼',
    },
    feed: {
      live: 'زنده',
      poll: 'زنده',
      connecting: 'در حال اتصال…',
      demo: 'دمو',
      waiting: 'در انتظار قیمت بازار…',
      note: 'قیمت لحظه‌ای طلا (PAXG/USD)',
    },
    result: {
      winTitle: 'درست پیش‌بینی کردی!',
      winPoints: '{pts}+ امتیاز',
      winSub: '{base} امتیاز پایه × {lev}',
      missTitle: 'این بار نشد؛ دوباره پیش‌بینی کن',
      missSub: 'امتیازی کسر نمی‌شود',
      tieTitle: 'قیمت تغییر نکرد',
      tieSub: 'بدون امتیاز؛ یک دور دیگه امتحان کن',
      start: 'قیمت شروع',
      end: 'قیمت پایان',
      again: 'دور بعدی',
      lb: 'لیدربورد',
    },
    body: {
      lever: 'اهرم امتیاز',
      hintIdle: 'اهرم رو بکش، بعد جهت رو انتخاب کن',
      hintRunning: 'انتخاب تا پایان دور قفل شد',
      hintWin: 'موجودی: {bal} امتیاز',
      hintLose: 'دور بعدی رو شروع کن',
    },
    lb: { title: 'لیدربورد', you: 'شما' },
    nav: { home: 'خانه', play: 'بازی', lb: 'لیدربورد' },
    lead: {
      title: 'امتیازت رو ذخیره کن',
      sub: 'ایمیلت رو بزن تا امتیازها و جایزه‌ها رو از دست ندی',
      placeholder: 'ایمیل شما',
      cta: 'ثبت',
      done: 'ثبت شد ✓ امتیازت ذخیره می‌شه',
      invalid: 'یک ایمیل معتبر وارد کن',
      privacy: 'بدون اسپم. هر وقت خواستی لغو کن.',
      lbTitle: 'می‌خوای تو لیدربورد بمونی؟',
      lbSub: 'ایمیلت رو بزن تا رتبه‌ت ثبت بشه',
    },
  },
  en: {
    dir: 'ltr',
    pts: 'pts',
    langToggle: 'فا',
    home: {
      question: 'In 5 seconds, does gold go up or down?',
      start: 'Start the challenge',
      note: 'Base points per win: {base} × lever',
    },
    game: {
      home: '← Home',
      after: 'Up or down in 5s?',
      help: 'Pick a lever with the slider, then tap a direction',
      levPill: 'Points lever',
      win: 'win =',
      locked: 'Prediction locked',
      lever: 'lever',
      up: 'Up ▲',
      down: 'Down ▼',
    },
    feed: {
      live: 'LIVE',
      poll: 'LIVE',
      connecting: 'Connecting…',
      demo: 'DEMO',
      waiting: 'Waiting for market price…',
      note: 'Live gold price (PAXG/USD)',
    },
    result: {
      winTitle: 'You called it!',
      winPoints: '+{pts} pts',
      winSub: '{base} base × {lev}',
      missTitle: 'Not this time. Go again',
      missSub: 'No points deducted',
      tieTitle: 'Price did not move',
      tieSub: 'No points. Try another round',
      start: 'Start',
      end: 'End',
      again: 'Next round',
      lb: 'Leaderboard',
    },
    body: {
      lever: 'Points lever',
      hintIdle: 'Drag the lever, then pick a direction',
      hintRunning: 'Locked until the round ends',
      hintWin: 'Balance: {bal} pts',
      hintLose: 'Start the next round',
    },
    lb: { title: 'Leaderboard', you: 'You' },
    nav: { home: 'Home', play: 'Play', lb: 'Board' },
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
    },
  },
};

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** Integer → localized digits with a thousands separator. */
export function num(n, lang) {
  const s = Math.round(n).toLocaleString('en-US');
  if (lang !== 'fa') return s;
  return s.replace(/\d/g, (d) => FA_DIGITS[d]).replace(/,/g, '٬');
}

/** Price → "2,500.00" (always Latin digits, shown inside dir="ltr"). */
export function money(v) {
  return v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function interpolate(str, vars) {
  return str.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export function makeT(lang) {
  const d = dict[lang] || dict.fa;
  return (path, vars) => {
    const val = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), d);
    if (typeof val !== 'string') return path;
    return vars ? interpolate(val, vars) : val;
  };
}

export function readStoredLang() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (LANGS.includes(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return 'fa';
}

export const LangContext = createContext({ lang: 'fa', t: makeT('fa'), setLang: () => {} });
export const useLang = () => useContext(LangContext);
