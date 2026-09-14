/**
 * Afghanistan welcome-bonus landing page ("/af/").
 *
 * Implemented from the Figma Make design "Redesign with Real Images"
 * (desktop + mobile variants). Content lives in the arrays below so a
 * marketer can edit copy without touching markup. The registration link can
 * be overridden with VITE_AF_REGISTER_URL.
 */
import { useEffect, useRef, useState } from 'react';
import Logo from '../Logo.jsx';

const env = import.meta.env || {};
export const REGISTER_URL =
  env.VITE_AF_REGISTER_URL ||
  'https://my.xchief.com/registration?gclid=CjwKCAjwyuDTBhB-EiwANCQhLAj3EcZsIptNl5tcfZIyvJWalIKc_9VsMQOagpn2M9P96Am7SquMlxoCF5oQAvD_BwE&gbraid=0AAAAA9ZWc2h_DnwrhMPqIEs6eTTr8WlJN&campaign_id=23982802521&mode=personal';

const HERO_DESKTOP = '/af/hero-desktop.jpg';
const HERO_MOBILE = '/af/hero-mobile.jpg';
const PLATFORM_IMG = '/af/presenter.jpg';

/* ---------- icons (lucide, copied from the design) ---------- */

const svgProps = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

function UsersIcon(props) {
  return (
    <svg {...svgProps} {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <path d="M16 3.128a4 4 0 0 1 0 7.744" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <circle cx="9" cy="7" r="4" />
    </svg>
  );
}
function ShieldCheckIcon(props) {
  return (
    <svg {...svgProps} {...props}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
function WalletIcon(props) {
  return (
    <svg {...svgProps} {...props}>
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </svg>
  );
}
function CircleCheckIcon(props) {
  return (
    <svg {...svgProps} {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="m16 9-5.5 5.5L8 12" />
    </svg>
  );
}
function TrendingUpIcon(props) {
  return (
    <svg {...svgProps} {...props}>
      <path d="M16 7h6v6" />
      <path d="m22 7-8.5 8.5-5-5L2 17" />
    </svg>
  );
}
function ArrowLeftIcon(props) {
  return (
    <svg {...svgProps} {...props}>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  );
}
function ChevronDownIcon(props) {
  return (
    <svg {...svgProps} {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
function GiftIcon(props) {
  return (
    <svg {...svgProps} {...props}>
      <path d="M12 7v14" />
      <path d="M20 11v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8" />
      <path d="M7.5 7a1 1 0 0 1 0-5A4.8 8 0 0 1 12 7a4.8 8 0 0 1 4.5-5 1 1 0 0 1 0 5" />
      <rect x="3" y="7" width="18" height="4" rx="1" />
    </svg>
  );
}

/* ---------- content ---------- */

const STEPS = [
  { Icon: UsersIcon, title: 'مرحله اول', text: 'یک حساب رایگان در بروکر ایکس‌چیف بسازید.' },
  { Icon: ShieldCheckIcon, title: 'مرحله دوم', text: 'حساب خود را با تذکره یا کارت ملی تأیید کنید.' },
  { Icon: WalletIcon, title: 'مرحله سوم', text: 'حساب خود را به دالر شارژ کنید؛ هرچه واریز بیشتر، هدیه بیشتر.' },
  {
    Icon: CircleCheckIcon,
    title: 'مرحله چهارم',
    text: 'در صفحه واریز، حتماً گزینه "Enroll Welcome Bonus" را تیک بزنید.',
  },
  { Icon: TrendingUpIcon, title: 'مرحله پنجم', text: 'با سرمایه دو برابر معامله کنید.' },
];

const FEATURES = [
  'پشتیبانی از پلتفرم‌های MT4 و MT5',
  'اسپرد از صفر پیپ در حساب‌های پرایم',
  'واریز و برداشت سریع با رمزارز و روش‌های محلی',
  'بدون محدودیت در استراتژی‌های معاملاتی',
];

const FAQS = [
  {
    q: 'آیا واقعاً می‌توانم این ۵۰۰ دالر هدیه را برداشت کنم؟',
    a: 'بله، کاملاً! این هدیه صرفاً یک عدد نمایشی برای معامله نیست. سودی که با این هدیه می‌سازید از همان ابتدا و بدون هیچ محدودیتی قابل برداشت است. خودِ مبلغ هدیه هم پس از رسیدن به حجم معاملات مشخص‌شده، به‌صورت نقدی آزاد می‌شود. شما سود می‌کنید، پول واقعاً مال شماست.',
  },
  {
    q: 'حداقل مبلغ برای دریافت این دو برابر کننده چقدر است؟',
    a: 'شما می‌توانید تنها با واریز ۵۰ دالر شروع کنید و بلافاصله ۵۰ دالر دیگر از ما هدیه بگیرید. اما برای استفاده از حداکثر قدرت این طرح انحصاری، پیشنهاد می‌کنیم ۵۰۰ دالر واریز کنید تا با ۱۰۰۰ دالر سرمایه و قدرت دو برابر وارد بازارهای جهانی شوید.',
  },
  {
    q: 'آیا این هدیه روی همه حساب‌ها فعال می‌شود؟',
    a: 'این هدیه روی همه حساب‌های ایکس‌چیف فعال می‌شود، به‌جز حساب سنت (Cent). هدف ما این است که با کمترین اسپرد و بهترین شرایط استاندارد معامله کنید.',
  },
  {
    q: 'نکته طلایی در زمان واریز چیست؟ (بسیار مهم)',
    a: 'برای اینکه موجودی شما با موفقیت دو برابر شود، در صفحه واریز فقط و فقط باید گزینه "Enroll Welcome Bonus" را تیک بزنید. دقت کنید که این هدیه با طرح «اعتبار معاملاتی» (Trading Credit) هم‌زمان قابل استفاده نیست؛ پس مراقب باشید گزینه اشتباه را انتخاب نکنید!',
  },
  {
    q: 'آیا اگر قبلاً در ایکس‌چیف حساب ساخته باشم، باز هم هدیه می‌گیرم؟',
    a: 'این هدیه ویژه روی اولین واریز شما اعمال می‌شود. اگر به تازگی ثبت‌نام کرده‌اید، یا حتی اگر قبلاً حساب ساخته‌اید اما تا امروز هیچ واریزی نداشته‌اید، این فرصت طلایی دقیقاً برای شما طراحی شده است. همین حالا اولین واریز را انجام دهید و سرمایه‌تان را دو برابر کنید.',
  },
];

/* ---------- sections ---------- */

function Nav() {
  return (
    <nav className="af-nav">
      <div className="af-container af-nav-inner">
        <a href="https://www.xchief.com/" className="af-brand" aria-label="xChief" dir="ltr">
          <Logo height={28} />
        </a>
      </div>
    </nav>
  );
}

function Hero({ heroRef }) {
  return (
    <section className="af-hero" ref={heroRef}>
      <img className="af-hero-img af-hero-img-desktop" src={HERO_DESKTOP} alt="" fetchPriority="high" />
      <div
        className="af-hero-img af-hero-img-mobile"
        role="img"
        aria-label="معامله‌گری با تبلت در برابر نمای شبانه شهر"
        style={{ backgroundImage: `url(${HERO_MOBILE})` }}
      />
      <div className="af-container af-hero-inner">
        <div className="af-hero-content">
          <h1 className="af-hero-title">
            <span>تا ۵۰۰ دلار</span>
            <span>اعتبار معاملاتی هدیه</span>
          </h1>
          <p className="af-hero-sub">ویژه معامله‌گران افغانستان</p>
          {/* desktop only: the sticky bar takes over once the hero scrolls away */}
          <div className="af-hero-cta">
            <a href={REGISTER_URL} className="af-btn-red af-btn-red-desktop">
              ثبت‌نام رایگان
            </a>
            <a href="#conditions" className="af-terms-link af-terms-link-hero">
              مشاهده شرایط
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function Steps() {
  return (
    <section id="conditions" className="af-steps">
      <div className="af-container">
        <header className="af-section-head">
          <h2 className="af-h2">مراحل دریافت سرمایه دو برابری</h2>
          <p className="af-lead">
            فقط با چند قدم ساده، هدیه ۱۰۰ درصدی خود را دریافت کنید و با حاشیه امنیت بالاتری معامله کنید.
          </p>
        </header>
        <ol className="af-steps-grid">
          {STEPS.map(({ Icon, title, text }, i) => (
            <li key={title} className="af-step">
              <div className="af-step-icon">
                <Icon width={24} height={24} />
              </div>
              <h3 className="af-step-title">{title}</h3>
              <p className="af-step-text">{text}</p>
              {i < STEPS.length - 1 && <span className="af-step-line" aria-hidden="true" />}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section className="af-features">
      <div className="af-container af-features-grid">
        <div className="af-features-text">
          <h2 className="af-h2 af-h2-tight">این فرصت ویژه فقط برای معامله‌گران افغانستان است</h2>
          <p className="af-lead af-lead-start">
            با قدرت دو برابر وارد بازارهای جهانی شوید. بروکر ایکس‌چیف با ارائه پلتفرم‌های پیشرفته، اسپرد رقابتی و
            پشتیبانی اختصاصی، بهترین شرایط را برای موفقیت شما فراهم کرده است.
          </p>
          <ul className="af-feature-list">
            {FEATURES.map((f) => (
              <li key={f}>
                <CircleCheckIcon width={20} height={20} className="af-feature-check" />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="af-platform">
          <img src={PLATFORM_IMG} alt="معامله‌گر در حال کار با لپ‌تاپ" loading="lazy" />
          <div className="af-platform-overlay">
            <div className="af-platform-card">
              <div>
                <p className="af-platform-k">هدیه خوش‌آمدگویی</p>
                <p className="af-platform-v">تا سقف ۵۰۰ دالر</p>
              </div>
              <a href={REGISTER_URL} className="af-platform-go" aria-label="ثبت‌نام">
                <ArrowLeftIcon width={20} height={20} />
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Faq() {
  const [open, setOpen] = useState(0);
  return (
    <section className="af-faq">
      <div className="af-container af-faq-inner">
        <header className="af-section-head">
          <h2 className="af-h2">سوالات متداول</h2>
          <p className="af-lead">پاسخ به پرتکرارترین سوالات شما درباره طرح هدیه ایکس‌چیف</p>
        </header>
        <div className="af-faq-list">
          {FAQS.map(({ q, a }, i) => {
            const isOpen = open === i;
            return (
              <div key={q} className="af-faq-item">
                <button
                  type="button"
                  className="af-faq-q"
                  aria-expanded={isOpen}
                  aria-controls={`af-faq-a-${i}`}
                  onClick={() => setOpen(isOpen ? -1 : i)}
                >
                  <span>{q}</span>
                  <ChevronDownIcon width={20} height={20} className={`af-faq-chevron${isOpen ? ' is-open' : ''}`} />
                </button>
                <div id={`af-faq-a-${i}`} className={`af-faq-a${isOpen ? ' is-open' : ''}`}>
                  <p>{a}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="af-footer">
      <div className="af-container af-footer-inner">
        <div className="af-footer-box">
          <div className="af-footer-gift">
            <GiftIcon width={32} height={32} />
          </div>
          <h2 className="af-h2">آماده‌ی شروع هستید؟</h2>
          <p className="af-lead">
            همین حالا حساب خود را افتتاح کنید و با دریافت هدیه ۵۰۰ دالری، مسیر موفقیت در بازارهای مالی را با قدرت بیشتری
            آغاز کنید.
          </p>
          <div className="af-footer-cta">
            <a href={REGISTER_URL} className="af-btn-primary">
              <span>شروع ثبت‌نام و دریافت هدیه</span>
              <ArrowLeftIcon width={20} height={20} />
            </a>
          </div>
        </div>
        <p className="af-credits">خلق شده با ❤ برای معامله‌گران افغان</p>
      </div>
    </footer>
  );
}

function RegistrationBars({ desktopVisible }) {
  return (
    <>
      <div className="af-bar af-bar-mobile">
        <div className="af-bar-mobile-inner">
          <a href={REGISTER_URL} className="af-btn-red">
            ثبت‌نام رایگان
          </a>
          <a href="#conditions" className="af-terms-link af-terms-link-mobile">
            مشاهده شرایط
          </a>
        </div>
      </div>
      <div className={`af-bar af-bar-desktop${desktopVisible ? ' is-visible' : ''}`} aria-hidden={!desktopVisible}>
        <div className="af-container af-bar-desktop-inner">
          <a href={REGISTER_URL} className="af-btn-red af-btn-red-desktop" tabIndex={desktopVisible ? 0 : -1}>
            ثبت‌نام رایگان
          </a>
          <a href="#conditions" className="af-terms-link" tabIndex={desktopVisible ? 0 : -1}>
            مشاهده شرایط
          </a>
          <p className="af-bar-offer">تا ۵۰۰ دلار اعتبار معاملاتی هدیه</p>
        </div>
      </div>
    </>
  );
}

export default function Landing() {
  const heroRef = useRef(null);
  const [heroGone, setHeroGone] = useState(false);

  useEffect(() => {
    document.documentElement.lang = 'fa';
    document.documentElement.dir = 'rtl';
  }, []);

  // Desktop sticky bar: appears only after the hero (with its own CTA) has
  // scrolled out of view, and hides again when the user scrolls back up.
  useEffect(() => {
    const el = heroRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(([entry]) => setHeroGone(!entry.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="af-page">
      <Nav />
      <main>
        <Hero heroRef={heroRef} />
        <Steps />
        <Features />
        <Faq />
      </main>
      <Footer />
      <RegistrationBars desktopVisible={heroGone} />
    </div>
  );
}
