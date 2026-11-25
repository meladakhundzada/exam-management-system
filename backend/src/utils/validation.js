// Shared input validation — mirrors frontend/src/utils/validation.ts.
// Backend checks are the real guard: they run on every POST/PUT even when
// the frontend check is bypassed, and reject with HTTP 400 via the
// express-validator `validate` middleware.
//
// The `personName` / `phone` / `admissionYear` functions are express-validator
// custom validators: throw an Error to fail the field with that message.

const PERSON_NAME_ERROR = 'Please enter a real name (letters only, not numbers).';
const PHONE_ERROR = 'Enter a valid phone number (7–15 digits, optional leading +).';

// A real person name: at least 2 letters. Letters may be Latin or
// Pashto/Dari/Arabic script; spaces, hyphens, apostrophes and dots are
// allowed (e.g. "Maryam Karimi", "میلاد اخندزاده", "O'Brien", "Eng. Irfan").
// Digits and other symbols are NOT allowed — "123" or "4444" is not a name.
const NAME_ALLOWED = /^[\p{L}\p{M} .'\-]+$/u;

function isValidPersonName(value) {
  if (typeof value !== 'string') return false;
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 100) return false;
  if (!NAME_ALLOWED.test(name)) return false;
  const letters = name.match(/\p{L}/gu);
  return (letters ? letters.length : 0) >= 2;
}

function personName(value) {
  if (!isValidPersonName(value)) throw new Error(PERSON_NAME_ERROR);
  return true;
}

// Optional field: empty means "not given" and is valid. Otherwise only an
// optional leading + plus digits, spaces, dashes and parentheses.
function isValidPhone(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string') return false;
  const digits = value.replace(/[^\d]/g, '');
  return /^\+?[\d\s\-()]+$/.test(value.trim()) && digits.length >= 7 && digits.length <= 15;
}

function phone(value) {
  if (!isValidPhone(value)) throw new Error(PHONE_ERROR);
  return true;
}

function admissionYear(value) {
  const max = new Date().getFullYear() + 1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 2000 || value > max) {
    throw new Error(`Admission year must be between 2000 and ${max}.`);
  }
  return true;
}

module.exports = {
  PERSON_NAME_ERROR,
  PHONE_ERROR,
  isValidPersonName,
  personName,
  isValidPhone,
  phone,
  admissionYear,
};
