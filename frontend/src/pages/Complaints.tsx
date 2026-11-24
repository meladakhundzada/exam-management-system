import { useEffect, useState } from 'react';
import DataTable, { Column } from '../components/DataTable';
import {
  complaintsApi, examsApi, subjectsApi,
  Complaint, ComplaintType, ComplaintStatus, apiErrorMessage,
} from '../services/api';
import { useAuth } from '../context/AuthContext';

const inputCls = 'mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900';

const TYPE_LABELS: Record<ComplaintType, string> = {
  rechecking: 'Rechecking',
  marks_correction: 'Marks correction',
  absent_marked: 'Marked absent',
  other: 'Other',
};

const STATUS_BADGE: Record<ComplaintStatus, string> = {
  pending: 'bg-amber-100 text-amber-700',
  under_review: 'bg-blue-100 text-blue-700',
  resolved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
};

type ComplaintRow = Omit<Complaint, 'id'> & { id: string };

export default function Complaints() {
  const { user, hasRole } = useAuth();
  const isStudent = hasRole('STUDENT');
  const isStaff = hasRole('SUPER_ADMIN', 'EXAM_OFFICER');
  // Lecturers can open this page (route + sidebar) but there is no
  // lecturer complaint endpoint on the backend: the review queue
  // (GET /results/complaints/list) is exam_officer / super_admin only and
  // GET /students/:id/complaints is student / staff only, so calling either
  // would 403. Lecturers therefore see an explanatory note, not an empty
  // queue or an error; a lecturer review queue needs a backend change.
  const isLecturer = hasRole('LECTURER');
  const [complaints, setComplaints] = useState<ComplaintRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  // Student filing form. The backend files a complaint under a numeric
  // student record id (POST /api/students/:id/complaints); the login
  // response does not carry it, so it is prefilled when known and
  // otherwise entered by the student.
  const [myStudentId, setMyStudentId] = useState(user?.studentId ?? '');
  const [exams, setExams] = useState<Array<{ id: number; title: string }>>([]);
  const [subjects, setSubjects] = useState<Array<{ id: number; code: string; title: string }>>([]);
  const [form, setForm] = useState({ type: 'rechecking' as ComplaintType, examId: '', subjectId: '', description: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const [filing, setFiling] = useState(false);
  // Officer review.
  const [reviewTarget, setReviewTarget] = useState<ComplaintRow | null>(null);
  const [reviewForm, setReviewForm] = useState({ status: 'under_review' as ComplaintStatus, resolution: '' });
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);

  const load = async (status = statusFilter) => {
    setLoading(true);
    try {
      if (isStaff) {
        const { data } = await complaintsApi.reviewList(status || undefined);
        setComplaints((data.data as unknown as Complaint[]).map((c) => ({ ...c, id: String(c.id) })));
      } else if (myStudentId) {
        const { data } = await complaintsApi.forStudent(Number(myStudentId));
        setComplaints((data.data as unknown as Complaint[]).map((c) => ({ ...c, id: String(c.id) })));
      } else {
        setComplaints([]);
      }
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    examsApi.list({ limit: 500 })
      .then(({ data }) => setExams(data.data as unknown as Array<{ id: number; title: string }>))
      .catch(() => setExams([]));
    subjectsApi.list({ limit: 500 })
      .then(({ data }) => setSubjects(data.data as unknown as Array<{ id: number; code: string; title: string }>))
      .catch(() => setSubjects([]));
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  const fileComplaint = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!myStudentId || Number.isNaN(Number(myStudentId))) {
      setFormError('Enter your numeric student record ID (ask the Exam Officer if you do not know it).');
      return;
    }
    if (form.description.trim().length < 10) {
      setFormError('Describe the complaint in at least 10 characters.');
      return;
    }
    setFiling(true);
    try {
      await complaintsApi.file(Number(myStudentId), {
        type: form.type,
        description: form.description.trim(),
        exam_id: form.examId ? Number(form.examId) : undefined,
        subject_id: form.subjectId ? Number(form.subjectId) : undefined,
      });
      setNotice('Complaint filed. The Examination Office will review it.');
      setForm({ type: 'rechecking', examId: '', subjectId: '', description: '' });
      setFormError(null);
      await load();
    } catch (err) {
      setFormError(apiErrorMessage(err));
    } finally {
      setFiling(false);
    }
  };

  const openReview = (c: ComplaintRow) => {
    setReviewTarget(c);
    setReviewForm({ status: c.status === 'pending' ? 'under_review' : c.status, resolution: c.resolution ?? '' });
    setReviewError(null);
  };

  const submitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reviewTarget) return;
    setReviewing(true);
    try {
      await complaintsApi.review(reviewTarget.id ? Number(reviewTarget.id) : 0, {
        status: reviewForm.status,
        resolution: reviewForm.resolution.trim() || undefined,
      });
      setNotice(`Complaint #${reviewTarget.id} marked ${reviewForm.status.replace('_', ' ')}.`);
      setReviewTarget(null);
      await load();
    } catch (err) {
      setReviewError(apiErrorMessage(err));
    } finally {
      setReviewing(false);
    }
  };

  const columns: Column<ComplaintRow>[] = [
    { key: 'id', header: '#', sortable: true, accessor: (r) => Number(r.id) },
    { key: 'student', header: 'Student', sortable: true, accessor: (r) => r.student_name ?? String(r.student_id) },
    { key: 'type', header: 'Type', accessor: (r) => TYPE_LABELS[r.type] ?? r.type },
    { key: 'exam', header: 'Exam / Subject', accessor: (r) => `${r.exam_title ?? '—'} / ${r.subject_code ?? '—'}` },
    { key: 'description', header: 'Description', accessor: (r) => r.description },
    {
      key: 'status', header: 'Status', accessor: (r) => r.status,
      render: (r) => <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[r.status]}`}>{r.status.replace('_', ' ')}</span>,
    },
    { key: 'created', header: 'Filed', sortable: true, accessor: (r) => String(r.created_at).slice(0, 10) },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Complaints &amp; Rechecking</h1>
        <p className="text-sm text-slate-500">
          {isStudent
            ? 'File a rechecking or marks complaint about your results, and track its status here.'
            : 'Review student complaints: change the status and record the resolution.'}
        </p>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      {isLecturer && (
        <div role="status" className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:bg-blue-900/30 dark:text-blue-200">
          Lecturer view: complaints about your subjects (for example rechecking requests on marks you entered) are reviewed by the Examination Office — there is no lecturer review queue yet, so no complaints are listed here.
        </div>
      )}

      {isStudent && (
        <form onSubmit={fileComplaint} className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <h2 className="text-lg font-bold">File a complaint</h2>
          {formError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium">Your student record ID
              <input required inputMode="numeric" value={myStudentId} onChange={(e) => setMyStudentId(e.target.value)} placeholder="e.g. 1" className={inputCls} />
            </label>
            <label className="text-sm font-medium">Type
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ComplaintType })} className={inputCls}>
                {(Object.keys(TYPE_LABELS) as ComplaintType[]).map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
              </select>
            </label>
            <label className="text-sm font-medium">Examination (optional)
              <select value={form.examId} onChange={(e) => setForm({ ...form, examId: e.target.value })} className={inputCls}>
                <option value="">Not specific to one exam</option>
                {exams.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
              </select>
            </label>
            <label className="text-sm font-medium">Subject (optional)
              <select value={form.subjectId} onChange={(e) => setForm({ ...form, subjectId: e.target.value })} className={inputCls}>
                <option value="">Not specific to one subject</option>
                {subjects.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.title}</option>)}
              </select>
            </label>
            <label className="text-sm font-medium sm:col-span-2">Description
              <textarea required rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Explain what is wrong and what you are asking for…" className={inputCls} />
            </label>
          </div>
          <div className="mt-4 flex justify-end">
            <button type="submit" disabled={filing} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {filing ? 'Filing…' : 'File complaint'}
            </button>
          </div>
        </form>
      )}

      {isStaff && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm font-medium">Status
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); load(e.target.value); }}
              className="ml-2 rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900"
            >
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="under_review">Under review</option>
              <option value="resolved">Resolved</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>
          <button onClick={() => load()} className="rounded-lg border bg-white px-3 py-2 text-sm dark:bg-slate-800">Refresh</button>
        </div>
      )}

      {isStudent && myStudentId && (
        <div className="flex gap-2">
          <button onClick={() => load()} className="rounded-lg border bg-white px-3 py-2 text-sm dark:bg-slate-800">Refresh my complaints</button>
        </div>
      )}

      <DataTable<ComplaintRow>
        columns={columns}
        data={complaints}
        loading={loading}
        emptyMessage={isLecturer ? 'No complaints are shown for lecturers yet — see the note above.' : isStudent ? 'You have not filed any complaints yet.' : 'No complaints found.'}
        searchableKeys={[(r) => r.description, (r) => r.student_name ?? '', (r) => r.subject_code ?? '']}
        actions={isStaff ? (row) => (
          <span className="flex flex-col gap-1">
            <button onClick={() => openReview(row)} className="text-left text-navy-600 hover:underline">Review</button>
            {row.resolution && <span className="text-xs text-slate-500" title={row.resolution}>Resolution: {row.resolution.slice(0, 40)}{row.resolution.length > 40 ? '…' : ''}</span>}
          </span>
        ) : undefined}
      />

      {reviewTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Review complaint">
          <form onSubmit={submitReview} className="w-full max-w-lg rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">Review complaint #{reviewTarget.id}</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              {reviewTarget.student_name ?? `Student ${reviewTarget.student_id}`} · {TYPE_LABELS[reviewTarget.type] ?? reviewTarget.type}
            </p>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{reviewTarget.description}</p>
            {reviewError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{reviewError}</p>}
            <div className="mt-4 grid grid-cols-1 gap-4">
              <label className="text-sm font-medium">Status
                <select value={reviewForm.status} onChange={(e) => setReviewForm({ ...reviewForm, status: e.target.value as ComplaintStatus })} className={inputCls}>
                  <option value="pending">Pending</option>
                  <option value="under_review">Under review</option>
                  <option value="resolved">Resolved</option>
                  <option value="rejected">Rejected</option>
                </select>
              </label>
              <label className="text-sm font-medium">Resolution (optional)
                <textarea rows={3} value={reviewForm.resolution} onChange={(e) => setReviewForm({ ...reviewForm, resolution: e.target.value })} placeholder="What was decided / done…" className={inputCls} />
              </label>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setReviewTarget(null)} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={reviewing} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {reviewing ? 'Saving…' : 'Save review'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
