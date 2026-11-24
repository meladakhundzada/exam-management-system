import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  examsApi, marksApi, Exam, RosterRow, normalizeExam, normalizeRosterRow,
  apiErrorMessage,
} from '../services/api';
import { useAuth } from '../context/AuthContext';

interface ScheduleOption {
  id: string;
  subjectId: string;
  subjectCode: string;
  subjectTitle: string;
  examDate: string;
}

const STATUS_LABEL: Record<RosterRow['status'], string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  rejected: 'Rejected — needs correction',
};

export default function Marks() {
  const { examId } = useParams<{ examId: string }>();
  const { hasRole } = useAuth();
  const canApprove = hasRole('SUPER_ADMIN', 'EXAM_OFFICER');
  const [exams, setExams] = useState<Exam[]>([]);
  const [selectedExamId, setSelectedExamId] = useState<string>(examId ?? '');
  const [schedules, setSchedules] = useState<ScheduleOption[]>([]);
  const [selectedSubjectId, setSelectedSubjectId] = useState<string>('');
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [confirmReject, setConfirmReject] = useState(false);

  useEffect(() => {
    examsApi.list({ limit: 200 }).then(
      ({ data }) => setExams(
        (data.data as unknown as Record<string, unknown>[])
          .map(normalizeExam)
          .filter((e) => e.status !== 'CANCELLED'),
      ),
      () => setError('Could not load the exam list.'),
    );
  }, []);

  // Subjects scheduled for the selected exam (GET /api/exams/:id).
  useEffect(() => {
    if (!selectedExamId) { setSchedules([]); setSelectedSubjectId(''); return; }
    examsApi.get(selectedExamId).then(
      ({ data }) => {
        const raw = data.data as unknown as Record<string, unknown>;
        const list = (raw.schedules as Array<Record<string, unknown>> | undefined ?? []).map((s) => ({
          id: String(s.id ?? ''),
          subjectId: String(s.subject_id ?? ''),
          subjectCode: String(s.subject_code ?? ''),
          subjectTitle: String(s.subject_title ?? ''),
          examDate: String(s.exam_date ?? '').slice(0, 10),
        }));
        setSchedules(list);
        setSelectedSubjectId(list.length === 1 ? list[0].subjectId : '');
      },
      () => setError('Could not load the exam timetable.'),
    );
  }, [selectedExamId]);

  const loadRoster = async (eId: string, sId: string) => {
    setLoading(true);
    try {
      const { data } = await marksApi.roster(eId, sId);
      setRows((data.data as unknown as Record<string, unknown>[]).map(normalizeRosterRow));
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!selectedExamId || !selectedSubjectId) { setRows([]); return; }
    loadRoster(selectedExamId, selectedSubjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedExamId, selectedSubjectId]);

  const selectedExam = exams.find((e) => e.id === selectedExamId);
  const selectedSchedule = schedules.find((s) => s.subjectId === selectedSubjectId);

  const setMark = (studentPk: string, value: string) => {
    const n = value === '' ? null : Number(value);
    setRows((prev) => prev.map((r) =>
      r.studentPk === studentPk
        ? { ...r, marksObtained: n !== null && Number.isFinite(n) ? n : null }
        : r,
    ));
  };

  const validateAll = (): string | null => {
    if (!selectedExam || !selectedSubjectId) return 'Choose an exam and a subject first.';
    for (const r of rows) {
      if (r.marksObtained === null) return `Enter a mark for ${r.studentName} (${r.studentNo}), or 0 for absent-with-mark.`;
      if (r.marksObtained < 0 || r.marksObtained > 100) {
        return `${r.studentName}: marks must be between 0 and 100.`;
      }
    }
    return null;
  };

  // Save the whole class as drafts: POST /api/marks/bulk.
  const saveDrafts = async () => {
    const v = validateAll();
    if (v) { setError(v); return; }
    setSaving(true);
    try {
      await marksApi.bulk(
        selectedExamId,
        selectedSubjectId,
        rows.map((r) => ({ student_id: Number(r.studentPk), obtained_marks: r.marksObtained! })),
      );
      setNotice('Marks saved as drafts.');
      setError(null);
      await loadRoster(selectedExamId, selectedSubjectId);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // Submit every draft row for approval: POST /api/marks/:id/submit.
  const submitMarks = async () => {
    const v = validateAll();
    if (v) { setError(v); return; }
    setSaving(true);
    try {
      await saveDraftsQuiet();
      const { data } = await marksApi.roster(selectedExamId, selectedSubjectId);
      const fresh = (data.data as unknown as Record<string, unknown>[]).map(normalizeRosterRow);
      const drafts = fresh.filter((r) => r.status === 'draft' && r.markId);
      if (!drafts.length) { setError('No draft marks to submit — save them first.'); return; }
      await Promise.all(drafts.map((r) => marksApi.submit(r.markId!)));
      setNotice('Marks submitted for review. An Examination Officer must approve them before results are calculated.');
      setError(null);
      await loadRoster(selectedExamId, selectedSubjectId);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // Save without touching notice/loading state (used before submit).
  const saveDraftsQuiet = async () => {
    await marksApi.bulk(
      selectedExamId,
      selectedSubjectId,
      rows.map((r) => ({ student_id: Number(r.studentPk), obtained_marks: r.marksObtained! })),
    );
  };

  const approveMarks = async () => {
    setSaving(true);
    try {
      const targets = rows.filter((r) => (r.status === 'submitted' || r.status === 'draft') && r.markId);
      if (!targets.length) { setError('No marks awaiting approval.'); return; }
      await Promise.all(targets.map((r) => marksApi.approve(r.markId!)));
      setNotice('Marks approved. Grades and GPA will be calculated on publication.');
      setConfirmApprove(false);
      await loadRoster(selectedExamId, selectedSubjectId);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const rejectMarks = async () => {
    setSaving(true);
    try {
      const targets = rows.filter((r) => (r.status === 'submitted' || r.status === 'draft') && r.markId);
      if (!targets.length) { setError('No marks to reject.'); return; }
      await Promise.all(targets.map((r) => marksApi.reject(r.markId!, rejectReason || undefined)));
      setNotice('Marks rejected and sent back for correction.');
      setConfirmReject(false);
      setRejectReason('');
      await loadRoster(selectedExamId, selectedSubjectId);
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
          Lecturers enter marks out of 100. Save drafts, then submit for approval; after approval only an
          Examination Officer can reject them back for correction.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="block w-full max-w-md text-sm font-medium">Exam
          <select
            value={selectedExamId}
            onChange={(e) => setSelectedExamId(e.target.value)}
            className="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:bg-slate-800"
          >
            <option value="">— Select an exam —</option>
            {exams.map((e) => (
              <option key={e.id} value={e.id}>{e.title} · {e.examType} · {e.startDate}</option>
            ))}
          </select>
        </label>
        <label className="block w-full max-w-md text-sm font-medium">Subject
          <select
            value={selectedSubjectId}
            onChange={(e) => setSelectedSubjectId(e.target.value)}
            disabled={!schedules.length}
            className="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:bg-slate-800 disabled:opacity-50"
          >
            <option value="">— Select a subject —</option>
            {schedules.map((s) => (
              <option key={s.subjectId} value={s.subjectId}>{s.subjectCode} — {s.subjectTitle} · {s.examDate}</option>
            ))}
          </select>
        </label>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      {selectedExam && selectedSchedule && (
        <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <h2 className="font-bold">{selectedExam.title}</h2>
              <p className="text-sm text-slate-500">{selectedSchedule.subjectCode} — {selectedSchedule.subjectTitle} · Total 100 marks · {filled}/{rows.length} entered</p>
            </div>
            <div className="ml-auto flex flex-wrap gap-2">
              <button onClick={saveDrafts} disabled={saving || loading} className="rounded-lg border px-4 py-2 text-sm font-semibold disabled:opacity-50">
                {saving ? 'Saving…' : 'Save drafts'}
              </button>
              <button onClick={submitMarks} disabled={saving || loading} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {saving ? 'Saving…' : 'Submit for approval'}
              </button>
              {canApprove && (
                <>
                  <button onClick={() => setConfirmApprove(true)} disabled={saving || rows.length === 0} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                    Approve marks
                  </button>
                  <button onClick={() => setConfirmReject(true)} disabled={saving || rows.length === 0} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                    Reject
                  </button>
                </>
              )}
            </div>
          </div>

          {loading ? (
            <p className="mt-4 text-sm text-slate-500">Loading students…</p>
          ) : rows.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">No students are enrolled for this subject yet.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900">
                  <tr><th className="px-3 py-2">Student</th><th className="px-3 py-2">Student No.</th><th className="px-3 py-2">Marks / 100</th><th className="px-3 py-2">Status</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.studentPk} className="border-t">
                      <td className="px-3 py-2">{r.studentName}</td>
                      <td className="px-3 py-2">{r.studentNo}</td>
                      <td className="px-3 py-2">
                        <input
                          type="number" min={0} max={100} step={0.5}
                          value={r.marksObtained ?? ''}
                          onChange={(e) => setMark(r.studentPk, e.target.value)}
                          aria-label={`Marks for ${r.studentName}`}
                          className="w-28 rounded-lg border px-2 py-1.5"
                        />
                      </td>
                      <td className="px-3 py-2 text-xs">{STATUS_LABEL[r.status]}</td>
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

      {confirmReject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="alertdialog" aria-modal="true" aria-label="Confirm rejection">
          <div className="w-full max-w-md rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">Reject these marks?</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              The marks go back to draft so the lecturer can correct them.
            </p>
            <label className="mt-4 block text-sm font-medium">Reason (optional)
              <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="e.g. marks do not match the answer sheets" className="mt-1 w-full rounded-lg border px-3 py-2" />
            </label>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setConfirmReject(false)} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>
              <button onClick={rejectMarks} disabled={saving} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white">Reject</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
