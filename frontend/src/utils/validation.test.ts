import { describe, expect, it } from 'vitest';
import {
  isValidPersonName,
  validatePersonName,
  isValidPhone,
  validateEmail,
  validateAdmissionYear,
} from './validation';

describe('isValidPersonName', () => {
  it('accepts ordinary Latin names', () => {
    expect(isValidPersonName('Melad Akhundzada')).toBe(true);
    expect(isValidPersonName('Maryam Karimi')).toBe(true);
    expect(isValidPersonName('Ahmad')).toBe(true);
  });

  it('accepts Pashto/Dari (Arabic-script) names', () => {
    expect(isValidPersonName('میلاد اخندزاده')).toBe(true);
    expect(isValidPersonName('احمد')).toBe(true);
    expect(isValidPersonName('زاهد افغان')).toBe(true);
  });

  it('accepts hyphens, apostrophes and dots', () => {
    expect(isValidPersonName('Ahmad-Karimi')).toBe(true);
    expect(isValidPersonName("O'Brien")).toBe(true);
    expect(isValidPersonName('Eng. Irfan')).toBe(true);
  });

  it('rejects numbers as a name (the reported bug: "4444" / "123")', () => {
    expect(isValidPersonName('123')).toBe(false);
    expect(isValidPersonName('4444')).toBe(false);
    expect(isValidPersonName('Ahmad123')).toBe(false);
    expect(isValidPersonName('12 Ahmad')).toBe(false);
  });

  it('rejects symbols-only, single letters and empty names', () => {
    expect(isValidPersonName('!!!')).toBe(false);
    expect(isValidPersonName('@@@')).toBe(false);
    expect(isValidPersonName('A')).toBe(false);
    expect(isValidPersonName('')).toBe(false);
    expect(isValidPersonName('   ')).toBe(false);
  });

  it('validatePersonName returns the plain-English error for bad names', () => {
    expect(validatePersonName('4444')).toBe('Please enter a real name (letters only, not numbers).');
    expect(validatePersonName('Melad Akhundzada')).toBeNull();
  });
});

describe('isValidPhone', () => {
  it('accepts Afghan/international numbers and empty (optional)', () => {
    expect(isValidPhone('+93700123456')).toBe(true);
    expect(isValidPhone('0700123456')).toBe(true);
    expect(isValidPhone('')).toBe(true);
    expect(isValidPhone(undefined)).toBe(true);
  });

  it('rejects too-short numbers and letters', () => {
    expect(isValidPhone('123')).toBe(false);
    expect(isValidPhone('abc')).toBe(false);
    expect(isValidPhone('700 123')).toBe(false); // only 6 digits
  });
});

describe('validateEmail / validateAdmissionYear', () => {
  it('validates email format', () => {
    expect(validateEmail('a@b.com')).toBeNull();
    expect(validateEmail('not-an-email')).not.toBeNull();
    expect(validateEmail('')).not.toBeNull();
  });

  it('accepts 2000..current year + 1 only', () => {
    const max = new Date().getFullYear() + 1;
    expect(validateAdmissionYear(2026)).toBeNull();
    expect(validateAdmissionYear(1999)).not.toBeNull();
    expect(validateAdmissionYear(max + 1)).not.toBeNull();
  });
});
