// Shared input validation for person/data forms.
// The same rules exist on the backend (backend/src/utils/validation.js):
// frontend checks give instant feedback, backend checks are the real guard
// and reject bypassed requests with HTTP 400.

export const PERSON_NAME_ERROR = 'Please enter a real name (letters only, not numbers).';

// A real person name: at least 2 letters. Letters may be Latin or
// Pashto/Dari/Arabic script; spaces, hyphens, apostrophes and dots are
// allowed (e.g. "Maryam Karimi", "میلاد اخندزاده", "O'Brien", "Eng. Irfan").
// Digits and other symbols are NOT allowed — "123" or "4444" is not a name.
const NAME_ALLOWED = /^[\p{L}\p{M} .'\-]+$/u;

export function isValidPersonName(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 100) return false;
  if (!NAME_ALLOWED.test(name)) return false;
  const letters = name.match(/\p{L}/gu);
  return (letters?.length ?? 0) >= 2;
}

export function validatePersonName(value: unknown): string | null {
  return isValidPersonName(value) ? null : PERSON_NAME_ERROR;
}

export const PHONE_ERROR = 'Enter a valid phone number (7–15 digits, optional leading +).';

// Optional field: empty means "not given" and is valid. Otherwise only an
// optional leading + plus digits, spaces, dashes and parentheses.
export function isValidPhone(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string') return false;
  const digits = value.replace(/[^\d]/g, '');
  return /^\+?[\d\s\-()]+$/.test(value.trim()) && digits.length >= 7 && digits.length <= 15;
}

export function validatePhone(value: unknown): string | null {
  return isValidPhone(value) ? null : PHONE_ERROR;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(value: unknown): string | null {
  return typeof value === 'string' && EMAIL_RE.test(value.trim())
    ? null
    : 'Enter a valid email address.';
}

export function validateAdmissionYear(year: unknown): string | null {
  const max = new Date().getFullYear() + 1;
  return typeof year === 'number' && Number.isInteger(year) && year >= 2000 && year <= max
    ? null
    : `Admission year must be between 2000 and ${max}.`;
}
