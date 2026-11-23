import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { examsApi, marksApi, Exam, MarkRow, apiErrorMessage } from '../services/api';
import { useAuth } from '../context/AuthContext';

export default function Marks() {
  const { examId } = useParams<{ examId: string }>();
  const { hasRole } = useAuth();
  const canApprove = hasRole('SUPER_ADMIN', 'EXAM_OFFICER');
  const [exams, setExams] = useState<Exam[]>([]);
  const [selectedExamId, setSelectedExamId] = useState<string>(examId ?? '');
  const [rows, setRows] = useState<MarkRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);

  useEffect(() => {
    examsApi.list({ limit: 200 }).then(
      ({ data }) => setExams(data.data.filter((e) => e.status !== 'CANCELLED')),
      () => setError('Could not load the exam list.'),
    );
  }, []);

  useEffect(() => {
    if (!selectedExamId) { setRows([]); return; }
    setLoading(true);
    marksApi.byExam(selectedExamId)
      .then(({ data }) => { setRows(data.data); setError(null); })
      .catch((err) => setError(apiErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [selectedExamId]);

  const selectedExam = exams.find((e) => e.id === selectedExamId);

  const setMark = (studentId: string, value: string) => {
    const n = value === '' ? null : Number(value);
    setRows((prev) => prev.map((r) =>
      r.studentId === studentId
        ? { ...r, marksObtained: n !== null && Number.isFinite(n) ? n : null }
        : r,
    ));
  };

  const validateAll = (): string | null => {
    if (!selectedExam) return 'Choose an exam first.';
    for (const r of rows) {
      if (r.marksObtained === null) return `Enter a mark for ${r.studentName} (${r.studentNo}), or 0 for absent-with-mark.`;
      if (r.marksObtained < 0 || r.marksObtained > r.totalMarks) {
        return `${r.studentName}: marks must be between 0 and ${r.totalMarks}.`;
      }
    }
    return null;
  };

  const submitMarks = async () => {
    const v = validateAll();
    if (v) { setError(v); return; }
    setSaving(true);
    try {
      await marksApi.submit(selectedExamId, rows.map((r) => ({ studentId: r.studentId, marksObtained: r.marksObtained! })));
      setNotice('Marks submitted for review. An Examination Officer must approve them before results are calculated.');
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const approveMarks = async () => {
    setSaving(true);
    try {
      await marksApi.approve(selectedExamId);
      setNotice('Marks approved. Grades and GPA will be calculated on publication.');
      setConfirmApprove(false);
      const { data } = await marksApi.byExam(selectedExamId);
      setRows(data.data);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const filled = rows.filter((r) => r.marksObtained !== null).length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Marks Entry</h1>
        <p className="text-sm text-slate-500">
          Lecturers enter marks within the exam total. Marks stay editable until submitted; after approval only an
          Examination Officer can reject them back for correction.
        </p>
      </div>

      <label className="block max-w-md text-sm font-medium">Exam
        <select
          value={selectedExamId}
          onChange={(e) => setSelectedExamId(e.target.value)}
          className="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:bg-slate-800"
        >
          <option value="">— Select an exam —</option>
          {exams.map((e) => (
            <option key={e.id} value={e.id}>{e.title} · {e.subjectCode} · {e.examDate}</option>
          ))}
        </select>
      </label>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      {selectedExam && (
        <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <h2 className="font-bold">{selectedExam.title}</h2>
              <p className="text-sm text-slate-500">{selectedExam.subjectCode} — {selectedExam.subjectName} · Total {selectedExam.totalMarks} marks · {filled}/{rows.length} entered</p>
            </div>
            <div className="ml-auto flex gap-2">
              <button onClick={submitMarks} disabled={saving || loading} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {saving ? 'Saving…' : 'Submit for approval'}
              </button>
              {canApprove && (
                <button onClick={() => setConfirmApprove(true)} disabled={saving || rows.length === 0} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                  Approve marks
                </button>
              )}
            </div>
          </div>

          {loading ? (
            <p className="mt-4 text-sm text-slate-500">Loading students…</p>
          ) : rows.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">No students are enrolled for this exam yet.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900">
                  <tr><th className="px-3 py-2">Student</th><th className="px-3 py-2">Student No.</th><th className="px-3 py-2">Marks / {selectedExam.totalMarks}</th><th className="px-3 py-2">Status</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.studentId} className="border-t">
                      <td className="px-3 py-2">{r.studentName}</td>
                      <td className="px-3 py-2">{r.studentNo}</td>
                      <td className="px-3 py-2">
                        <input
                          type="number" min={0} max={r.totalMarks} step={0.5}
                          value={r.marksObtained ?? ''}
                          onChange={(e) => setMark(r.studentId, e.target.value)}
                          aria-label={`Marks for ${r.studentName}`}
                          className="w-28 rounded-lg border px-2 py-1.5"
                        />
                      </td>
                      <td className="px-3 py-2 text-xs">{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {confirmApprove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="alertdialog" aria-modal="true" aria-label="Confirm approval">
          <div className="w-full max-w-md rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">Approve these marks?</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              Approved marks are locked for lecturers and feed GPA / result calculation. Only an Examination Officer
              can reject them afterwards.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setConfirmApprove(false)} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>
              <button onClick={approveMarks} disabled={saving} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white">Approve</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
