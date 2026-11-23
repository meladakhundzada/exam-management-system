import { useEffect, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import StatCard from '../components/StatCard';
import { dashboardApi, DashboardStats, ActivityItem, apiErrorMessage } from '../services/api';
import { useAuth } from '../context/AuthContext';

const STATUS_COLORS: Record<string, string> = {
  DRAFT: '#94a3b8', SCHEDULED: '#3b82f6', ONGOING: '#f59e0b',
  COMPLETED: '#10b981', CANCELLED: '#ef4444',
};

export default function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, a] = await Promise.all([dashboardApi.stats(), dashboardApi.recentActivity()]);
        if (!cancelled) { setStats(s.data.data); setActivity(a.data.data); }
      } catch (err) {
        if (!cancelled) setError(apiErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <p className="p-4">Loading dashboard…</p>;
  if (error || !stats) {
    return (
      <div role="alert" className="rounded-xl bg-red-50 p-6 text-red-700 dark:bg-red-900/30 dark:text-red-300">
        Could not load the dashboard: {error ?? 'No data returned.'}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Welcome back, {user?.fullName}</h1>
        <p className="text-sm text-slate-500">Overview of examinations, results and pending work.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Total Students" value={stats.totalStudents} icon="🎓" accent="blue" subtitle="Active enrolments" />
        <StatCard title="Total Lecturers" value={stats.totalLecturers} icon="👩‍🏫" accent="violet" subtitle="Across all departments" />
        <StatCard title="Total Departments" value={stats.totalDepartments} icon="🏛️" accent="green" subtitle="Faculties & departments" />
        <StatCard title="Total Subjects" value={stats.totalSubjects} icon="📚" accent="amber" subtitle="Current semester" />
        <StatCard title="Upcoming Exams" value={stats.upcomingExams} icon="🗓️" accent="blue" subtitle="Scheduled, not yet held" />
        <StatCard title="Completed Exams" value={stats.completedExams} icon="✅" accent="green" subtitle="This academic year" />
        <StatCard title="Published Results" value={stats.publishedResults} icon="📊" accent="violet" subtitle="Visible to students" />
        <StatCard title="Pending Marks" value={stats.pendingMarks} icon="⏳" accent="red" subtitle="Awaiting lecturer submission" trend={{ label: 'Action needed', positive: false }} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800" aria-label="Exams per month">
          <h2 className="font-semibold">Exams per month</h2>
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.monthlyExams}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" /><YAxis allowDecimals={false} />
                <Tooltip /><Legend />
                <Bar dataKey="scheduled" fill="#3b82f6" name="Scheduled" />
                <Bar dataKey="completed" fill="#10b981" name="Completed" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800" aria-label="Exams by status">
          <h2 className="font-semibold">Exams by status</h2>
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={stats.examsByStatus} dataKey="count" nameKey="status" outerRadius={90} label>
                  {stats.examsByStatus.map((e) => (
                    <Cell key={e.status} fill={STATUS_COLORS[e.status] ?? '#94a3b8'} />
                  ))}
                </Pie>
                <Tooltip /><Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <section className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800" aria-label="Department performance">
        <h2 className="font-semibold">Department performance — average GPA &amp; pass rate</h2>
        <div className="mt-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={stats.resultsByDepartment}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="department" /><YAxis domain={[0, 4]} />
              <Tooltip /><Legend />
              <Line type="monotone" dataKey="averageGpa" stroke="#1d4ed8" name="Average GPA" />
              <Line type="monotone" dataKey="passRate" stroke="#10b981" name="Pass rate (%)" />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          GPA is calculated from the configurable grade scale (Settings → Grade Scale). Pass rate = students with grade ≥ D.
        </p>
      </section>

      <section className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800" aria-label="Recent activity">
        <h2 className="font-semibold">Recent activity</h2>
        {activity.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No recent activity.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-700">
            {activity.map((item) => (
              <li key={item.id} className="flex justify-between gap-4 py-2 text-sm">
                <span><strong>{item.actorName}</strong> {item.action} — {item.entity}</span>
                <time className="shrink-0 text-xs text-slate-500">{new Date(item.createdAt).toLocaleString()}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
