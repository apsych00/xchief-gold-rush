const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** Integer → Persian digits with Persian thousands separator (٬). */
export function fa(n) {
  return Math.round(n)
    .toLocaleString('en-US')
    .replace(/\d/g, (d) => FA_DIGITS[d])
    .replace(/,/g, '٬');
}

/** Price → "2,500.00" (Latin digits, used inside dir="ltr" spans). */
export function money(v) {
  return v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
