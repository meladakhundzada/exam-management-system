import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import DataTable, { Column } from '../components/DataTable';
import {
  studentsApi, departmentsApi, Department, Student,
  CreateStudentPayload, UpdateStudentPayload,
  apiErrorMessage, downloadBlob,
} from '../services/api';
import { useAuth } from '../context/AuthContext';
import { nextStudentId } from '../utils/studentId';

const STATUS_BADGE: Record<Student['status'], string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  SUSPENDED: 'bg-amber-100 text-amber-700',
  GRADUATED: 'bg-blue-100 text-blue-700',
  WITHDRAWN: 'bg-red-100 text-red-700',
};

// Backend status values (lowercase) -> display values (uppercase).
const toDisplayStatus = (s: string): Student['status'] => {
  switch ((s ?? '').toLowerCase()) {
    case 'suspended': return 'SUSPENDED';
    case 'graduated': return 'GRADUATED';
    case 'dropped': return 'WITHDRAWN';
    default: return 'ACTIVE';
  }
};

const toBackendStatus = (s: Student['status']): UpdateStudentPayload['status'] => {
  switch (s) {
    case 'SUSPENDED': return 'suspended';
    case 'GRADUATED': return 'graduated';
    case 'WITHDRAWN': return 'dropped';
    default: return 'active';
  }
};

// The backend returns snake_case rows (pg); map them to the camelCase
// shape this page renders. Without this the table showed empty cells.
type StudentRow = Record<string, unknown>;
const mapStudent = (r: StudentRow): Student => {
  const admissionYear = Number(r.admission_year ?? new Date().getFullYear());
  return {
    id: String(r.id),
    studentNo: String(r.student_id ?? ''),
    fullName: String(r.full_name ?? ''),
    email: String(r.email ?? ''),
    phone: (r.phone as string | undefined) ?? undefined,
    departmentId: String(r.department_id ?? ''),
    departmentName: String(r.department_name ?? ''),
    facultyName: String(r.faculty_name ?? ''),
    academicYear: `${admissionYear}-${admissionYear + 1}`,
    admissionYear,
    gender: (r.gender as string | undefined) ?? undefined,
    semester: Number(r.current_semester ?? 1),
    status: toDisplayStatus(String(r.status ?? 'active')),
    enrollmentDate: String(r.created_at ?? ''),
  };
};

const CURRENT_YEAR = new Date().getFullYear();

interface FormState {
  studentNo: string;
  fullName: string;
  email: string;
  phone: string;
  departmentId: string;
  admissionYear: number;
  semester: number;
  gender: '' | 'male' | 'female' | 'other';
  password: string;
}

const emptyForm = (studentNo: string): FormState => ({
  studentNo,
  fullName: '',
  email: '',
  phone: '',
  departmentId: '',
  admissionYear: CURRENT_YEAR,
  semester: 1,
  gender: '',
  password: '',
});

