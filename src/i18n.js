import { createContext, useContext } from 'react';

// Persian strings are kept below for a later release, but the UI currently
// ships English only: the toggle is hidden and the stored choice is ignored.
export const ENABLED_LANGS = ['en'];
export const DEFAULT_LANG = 'en';
export const LANGS = ['fa', 'en'];
export const LANG_KEY = 'xchief.lang';

const dict = {
  fa: {
    dir: 'rtl',
    coins: 'سکه',
    record: 'رکورد',
    streak: 'استریک',
    langToggle: 'EN',
    level: { rookie: 'تازه‌کار', trader: 'تریدر', pro: 'حرفه‌ای', chief: 'Gold Chief' },
    home: {
      question: '۵ ثانیه بعد، طلا بالاتر می‌ره یا پایین‌تر؟',
      start: 'شروع چالش',
      note: 'هر دور {base} سکه × اهرم شرط می‌بندی',
      more: 'سکهٔ بیشتر',
      toNext: '{n} سکه تا سطح {level}',
      maxLevel: 'بالاترین سطح',
    },
    game: {
      home: '→ خانه',
      after: '۵ ثانیه بعد؟',
      help: 'اهرم رو انتخاب کن، بعد جهت رو بزن',
      stake: 'شرط',
      win: 'برد',
      locked: 'پیش‌بینی قفل شد',
      lever: 'اهرم',
      up: 'صعود ▲',
      down: 'نزول ▼',
      brokeTitle: 'سکه‌هات تموم شد',
      brokeSub: 'با انجام یک کار کوچک دوباره سکه بگیر و برگرد',
      brokeCta: 'سکه بگیر',
    },
    feed: {
      live: 'زنده',
      poll: 'زنده',
      connecting: 'در حال اتصال…',
      demo: 'دمو',
      quiet: 'بازار آرام',
      waiting: 'در انتظار قیمت بازار…',
      note: 'قیمت لحظه‌ای طلا ({symbol})',
      noteQuiet: 'بازار ثابته؛ حرکت ریز شبیه‌سازی‌شده روی آخرین قیمت',
    },
    result: {
      winTitle: 'درست پیش‌بینی کردی!',
      winDelta: '{n}+ سکه',
      winSub: 'شرط {stake} × {mult}',
      streakTag: 'استریک {n} · ضریب ×{mult}',
      daily: 'جایزهٔ اولین برد امروز {n}+',
      missTitle: 'این بار نشد',
      missDelta: '{n}− سکه',
      missSub: 'استریک صفر شد؛ دوباره پیش‌بینی کن',
      tieTitle: 'قیمت تغییر نکرد',
      tieSub: 'سکه‌ات برگشت؛ یک دور دیگه',
      start: 'شروع',
      end: 'پایان',
      again: 'دور بعدی',
      lb: 'لیدربورد',
      tasks: 'سکه بگیر',
      newRecord: 'رکورد جدید!',
      badge: { high_roller: 'نشان High Roller', hot_streak: 'نشان Hot Streak', comeback: 'نشان Comeback' },
    },
    body: {
      lever: 'اهرم',
      hintIdle: 'اهرم رو بکش، بعد جهت رو انتخاب کن',
      hintRunning: 'انتخاب تا پایان دور قفل شد',
      hintWin: 'موجودی: {bal} سکه',
      hintLose: 'دور بعدی رو شروع کن',
      cantAfford: 'سکه کافی نیست',
    },
    lb: { title: 'لیدربورد', you: 'شما', byRecord: 'بر اساس رکورد' },
    nav: { home: 'خانه', play: 'بازی', tasks: 'سکه', lb: 'لیدربورد' },
    tasks: {
      title: 'سکه بگیر',
      sub: 'هر کار یک بار سکه می‌ده؛ برگرد و رکوردت رو بشکن',
      reward: '{n}+',
      start: 'شروع',
      open: 'باز کن',
      waiting: '{s} ثانیه…',
      done: 'انجام دادم ✓',
      claimed: 'دریافت شد',
      again: 'دوباره تا {t}',
      verify: 'تأیید پرسنل',
      pinTitle: 'تأیید پرسنل غرفه',
      pinSub: 'PIN چهاررقمی رو وارد کنید',
      pinWrong: 'PIN اشتباهه',
      pinOk: 'تأیید',
      cancel: 'انصراف',
      videoTitle: 'xChief رو بشناس',
      videoSub: 'چند ثانیه صبر کن، سکه‌ت میاد',
      shareText: 'رکوردم توی چالش طلای xChief: {record} سکه! تو می‌تونی بزنی؟ {url}',
      copied: 'متن کپی شد؛ توی استوری بذار',
      items: {
        video: { title: 'ویدیوی xChief', desc: '۱۵ ثانیه، هر ۵ دقیقه' },
        email: { title: 'ثبت ایمیل', desc: 'امتیازت ذخیره می‌شه' },
        instagram: { title: 'فالو اینستاگرام', desc: '@xchief' },
        telegram: { title: 'عضویت کانال تلگرام', desc: 'اخبار و سیگنال' },
        youtube: { title: 'سابسکرایب یوتیوب', desc: 'آموزش ترید' },
        story: { title: 'استوری رکوردت', desc: 'با تگ xChief · روزی یک بار' },
        review_trustpilot: { title: 'نظر در Trustpilot', desc: 'تجربه‌ت رو بنویس' },
        review_google: { title: 'نظر در گوگل', desc: 'تجربه‌ت رو بنویس' },
        review_fpa: { title: 'نظر در Forex Peace Army', desc: 'تجربه‌ت رو بنویس' },
        demo: { title: 'حساب دموی xChief بساز', desc: 'بزرگ‌ترین جایزه · ۲ دقیقه' },
      },
    },
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
    toast: { limit: 'سقف ۶۰ دور در ساعت؛ کمی استراحت کن', coins: '{n}+ سکه' },
    update: { text: 'نسخهٔ جدید بازی آماده‌ست', cta: 'به‌روزرسانی' },
  },
  en: {
    dir: 'ltr',
    coins: 'coins',
    record: 'Record',
    streak: 'Streak',
    langToggle: 'فا',
    level: { rookie: 'Rookie', trader: 'Trader', pro: 'Pro', chief: 'Gold Chief' },
    home: {
      question: 'In 5 seconds, does gold go up or down?',
      start: 'Start the challenge',
      note: 'Each round stakes {base} coins × lever',
      more: 'Get coins',
      toNext: '{n} coins to {level}',
      maxLevel: 'Top level',
    },
    game: {
      home: '← Home',
      after: 'Up or down in 5s?',
      help: 'Pick a lever, then tap a direction',
      stake: 'Stake',
      win: 'win',
      locked: 'Prediction locked',
      lever: 'lever',
      up: 'Up ▲',
      down: 'Down ▼',
      brokeTitle: 'Out of coins',
      brokeSub: 'Do a quick task, get coins, come back',
      brokeCta: 'Get coins',
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
    result: {
      winTitle: 'You called it!',
      winDelta: '+{n} coins',
      winSub: 'Stake {stake} × {mult}',
      streakTag: 'Streak {n} · ×{mult} multiplier',
      daily: 'First win of the day +{n}',
      missTitle: 'Not this time',
      missDelta: '−{n} coins',
      missSub: 'Streak reset. Go again',
      tieTitle: 'Price did not move',
      tieSub: 'Stake returned. One more round',
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
      hintIdle: 'Drag the lever, then pick a direction',
      hintRunning: 'Locked until the round ends',
      hintWin: 'Balance: {bal} coins',
      hintLose: 'Start the next round',
      cantAfford: 'Not enough coins',
    },
    lb: { title: 'Leaderboard', you: 'You', byRecord: 'by record' },
    nav: { home: 'Home', play: 'Play', tasks: 'Coins', lb: 'Board' },
    tasks: {
      title: 'Get coins',
      sub: 'Each task pays once. Come back and beat your record',
      reward: '+{n}',
      start: 'Start',
      open: 'Open',
      waiting: '{s}s…',
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
      shareText: 'My record in the xChief Gold Rush: {record} coins. Can you beat it? {url}',
      copied: 'Text copied. Post it to your story',
      items: {
        video: { title: 'Watch the xChief video', desc: '15 s, every 5 min' },
        email: { title: 'Save your email', desc: 'Keeps your score' },
        instagram: { title: 'Follow on Instagram', desc: '@xchief' },
        telegram: { title: 'Join the Telegram channel', desc: 'News & signals' },
        youtube: { title: 'Subscribe on YouTube', desc: 'Trading lessons' },
        story: { title: 'Share your record', desc: 'Tag xChief · once a day' },
        review_trustpilot: { title: 'Review on Trustpilot', desc: 'Tell your experience' },
        review_google: { title: 'Review on Google', desc: 'Tell your experience' },
        review_fpa: { title: 'Review on Forex Peace Army', desc: 'Tell your experience' },
        demo: { title: 'Open an xChief demo account', desc: 'Biggest reward · 2 min' },
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
    },
    toast: { limit: '60 rounds per hour max. Take a breather', coins: '+{n} coins' },
    update: { text: 'A new version of the game is ready', cta: 'Update' },
  },
};

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function num(n, lang) {
  const s = Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (lang !== 'fa') return s;
  return s.replace(/\d/g, (d) => FA_DIGITS[d]).replace(/,/g, '٬').replace(/\./g, '٫');
}

export function money(v) {
  return Number(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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
