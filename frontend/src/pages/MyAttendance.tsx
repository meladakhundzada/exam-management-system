import { useEffect, useState } from 'react';
import { studentsApi, StudentAttendanceRow, apiErrorMessage } from '../services/api';
import { useAuth } from '../context/AuthContext';

const STATUS_BADGE: Record<string, string> = {
  present: 'bg-emerald-100 text-emerald-700',
  absent: 'bg-red-100 text-red-700',
  late: 'bg-amber-100 text-amber-700',
};

const fmtDate = (d: string) => String(d).slice(0, 10);

export default function MyAttendance() {
  const { user } = useAuth();
  const [rows, setRows] = useState<StudentAttendanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if (!user?.studentId) {
        setError('No student profile is linked to your account. Contact the Examination Office.');
        setLoading(false);
        return;
      }
      try {
        const { data } = await studentsApi.attendance(user.studentId);
        setRows(data.data);
        setError(null);
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [user?.studentId]);

  if (loading) return <p className="p-4">Loading your attendance…</p>;

  const present = rows.filter((r) => r.status === 'present').length;
  const absent = rows.filter((r) => r.status === 'absent').length;
  const late = rows.filter((r) => r.status === 'late').length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">My Attendance</h1>
        <p className="text-sm text-slate-500">Your examination attendance record, as marked by the Examination Office.</p>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {!error && rows.length > 0 && (
        <div className="grid grid-cols-3 gap-4 sm:max-w-lg">
          <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800">
            <p className="text-sm text-slate-500">Present</p>
            <p className="text-xl font-bold text-emerald-600">{present}</p>
          </div>
          <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800">
            <p className="text-sm text-slate-500">Absent</p>
            <p className="text-xl font-bold text-red-600">{absent}</p>
          </div>
          <div className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800">
            <p className="text-sm text-slate-500">Late</p>
            <p className="text-xl font-bold text-amber-600">{late}</p>
          </div>
        </div>
      )}

      {!error && rows.length === 0 && (
        <p className="rounded-xl bg-white p-6 text-center text-sm text-slate-500 shadow-card dark:bg-slate-800">
          No attendance has been recorded for you yet.
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl bg-white shadow-card dark:bg-slate-800">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Examination</th>
                <th className="px-4 py-3">Subject</th>
                <th className="px-4 py-3">Room</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="px-4 py-3">{fmtDate(r.exam_date)}</td>
                  <td className="px-4 py-3">{String(r.start_time).slice(0, 5)} – {String(r.end_time).slice(0, 5)}</td>
                  <td className="px-4 py-3">{r.exam_title} <span className="text-xs text-slate-500">({r.exam_type})</span></td>
                  <td className="px-4 py-3">{r.subject_code} — {r.subject_title}</td>
                  <td className="px-4 py-3">{r.room_name ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_BADGE[r.status]}`}>{r.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
