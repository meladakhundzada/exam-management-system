import { useEffect, useState } from 'react';
import {
  examsApi, studentsApi, attendanceApi,
  apiErrorMessage,
} from '../services/api';
import { useAuth } from '../context/AuthContext';

const inputCls = 'mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900';

interface ExamRow {
  id: number;
  title: string;
  start_date?: string;
  end_date?: string;
}

interface ScheduleRow {
  id: number;
  exam_date: string;
  start_time: string;
  end_time: string;
  subject_code: string;
  subject_title: string;
  room_name?: string | null;
}

// GET /api/exams/schedules/:id/attendance returns a.* plus the student's
// code (s.student_id) — the code overwrites the numeric FK in the row
// object, so the numeric student id is resolved through the student list.
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
}

const fmtDate = (d: string) => String(d).slice(0, 10);

export default function Attendance() {
  const { hasRole } = useAuth();
  const canManage = hasRole('SUPER_ADMIN', 'EXAM_OFFICER');
  const [exams, setExams] = useState<ExamRow[]>([]);
  const [examId, setExamId] = useState('');
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [scheduleId, setScheduleId] = useState('');
  const [students, setStudents] = useState<StudentOption[]>([]);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [unmatched, setUnmatched] = useState<AttendanceRowRaw[]>([]);
  const [roomId, setRoomId] = useState('');
  const [rooms, setRooms] = useState<Array<{ id: number; name: string }>>([]);
  const [addStudentId, setAddStudentId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [{ data: examRes }, { data: stuRes }, { data: roomRes }] = await Promise.all([
          examsApi.list({ limit: 500 }),
          studentsApi.list({ limit: 500 }),
          attendanceApi.rooms(),
        ]);
        setExams(examRes.data as unknown as ExamRow[]);
        setStudents((stuRes.data as unknown as StudentOption[]).map((s) => ({
          id: Number(s.id), student_id: String(s.student_id), full_name: String(s.full_name),
        })));
        setRooms(roomRes.data as unknown as Array<{ id: number; name: string }>);
        setError(null);
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
    setRows([]);
    setUnmatched([]);
    setSchedules([]);
    if (!id) return;
    try {
      const { data } = await examsApi.get(id);
      const detail = data.data as unknown as { schedules?: ScheduleRow[] };
      setSchedules(detail.schedules ?? []);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const loadAttendance = async (id: string) => {
    setScheduleId(id);
    setRows([]);
    setUnmatched([]);
    if (!id) return;
    try {
      const { data } = await attendanceApi.get(Number(id));
      const raw = data.data as unknown as AttendanceRowRaw[];
      const byCode = new Map(students.map((s) => [s.student_id, s]));
      const editable: EditableRow[] = [];
      const missing: AttendanceRowRaw[] = [];
      raw.forEach((r) => {
        const match = byCode.get(String(r.student_id));
        if (match) {
          editable.push({
            studentId: match.id, studentNo: match.student_id,
            fullName: match.full_name, status: r.status,
          });
        } else {
          missing.push(r); // student not in the loaded list — shown read-only
        }
      });
      setRows(editable);
      setUnmatched(missing);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const addStudent = () => {
    const s = students.find((x) => String(x.id) === addStudentId);
    if (!s) return;
    if (rows.some((r) => r.studentId === s.id)) {
      setError(`${s.full_name} is already in this attendance list.`);
      return;
    }
    setRows([...rows, { studentId: s.id, studentNo: s.student_id, fullName: s.full_name, status: 'present' }]);
    setAddStudentId('');
    setError(null);
  };

  const save = async () => {
    if (!scheduleId || rows.length === 0) {
      setError('Add at least one student to this attendance list before saving.');
      return;
    }
    setSaving(true);
    try {
      await attendanceApi.mark(Number(scheduleId), rows.map((r) => ({
        student_id: r.studentId,
        status: r.status,
        room_id: roomId ? Number(roomId) : undefined,
      })));
      setNotice(`Attendance saved for ${rows.length} student(s).`);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const selectedSchedule = schedules.find((s) => String(s.id) === scheduleId);
  const present = rows.filter((r) => r.status === 'present').length;
  const absent = rows.filter((r) => r.status === 'absent').length;
  const late = rows.filter((r) => r.status === 'late').length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Examination Attendance</h1>
        <p className="text-sm text-slate-500">
          Pick an examination and a scheduled subject, then mark each student present, absent or late.
        </p>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      <div className="flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow-card dark:bg-slate-800">
        <label className="text-sm font-medium">Examination
          <select value={examId} onChange={(e) => loadExam(e.target.value)} className={`${inputCls} w-72 max-w-full`}>
            <option value="">Choose an examination…</option>
            {exams.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title} ({e.start_date ? fmtDate(e.start_date) : ''})
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium">Scheduled subject
          <select value={scheduleId} onChange={(e) => loadAttendance(e.target.value)} disabled={!examId} className={`${inputCls} w-72 max-w-full`}>
            <option value="">Choose a scheduled subject…</option>
            {schedules.map((s) => (
              <option key={s.id} value={s.id}>
                {fmtDate(s.exam_date)} · {s.subject_code} — {s.subject_title} ({String(s.start_time).slice(0, 5)}–{String(s.end_time).slice(0, 5)})
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium">Room (optional)
          <select value={roomId} onChange={(e) => setRoomId(e.target.value)} className={`${inputCls} w-48 max-w-full`}>
            <option value="">No room recorded</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
      </div>

      {loading && <p className="text-sm text-slate-500">Loading…</p>}

      {selectedSchedule && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-4 rounded-xl bg-white p-4 shadow-card dark:bg-slate-800">
            <div>
              <h2 className="font-bold">{selectedSchedule.subject_code} — {selectedSchedule.subject_title}</h2>
              <p className="text-sm text-slate-500">
                {fmtDate(selectedSchedule.exam_date)} · {String(selectedSchedule.start_time).slice(0, 5)}–{String(selectedSchedule.end_time).slice(0, 5)}
                {selectedSchedule.room_name ? ` · Room: ${selectedSchedule.room_name}` : ''}
              </p>
            </div>
            <p className="ml-auto text-sm text-slate-600 dark:text-slate-300">
              Present: <strong>{present}</strong> · Absent: <strong>{absent}</strong> · Late: <strong>{late}</strong>
            </p>
          </div>

          {canManage && (
            <div className="flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow-card dark:bg-slate-800">
              <label className="text-sm font-medium">Add student
                <select value={addStudentId} onChange={(e) => setAddStudentId(e.target.value)} className={`${inputCls} w-72 max-w-full`}>
                  <option value="">Choose a student…</option>
                  {students.map((s) => <option key={s.id} value={s.id}>{s.full_name} ({s.student_id})</option>)}
                </select>
              </label>
              <button onClick={addStudent} disabled={!addStudentId} className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50">+ Add to list</button>
              <button onClick={save} disabled={saving || rows.length === 0} className="ml-auto rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {saving ? 'Saving…' : `Save attendance (${rows.length})`}
              </button>
            </div>
          )}

          {rows.length === 0 && unmatched.length === 0 ? (
            <p className="rounded-xl bg-white p-6 text-center text-sm text-slate-500 shadow-card dark:bg-slate-800">
              No attendance recorded for this schedule yet — add students above and save.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl bg-white shadow-card dark:bg-slate-800">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900">
                  <tr><th className="px-4 py-3">Student</th><th className="px-4 py-3">Student No.</th><th className="px-4 py-3">Status</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.studentId} className="border-t">
                      <td className="px-4 py-3">{r.fullName}</td>
                      <td className="px-4 py-3">{r.studentNo}</td>
                      <td className="px-4 py-3">
                        {canManage ? (
                          <select
                            value={r.status}
                            onChange={(e) => setRows(rows.map((x) => (x.studentId === r.studentId ? { ...x, status: e.target.value as EditableRow['status'] } : x)))}
                            className="rounded-lg border px-2 py-1 dark:border-slate-600 dark:bg-slate-900"
                          >
                            <option value="present">Present</option>
                            <option value="absent">Absent</option>
                            <option value="late">Late</option>
                          </select>
                        ) : (
                          r.status
                        )}
                      </td>
                    </tr>
                  ))}
                  {unmatched.map((r) => (
                    <tr key={r.student_id} className="border-t">
                      <td className="px-4 py-3">{r.full_name}</td>
                      <td className="px-4 py-3">{r.student_id}</td>
                      <td className="px-4 py-3 text-slate-500">{r.status} (read-only — student not in the loaded list)</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
