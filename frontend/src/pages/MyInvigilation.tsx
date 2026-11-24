import { useEffect, useState } from 'react';
import { API_BASE_URL, apiErrorMessage, tokenStore } from '../services/api';
import { useAuth } from '../context/AuthContext';

// Invigilator's own view: sessions assigned to the signed-in user
// (GET /api/exams/invigilator/my-sessions) and incident reports for those
// sessions. An invigilator sees only the incidents they reported; staff
// see all of them. A lecturer sees this page too when they invigilate.
//
// NOTE (coordinator): this page is not wired into App.tsx / Sidebar.tsx
// yet — those files belong to the coordinator. Suggested wiring:
//   Route: <Route path="/my-invigilation" element={<MyInvigilation />} />
//   Sidebar (LECTURER, plus INVIGILATOR once that role exists in the
//   frontend): { to: '/my-invigilation', label: 'My Invigilation', icon: '👁️' }
//   AuthContext: the frontend has no INVIGILATOR role yet (ROLE_MAP /
//   ROLE_ROUTES / ROLE_LABELS) — add it there when the role is introduced,
//   and add '/my-invigilation' to its routes. Until then a user with the
//   backend 'invigilator' role is recognised here by role string.
// New endpoints are called with fetch (not services/api.ts) because the
// API service file is owned by the coordinator.

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

interface SessionRow {
  id: number;
  exam_id: number;
  exam_title: string;
  subject_code: string;
  subject_title: string;
  exam_date: string;
  start_time: string;
  end_time: string;
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

interface SeatingRow {
  student_id: number;
  student_no: string;
  student_name: string;
}

const fmtDate = (d: string) => String(d).slice(0, 10);
const fmtTime = (t: string) => String(t).slice(0, 5);

export default function MyInvigilation() {
  const { user, hasRole } = useAuth();
  // The frontend role map has no INVIGILATOR entry yet; recognise the
  // backend role by its raw string so the page works once the role exists.
  const isInvigilator = hasRole('LECTURER', 'SUPER_ADMIN', 'EXAM_OFFICER')
    || String(user?.role ?? '') === 'invigilator';
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [seated, setSeated] = useState<SeatingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [incidentType, setIncidentType] = useState('misconduct');
  const [incidentStudentId, setIncidentStudentId] = useState('');
  const [incidentDescription, setIncidentDescription] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const rows = await apiFetch<SessionRow[]>('/exams/invigilator/my-sessions');
        setSessions(rows);
        setError(null);
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const loadSession = async (id: string) => {
    setSessionId(id);
    setIncidents([]);
    setSeated([]);
    if (!id) return;
    try {
      const session = sessions.find((s) => String(s.id) === id);
      const [inc, seats] = await Promise.all([
        apiFetch<IncidentRow[]>(`/exams/schedules/${id}/incidents`),
        session
          ? apiFetch<SeatingRow[]>(`/exams/schedules/${id}/seating`)
          : Promise.resolve([] as SeatingRow[]),
      ]);
      setIncidents(inc);
      setSeated(seats);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  if (!isInvigilator) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">My Invigilation</h1>
        <p className="text-sm text-slate-500">This page is for invigilators — lecturers assigned to invigilate a session.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">My Invigilation</h1>
        <p className="text-sm text-slate-500">
          Sessions assigned to you, with the room and time. File an incident report for a session here — you will only see the reports you filed yourself.
        </p>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      {loading && <p className="text-sm text-slate-500">Loading your sessions…</p>}
      {!loading && sessions.length === 0 && !error && (
        <p className="text-sm text-slate-500">No sessions assigned to you yet.</p>
      )}

      {sessions.length > 0 && (
        <div className="overflow-x-auto rounded-xl bg-white shadow-card dark:bg-slate-800">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Examination</th>
                <th className="px-4 py-3">Subject</th>
                <th className="px-4 py-3">Room</th>
                <th className="px-4 py-3"> </th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="border-t">
                  <td className="px-4 py-3">{fmtDate(s.exam_date)}</td>
                  <td className="px-4 py-3">{fmtTime(s.start_time)} – {fmtTime(s.end_time)}</td>
                  <td className="px-4 py-3">{s.exam_title}</td>
                  <td className="px-4 py-3">{s.subject_code} — {s.subject_title}</td>
                  <td className="px-4 py-3">{s.room_name ?? 'TBA'}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => loadSession(String(s.id))}
                      className="rounded-lg border px-2 py-1 text-xs"
                    >
                      {String(s.id) === sessionId ? 'Selected' : 'Open'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sessionId && (
        <section className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800">
          <h2 className="font-bold">Incident reports for this session</h2>
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
                {seated.map((s) => <option key={s.student_id} value={s.student_id}>{s.student_name} ({s.student_no})</option>)}
              </select>
            </label>
            <label className="grow text-sm font-medium">Description
              <input value={incidentDescription} onChange={(e) => setIncidentDescription(e.target.value)} placeholder="What happened?" className="mt-1 block w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900" />
            </label>
            <button
              disabled={incidentDescription.trim().length < 3}
              onClick={async () => {
                setError(null);
                setNotice(null);
                try {
                  await apiFetch(`/exams/schedules/${sessionId}/incidents`, {
                    method: 'POST',
                    body: JSON.stringify({
                      type: incidentType,
                      description: incidentDescription.trim(),
                      ...(incidentStudentId ? { student_id: Number(incidentStudentId) } : {}),
                    }),
                  });
                  setNotice('Incident report filed.');
                  setIncidentDescription('');
                  setIncidentStudentId('');
                  await loadSession(sessionId);
                } catch (err) {
                  setError(apiErrorMessage(err));
                }
              }}
              className="rounded-lg bg-navy-900 px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              File report
            </button>
          </div>
          {incidents.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No incident reports filed by you for this session.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {incidents.map((i) => (
                <li key={i.id} className="rounded-lg border px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{i.type}{i.student_name ? ` — ${i.student_name} (${i.student_no})` : ''}</span>
                    <span className="text-slate-500">{fmtDate(i.created_at)} · Status: {i.status}</span>
                  </div>
                  <p className="mt-1 text-slate-600 dark:text-slate-300">{i.description}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
