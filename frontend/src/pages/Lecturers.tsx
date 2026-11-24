import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import DataTable, { Column } from '../components/DataTable';
import { lecturersApi, Lecturer, apiErrorMessage } from '../services/api';

type LecturerRow = Omit<Lecturer, 'id'> & { id: string; lecturerId: number };

const mapLecturer = (r: Lecturer): LecturerRow => ({ ...r, id: String(r.id), lecturerId: r.id });

export default function Lecturers() {
  const [lecturers, setLecturers] = useState<LecturerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Detail panel: assigned subjects for the selected lecturer.
  const [selected, setSelected] = useState<LecturerRow | null>(null);
  const [selectedSubjects, setSelectedSubjects] = useState<Lecturer['subjects']>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await lecturersApi.list({ limit: 500 });
      setLecturers((data.data as unknown as Lecturer[]).map(mapLecturer));
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const showSubjects = async (row: LecturerRow) => {
    setSelected(row);
    setDetailLoading(true);
    setDetailError(null);
    try {
      const { data } = await lecturersApi.get(row.lecturerId);
      setSelectedSubjects((data.data as unknown as Lecturer).subjects ?? []);
    } catch (err) {
      setDetailError(apiErrorMessage(err));
      setSelectedSubjects([]);
    } finally {
      setDetailLoading(false);
    }
  };

  const columns: Column<LecturerRow>[] = [
    { key: 'employeeId', header: 'Employee ID', sortable: true, accessor: (r) => r.employee_id },
    { key: 'fullName', header: 'Name', sortable: true, accessor: (r) => r.full_name },
    { key: 'email', header: 'Email', accessor: (r) => r.email },
    { key: 'department', header: 'Department', sortable: true, accessor: (r) => r.department_name ?? '—' },
    { key: 'designation', header: 'Designation', accessor: (r) => r.designation ?? '—' },
    { key: 'qualification', header: 'Qualification', accessor: (r) => r.qualification ?? '—' },
    {
      key: 'status', header: 'Status', accessor: (r) => (r.is_active === false ? 'Inactive' : 'Active'),
      render: (r) => (
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.is_active === false ? 'bg-slate-100 text-slate-600' : 'bg-emerald-100 text-emerald-700'}`}>
          {r.is_active === false ? 'Inactive' : 'Active'}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold">Lecturers</h1>
          <p className="text-sm text-slate-500">
            Read-only list with each lecturer&apos;s assigned subjects. Lecturers are created
            together with their login account on the{' '}
            <Link to="/users" className="font-medium text-navy-600 hover:underline">User Management</Link>{' '}
            page (role Lecturer) — there is no separate create form here.
          </p>
        </div>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <DataTable<LecturerRow>
        columns={columns}
        data={lecturers}
        loading={loading}
        emptyMessage="No lecturers yet — create one on the User Management page."
        searchableKeys={[(r) => r.full_name, (r) => r.employee_id, (r) => r.email]}
        actions={(row) => (
          <button onClick={() => showSubjects(row)} className="text-navy-600 hover:underline">
            {selected?.lecturerId === row.lecturerId ? 'Hide subjects' : 'View subjects'}
          </button>
        )}
      />

      {selected && (
        <div className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold">Assigned subjects — {selected.full_name}</h2>
            <button onClick={() => setSelected(null)} className="ml-auto text-sm text-slate-500 hover:underline">Close</button>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {selected.employee_id} · {selected.department_name ?? '—'} · {selected.email}
          </p>
          {detailError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{detailError}</p>}
          {detailLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : selectedSubjects && selectedSubjects.length > 0 ? (
            <table className="mt-3 w-full min-w-[480px] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900">
                <tr><th className="px-4 py-2">Code</th><th className="px-4 py-2">Title</th><th className="px-4 py-2">Credit hours</th></tr>
              </thead>
              <tbody>
                {selectedSubjects.map((s) => (
                  <tr key={s.id} className="border-t">
                    <td className="px-4 py-2">{s.code}</td>
                    <td className="px-4 py-2">{s.title}</td>
                    <td className="px-4 py-2">{s.credit_hours}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-3 text-sm text-slate-500">No subjects assigned to this lecturer yet — assign one on the Subjects page.</p>
          )}
        </div>
      )}
    </div>
  );
}
