// Tests for backend/src/utils/validation.js — person-name / phone /
// admission-year validators shared with the frontend.
// Run with: node --test backend/test/validation.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidPersonName,
  personName,
  isValidPhone,
  phone,
  admissionYear,
} = require('../src/utils/validation');

test('person name: accepts Latin and Pashto/Dari names', () => {
  assert.equal(isValidPersonName('Melad Akhundzada'), true);
  assert.equal(isValidPersonName('میلاد اخندزاده'), true);
  assert.equal(isValidPersonName('احمد'), true);
  assert.equal(isValidPersonName("O'Brien"), true);
  assert.equal(isValidPersonName('Eng. Irfan'), true);
});

test('person name: rejects numbers as a name (the reported bug)', () => {
  assert.equal(isValidPersonName('123'), false);
  assert.equal(isValidPersonName('4444'), false);
  assert.equal(isValidPersonName('Ahmad123'), false);
  assert.equal(isValidPersonName('!!!'), false);
  assert.equal(isValidPersonName('A'), false);
  assert.equal(isValidPersonName(''), false);
});

test('personName custom validator throws with a clear message', () => {
  assert.throws(() => personName('4444'), /real name/);
  assert.equal(personName('Melad Akhundzada'), true);
});

test('phone: optional, 7–15 digits with optional leading +', () => {
  assert.equal(isValidPhone(''), true);
  assert.equal(isValidPhone(undefined), true);
  assert.equal(isValidPhone('+93700123456'), true);
  assert.equal(isValidPhone('0700123456'), true);
  assert.equal(isValidPhone('123'), false);
  assert.equal(isValidPhone('abc'), false);
  assert.throws(() => phone('123'), /phone number/);
});

test('admissionYear: 2000..current year + 1', () => {
  const max = new Date().getFullYear() + 1;
  assert.equal(admissionYear(2026), true);
  assert.throws(() => admissionYear(1999), /Admission year/);
  assert.throws(() => admissionYear(max + 1), /Admission year/);
  assert.throws(() => admissionYear(undefined), /Admission year/);
});
