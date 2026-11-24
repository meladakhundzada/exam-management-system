import { useEffect, useState } from 'react';
import { examsApi, reportsApi, studentsApi, apiErrorMessage, downloadBlob } from '../services/api';
import { useAuth } from '../context/AuthContext';

// The backend returns snake_case examination rows (title, exam_type,
// start_date, end_date, status in lowercase). GET /api/exams/:id adds a
// nested `schedules` array with subject code/title, room and invigilator.
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

interface ExamRow {
  id: number;
  title: string;
  exam_type?: string;
  academic_year?: string;
  semester_name?: string;
  start_date?: string;
  end_date?: string;
  status?: string;
  schedules?: ScheduleRow[];
}

const fmtDate = (d: string) => String(d).slice(0, 10);

export default function Timetable() {
  const { user, hasRole } = useAuth();
  const isStudent = hasRole('STUDENT');
  const canExport = hasRole('SUPER_ADMIN', 'EXAM_OFFICER');
  const [exams, setExams] = useState<ExamRow[]>([]);
  const [examId, setExamId] = useState('');
  const [exam, setExam] = useState<ExamRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Students see only their own class timetable: schedules are filtered
  // to their enrolled subjects (loaded once from their enrolments).
  const [enrolledSubjectIds, setEnrolledSubjectIds] = useState<Set<number> | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { data } = await examsApi.list({ limit: 500 });
        setExams(data.data as unknown as ExamRow[]);
        setError(null);
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
    if (isStudent && user?.studentId) {
      studentsApi.enrollments(user.studentId)
        .then(({ data }) => setEnrolledSubjectIds(
          new Set((data.data as unknown as Array<{ subject_id: number }>).map((e) => Number(e.subject_id))),
        ))
        .catch(() => setEnrolledSubjectIds(new Set()));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadExam = async (id: string) => {
    setExamId(id);
    setExam(null);
    if (!id) return;
    setDetailLoading(true);
    try {
      const { data } = await examsApi.get(id);
      setExam(data.data as unknown as ExamRow);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const exportSchedule = async (format: 'xlsx' | 'pdf') => {
    if (!examId) return;
    try {
      const res = await reportsApi.scheduleExport(Number(examId), format);
      downloadBlob(res.data, `schedule-${examId}.${format === 'pdf' ? 'pdf' : 'xlsx'}`);
      setNotice(`Timetable exported as ${format.toUpperCase()}.`);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const schedules = (exam?.schedules ?? []).filter(
    (s) => !isStudent || !enrolledSubjectIds || enrolledSubjectIds.has(Number(s.subject_id)),
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Examination Timetable</h1>
        <p className="text-sm text-slate-500">
          Pick an examination to see its scheduled subjects with date, time, room and invigilator.
        </p>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      <div className="flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow-card dark:bg-slate-800">
        <label className="text-sm font-medium">Examination
          <select
            value={examId}
            onChange={(e) => loadExam(e.target.value)}
            className="mt-1 block w-80 max-w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900"
          >
            <option value="">Choose an examination…</option>
            {exams.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title} ({e.start_date ? fmtDate(e.start_date) : ''}{e.end_date ? ` – ${fmtDate(e.end_date)}` : ''})
              </option>
            ))}
          </select>
        </label>
        {examId && canExport && (
          <span className="flex gap-2">
            <button onClick={() => exportSchedule('xlsx')} className="rounded-lg border bg-white px-3 py-2 text-sm dark:bg-slate-800">Export Excel</button>
            <button onClick={() => exportSchedule('pdf')} className="rounded-lg border bg-white px-3 py-2 text-sm dark:bg-slate-800">Export PDF</button>
          </span>
        )}
      </div>

      {loading && <p className="text-sm text-slate-500">Loading examinations…</p>}
      {!loading && !examId && !error && (
        <p className="text-sm text-slate-500">No examination selected yet.</p>
      )}
      {detailLoading && <p className="text-sm text-slate-500">Loading timetable…</p>}

      {exam && !detailLoading && (
        <div className="overflow-x-auto rounded-xl bg-white shadow-card dark:bg-slate-800">
          <div className="border-b px-4 py-3 dark:border-slate-700">
            <h2 className="font-bold">{exam.title}</h2>
            <p className="text-sm text-slate-500">
              {exam.academic_year ?? ''}{exam.semester_name ? ` · ${exam.semester_name}` : ''}
              {exam.exam_type ? ` · ${exam.exam_type}` : ''} · Status: {exam.status ?? '—'}
            </p>
          </div>
          {schedules.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-500">
              {isStudent
                ? 'None of your enrolled subjects are scheduled in this examination yet.'
                : 'No subjects scheduled for this examination yet — add schedules on the Examinations page.'}
            </p>
          ) : (
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Time</th>
                  <th className="px-4 py-3">Subject</th>
                  <th className="px-4 py-3">Room</th>
                  <th className="px-4 py-3">Invigilator</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <tr key={s.id} className="border-t">
                    <td className="px-4 py-3">{fmtDate(s.exam_date)}</td>
                    <td className="px-4 py-3">{String(s.start_time).slice(0, 5)} – {String(s.end_time).slice(0, 5)}</td>
                    <td className="px-4 py-3">{s.subject_code} — {s.subject_title}</td>
                    <td className="px-4 py-3">{s.room_name ?? 'Room TBA'}</td>
                    <td className="px-4 py-3">{s.invigilator ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
