import { useEffect, useState } from 'react';
import {
  resultsApi, examsApi, studentsApi, ResultRow, Exam,
  normalizeResultRow, normalizeExam, gpaFromRows,
  apiErrorMessage, downloadBlob,
} from '../services/api';
import { useAuth } from '../context/AuthContext';

const GRADE_BADGE: Record<string, string> = {
  A: 'bg-emerald-100 text-emerald-700', B: 'bg-blue-100 text-blue-700',
  C: 'bg-amber-100 text-amber-700', D: 'bg-orange-100 text-orange-700',
  F: 'bg-red-100 text-red-700',
};

export default function Results() {
  const { user, hasRole } = useAuth();
  const isStudent = hasRole('STUDENT');
  const isStaff = hasRole('SUPER_ADMIN', 'EXAM_OFFICER');
  // Students see only their own results; staff enter a student number
  // (STU-2026-001) or an internal id to inspect.
  const [studentInput, setStudentInput] = useState(user?.studentId ?? '');
  // Internal students.id resolved from the input — what the API needs.
  const [studentId, setStudentId] = useState(user?.studentId ?? '');
  const [results, setResults] = useState<ResultRow[]>([]);
  const [gpa, setGpa] = useState<number | null>(null);
  const [cgpa, setCgpa] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exams, setExams] = useState<Exam[]>([]);
  const [selectedExamId, setSelectedExamId] = useState('');
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (isStaff) {
      examsApi.list({ limit: 200 }).then(
        ({ data }) => setExams(
          (data.data as unknown as Record<string, unknown>[]).map(normalizeExam),
        ),
        () => undefined,
      );
    }
  }, [isStaff]);

  // Resolve what the user typed to the internal students.id:
  // - a bare number is already the internal id;
  // - STU-2026-001 (or any non-numeric value) is looked up via the
  //   students search, matching the public student_id exactly.
  const resolveStudentId = async (input: string): Promise<string> => {
    const trimmed = input.trim();
    if (/^\d+$/.test(trimmed)) return trimmed;
    const { data } = await studentsApi.list({ search: trimmed, limit: 10 });
    const rows = data.data as unknown as Array<Record<string, unknown>>;
    const match = rows.find(
      (r) => String(r.student_id ?? '').toLowerCase() === trimmed.toLowerCase(),
    ) ?? rows[0];
    if (!match) throw new Error(`No student found for "${trimmed}".`);
    return String(match.id);
  };

  const load = async (id: string) => {
    if (!id.trim()) { setError('Enter a student ID to view results.'); return; }
    setLoading(true);
    try {
      const internalId = await resolveStudentId(id);
      setStudentId(internalId);
      const { data } = await resultsApi.byStudent(internalId);
      const rows = (data.data.results as unknown as Record<string, unknown>[]).map(normalizeResultRow);
      setResults(rows);
      // The response has no gpa field — only cgpa. GPA for the rows shown
      // is computed from them (credit-weighted grade points).
      setGpa(gpaFromRows(rows));
      setCgpa(data.data.cgpa == null ? null : Number(data.data.cgpa));
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
      setResults([]);
      setGpa(null);
      setCgpa(null);
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
    if (!studentId) { setError('Load a student first.'); return; }
    try {
      const res = await resultsApi.transcript(studentId);
      downloadBlob(res.data, `transcript-${studentId}.pdf`);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const downloadAdmitCard = async () => {
    if (!studentId) { setError('Load a student first.'); return; }
    if (!selectedExamId) { setError('Choose an exam for the admit card.'); return; }
    try {
      const res = await resultsApi.admitCard(studentId, selectedExamId);
      downloadBlob(res.data, `admit-card-${studentId}.pdf`);
      setNotice('Admit card downloaded.');
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const calculateResults = async () => {
    if (!selectedExamId) { setError('Choose an exam to calculate results for.'); return; }
    setWorking(true);
    try {
      const { data } = await resultsApi.calculate(selectedExamId);
      setNotice(data.message ?? `${(data.data as unknown[]).length} result(s) calculated from approved marks.`);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setWorking(false);
    }
  };

  const publishResults = async () => {
    if (!selectedExamId) { setError('Choose an exam to publish results for.'); return; }
    setWorking(true);
    try {
      const { data } = await resultsApi.publish(selectedExamId);
      setNotice(data.message ?? 'Results published.');
      setError(null);
      if (studentId) await load(studentId);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setWorking(false);
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
            <input value={studentInput} onChange={(e) => setStudentInput(e.target.value)} placeholder="e.g. STU-2026-001" className="mt-1 block w-64 rounded-lg border px-3 py-2" />
          </label>
          <button onClick={() => load(studentInput)} disabled={loading} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {loading ? 'Loading…' : 'View results'}
          </button>
          <button onClick={downloadTranscript} disabled={!studentId || results.length === 0} className="rounded-lg border bg-white px-4 py-2 text-sm dark:bg-slate-800 disabled:opacity-50">
            Download transcript (PDF)
          </button>
        </div>
      )}

      {isStaff && (
        <div className="flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow-card dark:bg-slate-800">
          <label className="text-sm font-medium">Exam
            <select value={selectedExamId} onChange={(e) => setSelectedExamId(e.target.value)} className="mt-1 block w-72 rounded-lg border bg-white px-3 py-2 dark:bg-slate-800">
              <option value="">— Select an exam —</option>
              {exams.map((e) => (
                <option key={e.id} value={e.id}>{e.title} · {e.examType} · {e.startDate}</option>
              ))}
            </select>
          </label>
          <button onClick={calculateResults} disabled={working || !selectedExamId} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {working ? 'Working…' : 'Calculate results'}
          </button>
          <button onClick={publishResults} disabled={working || !selectedExamId} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {working ? 'Working…' : 'Publish results'}
          </button>
          <button onClick={downloadAdmitCard} disabled={!studentId || !selectedExamId} className="rounded-lg border bg-white px-4 py-2 text-sm dark:bg-slate-800 disabled:opacity-50">
            Download admit card (PDF)
          </button>
        </div>
      )}

      {isStudent && (
        <div className="flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow-card dark:bg-slate-800">
          <button onClick={downloadTranscript} disabled={!studentId || results.length === 0} className="rounded-lg border bg-white px-4 py-2 text-sm dark:bg-slate-800 disabled:opacity-50">
            Download transcript (PDF)
          </button>
          <span className="text-sm text-slate-500">Admit cards are available from the Admit Card page.</span>
        </div>
      )}

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      {(gpa !== null || cgpa !== null) && (
        <div className="grid grid-cols-2 gap-4 sm:max-w-md">
          <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
            <p className="text-sm text-slate-500">GPA (results shown)</p>
            <p className="text-3xl font-bold">{gpa !== null ? gpa.toFixed(2) : '—'}</p>
          </div>
          <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
            <p className="text-sm text-slate-500">CGPA</p>
            <p className="text-3xl font-bold">{cgpa !== null ? cgpa.toFixed(2) : '—'}</p>
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
                <tr key={`${r.studentId}-${r.subjectCode}-${r.examTitle ?? ''}`} className="border-t">
                  <td className="px-4 py-3">{r.subjectCode} — {r.subjectName}<br /><span className="text-xs text-slate-500">{r.studentName} ({r.studentNo}){r.examTitle ? ` · ${r.examTitle}` : ''}</span></td>
                  <td className="px-4 py-3">{r.marksObtained} / {r.totalMarks}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${GRADE_BADGE[r.grade] ?? 'bg-slate-100'}`}>{r.grade}</span>
                  </td>
                  <td className="px-4 py-3">{r.gradePoint.toFixed(1)}</td>
                  <td className="px-4 py-3 text-xs">{r.status === 'PUBLISHED' ? 'Published' : 'Unpublished'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isStudent && results.length > 0 && (
        <p className="text-sm text-slate-500">
          Use “Download transcript” above for your official result sheet.
        </p>
      )}

      {!loading && results.length === 0 && !error && (
        <p className="text-sm text-slate-500">No published results found for this student yet.</p>
      )}
    </div>
  );
}
