// Auto-generation of student numbers: STU-<admission year>-<sequence>.
// The sequence is the next number after the highest existing student number
// for that year, so IDs stay unique without the user typing anything.

export function nextStudentId(
  existingIds: string[] | null,
  year: number = new Date().getFullYear(),
): string {
  // List could not be fetched: fall back to a timestamp suffix so the
  // generated ID is still unique (the backend rejects duplicates with 409,
  // and the form surfaces that error).
  if (existingIds === null) {
    return `STU-${year}-${String(Date.now() % 1000).padStart(3, '0')}`;
  }
  const pattern = new RegExp(`^STU-${year}-(\\d+)$`);
  let max = 0;
  for (const id of existingIds) {
    const m = pattern.exec(id.trim());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `STU-${year}-${String(max + 1).padStart(3, '0')}`;
}
