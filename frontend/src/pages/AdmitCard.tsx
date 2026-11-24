import { useEffect, useState } from 'react';
import {
  examsApi, studentsApi, reportsApi, resultsApi,
  apiErrorMessage, downloadBlob,
} from '../services/api';
import { useAuth } from '../context/AuthContext';

interface ExamRow {
  id: number;
  title: string;
  exam_type?: string;
  start_date?: string;
  end_date?: string;
  status?: string;
}

interface TimetableRow {
  exam_date: string;
  start_time: string;
  end_time: string;
  subject_code: string;
  subject_title: string;
  room_name?: string | null;
  building?: string | null;
  exam_title: string;
}

const fmtDate = (d: string) => String(d).slice(0, 10);

export default function AdmitCard() {
  const { user } = useAuth();
  const studentId = user?.studentId ?? '';
  const [exams, setExams] = useState<ExamRow[]>([]);
  const [examId, setExamId] = useState('');
  const [timetable, setTimetable] = useState<TimetableRow[]>([]);
  const [examTitle, setExamTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
  }, []);

  const loadExam = async (id: string) => {
    setExamId(id);
    setTimetable([]);
    setExamTitle('');
    if (!id || !studentId) return;
    setDetailLoading(true);
    try {
      // GET /api/students/:id/admit-card?exam_id= returns only this
      // student's enrolled subjects scheduled in the exam.
      const { data } = await studentsApi.admitCardData(studentId, id);
      setTimetable(data.data.timetable);
      setExamTitle(data.data.timetable[0]?.exam_title ?? '');
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const downloadAdmitCard = async () => {
    if (!examId || !studentId) return;
    try {
      const res = await reportsApi.admitCard(Number(studentId), Number(examId));
      downloadBlob(res.data, `admit-card-${examId}.pdf`);
      setNotice('Admit card downloaded.');
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const downloadTranscript = async () => {
    if (!studentId) return;
    try {
      const res = await resultsApi.transcript(studentId);
      downloadBlob(res.data, `transcript-${studentId}.pdf`);
      setNotice('Result sheet downloaded.');
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  if (!studentId) {
    return (
      <div role="alert" className="rounded-xl bg-red-50 p-6 text-red-700 dark:bg-red-900/30 dark:text-red-300">
        No student profile is linked to your account. Contact the Examination Office.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Admit Card</h1>
        <p className="text-sm text-slate-500">
          Pick an examination to see your scheduled subjects, then download your admit card.
          Bring the printed card and a valid ID to every examination.
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
        {examId && (
          <button onClick={downloadAdmitCard} disabled={detailLoading} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            Download admit card (PDF)
          </button>
        )}
        <button onClick={downloadTranscript} className="rounded-lg border bg-white px-4 py-2 text-sm dark:bg-slate-800">
          Download result sheet (PDF)
        </button>
      </div>

      {loading && <p className="text-sm text-slate-500">Loading examinations…</p>}
      {!loading && !examId && !error && (
        <p className="text-sm text-slate-500">No examination selected yet.</p>
      )}
      {detailLoading && <p className="text-sm text-slate-500">Loading your schedule…</p>}

      {examId && !detailLoading && (
        <div className="overflow-x-auto rounded-xl bg-white shadow-card dark:bg-slate-800">
          <div className="border-b px-4 py-3 dark:border-slate-700">
            <h2 className="font-bold">{examTitle || `Examination #${examId}`}</h2>
            <p className="text-sm text-slate-500">Your enrolled subjects scheduled in this examination.</p>
          </div>
          {timetable.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-500">
              None of your enrolled subjects are scheduled in this examination yet.
            </p>
          ) : (
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Time</th>
                  <th className="px-4 py-3">Subject</th>
                  <th className="px-4 py-3">Room</th>
                </tr>
              </thead>
              <tbody>
                {timetable.map((s, i) => (
                  <tr key={`${s.subject_code}-${i}`} className="border-t">
                    <td className="px-4 py-3">{fmtDate(s.exam_date)}</td>
                    <td className="px-4 py-3">{String(s.start_time).slice(0, 5)} – {String(s.end_time).slice(0, 5)}</td>
                    <td className="px-4 py-3">{s.subject_code} — {s.subject_title}</td>
                    <td className="px-4 py-3">{s.room_name ?? 'Room TBA'}{s.building ? ` (${s.building})` : ''}</td>
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
