import { useEffect, useState } from 'react';
import {
  API_BASE_URL, apiErrorMessage, attendanceApi, departmentsApi, examsApi,
  lecturersApi, studentsApi, tokenStore,
} from '../services/api';
import { useAuth } from '../context/AuthContext';

// Staff page for the exam-management endpoints added in migration 008
// (backend/src/routes/exams.js): exam registration, invigilator
// assignment, per-student seating and incident reports. Registration is
// staff-only by design — students do not self-register.
//
// NOTE (coordinator): this page is not wired into App.tsx / Sidebar.tsx
// yet — those files belong to the coordinator. Suggested wiring:
//   Route: <Route path="/exam-management" element={<ExamManagement />} />
//   Sidebar (SUPER_ADMIN, EXAM_OFFICER, LECTURER): { to: '/exam-management',
//     label: 'Exam Management', icon: '🪑' }
//   AuthContext ROLE_ROUTES: add '/exam-management' to EXAM_OFFICER and
//   LECTURER (SUPER_ADMIN already has '*').
// New endpoints are called with fetch (not services/api.ts) because the
// API service file is owned by the coordinator; API_BASE_URL and
// tokenStore are the exported pieces it provides.

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenStore.get() ?? ''}`,
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean; error?: string; message?: string; data?: T;
  };
  if (!res.ok || body.success === false) {
    throw new Error(body.error ?? body.message ?? `Request failed (${res.status})`);
  }
  return body.data as T;
}

interface ExamRow {
  id: number;
  title: string;
  start_date?: string;
  end_date?: string;
  status?: string;
  schedules?: ScheduleRow[];
}

interface ScheduleRow {
  id: number;
  exam_id: number;
  subject_id: number;
  exam_date: string;
  start_time: string;
  end_time: string;
  subject_code: string;
  subject_title: string;
  room_name?: string | null;
  invigilator?: string | null;
}

interface RegistrationRow {
  id: number;
  student_id: number;
  student_no: string;
  full_name: string;
  email: string;
  department_name: string;
  status: string;
}

interface BulkResult {
  registered: number;
  already_registered: number;
  skipped_conflict: number;
  total_candidates: number;
}

interface InvigilatorRow {
  id: number;
  lecturer_id?: number | null;
  user_id?: number | null;
  lecturer_name?: string | null;
  employee_id?: string | null;
  user_name?: string | null;
  user_email?: string | null;
}

interface SeatRow {
  id: number;
  student_id: number;
  student_no: string;
  student_name: string;
  seat_number: string;
  room_id?: number | null;
  room_name?: string | null;
}

interface IncidentRow {
  id: number;
  type: string;
  description: string;
  status: string;
  student_id?: number | null;
  student_no?: string | null;
  student_name?: string | null;
  reported_by_name?: string | null;
  created_at: string;
}

const fmtDate = (d: string) => String(d).slice(0, 10);
const fmtTime = (t: string) => String(t).slice(0, 5);

export default function ExamManagement() {
  const { hasRole } = useAuth();
  const canManage = hasRole('SUPER_ADMIN', 'EXAM_OFFICER', 'LECTURER');
  const isStaff = hasRole('SUPER_ADMIN', 'EXAM_OFFICER');
  const [exams, setExams] = useState<ExamRow[]>([]);
  const [examId, setExamId] = useState('');
  const [exam, setExam] = useState<ExamRow | null>(null);
  const [registrations, setRegistrations] = useState<RegistrationRow[]>([]);
  const [scheduleId, setScheduleId] = useState('');
  const [invigilators, setInvigilators] = useState<InvigilatorRow[]>([]);
  const [seating, setSeating] = useState<SeatRow[]>([]);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [students, setStudents] = useState<Array<{ id: string; studentNo: string; fullName: string }>>([]);
  const [lecturers, setLecturers] = useState<Array<{ id: number; full_name: string }>>([]);
  const [departments, setDepartments] = useState<Array<{ id: number; name: string }>>([]);
  const [rooms, setRooms] = useState<Array<{ id: number; name: string; capacity: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Forms: single registration / bulk registration.
  const [regStudentId, setRegStudentId] = useState('');
  const [bulkDept, setBulkDept] = useState('');
  const [bulkYear, setBulkYear] = useState('');
  const [bulkSemester, setBulkSemester] = useState('');
  // Forms: invigilator / seating / incident for the chosen schedule.
  const [invLecturerId, setInvLecturerId] = useState('');
  const [seatStudentId, setSeatStudentId] = useState('');
  const [seatNumber, setSeatNumber] = useState('');
  const [seatRoomId, setSeatRoomId] = useState('');
  const [incidentType, setIncidentType] = useState('misconduct');
  const [incidentStudentId, setIncidentStudentId] = useState('');
  const [incidentDescription, setIncidentDescription] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [ex, st, le, de, ro] = await Promise.all([
          examsApi.list({ limit: 500 }),
          studentsApi.list({ limit: 500 }),
          lecturersApi.list({ limit: 500 }),
          departmentsApi.list(),
          attendanceApi.rooms(),
        ]);
        setExams(ex.data.data as unknown as ExamRow[]);
        setStudents(st.data.data as unknown as Array<{ id: string; studentNo: string; fullName: string }>);
        setLecturers(le.data.data as unknown as Array<{ id: number; full_name: string }>);
        setDepartments(de.data.data as unknown as Array<{ id: number; name: string }>);
        setRooms(ro.data.data as unknown as Array<{ id: number; name: string; capacity: number }>);
        setError(null);
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const loadRegistrations = async (id: string) => {
    const rows = await apiFetch<RegistrationRow[]>(`/exams/${id}/registrations?limit=100`);
    setRegistrations(rows);
  };

  const loadExam = async (id: string) => {
    setExamId(id);
    setExam(null);
    setRegistrations([]);
    setScheduleId('');
    setInvigilators([]);
    setSeating([]);
    setIncidents([]);
    if (!id) return;
    try {
      const { data } = await examsApi.get(id);
      setExam(data.data as unknown as ExamRow);
      await loadRegistrations(id);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const loadScheduleData = async (id: string) => {
    setScheduleId(id);
    if (!id) {
      setInvigilators([]);
      setSeating([]);
      setIncidents([]);
      return;
    }
    try {
      const [inv, seats, inc] = await Promise.all([
        apiFetch<InvigilatorRow[]>(`/exams/schedules/${id}/invigilators`),
        apiFetch<SeatRow[]>(`/exams/schedules/${id}/seating`),
        apiFetch<IncidentRow[]>(`/exams/schedules/${id}/incidents`),
      ]);
      setInvigilators(inv);
      setSeating(seats);
      setIncidents(inc);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const run = async (fn: () => Promise<string>, after?: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    try {
      setNotice(await fn());
      if (after) await after();
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const schedules = exam?.schedules ?? [];
  const schedule = schedules.find((s) => String(s.id) === scheduleId) ?? null;
  const registeredStudents = registrations.filter((r) => r.status === 'registered');

  if (!canManage) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Exam Management</h1>
        <p className="text-sm text-slate-500">Exam registration, invigilators, seating and incidents are for examination staff and lecturers.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Exam Management</h1>
        <p className="text-sm text-slate-500">
          Register students for an examination, assign invigilators and seats per session, and file incident reports. Registration is staff-only — students cannot register themselves.
        </p>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800">
        <label className="text-sm font-medium">Examination
          <select
            value={examId}
            onChange={(e) => loadExam(e.target.value)}
            className="mt-1 block w-80 max-w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900"
          >
            <option value="">Choose an examination…</option>
            {exams.map((e) => (
              <option key={e.id} value={e.id}>{e.title}</option>
            ))}
          </select>
        </label>
        {loading && <p className="mt-2 text-sm text-slate-500">Loading…</p>}
      </div>

      {exam && (
        <>
          {/* ---- Registration ---- */}
          <section className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800">
            <h2 className="font-bold">Registration — {exam.title}</h2>
            <p className="text-sm text-slate-500">
              Only active students enrolled in a subject scheduled in this exam can be registered. Students whose other exams overlap this one are refused or skipped.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-sm font-medium">Register one student
                <select
                  value={regStudentId}
                  onChange={(e) => setRegStudentId(e.target.value)}
                  className="mt-1 block w-72 max-w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900"
                >
                  <option value="">Choose a student…</option>
                  {students.map((s) => (
                    <option key={s.id} value={s.id}>{s.fullName} ({s.studentNo})</option>
                  ))}
                </select>
              </label>
              <button
                disabled={!regStudentId}
                onClick={() => run(
                  async () => {
                    await apiFetch(`/exams/${examId}/registrations`, {
                      method: 'POST',
                      body: JSON.stringify({ student_id: Number(regStudentId) }),
                    });
                    return 'Student registered.';
                  },
                  async () => { setRegStudentId(''); await loadRegistrations(examId); },
                )}
                className="rounded-lg bg-navy-900 px-3 py-2 text-sm text-white disabled:opacity-50"
              >
                Register
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-end gap-3 border-t pt-3 dark:border-slate-700">
              <label className="text-sm font-medium">Department
                <select value={bulkDept} onChange={(e) => setBulkDept(e.target.value)} className="mt-1 block rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900">
                  <option value="">Any</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
              <label className="text-sm font-medium">Admission year
                <input value={bulkYear} onChange={(e) => setBulkYear(e.target.value)} placeholder="e.g. 2026" inputMode="numeric" className="mt-1 block w-28 rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900" />
              </label>
              <label className="text-sm font-medium">Semester
                <input value={bulkSemester} onChange={(e) => setBulkSemester(e.target.value)} placeholder="e.g. 1" inputMode="numeric" className="mt-1 block w-20 rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900" />
              </label>
              <button
                onClick={() => run(
                  async () => {
                    const payload: Record<string, number> = {};
                    if (bulkDept) payload.department_id = Number(bulkDept);
                    if (bulkYear) payload.admission_year = Number(bulkYear);
                    if (bulkSemester) payload.current_semester = Number(bulkSemester);
                    const r = await apiFetch<BulkResult>(`/exams/${examId}/registrations/bulk`, {
                      method: 'POST', body: JSON.stringify(payload),
                    });
                    return `Bulk registration done: ${r.registered} registered, ${r.already_registered} already registered, ${r.skipped_conflict} skipped (overlapping exam), of ${r.total_candidates} eligible.`;
                  },
                  async () => loadRegistrations(examId),
                )}
                className="rounded-lg bg-navy-900 px-3 py-2 text-sm text-white"
              >
                Register cohort
              </button>
            </div>
            {registrations.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">No students registered for this examination yet.</p>
            ) : (
              <table className="mt-3 w-full min-w-[520px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900">
                  <tr><th className="px-4 py-3">Student</th><th className="px-4 py-3">Department</th><th className="px-4 py-3">Status</th><th className="px-4 py-3"> </th></tr>
                </thead>
                <tbody>
                  {registrations.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="px-4 py-3">{r.full_name} ({r.student_no})</td>
                      <td className="px-4 py-3">{r.department_name}</td>
                      <td className="px-4 py-3">{r.status}</td>
                      <td className="px-4 py-3 text-right">
                        {r.status === 'registered' && isStaff && (
                          <button
                            onClick={() => run(
                              async () => {
                                await apiFetch(`/exams/${examId}/registrations/${r.student_id}`, { method: 'DELETE' });
                                return 'Registration cancelled.';
                              },
                              async () => loadRegistrations(examId),
                            )}
                            className="rounded-lg border px-2 py-1 text-xs"
                          >
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* ---- Per-schedule work ---- */}
          <section className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800">
            <h2 className="font-bold">Session detail</h2>
            <label className="mt-2 block text-sm font-medium">Scheduled subject
              <select
                value={scheduleId}
                onChange={(e) => loadScheduleData(e.target.value)}
                className="mt-1 block w-96 max-w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900"
              >
                <option value="">Choose a scheduled subject…</option>
                {schedules.map((s) => (
                  <option key={s.id} value={s.id}>
                    {fmtDate(s.exam_date)} {fmtTime(s.start_time)}–{fmtTime(s.end_time)} · {s.subject_code} — {s.subject_title}
                  </option>
                ))}
              </select>
            </label>
            {schedule && (
              <p className="mt-2 text-sm text-slate-500">
                Room: {schedule.room_name ?? 'TBA'} · Invigilator (room allocation): {schedule.invigilator ?? '—'}
              </p>
            )}
          </section>

          {schedule && (
            <>
              {/* ---- Invigilators ---- */}
              <section className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800">
                <h2 className="font-bold">Invigilators — {schedule.subject_code}</h2>
                <p className="text-sm text-slate-500">Assigning an invigilator who already has an overlapping session is refused.</p>
                {isStaff && (
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <label className="text-sm font-medium">Assign lecturer as invigilator
                      <select value={invLecturerId} onChange={(e) => setInvLecturerId(e.target.value)} className="mt-1 block w-72 max-w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900">
                        <option value="">Choose a lecturer…</option>
                        {lecturers.map((l) => <option key={l.id} value={l.id}>{l.full_name}</option>)}
                      </select>
                    </label>
                    <button
                      disabled={!invLecturerId}
                      onClick={() => run(
                        async () => {
                          await apiFetch(`/exams/schedules/${scheduleId}/invigilators`, {
                            method: 'POST',
                            body: JSON.stringify({ lecturer_id: Number(invLecturerId) }),
                          });
                          return 'Invigilator assigned.';
                        },
                        async () => { setInvLecturerId(''); await loadScheduleData(scheduleId); },
                      )}
                      className="rounded-lg bg-navy-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                    >
                      Assign
                    </button>
                  </div>
                )}
                {invigilators.length === 0 ? (
                  <p className="mt-3 text-sm text-slate-500">No invigilators assigned to this session yet (beyond any room-allocation invigilator shown above).</p>
                ) : (
                  <ul className="mt-3 space-y-2 text-sm">
                    {invigilators.map((v) => (
                      <li key={v.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                        <span>{v.lecturer_name ?? v.user_name ?? '—'}{v.employee_id ? ` (${v.employee_id})` : ''}{v.user_email ? ` · ${v.user_email}` : ''}</span>
                        {isStaff && (
                          <button
                            onClick={() => run(
                              async () => {
                                await apiFetch(`/exams/schedules/${scheduleId}/invigilators/${v.id}`, { method: 'DELETE' });
                                return 'Invigilator assignment removed.';
                              },
                              async () => loadScheduleData(scheduleId),
                            )}
                            className="rounded-lg border px-2 py-1 text-xs"
                          >
                            Remove
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* ---- Seating ---- */}
              <section className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800">
                <h2 className="font-bold">Seating plan — {schedule.subject_code}</h2>
                <p className="text-sm text-slate-500">One seat per registered student, unique per session, within the allocated seat capacity.</p>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <label className="text-sm font-medium">Student (registered)
                    <select value={seatStudentId} onChange={(e) => setSeatStudentId(e.target.value)} className="mt-1 block w-64 max-w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900">
                      <option value="">Choose a student…</option>
                      {registeredStudents.map((s) => <option key={s.student_id} value={s.student_id}>{s.full_name} ({s.student_no})</option>)}
                    </select>
                  </label>
                  <label className="text-sm font-medium">Seat number
                    <input value={seatNumber} onChange={(e) => setSeatNumber(e.target.value)} placeholder="e.g. A-12" className="mt-1 block w-28 rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900" />
                  </label>
                  <label className="text-sm font-medium">Room
                    <select value={seatRoomId} onChange={(e) => setSeatRoomId(e.target.value)} className="mt-1 block rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900">
                      <option value="">—</option>
                      {rooms.map((r) => <option key={r.id} value={r.id}>{r.name} (cap. {r.capacity})</option>)}
                    </select>
                  </label>
                  <button
                    disabled={!seatStudentId || !seatNumber.trim()}
                    onClick={() => run(
                      async () => {
                        await apiFetch(`/exams/schedules/${scheduleId}/seating`, {
                          method: 'POST',
                          body: JSON.stringify({ assignments: [{ student_id: Number(seatStudentId), seat_number: seatNumber.trim(), ...(seatRoomId ? { room_id: Number(seatRoomId) } : {}) }] }),
                        });
                        return `Seat ${seatNumber.trim()} assigned.`;
                      },
                      async () => { setSeatStudentId(''); setSeatNumber(''); setSeatRoomId(''); await loadScheduleData(scheduleId); },
                    )}
                    className="rounded-lg bg-navy-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                  >
                    Assign seat
                  </button>
                </div>
                {seating.length === 0 ? (
                  <p className="mt-3 text-sm text-slate-500">No seats assigned for this session yet.</p>
                ) : (
                  <table className="mt-3 w-full min-w-[520px] text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900">
                      <tr><th className="px-4 py-3">Seat</th><th className="px-4 py-3">Student</th><th className="px-4 py-3">Room</th><th className="px-4 py-3"> </th></tr>
                    </thead>
                    <tbody>
                      {seating.map((s) => (
                        <tr key={s.id} className="border-t">
                          <td className="px-4 py-3 font-medium">{s.seat_number}</td>
                          <td className="px-4 py-3">{s.student_name} ({s.student_no})</td>
                          <td className="px-4 py-3">{s.room_name ?? '—'}</td>
                          <td className="px-4 py-3 text-right">
                            {isStaff && (
                              <button
                                onClick={() => run(
                                  async () => {
                                    await apiFetch(`/exams/schedules/${scheduleId}/seating/${s.student_id}`, { method: 'DELETE' });
                                    return 'Seat assignment removed.';
                                  },
                                  async () => loadScheduleData(scheduleId),
                                )}
                                className="rounded-lg border px-2 py-1 text-xs"
                              >
                                Remove
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              {/* ---- Incidents ---- */}
              <section className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800">
                <h2 className="font-bold">Incident reports — {schedule.subject_code}</h2>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <label className="text-sm font-medium">Type
                    <select value={incidentType} onChange={(e) => setIncidentType(e.target.value)} className="mt-1 block rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900">
                      <option value="misconduct">Misconduct</option>
                      <option value="absence">Absence</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                  <label className="text-sm font-medium">Student (optional)
                    <select value={incidentStudentId} onChange={(e) => setIncidentStudentId(e.target.value)} className="mt-1 block w-64 max-w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900">
                      <option value="">—</option>
                      {registeredStudents.map((s) => <option key={s.student_id} value={s.student_id}>{s.full_name} ({s.student_no})</option>)}
                    </select>
                  </label>
                  <label className="grow text-sm font-medium">Description
                    <input value={incidentDescription} onChange={(e) => setIncidentDescription(e.target.value)} placeholder="What happened?" className="mt-1 block w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900" />
                  </label>
                  <button
                    disabled={incidentDescription.trim().length < 3}
                    onClick={() => run(
                      async () => {
                        await apiFetch(`/exams/schedules/${scheduleId}/incidents`, {
                          method: 'POST',
                          body: JSON.stringify({
                            type: incidentType,
                            description: incidentDescription.trim(),
                            ...(incidentStudentId ? { student_id: Number(incidentStudentId) } : {}),
                          }),
                        });
                        return 'Incident report filed.';
                      },
                      async () => { setIncidentDescription(''); setIncidentStudentId(''); await loadScheduleData(scheduleId); },
                    )}
                    className="rounded-lg bg-navy-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                  >
                    File report
                  </button>
                </div>
                {incidents.length === 0 ? (
                  <p className="mt-3 text-sm text-slate-500">No incident reports for this session.</p>
                ) : (
                  <ul className="mt-3 space-y-2 text-sm">
                    {incidents.map((i) => (
                      <li key={i.id} className="rounded-lg border px-3 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">{i.type}{i.student_name ? ` — ${i.student_name} (${i.student_no})` : ''}</span>
                          <span className="text-slate-500">{fmtDate(i.created_at)} · reported by {i.reported_by_name ?? '—'}</span>
                        </div>
                        <p className="mt-1 text-slate-600 dark:text-slate-300">{i.description}</p>
                        {isStaff && (
                          <label className="mt-2 block text-xs font-medium">Status
                            <select
                              value={i.status}
                              onChange={(e) => run(
                                async () => {
                                  await apiFetch(`/exams/schedules/${scheduleId}/incidents/${i.id}`, {
                                    method: 'PATCH',
                                    body: JSON.stringify({ status: e.target.value }),
                                  });
                                  return 'Incident status updated.';
                                },
                                async () => loadScheduleData(scheduleId),
                              )}
                              className="ml-2 rounded-lg border px-2 py-1 dark:border-slate-600 dark:bg-slate-900"
                            >
                              <option value="open">Open</option>
                              <option value="under_review">Under review</option>
                              <option value="resolved">Resolved</option>
                            </select>
                          </label>
                        )}
                        {!isStaff && <p className="mt-1 text-xs text-slate-500">Status: {i.status}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