export default function Students() {
  const { hasRole, user } = useAuth();
  const canManage = hasRole('SUPER_ADMIN', 'EXAM_OFFICER');
  // Lecturers are read-only here (Add / Edit / Delete are canManage-gated
  // below) and see only students in their own department: GET /api/students
  // allows lecturers but the backend returns every student with no
  // per-subject scoping, and there is no enrollments-by-subject endpoint
  // to scope it exactly (see report). Department is the closest
  // server-supported scoping available from the frontend.
  const isLecturer = hasRole('LECTURER');
  const [students, setStudents] = useState<Student[]>([]);
  const [studentsLoaded, setStudentsLoaded] = useState(false);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Student | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Student | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm(`STU-${CURRENT_YEAR}-001`));
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Next auto student number from the loaded list (null = list unavailable,
  // so the helper falls back to a timestamp suffix).
  const nextId = (list: Student[] | null) =>
    nextStudentId(list ? list.map((s) => s.studentNo) : null, CURRENT_YEAR);

  const load = async (): Promise<Student[]> => {
    setLoading(true);
    try {
      const { data } = await studentsApi.list({ limit: 500 });
      let rows = (data.data as unknown as StudentRow[]).map(mapStudent);
      if (isLecturer && user?.departmentId) {
        rows = rows.filter((s) => s.departmentId === user.departmentId);
      }
      setStudents(rows);
      setStudentsLoaded(true);
      setError(null);
      return rows;
    } catch (err) {
      setError(apiErrorMessage(err));
      setStudentsLoaded(false);
      return [];
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    departmentsApi.list()
      .then(({ data }) => setDepartments(data.data))
      .catch(() => setDepartments([]));
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  const openCreate = () => {
    setEditing(null);
    // Auto-generate the next student number — the user never types it.
    setForm(emptyForm(nextId(studentsLoaded ? students : null)));
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (s: Student) => {
    setEditing(s);
    setForm({
      studentNo: s.studentNo,
      fullName: s.fullName,
      email: s.email,
      phone: s.phone ?? '',
      departmentId: s.departmentId,
      admissionYear: s.admissionYear,
      semester: s.semester,
      gender: (s.gender as FormState['gender']) ?? '',
      password: '',
    });
    setFormError(null);
    setFormOpen(true);
  };

  const validate = () => {
    if (!/^[A-Za-z0-9-]{4,20}$/.test(form.studentNo)) return 'Student number could not be generated — please reload the page and try again.';
    if (form.fullName.trim().length < 3) return 'Full name is required (at least 3 characters).';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return 'Enter a valid email address.';
    if (!form.departmentId) return 'Choose a department.';
    if (form.admissionYear < 2000 || form.admissionYear > 2100) return 'Admission year must be between 2000 and 2100.';
    if (form.semester < 1 || form.semester > 8) return 'Semester must be between 1 and 8.';
    if (!editing && form.password.length < 8) return 'Password must be at least 8 characters (the student signs in with it).';
    return null;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = validate();
    if (v) { setFormError(v); return; }
    setSaving(true);
    try {
      if (editing) {
        // PUT requires the full validated set (student_id included).
        const payload: UpdateStudentPayload = {
          student_id: form.studentNo,
          full_name: form.fullName.trim(),
          email: form.email.trim().toLowerCase(),
          phone: form.phone || undefined,
          department_id: Number(form.departmentId),
          admission_year: form.admissionYear,
          current_semester: form.semester,
          gender: form.gender || undefined,
          status: toBackendStatus(editing.status),
        };
        await studentsApi.update(editing.id, payload);
        setNotice(`Student ${form.studentNo} updated.`);
      } else {
        const payload: CreateStudentPayload = {
          student_id: form.studentNo,
          full_name: form.fullName.trim(),
          email: form.email.trim().toLowerCase(),
          phone: form.phone || undefined,
          department_id: Number(form.departmentId),
          admission_year: form.admissionYear,
          current_semester: form.semester,
          gender: form.gender || undefined,
          password: form.password,
        };
        await studentsApi.create(payload);
        setNotice(`Student ${form.studentNo} registered.`);
      }
      setFormOpen(false);
      // Reload, then reset the form with the NEXT auto number so the
      // following registration continues the sequence.
      const rows = await load();
      setForm(emptyForm(nextId(rows)));
    } catch (err) {
      setFormError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await studentsApi.remove(deleteTarget.id);
      setNotice(`Student ${deleteTarget.studentNo} deleted.`);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
      setDeleteTarget(null);
    }
  };

  const exportCsv = async () => {
    try {
      const res = await studentsApi.exportCsv();
      downloadBlob(res.data, 'students.xlsx');
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const columns: Column<Student>[] = [
    { key: 'studentNo', header: 'Student No.', sortable: true, accessor: (r) => r.studentNo },
    { key: 'fullName', header: 'Name', sortable: true, accessor: (r) => r.fullName },
    { key: 'email', header: 'Email', accessor: (r) => r.email },
    { key: 'departmentName', header: 'Department', sortable: true, accessor: (r) => r.departmentName },
    { key: 'semester', header: 'Semester', sortable: true, accessor: (r) => r.semester },
    {
      key: 'status', header: 'Status', accessor: (r) => r.status,
      render: (r) => <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[r.status]}`}>{r.status}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold">Students</h1>
          <p className="text-sm text-slate-500">{isLecturer ? 'Students in your department (read-only). For the students enrolled in one of your subjects, use Marks Entry for that subject.' : 'Register and manage students. Student numbers are generated automatically and emails must be unique.'}</p>
        </div>
        <div className="ml-auto flex gap-2">
          {canManage && (
            <button onClick={exportCsv} className="rounded-lg border bg-white px-3 py-2 text-sm dark:bg-slate-800">Export CSV</button>
          )}
          {canManage && (
            <button onClick={openCreate} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-700">+ Add Student</button>
          )}
        </div>
      </div>

      {isLecturer && (
        <div role="status" className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:bg-blue-900/30 dark:text-blue-200">
          Lecturer view: showing students in your department only.
        </div>
      )}

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      <DataTable<Student>
        columns={columns}
        data={students}
        loading={loading}
        searchableKeys={[(r) => r.fullName, (r) => r.studentNo, (r) => r.email]}
        filters={[
          { label: 'Active', value: 'ACTIVE', test: (r) => r.status === 'ACTIVE' },
          { label: 'Suspended', value: 'SUSPENDED', test: (r) => r.status === 'SUSPENDED' },
          { label: 'Graduated', value: 'GRADUATED', test: (r) => r.status === 'GRADUATED' },
        ]}
        actions={canManage ? (row) => (
          <span className="flex gap-2">
            <button onClick={() => openEdit(row)} className="text-navy-600 hover:underline">Edit</button>
            <button onClick={() => setDeleteTarget(row)} className="text-red-600 hover:underline">Delete</button>
          </span>
        ) : undefined}
      />

      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Student form">
          <form onSubmit={submit} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">{editing ? 'Edit student' : 'Register student'}</h2>
            {formError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium">Student No. (auto-generated)
                <input readOnly value={form.studentNo} title="Generated automatically — you do not need to type it" className="mt-1 w-full rounded-lg border bg-slate-50 px-3 py-2 dark:bg-slate-900" />
              </label>
              <label className="text-sm font-medium">Full name
                <input required value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="text-sm font-medium">Email
                <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="text-sm font-medium">Phone
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="text-sm font-medium">Department
                <select required value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2">
                  <option value="">Choose a department…</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.code})</option>)}
                </select>
              </label>
              {!departments.length && (
                <p className="text-xs text-amber-700 sm:col-span-2">
                  No departments exist yet — <Link to="/departments" className="font-medium text-navy-600 hover:underline">create one on the Departments page</Link> first.
                </p>
              )}
              <label className="text-sm font-medium">Admission year
                <input required type="number" min={2000} max={2100} value={form.admissionYear} onChange={(e) => setForm({ ...form, admissionYear: Number(e.target.value) })} className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="text-sm font-medium">Semester (1–8)
                <input required type="number" min={1} max={8} value={form.semester} onChange={(e) => setForm({ ...form, semester: Number(e.target.value) })} className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="text-sm font-medium">Gender
                <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value as FormState['gender'] })} className="mt-1 w-full rounded-lg border px-3 py-2">
                  <option value="">Not specified</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="other">Other</option>
                </select>
              </label>
              {!editing && (
                <label className="text-sm font-medium">Password (at least 8 characters)
                  <input required type="password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" className="mt-1 w-full rounded-lg border px-3 py-2" />
                </label>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setFormOpen(false)} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={saving} className="rounded-lg bg-navy-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Register'}
              </button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="alertdialog" aria-modal="true" aria-label="Confirm delete">
          <div className="w-full max-w-md rounded-xl bg-white p-6 dark:bg-slate-800">
            <h2 className="text-lg font-bold">Delete student?</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              This deletes {deleteTarget.fullName} ({deleteTarget.studentNo}) and their enrolments.
              Marks and results already published are kept in the audit log but the student record is removed. This cannot be undone.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>
              <button onClick={confirmDelete} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
