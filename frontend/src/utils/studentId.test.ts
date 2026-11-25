import { describe, expect, it } from 'vitest';
import { nextStudentId } from './studentId';

describe('nextStudentId', () => {
  it('starts at 001 when no students exist', () => {
    expect(nextStudentId([])).toBe('001');
  });

  it('continues from a legacy STU-YYYY-NNN id (e.g. Zahid STU-2026-001 -> 002)', () => {
    expect(nextStudentId(['STU-2026-001'])).toBe('002');
  });

  it('continues from plain ids', () => {
    expect(nextStudentId(['001', '002'])).toBe('003');
  });

  it('takes the max across mixed old and new formats', () => {
    expect(nextStudentId(['001', 'STU-2025-007'])).toBe('008');
  });

  it('ignores ids that match neither format', () => {
    expect(nextStudentId(['001', 'ABC'])).toBe('002');
  });

  it('keeps padding past 999', () => {
    expect(nextStudentId(['999'])).toBe('1000');
  });
});
