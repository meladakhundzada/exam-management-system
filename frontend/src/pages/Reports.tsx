import { useEffect, useState } from 'react';
import {
  reportsApi, examsApi, departmentsApi, ReportDashboard,
  apiErrorMessage, downloadBlob,
} from '../services/api';
import { useAuth } from '../context/AuthContext';

const inputCls = 'mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900';

export default function Reports() {
  const { hasRole } = useAuth();
  // Lecturers can open this page: GET /api/reports/dashboard, GET /exams
  // and GET /departments all allow any authenticated role, so the counts
  // load without a 403. The counts are scoped to the lecturer's own
  // courses on the backend (GET /api/reports/dashboard). The student-list
  // export stays STAFF-only and is hidden here; the schedule and published
  // results exports are open to lecturers for their own subjects' exams,
  // and the admit-card / individual result-sheet PDFs stay available.
  const isLecturer = hasRole('LECTURER');
  const [stats, setStats] = useState<ReportDashboard | null>(null);
  const [exams, setExams] = useState<Array<{ id: number; title: string }>>([]);
  const [departments, setDepartments] = useState<Array<{ id: number; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Export form state.
  const [studentDept, setStudentDept] = useState('');
  const [scheduleExam, setScheduleExam] = useState('');
  const [resultsExam, setResultsExam] = useState('');
  const [admitStudent, setAdmitStudent] = useState('');
  const [admitExam, setAdmitExam] = useState('');
  const [resultStudent, setResultStudent] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [{ data: statsRes }, { data: examRes }, { data: deptRes }] = await Promise.all([
          reportsApi.dashboard(),
          examsApi.list({ limit: 500 }),
          departmentsApi.list(),
        ]);
        setStats(statsRes.data);
        setExams(examRes.data as unknown as Array<{ id: number; title: string }>);
        setDepartments(deptRes.data);
        setError(null);
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const runExport = async (key: string, fn: () => Promise<{ data: Blob }>, filename: string) => {
    setBusy(key);
    try {
      const res = await fn();
      downloadBlob(res.data, filename);
      setNotice(`Downloaded ${filename}.`);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const statCards: Array<[string, number | undefined]> = stats ? [
    ['Total students', stats.total_students],
    ['Total lecturers', stats.total_lecturers],
    ['Total departments', stats.total_departments],
    ['Total subjects', stats.total_subjects],
    ['Upcoming exams', stats.upcoming_exams],
    ['Completed exams', stats.completed_exams],
    ['Published results', stats.published_results],
    ['Pending marks', stats.pending_marks],
    ['Pending complaints', stats.pending_complaints],
  ] : [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Reports &amp; Statistics</h1>
        <p className="text-sm text-slate-500">Live counts from the database, plus Excel / PDF exports.{isLecturer ? ' Counts and exports below cover your courses only.' : ''}</p>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : stats ? (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {statCards.map(([label, value]) => (
              <div key={label} className="rounded-xl bg-white p-4 shadow-card dark:bg-slate-800">
                <p className="text-sm text-slate-500">{label}</p>
                <p className="text-2xl font-bold">{value ?? '—'}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
              <h2 className="font-bold">Students by department</h2>
              {stats.students_by_department.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">No data yet.</p>
              ) : (
                <ul className="mt-2 space-y-1 text-sm">
                  {stats.students_by_department.map((d) => (
                    <li key={d.department} className="flex justify-between border-b py-1 last:border-0">
                      <span>{d.department}</span><strong>{d.students}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
              <h2 className="font-bold">Published results by grade</h2>
              {stats.grade_distribution.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">No published results yet.</p>
              ) : (
                <ul className="mt-2 space-y-1 text-sm">
                  {stats.grade_distribution.map((g) => (
                    <li key={g.grade} className="flex justify-between border-b py-1 last:border-0">
                      <span>Grade {g.grade}</span><strong>{g.count}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      ) : null}

      <h2 className="pt-2 text-lg font-bold">Exports</h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {!isLecturer && (
        <div className="space-y-3 rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <h3 className="font-bold">Student list</h3>
          <label className="text-sm font-medium">Department (optional)
            <select value={studentDept} onChange={(e) => setStudentDept(e.target.value)} className={inputCls}>
              <option value="">All departments</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <div className="flex gap-2">
            <button disabled={busy !== null} onClick={() => runExport('students-xlsx', () => reportsApi.studentsExport('xlsx', studentDept ? Number(studentDept) : undefined), 'students.xlsx')} className="rounded-lg bg-navy-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Excel</button>
            <button disabled={busy !== null} onClick={() => runExport('students-pdf', () => reportsApi.studentsExport('pdf', studentDept ? Number(studentDept) : undefined), 'students.pdf')} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">PDF</button>
          </div>
        </div>
        )}

        <div className="space-y-3 rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <h3 className="font-bold">Examination schedule</h3>
          <label className="text-sm font-medium">Examination
            <select value={scheduleExam} onChange={(e) => setScheduleExam(e.target.value)} className={inputCls}>
              <option value="">Choose an examination…</option>
              {exams.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
            </select>
          </label>
          <div className="flex gap-2">
            <button disabled={!scheduleExam || busy !== null} onClick={() => runExport('schedule-xlsx', () => reportsApi.scheduleExport(Number(scheduleExam), 'xlsx'), 'schedule.xlsx')} className="rounded-lg bg-navy-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Excel</button>
            <button disabled={!scheduleExam || busy !== null} onClick={() => runExport('schedule-pdf', () => reportsApi.scheduleExport(Number(scheduleExam), 'pdf'), 'schedule.pdf')} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">PDF</button>
          </div>
        </div>

        <div className="space-y-3 rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <h3 className="font-bold">Published results</h3>
          <label className="text-sm font-medium">Examination
            <select value={resultsExam} onChange={(e) => setResultsExam(e.target.value)} className={inputCls}>
              <option value="">Choose an examination…</option>
              {exams.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
            </select>
          </label>
          <div className="flex gap-2">
            <button disabled={!resultsExam || busy !== null} onClick={() => runExport('results-xlsx', () => reportsApi.resultsExport(Number(resultsExam), 'xlsx'), 'results.xlsx')} className="rounded-lg bg-navy-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Excel</button>
            <button disabled={!resultsExam || busy !== null} onClick={() => runExport('results-pdf', () => reportsApi.resultsExport(Number(resultsExam), 'pdf'), 'results.pdf')} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">PDF</button>
          </div>
          <p className="text-xs text-slate-500">Only published results are exported.</p>
        </div>

        <div className="space-y-3 rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <h3 className="font-bold">Admit card (PDF)</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm font-medium">Student record ID
              <input inputMode="numeric" value={admitStudent} onChange={(e) => setAdmitStudent(e.target.value)} placeholder="e.g. 1" className={inputCls} />
            </label>
            <label className="text-sm font-medium">Examination
              <select value={admitExam} onChange={(e) => setAdmitExam(e.target.value)} className={inputCls}>
                <option value="">Choose…</option>
                {exams.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
              </select>
            </label>
          </div>
          <button disabled={!admitStudent || !admitExam || busy !== null} onClick={() => runExport('admit', () => reportsApi.admitCard(Number(admitStudent), Number(admitExam)), `admit-card-${admitStudent}.pdf`)} className="rounded-lg bg-navy-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Download admit card</button>
        </div>

        <div className="space-y-3 rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <h3 className="font-bold">Individual result sheet (PDF)</h3>
          <label className="text-sm font-medium">Student record ID
            <input inputMode="numeric" value={resultStudent} onChange={(e) => setResultStudent(e.target.value)} placeholder="e.g. 1" className={inputCls} />
          </label>
          <button disabled={!resultStudent || busy !== null} onClick={() => runExport('result-pdf', () => reportsApi.resultPdf(Number(resultStudent)), `result-${resultStudent}.pdf`)} className="rounded-lg bg-navy-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Download result sheet</button>
          <p className="text-xs text-slate-500">Only published results are included; fails if the student has none.</p>
        </div>
      </div>
    </div>
  );
}
