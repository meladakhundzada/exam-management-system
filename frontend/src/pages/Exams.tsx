import { useEffect, useState } from 'react';
import DataTable, { Column } from '../components/DataTable';
import { examsApi, referenceApi, Exam, normalizeExam, apiErrorMessage } from '../services/api';
import { useAuth } from '../context/AuthContext';

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700',
  scheduled: 'bg-blue-100 text-blue-700',
  ongoing: 'bg-amber-100 text-amber-700',
  completed: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-red-100 text-red-700',
};

const EXAM_TYPES = ['midterm', 'final', 'quiz', 'supplementary', 'entry'] as const;

interface ReferenceOption {
  id: number;
  name: string;
  semester_number?: number;
  academic_year?: string;
}

export default function Exams() {
  const { hasRole } = useAuth();
  const canManage = hasRole('SUPER_ADMIN', 'EXAM_OFFICER');
  const canDelete = hasRole('SUPER_ADMIN');
  // Edit opens the form with the Status field — that is the schedule
  // approval action, so the Examination Controller gets it too (the
  // backend PUT /:id guard admits the controller). Create stays
  // unchanged: the controller cannot create exams.
  const canApproveExam = hasRole('SUPER_ADMIN', 'EXAM_OFFICER', 'EXAM_CONTROLLER');
  // Lecturers can create examinations for their own subjects (the form
  // offers the quiz type among others). Edit stays staff-only.
  // NOTE: the backend still restricts POST /api/exams to super_admin /
  // exam_officer (MANAGE in backend/src/routes/exams.js), so a lecturer
  // submit currently 403s until the backend allows lecturers to create —
  // the form is reachable here, but creation is blocked server-side.
  const canCreateExam = canManage || hasRole('LECTURER');
  const [exams, setExams] = useState<Exam[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [academicYears, setAcademicYears] = useState<ReferenceOption[]>([]);
  const [semesters, setSemesters] = useState<ReferenceOption[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Exam | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Exam | null>(null);
  const [form, setForm] = useState({
    title: '', academicYearId: '', semesterId: '', examType: 'midterm',
    startDate: '', endDate: '', status: 'scheduled',
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await examsApi.list({ limit: 500 });
      setExams((data.data as unknown as Record<string, unknown>[]).map(normalizeExam));
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    referenceApi.get()
      .then(({ data }) => {
        const d = data.data as unknown as Record<string, Array<Record<string, unknown>>>;
        setAcademicYears((d.academic_years ?? []).map((r) => ({ id: Number(r.id), name: String(r.name) })));
        setSemesters((d.semesters ?? []).map((r) => ({
          id: Number(r.id),
          name: String(r.name),
          semester_number: Number(r.semester_number ?? 0),
          academic_year: String(r.academic_year ?? ''),
        })));
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({
      title: '', academicYearId: academicYears[0] ? String(academicYears[0].id) : '',
      semesterId: semesters[0] ? String(semesters[0].id) : '',
      examType: 'midterm', startDate: '', endDate: '', status: 'scheduled',
    });
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (exam: Exam) => {
    setEditing(exam);
    // academic_year_id / semester_id are not returned on the list rows in
    // a form-ready shape beyond semester (id); match the semester by its
    // displayed name where possible, otherwise leave the dropdowns blank
    // for the user to re-pick.
    const sem = semesters.find((s) => s.name === exam.semesterName);
    setForm({
      title: exam.title,
      academicYearId: '',
      semesterId: sem ? String(sem.id) : String(exam.semester || ''),
      examType: exam.examType ?? 'midterm',
      startDate: exam.startDate ?? '',
      endDate: exam.endDate ?? '',
      status: exam.status.toLowerCase(),
    });
    setFormError(null);
    setFormOpen(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.startDate || !form.endDate) {
      setFormError('Title, start date and end date are required.');
      return;
    }
    if (form.endDate < form.startDate) {
      setFormError('End date must be on or after the start date.');
      return;
    }
    if (!editing && (!form.academicYearId || !form.semesterId)) {
      setFormError('Choose an academic year and a semester.');
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await examsApi.update(editing.id, {
          title: form.title.trim(),
          exam_type: form.examType,
          start_date: form.startDate,
          end_date: form.endDate,
          status: form.status,
        } as unknown as Partial<Exam>);
        setNotice(`Exam "${form.title.trim()}" updated.`);
      } else {
        await examsApi.create({
          academic_year_id: Number(form.academicYearId),
          semester_id: Number(form.semesterId),
          title: form.title.trim(),
          exam_type: form.examType,
          start_date: form.startDate,
          end_date: form.endDate,
          status: 'scheduled',
        });
        setNotice(`Exam "${form.title.trim()}" scheduled.`);
      }
      setFormOpen(false);
      setEditing(null);
      await load();
    } catch (err) {
      setFormError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await examsApi.remove(deleteTarget.id);
      setNotice(`Exam "${deleteTarget.title}" deleted.`);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
      setDeleteTarget(null);
    } finally {
      setSaving(false);
    }
  };

  const columns: Column<Exam>[] = [
    { key: 'title', header: 'Exam', sortable: true, accessor: (r) => r.title },
    { key: 'examType', header: 'Type', sortable: true, accessor: (r) => r.examType ?? '—' },
    { key: 'dates', header: 'Dates', sortable: true, accessor: (r) => `${r.startDate ?? ''} – ${r.endDate ?? ''}` },
    { key: 'academicYear', header: 'Academic year', sortable: true, accessor: (r) => r.academicYear },
    { key: 'semester', header: 'Semester', sortable: true, accessor: (r) => r.semesterName ?? '—' },
    { key: 'published', header: 'Published', accessor: (r) => String(r.publishedResults ?? 0) },
    {
      key: 'status', header: 'Status', accessor: (r) => r.status,
      render: (r) => <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[r.status.toLowerCase()] ?? 'bg-slate-100'}`}>{r.status}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold">Examinations</h1>
          <p className="text-sm text-slate-500">Create exams for an academic year and semester. Subjects, rooms and times are scheduled per exam afterwards.{hasRole('LECTURER') ? ' Lecturers create exams (including quizzes) for their own subjects.' : ''}</p>
        </div>
        {canCreateExam && (
          <button onClick={openCreate} className="ml-auto rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-700">
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
        searchableKeys={[(r) => r.title, (r) => r.academicYear, (r) => r.semesterName ?? '']}
        filters={[
          { label: 'Scheduled', value: 'SCHEDULED', test: (r) => r.status === 'SCHEDULED' },
          { label: 'Completed', value: 'COMPLETED', test: (r) => r.status === 'COMPLETED' },
          { label: 'Draft', value: 'DRAFT', test: (r) => r.status === 'DRAFT' },
        ]}
        actions={(row) => (
          <span className="flex gap-3">
            <a href={`/marks/${row.id}`} className="text-navy-600 hover:underline">Marks →</a>
            {canApproveExam && <button onClick={() => openEdit(row)} className="text-navy-600 hover:underline">Edit</button>}
            {canDelete && <button onClick={() => setDeleteTarget(row)} className="text-red-600 hover:underline">Delete</button>}
          </span>
        )}
      />

      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={editing ? 'Edit exam' : 'Create exam'}>
          <form onSubmit={submit} className="w-full max-w-lg rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">{editing ? 'Edit examination' : 'Create examination'}</h2>
            {formError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium sm:col-span-2">Title
                <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Fall 2025 Final Examination" className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              {!editing && (
                <>
                  <label className="text-sm font-medium">Academic year
                    <select required value={form.academicYearId} onChange={(e) => setForm({ ...form, academicYearId: e.target.value })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:bg-slate-800">
                      <option value="">— Select —</option>
                      {academicYears.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}
                    </select>
                  </label>
                  <label className="text-sm font-medium">Semester
                    <select required value={form.semesterId} onChange={(e) => setForm({ ...form, semesterId: e.target.value })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:bg-slate-800">
                      <option value="">— Select —</option>
                      {semesters.map((s) => <option key={s.id} value={s.id}>{s.name}{s.academic_year ? ` (${s.academic_year})` : ''}</option>)}
                    </select>
                  </label>
                </>
              )}
              <label className="text-sm font-medium">Exam type
                <select value={form.examType} onChange={(e) => setForm({ ...form, examType: e.target.value })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:bg-slate-800">
                  {EXAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              {editing && (
                <label className="text-sm font-medium">Status
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:bg-slate-800">
                    {['draft', 'scheduled', 'ongoing', 'completed', 'cancelled'].map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
              )}
              <label className="text-sm font-medium">Start date
                <input required type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="text-sm font-medium">End date
                <input required type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => { setFormOpen(false); setEditing(null); }} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={saving} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Create exam'}
              </button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="alertdialog" aria-modal="true" aria-label="Confirm delete">
          <div className="w-full max-w-md rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">Delete this exam?</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              “{deleteTarget.title}” and its schedules will be removed. Marks and results linked to it are deleted with it.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>
              <button onClick={confirmDelete} disabled={saving} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
