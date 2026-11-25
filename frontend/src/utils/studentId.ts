// Auto-generation of student numbers: plain zero-padded numbers
// (001, 002, 003, ...). The sequence is the next number after the highest
// existing student number, so IDs stay unique without the user typing
// anything. Both the new plain format ("001") and the legacy format
// ("STU-<year>-NNN") are parsed, so a list mixing old and new IDs still
// produces the correct next number.

export function nextStudentId(existingIds: string[] | null): string {
  // List could not be fetched: fall back to a timestamp suffix so the
  // generated ID is still unique (the backend rejects duplicates with 409,
  // and the form surfaces that error).
  if (existingIds === null) {
    return String(Date.now() % 1000).padStart(3, '0');
  }
  const pattern = /^(?:STU-\d{4}-)?(\d+)$/;
  let max = 0;
  for (const id of existingIds) {
    const m = pattern.exec(id.trim());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return String(max + 1).padStart(3, '0');
}
