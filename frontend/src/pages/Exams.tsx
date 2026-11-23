import { useEffect, useState } from 'react';
import DataTable, { Column } from '../components/DataTable';
import { examsApi, Exam, apiErrorMessage } from '../services/api';
import { useAuth } from '../context/AuthContext';

const STATUS_BADGE: Record<Exam['status'], string> = {
  DRAFT: 'bg-slate-100 text-slate-700',
  SCHEDULED: 'bg-blue-100 text-blue-700',
  ONGOING: 'bg-amber-100 text-amber-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  CANCELLED: 'bg-red-100 text-red-700',
};

export default function Exams() {
  const { hasRole } = useAuth();
  const canManage = hasRole('SUPER_ADMIN', 'EXAM_OFFICER');
  const [exams, setExams] = useState<Exam[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({
    title: '', subjectId: '', academicYear: '2025-2026', semester: 1,
    examDate: '', startTime: '09:00', endTime: '12:00', roomId: '', totalMarks: 100,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await examsApi.list({ limit: 500 });
      setExams(data.data);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.subjectId || !form.examDate) {
      setFormError('Title, subject and exam date are required.');
      return;
    }
    if (form.endTime <= form.startTime) {
      setFormError('End time must be after start time.');
      return;
    }
    if (form.totalMarks < 1 || form.totalMarks > 200) {
      setFormError('Total marks must be between 1 and 200.');
      return;
    }
    setSaving(true);
    try {
      await examsApi.create({ ...form, status: 'SCHEDULED' });
      setNotice(`Exam "${form.title}" scheduled for ${form.examDate}.`);
      setFormOpen(false);
      await load();
    } catch (err) {
      setFormError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const columns: Column<Exam>[] = [
    { key: 'title', header: 'Exam', sortable: true, accessor: (r) => r.title },
    { key: 'subjectCode', header: 'Subject', sortable: true, accessor: (r) => `${r.subjectCode} — ${r.subjectName}` },
    { key: 'examDate', header: 'Date', sortable: true, accessor: (r) => r.examDate },
    { key: 'time', header: 'Time', accessor: (r) => `${r.startTime} – ${r.endTime}` },
    { key: 'roomName', header: 'Room', accessor: (r) => r.roomName ?? '—' },
    {
      key: 'status', header: 'Status', accessor: (r) => r.status,
      render: (r) => <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[r.status]}`}>{r.status}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold">Examinations</h1>
          <p className="text-sm text-slate-500">Create exams, assign rooms and times. A subject can have only one exam per semester — duplicates are rejected by the server.</p>
        </div>
        {canManage && (
          <button onClick={() => { setFormError(null); setFormOpen(true); }} className="ml-auto rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-700">
            + Create Exam
          </button>
        )}
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      <DataTable<Exam>
        columns={columns}
        data={exams}
        loading={loading}
        searchableKeys={[(r) => r.title, (r) => r.subjectName, (r) => r.subjectCode]}
        filters={[
          { label: 'Scheduled', value: 'SCHEDULED', test: (r) => r.status === 'SCHEDULED' },
          { label: 'Completed', value: 'COMPLETED', test: (r) => r.status === 'COMPLETED' },
          { label: 'Draft', value: 'DRAFT', test: (r) => r.status === 'DRAFT' },
        ]}
        actions={(row) => (
          <a href={`/marks/${row.id}`} className="text-navy-600 hover:underline">Marks →</a>
        )}
      />

      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Create exam">
          <form onSubmit={submit} className="w-full max-w-lg rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">Create examination</h2>
            {formError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium sm:col-span-2">Title
                <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Midterm — Database Systems" className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="text-sm font-medium">Subject ID
                <input required value={form.subjectId} onChange={(e) => setForm({ ...form, subjectId: e.target.value })} placeholder="e.g. subj-db-101" className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="text-sm font-medium">Room ID (optional)
                <input value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })} placeholder="e.g. room-a-101" className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="text-sm font-medium">Exam date
                <input required type="date" value={form.examDate} onChange={(e) => setForm({ ...form, examDate: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="text-sm font-medium">Semester
                <input required type="number" min={1} max={8} value={form.semester} onChange={(e) => setForm({ ...form, semester: Number(e.target.value) })} className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="text-sm font-medium">Start time
                <input required type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="text-sm font-medium">End time
                <input required type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="text-sm font-medium">Total marks
                <input required type="number" min={1} max={200} value={form.totalMarks} onChange={(e) => setForm({ ...form, totalMarks: Number(e.target.value) })} className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setFormOpen(false)} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={saving} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {saving ? 'Saving…' : 'Create exam'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
