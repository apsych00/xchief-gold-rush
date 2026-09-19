/**
 * The client-side validation PromptModal.jsx falls back to for its two field types (unify-
 * email-modal ticket). Pulled into its own module so it is plain, dependency-free logic a unit
 * test can call directly - no React, no i18n - while PromptModal.jsx imports the same functions
 * it tests here, so there is exactly one place this rule lives.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(value) {
  return EMAIL_RE.test(String(value ?? '').trim());
}

export function isValidCode(value, length = 8) {
  const v = String(value ?? '');
  return v.length === length && /^\d+$/.test(v);
}
