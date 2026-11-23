import { useEffect, useState } from 'react';
import { resultsApi, ResultRow, apiErrorMessage, downloadBlob } from '../services/api';
import { useAuth } from '../context/AuthContext';

const GRADE_BADGE: Record<string, string> = {
  A: 'bg-emerald-100 text-emerald-700', B: 'bg-blue-100 text-blue-700',
  C: 'bg-amber-100 text-amber-700', D: 'bg-orange-100 text-orange-700',
  F: 'bg-red-100 text-red-700',
};

export default function Results() {
  const { user, hasRole } = useAuth();
  const isStudent = hasRole('STUDENT');
  // Students see only their own results; staff enter a student ID to inspect.
  const [studentId, setStudentId] = useState(user?.studentId ?? '');
  const [semester, setSemester] = useState<number | ''>('');
  const [results, setResults] = useState<ResultRow[]>([]);
  const [gpa, setGpa] = useState<number | null>(null);
  const [cgpa, setCgpa] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async (id: string) => {
    if (!id.trim()) { setError('Enter a student ID to view results.'); return; }
    setLoading(true);
    try {
      const { data } = await resultsApi.byStudent(id.trim(), semester === '' ? undefined : semester);
      setResults(data.data.results);
      setGpa(data.data.gpa);
      setCgpa(data.data.cgpa);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  // Students auto-load their own published results on mount.
  useEffect(() => {
    if (isStudent && user?.studentId) load(user.studentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStudent, user?.studentId]);

  const downloadTranscript = async () => {
    try {
      const res = await resultsApi.transcript(studentId);
      downloadBlob(res.data, `transcript-${studentId}.pdf`);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const downloadAdmitCard = async (examId: string) => {
    try {
      const res = await resultsApi.admitCard(studentId, examId);
      downloadBlob(res.data, `admit-card-${studentId}.pdf`);
      setNotice('Admit card downloaded.');
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Results</h1>
        <p className="text-sm text-slate-500">
          Only published results are visible here. Unpublished results are never returned by the API to students.
        </p>
      </div>

      {!isStudent && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium">Student ID
            <input value={studentId} onChange={(e) => setStudentId(e.target.value)} placeholder="e.g. stu-0001" className="mt-1 block w-64 rounded-lg border px-3 py-2" />
          </label>
          <label className="text-sm font-medium">Semester
            <select value={semester} onChange={(e) => setSemester(e.target.value === '' ? '' : Number(e.target.value))} className="mt-1 block rounded-lg border bg-white px-3 py-2 dark:bg-slate-800">
              <option value="">All</option>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <button onClick={() => load(studentId)} disabled={loading} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {loading ? 'Loading…' : 'View results'}
          </button>
          <button onClick={downloadTranscript} disabled={!studentId || results.length === 0} className="rounded-lg border bg-white px-4 py-2 text-sm dark:bg-slate-800 disabled:opacity-50">
            Download transcript (PDF)
          </button>
        </div>
      )}

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      {gpa !== null && cgpa !== null && (
        <div className="grid grid-cols-2 gap-4 sm:max-w-md">
          <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
            <p className="text-sm text-slate-500">Semester GPA</p>
            <p className="text-3xl font-bold">{gpa.toFixed(2)}</p>
          </div>
          <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
            <p className="text-sm text-slate-500">CGPA</p>
            <p className="text-3xl font-bold">{cgpa.toFixed(2)}</p>
          </div>
        </div>
      )}

      {results.length > 0 && (
        <div className="overflow-x-auto rounded-xl bg-white shadow-card dark:bg-slate-800">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900">
              <tr><th className="px-4 py-3">Subject</th><th className="px-4 py-3">Marks</th><th className="px-4 py-3">Grade</th><th className="px-4 py-3">Grade Point</th><th className="px-4 py-3">Status</th></tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={`${r.studentId}-${r.subjectCode}`} className="border-t">
                  <td className="px-4 py-3">{r.subjectCode} — {r.subjectName}<br /><span className="text-xs text-slate-500">{r.studentName} ({r.studentNo})</span></td>
                  <td className="px-4 py-3">{r.marksObtained} / {r.totalMarks}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${GRADE_BADGE[r.grade] ?? 'bg-slate-100'}`}>{r.grade}</span>
                  </td>
                  <td className="px-4 py-3">{r.gradePoint.toFixed(1)}</td>
                  <td className="px-4 py-3 text-xs">{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isStudent && results.length > 0 && (
        <p className="text-sm text-slate-500">
          To download an admit card, open Timetable → choose an exam → Download admit card.
          That button calls the same <code>resultsApi.admitCard</code> used here.
          <button onClick={() => downloadAdmitCard('latest')} className="ml-2 text-navy-600 hover:underline">Download latest admit card</button>
        </p>
      )}

      {!loading && results.length === 0 && !error && (
        <p className="text-sm text-slate-500">No published results found for this student / semester yet.</p>
      )}
    </div>
  );
}
