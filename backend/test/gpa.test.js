// Tests for backend/src/utils/gpa.js — grade banding with total_marks.
// Run with: node --test backend/test/gpa.test.js
// (Backend has no test runner in package.json; Node 18+ built-in test runner.)
const test = require('node:test');
const assert = require('node:assert/strict');
const { gradeForMarks, calculateGpa } = require('../src/utils/gpa');

// Default grade scale (percentages): A 90–100, B 80–89, C 70–79, D 60–69, F 0–59.
const SCALE = [
  { grade: 'A', min_marks: 90, max_marks: 100, grade_point: 4.0, is_passing: true },
  { grade: 'B', min_marks: 80, max_marks: 89, grade_point: 3.0, is_passing: true },
  { grade: 'C', min_marks: 70, max_marks: 79, grade_point: 2.0, is_passing: true },
  { grade: 'D', min_marks: 60, max_marks: 69, grade_point: 1.0, is_passing: true },
  { grade: 'F', min_marks: 0, max_marks: 59, grade_point: 0.0, is_passing: false },
];

test('gradeForMarks: exam out of 100 grades as before', () => {
  assert.equal(gradeForMarks(95, 100, SCALE).grade, 'A');
  assert.equal(gradeForMarks(85, 100, SCALE).grade, 'B');
  assert.equal(gradeForMarks(72, 100, SCALE).grade, 'C');
  assert.equal(gradeForMarks(60, 100, SCALE).grade, 'D');
  assert.equal(gradeForMarks(30, 100, SCALE).grade, 'F');
});

test('gradeForMarks: exam out of 50 grades by percentage (45/50 = 90% = A)', () => {
  assert.equal(gradeForMarks(45, 50, SCALE).grade, 'A');
  assert.equal(gradeForMarks(40, 50, SCALE).grade, 'B'); // 80%
  assert.equal(gradeForMarks(25, 50, SCALE).grade, 'F'); // 50%
});

test('gradeForMarks: exam out of 200 grades by percentage', () => {
  assert.equal(gradeForMarks(180, 200, SCALE).grade, 'A'); // 90%
  assert.equal(gradeForMarks(140, 200, SCALE).grade, 'C'); // 70%
  assert.equal(gradeForMarks(118, 200, SCALE).grade, 'F'); // 59%
  assert.equal(gradeForMarks(119, 200, SCALE), null); // 59.5% falls between F (≤59) and D (≥60)
});

test('gradeForMarks: band boundaries are inclusive', () => {
  assert.equal(gradeForMarks(90, 100, SCALE).grade, 'A');
  assert.equal(gradeForMarks(89, 100, SCALE).grade, 'B');
  assert.equal(gradeForMarks(59, 100, SCALE).grade, 'F');
  assert.equal(gradeForMarks(44.5, 50, SCALE).grade, 'B'); // 89%
  assert.equal(gradeForMarks(45, 50, SCALE).grade, 'A'); // 90%
});

test('gradeForMarks: returns null when no band covers the percentage', () => {
  const gapScale = [
    { grade: 'A', min_marks: 90, max_marks: 100, grade_point: 4.0 },
    { grade: 'F', min_marks: 0, max_marks: 49, grade_point: 0.0 },
  ];
  assert.equal(gradeForMarks(70, 100, gapScale), null); // 70% falls in the gap
  assert.equal(gradeForMarks(35, 50, gapScale), null); // 70% of 50, same gap
});

test('gradeForMarks: invalid totals return null instead of a wrong grade', () => {
  assert.equal(gradeForMarks(50, 0, SCALE), null);
  assert.equal(gradeForMarks(50, -10, SCALE), null);
  assert.equal(gradeForMarks(50, null, SCALE).grade, 'F'); // null total defaults to 100
  assert.equal(gradeForMarks(101, 100, SCALE), null); // over 100%
  assert.equal(gradeForMarks(-5, 100, SCALE), null);
});

test('gradeForMarks: old 2-arg call still works (total defaults to 100)', () => {
  assert.equal(gradeForMarks(95, SCALE).grade, 'A');
  assert.equal(gradeForMarks(30, SCALE).grade, 'F');
});

test('calculateGpa: unchanged behaviour', () => {
  assert.equal(calculateGpa([
    { grade_point: 4.0, credit_hours: 3 },
    { grade_point: 3.0, credit_hours: 3 },
  ]), 3.5);
  assert.equal(calculateGpa([]), null);
});
