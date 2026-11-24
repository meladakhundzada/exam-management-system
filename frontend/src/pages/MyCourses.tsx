import { useEffect, useState } from 'react';
import { studentsApi, apiErrorMessage } from '../services/api';
import { useAuth } from '../context/AuthContext';

export default function MyCourses() {
  const { user } = useAuth();
  const [courses, setCourses] = useState<Array<{
    id: number; status: string; subject_code: string; subject_title: string;
    credit_hours: number; semester_name: string; academic_year: string;
    lecturer_name?: string | null;
  }>>([]);
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
        const { data } = await studentsApi.enrollments(user.studentId);
        setCourses(data.data as unknown as typeof courses);
        setError(null);
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [user?.studentId]);

  if (loading) return <p className="p-4">Loading your courses…</p>;

  const totalCredits = courses.reduce((n, c) => n + Number(c.credit_hours || 0), 0);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">My Courses</h1>
        <p className="text-sm text-slate-500">
          The subjects you are enrolled in. {courses.length > 0 && `${courses.length} subject(s) · ${totalCredits} credit hours.`}
        </p>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {!error && courses.length === 0 && (
        <p className="rounded-xl bg-white p-6 text-center text-sm text-slate-500 shadow-card dark:bg-slate-800">
          You are not enrolled in any subjects yet — contact the Examination Office.
        </p>
      )}

      {courses.length > 0 && (
        <div className="overflow-x-auto rounded-xl bg-white shadow-card dark:bg-slate-800">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900">
              <tr>
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Subject</th>
                <th className="px-4 py-3">Credits</th>
                <th className="px-4 py-3">Lecturer</th>
                <th className="px-4 py-3">Semester</th>
                <th className="px-4 py-3">Academic year</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {courses.map((c) => (
                <tr key={c.id} className="border-t">
                  <td className="px-4 py-3 font-medium">{c.subject_code}</td>
                  <td className="px-4 py-3">{c.subject_title}</td>
                  <td className="px-4 py-3">{c.credit_hours}</td>
                  <td className="px-4 py-3">{c.lecturer_name ?? '—'}</td>
                  <td className="px-4 py-3">{c.semester_name}</td>
                  <td className="px-4 py-3">{c.academic_year}</td>
                  <td className="px-4 py-3 text-xs capitalize">{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
