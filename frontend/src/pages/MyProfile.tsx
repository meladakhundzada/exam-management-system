import { useEffect, useState } from 'react';
import { studentsApi, apiErrorMessage } from '../services/api';
import { useAuth } from '../context/AuthContext';

// GET /api/students/:id returns the snake_case student row plus
// department/faculty names and cgpa (published results only).
interface ProfileRow {
  student_id: string;
  full_name: string;
  email: string;
  phone?: string | null;
  gender?: string | null;
  date_of_birth?: string | null;
  address?: string | null;
  guardian_name?: string | null;
  guardian_phone?: string | null;
  department_name?: string;
  faculty_name?: string;
  admission_year: number;
  current_semester: number;
  status: string;
  cgpa?: number | null;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-slate-100 py-3 last:border-0 dark:border-slate-700">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 font-medium">{value}</p>
    </div>
  );
}

export default function MyProfile() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if (!user?.studentId) {
        setError('No student profile is linked to your account. Contact the Examination Office.');
        setLoading(false);
        return;
      }
      try {
        const { data } = await studentsApi.get(user.studentId);
        setProfile(data.data as unknown as ProfileRow);
        setError(null);
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [user?.studentId]);

  if (loading) return <p className="p-4">Loading profile…</p>;
  if (error || !profile) {
    return (
      <div role="alert" className="rounded-xl bg-red-50 p-6 text-red-700 dark:bg-red-900/30 dark:text-red-300">
        Could not load your profile: {error ?? 'No data returned.'}
      </div>
    );
  }

  const fmtDate = (d?: string | null) => (d ? String(d).slice(0, 10) : '—');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">My Profile</h1>
        <p className="text-sm text-slate-500">Your personal information as recorded by the Examination Department.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <section className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <h2 className="font-bold">{profile.full_name}</h2>
          <p className="text-sm text-slate-500">{profile.student_id} · {profile.status}</p>
          <div className="mt-4">
            <Field label="Student ID" value={profile.student_id} />
            <Field label="Email" value={profile.email} />
            <Field label="Phone" value={profile.phone ?? '—'} />
            <Field label="Gender" value={profile.gender ?? '—'} />
            <Field label="Date of birth" value={fmtDate(profile.date_of_birth)} />
            <Field label="Address" value={profile.address ?? '—'} />
          </div>
        </section>

        <section className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <h2 className="font-bold">Academic information</h2>
          <div className="mt-4">
            <Field label="Department" value={profile.department_name ?? '—'} />
            <Field label="Faculty" value={profile.faculty_name ?? '—'} />
            <Field label="Admission year" value={String(profile.admission_year)} />
            <Field label="Current semester" value={String(profile.current_semester)} />
            <Field label="Status" value={profile.status} />
          </div>
        </section>

        <section className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800">
          <h2 className="font-bold">Guardian</h2>
          <div className="mt-4">
            <Field label="Guardian name" value={profile.guardian_name ?? '—'} />
            <Field label="Guardian phone" value={profile.guardian_phone ?? '—'} />
          </div>
          <div className="mt-6 rounded-lg bg-slate-50 p-4 dark:bg-slate-900">
            <p className="text-sm text-slate-500">CGPA (published results)</p>
            <p className="text-3xl font-bold">{profile.cgpa != null ? Number(profile.cgpa).toFixed(2) : '—'}</p>
          </div>
          <p className="mt-4 text-sm text-slate-500">
            If any detail is wrong, contact the Examination Office — students cannot edit their own profile.
          </p>
        </section>
      </div>
    </div>
  );
}
