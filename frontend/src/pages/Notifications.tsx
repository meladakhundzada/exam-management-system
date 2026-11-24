import { useEffect, useState } from 'react';
import DataTable, { Column } from '../components/DataTable';
import {
  reportsApi, studentsApi, NotificationItem, apiErrorMessage,
} from '../services/api';
import { useAuth } from '../context/AuthContext';

const inputCls = 'mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-600 dark:bg-slate-900';

const TYPE_LABELS: Record<NotificationItem['type'], string> = {
  info: 'Info',
  exam: 'Exam',
  result: 'Result',
  announcement: 'Announcement',
  alert: 'Alert',
};

const TYPE_BADGE: Record<NotificationItem['type'], string> = {
  info: 'bg-slate-100 text-slate-700',
  exam: 'bg-blue-100 text-blue-700',
  result: 'bg-emerald-100 text-emerald-700',
  announcement: 'bg-violet-100 text-violet-700',
  alert: 'bg-red-100 text-red-700',
};

type NotificationRow = Omit<NotificationItem, 'id'> & { id: string };

export default function Notifications() {
  const { hasRole } = useAuth();
  const isLecturer = hasRole('LECTURER');
  const canCreate = hasRole('SUPER_ADMIN', 'EXAM_OFFICER') || isLecturer;
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ title: '', message: '', type: 'announcement' as NotificationItem['type'] });
  const [studentId, setStudentId] = useState('');
  const [students, setStudents] = useState<Array<{ id: number; full_name: string; student_id: string }>>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await reportsApi.notifications();
      setItems((data.data as unknown as NotificationItem[]).map((n) => ({ ...n, id: String(n.id) })));
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Lecturers message one of their own students (the student list is
  // already scoped to the lecturer's students on the backend).
  useEffect(() => {
    if (!isLecturer) return;
    studentsApi.list({ limit: 500 })
      .then(({ data }) => setStudents(data.data as unknown as Array<{ id: number; full_name: string; student_id: string }>))
      .catch(() => setStudents([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLecturer]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.title.trim().length < 2) { setFormError('Title is required.'); return; }
    if (form.message.trim().length < 2) { setFormError('Message is required.'); return; }
    if (isLecturer && !studentId) { setFormError('Choose one of your students to message.'); return; }
    setSaving(true);
    try {
      if (isLecturer) {
        // One-to-one message to an assigned student (backend checks scope).
        await reportsApi.createNotification({
          title: form.title.trim(),
          message: form.message.trim(),
          type: form.type,
          student_id: Number(studentId),
        });
        const target = students.find((s) => String(s.id) === studentId);
        setNotice(`Message sent to ${target ? `${target.full_name} (${target.student_id})` : 'the student'}.`);
      } else {
        // Broadcast: no user_id / role_id — the backend returns it to
        // every authenticated user (see GET /api/reports/notifications).
        await reportsApi.createNotification({
          title: form.title.trim(),
          message: form.message.trim(),
          type: form.type,
        });
        setNotice(`Notification "${form.title.trim()}" sent to everyone.`);
      }
      setForm({ title: '', message: '', type: 'announcement' });
      setStudentId('');
      setFormError(null);
      await load();
    } catch (err) {
      setFormError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const columns: Column<NotificationRow>[] = [
    { key: 'title', header: 'Title', sortable: true, accessor: (r) => r.title },
    { key: 'message', header: 'Message', accessor: (r) => r.message },
    {
      key: 'type', header: 'Type', accessor: (r) => r.type,
      render: (r) => <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TYPE_BADGE[r.type]}`}>{TYPE_LABELS[r.type]}</span>,
    },
    { key: 'created', header: 'Sent', sortable: true, accessor: (r) => String(r.created_at).slice(0, 16).replace('T', ' ') },
    {
      key: 'read', header: 'Read', accessor: (r) => (r.is_read ? 'Yes' : 'No'),
      render: (r) => <span className="text-xs">{r.is_read ? '✓ Read' : 'Unread'}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Notifications &amp; Announcements</h1>
        <p className="text-sm text-slate-500">Notifications addressed to you, your role, or everyone. Staff can send a broadcast announcement below; lecturers can message one of their own students.</p>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      {canCreate && (
        <form onSubmit={submit} className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <h2 className="text-lg font-bold">{isLecturer ? 'Message a student' : 'Send an announcement'}</h2>
          {formError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <label className="text-sm font-medium">Title
              <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Final exam dates published" className={inputCls} />
            </label>
            <label className="text-sm font-medium">Type
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as NotificationItem['type'] })} className={inputCls}>
                {(Object.keys(TYPE_LABELS) as NotificationItem['type'][]).map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
              </select>
            </label>
            {isLecturer ? (
              <label className="text-sm font-medium">To student
                <select required value={studentId} onChange={(e) => setStudentId(e.target.value)} className={inputCls}>
                  <option value="">Choose one of your students…</option>
                  {students.map((s) => <option key={s.id} value={s.id}>{s.full_name} ({s.student_id})</option>)}
                </select>
              </label>
            ) : (
              <p className="self-end text-xs text-slate-500">Audience: everyone (broadcast). Per-user / per-role targeting is not offered in this form.</p>
            )}
            <label className="text-sm font-medium sm:col-span-3">Message
              <textarea required rows={3} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} placeholder="Write the announcement…" className={inputCls} />
            </label>
          </div>
          <div className="mt-4 flex justify-end">
            <button type="submit" disabled={saving} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {saving ? 'Sending…' : isLecturer ? 'Send to student' : 'Send to everyone'}
            </button>
          </div>
        </form>
      )}

      <DataTable<NotificationRow>
        columns={columns}
        data={items}
        loading={loading}
        emptyMessage="No notifications yet."
        searchableKeys={[(r) => r.title, (r) => r.message]}
        filters={[
          { label: 'Unread', value: 'unread', test: (r) => !r.is_read },
          { label: 'Announcements', value: 'announcement', test: (r) => r.type === 'announcement' },
          { label: 'Alerts', value: 'alert', test: (r) => r.type === 'alert' },
        ]}
      />
    </div>
  );
}
