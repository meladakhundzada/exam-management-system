import { useEffect, useState } from 'react';
import {
  examsApi, studentsApi, attendanceApi, apiErrorMessage,
} from '../services/api';
import { useAuth } from '../context/AuthContext';

// Examination Invigilator — assigned sessions, halls, student lists and
// attendance marking. Uses ONLY endpoints that already exist:
//   GET /api/exams + GET /api/exams/:id (schedules with room + invigilator)
//   GET /api/exams/schedules/:id/attendance (existing marks)
//   POST /api/exams/schedules/:id/attendance (bulk upsert)
//   GET /api/students (resolves the numeric student id the POST needs —
//   the attendance GET returns the student CODE in the student_id field,
//   see the note on AttendanceRowRaw below)
//
// What this page deliberately does NOT do (backend work still needed):
// - It cannot filter to "my sessions" by id: room_allocations stores the
//   invigilator as a lecturers.id and returns only the invigilator NAME,
//   while an invigilator-role user has no lecturer row to join on. The
//   "Only sessions assigned to me" toggle therefore matches on the
//   invigilator's full name; true assignment scoping needs the exam
//   worker to link invigilator users to allocations (or an endpoint
//   such as GET /api/exams/my-sessions).
// - Marking attendance 403s until the coordinator adds 'invigilator' to
//   the POST /attendance guard (MANAGE_OR_LECTURER in exams.js) with an
//   assignment check, and admits the role on GET /api/students.
// - Incident reports have no submission endpoint at all yet.

const inputCls = 'mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900';
const fmtDate = (d: string) => String(d).slice(0, 10);

interface ExamRow {
  id: number;
  title: string;
  exam_type?: string;
  start_date?: string;
  end_date?: string;
  status?: string;
}

interface ScheduleRow {
  id: number;
  subject_id?: number;
  exam_date: string;
  start_time: string;
  end_time: string;
  subject_code: string;
  subject_title: string;
  room_name?: string | null;
  invigilator?: string | null;
}

// GET /api/exams/schedules/:id/attendance returns a.* plus the student's
// code (s.student_id) — the code overwrites the numeric FK in the row
// object, so the numeric student id is resolved through the student list
// (same workaround as the Attendance page).
interface AttendanceRowRaw {
  student_id: string; // student code, e.g. STU-2026-001
  full_name: string;
  status: 'present' | 'absent' | 'late';
  room_id?: number | null;
  marked_at?: string;
}

interface StudentOption {
  id: number; // numeric student id (needed by POST /attendance)
  student_id: string; // student code
  full_name: string;
}

interface EditableRow {
  studentId: number;
  studentNo: string;
  fullName: string;
  status: 'present' | 'absent' | 'late';
  roomId?: number | null;
}

export default function InvigilatorSessions() {
  const { user } = useAuth();
  const [exams, setExams] = useState<ExamRow[]>([]);
  const [examId, setExamId] = useState('');
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [scheduleId, setScheduleId] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);
  const [students, setStudents] = useState<StudentOption[]>([]);
  const [studentsAvailable, setStudentsAvailable] = useState(true);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [unmatched, setUnmatched] = useState<AttendanceRowRaw[]>([]);
  const [addStudentId, setAddStudentId] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [{ data: examRes }, stuRes] = await Promise.all([
          examsApi.list({ limit: 500 }),
          studentsApi.list({ limit: 500 }).catch((err) => {
            // GET /api/students still 403s for invigilators until the
            // coordinator admits the role — the session list below still
            // works; only attendance marking needs the numeric ids.
            setStudentsAvailable(false);
            setError(`Student list unavailable: ${apiErrorMessage(err)}`);
            return null;
          }),
        ]);
        setExams(examRes.data as unknown as ExamRow[]);
        if (stuRes) {
          setStudents((stuRes.data.data as unknown as StudentOption[]).map((s) => ({
            id: Number(s.id), student_id: String(s.student_id), full_name: String(s.full_name),
          })));
        }
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const loadExam = async (id: string) => {
    setExamId(id);
    setScheduleId('');
    setSchedules([]);
    setRows([]);
    setUnmatched([]);
    setNotice(null);
    if (!id) return;
    setDetailLoading(true);
    try {
      const { data } = await examsApi.get(id);
      const exam = data.data as unknown as { schedules?: ScheduleRow[] };
      setSchedules(exam.schedules ?? []);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const loadSchedule = async (id: string) => {
    setScheduleId(id);
    setRows([]);
    setUnmatched([]);
    setNotice(null);
    if (!id) return;
    setDetailLoading(true);
    try {
      const { data } = await attendanceApi.get(Number(id));
      const raw = data.data as unknown as AttendanceRowRaw[];
      const byCode = new Map(students.map((s) => [s.student_id, s]));
      const editable: EditableRow[] = [];
      const missing: AttendanceRowRaw[] = [];
      for (const r of raw) {
        const match = byCode.get(String(r.student_id));
        if (match) {
          editable.push({
            studentId: match.id, studentNo: match.student_id, fullName: r.full_name,
            status: r.status, roomId: r.room_id ?? null,
          });
        } else {
          missing.push(r);
        }
      }
      setRows(editable);
      setUnmatched(missing);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const visibleSchedules = onlyMine && user
    ? schedules.filter((s) => s.invigilator === user.fullName)
    : schedules;
  const selectedSchedule = schedules.find((s) => String(s.id) === scheduleId);
  const absentCount = rows.filter((r) => r.status === 'absent').length;

  const addStudent = () => {
    const s = students.find((x) => String(x.id) === addStudentId);
    if (!s || rows.some((r) => r.studentId === s.id)) return;
    setRows((prev) => [...prev, { studentId: s.id, studentNo: s.student_id, fullName: s.full_name, status: 'present' }]);
    setAddStudentId('');
  };

  const saveAttendance = async () => {
    if (!scheduleId || rows.length === 0) return;
    setSaving(true);
    setNotice(null);
    try {
      await attendanceApi.mark(Number(scheduleId), rows.map((r) => ({
        student_id: r.studentId, status: r.status, room_id: r.roomId ?? undefined,
      })));
      const absent = rows.filter((r) => r.status === 'absent');
      setNotice(
        absent.length > 0
          ? `Attendance saved: ${rows.length} students, ${absent.length} absent (${absent.map((r) => `${r.fullName} (${r.studentNo})`).join(', ')}) — absent students are reported through this record.`
          : `Attendance saved: all ${rows.length} students present.`,
      );
    } catch (err) {
      setError(
        `${apiErrorMessage(err)} — if this is a permission error, the backend guard on POST /api/exams/schedules/:id/attendance still needs to admit the Examination Invigilator role.`,
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="p-4">Loading sessions…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">My Invigilation Sessions</h1>
        <p className="text-sm text-slate-500">
          Your assigned examination sessions, halls and student lists. Mark attendance for the session you are invigilating.
        </p>
      </div>

      {error && (
        <div role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</div>
      )}
      {notice && (
        <div className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">{notice}</div>
      )}

      <section className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800" aria-label="Choose an examination">
        <label className="block text-sm font-medium">
          Examination
          <select value={examId} onChange={(e) => void loadExam(e.target.value)} className={inputCls}>
            <option value="">Select an examination…</option>
            {exams.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title} ({fmtDate(e.start_date ?? '')} – {fmtDate(e.end_date ?? '')}){e.status ? ` — ${e.status}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
          Only sessions assigned to me (matched by invigilator name)
        </label>
        {onlyMine && (
          <p className="mt-2 text-xs text-slate-500">
            Assignment matching is by name until the backend links invigilator accounts to room allocations — if your name does not match the assigned invigilator exactly, your sessions will not appear under this filter.
          </p>
        )}
      </section>

      {detailLoading && <p className="p-4">Loading…</p>}

      {examId && !detailLoading && schedules.length > 0 && (
        <section className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800" aria-label="Scheduled sessions">
          <h2 className="font-semibold">Sessions</h2>
          {visibleSchedules.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">
              No sessions assigned to you in this examination{onlyMine ? ' (by invigilator name)' : ''}.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="px-2 py-2">Subject</th>
                    <th className="px-2 py-2">Date</th>
                    <th className="px-2 py-2">Time</th>
                    <th className="px-2 py-2">Hall</th>
                    <th className="px-2 py-2">Invigilator</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {visibleSchedules.map((s) => (
                    <tr key={s.id} className="border-t border-slate-100 dark:border-slate-700">
                      <td className="px-2 py-2">{s.subject_code} — {s.subject_title}</td>
                      <td className="px-2 py-2">{fmtDate(s.exam_date)}</td>
                      <td className="px-2 py-2">{String(s.start_time).slice(0, 5)} – {String(s.end_time).slice(0, 5)}</td>
                      <td className="px-2 py-2">{s.room_name ?? '—'}</td>
                      <td className="px-2 py-2">{s.invigilator ?? '—'}</td>
                      <td className="px-2 py-2 text-right">
                        <button
                          onClick={() => void loadSchedule(String(s.id))}
                          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${scheduleId === String(s.id) ? 'bg-navy-900 text-white' : 'bg-slate-100 hover:bg-slate-200 dark:bg-slate-700'}`}
                        >
                          {scheduleId === String(s.id) ? 'Selected' : 'Open'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {selectedSchedule && (
        <section className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800" aria-label="Student list and attendance">
          <h2 className="font-semibold">
            {selectedSchedule.subject_code} — {selectedSchedule.subject_title}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {fmtDate(selectedSchedule.exam_date)} · {String(selectedSchedule.start_time).slice(0, 5)} – {String(selectedSchedule.end_time).slice(0, 5)}
            {' · '}Hall: {selectedSchedule.room_name ?? '—'}
            {' · '}Invigilator: {selectedSchedule.invigilator ?? '—'}
          </p>

          {!studentsAvailable ? (
            <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
              The student list is unavailable (the backend still needs to admit the Invigilator role on GET /api/students), so attendance cannot be marked from here yet. The session and hall above are still visible.
            </p>
          ) : rows.length === 0 && unmatched.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              No attendance has been recorded for this session yet. Add the students who are present in the hall below, set each one&apos;s status and save.
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="px-2 py-2">Student</th>
                    <th className="px-2 py-2">ID</th>
                    <th className="px-2 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.studentId} className="border-t border-slate-100 dark:border-slate-700">
                      <td className="px-2 py-2">{r.fullName}</td>
                      <td className="px-2 py-2">{r.studentNo}</td>
                      <td className="px-2 py-2">
                        <select
                          value={r.status}
                          onChange={(e) => setRows((prev) => prev.map((x) => (x.studentId === r.studentId ? { ...x, status: e.target.value as EditableRow['status'] } : x)))}
                          className="rounded-lg border px-2 py-1 dark:border-slate-600 dark:bg-slate-900"
                        >
                          <option value="present">Present</option>
                          <option value="absent">Absent</option>
                          <option value="late">Late</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                  {unmatched.map((r) => (
                    <tr key={r.student_id} className="border-t border-slate-100 dark:border-slate-700">
                      <td className="px-2 py-2">{r.full_name}</td>
                      <td className="px-2 py-2">{r.student_id}</td>
                      <td className="px-2 py-2 text-slate-500">{r.status} (recorded — student not in the loaded list)</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {studentsAvailable && (
            <div className="mt-4 flex flex-wrap items-end gap-2">
              <label className="block text-sm font-medium">
                Add a student
                <select value={addStudentId} onChange={(e) => setAddStudentId(e.target.value)} className={inputCls}>
                  <option value="">Select a student…</option>
                  {students
                    .filter((s) => !rows.some((r) => r.studentId === s.id))
                    .map((s) => (
                      <option key={s.id} value={s.id}>{s.full_name} ({s.student_id})</option>
                    ))}
                </select>
              </label>
              <button onClick={addStudent} disabled={!addStudentId} className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium hover:bg-slate-200 disabled:opacity-50 dark:bg-slate-700">
                Add
              </button>
              <button
                onClick={() => void saveAttendance()}
                disabled={saving || rows.length === 0}
                className="rounded-lg bg-navy-900 px-4 py-2 text-sm font-medium text-white hover:bg-navy-800 disabled:opacity-50"
              >
                {saving ? 'Saving…' : `Save attendance${absentCount > 0 ? ` (${absentCount} absent)` : ''}`}
              </button>
            </div>
          )}

          <p className="mt-4 text-xs text-slate-500">
            Reporting absent students: marking a student &ldquo;Absent&rdquo; above and saving is the absent report — the record is stored with your user id as the marker.
            Incident reports (e.g. cheating, disruption) have no submission form yet: there is no incident-report endpoint on the backend. Until one is added, report incidents directly to the Examination Officer.
          </p>
        </section>
      )}
    </div>
  );
}
