import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import StatCard from '../components/StatCard';
import { dashboardApi, DashboardStats, StudentDashboardStats, ActivityItem, apiErrorMessage, studentsApi, lecturersApi, subjectsApi } from '../services/api';
import { useAuth } from '../context/AuthContext';

const STATUS_COLORS: Record<string, string> = {
  DRAFT: '#94a3b8', SCHEDULED: '#3b82f6', ONGOING: '#f59e0b',
  COMPLETED: '#10b981', CANCELLED: '#ef4444',
};

export default function Dashboard() {
  const { user, hasRole } = useAuth();
  // GET /api/dashboard/stats is role-scoped on the backend: a lecturer's
  // counts cover only their own subjects (students enrolled in them,
  // their subjects/departments, exams with their subjects, their marks),
  // with Total Lecturers = 1 for themselves. A student's stats are
  // personal only — the backend returns NO system-wide totals for
  // students, and this page renders only personal cards for them (no
  // system cards, no charts). Activity is already own-only for
  // non-admins (backend privacy rule).
  const isLecturer = hasRole('LECTURER');
  const isStudent = hasRole('STUDENT');
  const isController = hasRole('EXAM_CONTROLLER');
  const isDeptHead = hasRole('DEPARTMENT_HEAD');
  const isInvigilator = hasRole('INVIGILATOR');
  // Least privilege: GET /api/dashboard/stats currently returns
  // SYSTEM-WIDE totals for any role the backend does not scope
  // (dashboard.js scopedIds() only handles lecturer/student), so the
  // Department Head and Invigilator must not even request it — their
  // sections below load only their own scope, and the backend worker
  // still has to scope the endpoint before these roles may call it.
  // The Examination Controller monitors the whole system, so the
  // system-wide stats are the correct scope for that role.
  const needsStats = !isDeptHead && !isInvigilator;
  const [stats, setStats] = useState<DashboardStats | StudentDashboardStats | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, a] = await Promise.all([
          needsStats ? dashboardApi.stats() : Promise.resolve(null),
          dashboardApi.recentActivity(),
        ]);
        if (!cancelled) { if (s) setStats(s.data.data); setActivity(a.data.data); }
      } catch (err) {
        if (!cancelled) setError(apiErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <p className="p-4">Loading dashboard…</p>;
  if (error || (needsStats && !stats)) {
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
        <p className="text-sm text-slate-500">
          {isStudent
            ? 'Overview of your subjects, results and fees.'
            : isLecturer
              ? 'Overview of your subjects, examinations and pending marks.'
              : isController
                ? 'Overview of examinations, pending approvals and exam activity.'
                : isDeptHead
                  ? 'Overview of your department — students, lecturers and results.'
                  : isInvigilator
                    ? 'Overview of your assigned examination sessions.'
                    : 'Overview of examinations, results and pending work.'}
        </p>
      </div>

      {isStudent ? (
        <StudentCards stats={stats as StudentDashboardStats} />
      ) : isDeptHead ? (
        <DeptHeadCards />
      ) : isInvigilator ? (
        <InvigilatorCards />
      ) : (
        <>
          {isController && <ControllerApprovals stats={stats as DashboardStats} />}
          <StaffCards stats={stats as DashboardStats} isLecturer={isLecturer} isController={isController} />
          <Charts stats={stats as DashboardStats} isLecturer={isLecturer} />
        </>
      )}

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

// --- Student view: personal cards only. No system-wide card or chart is
// rendered for students (the backend does not even send those numbers).
function StudentCards({ stats }: { stats: StudentDashboardStats }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <StatCard title="My Subjects" value={stats.mySubjects} icon="📚" accent="amber" subtitle="Enrolled this semester" />
      <StatCard title="My CGPA" value={stats.myCgpa == null ? '—' : stats.myCgpa.toFixed(2)} icon="📊" accent="violet" subtitle="From published results" />
      <StatCard title="My Upcoming Exams" value={stats.myUpcomingExams} icon="🗓️" accent="blue" subtitle="Scheduled, not yet held" />
      <StatCard title="My Published Results" value={stats.myPublishedResults} icon="✅" accent="green" subtitle="Results released to you" />
      <StatCard title="My Fees Due" value={stats.myFeesDue === 0 ? '0 AFN' : `${stats.myFeesDue.toLocaleString()} AFN`} icon="💰" accent="red" subtitle="Outstanding balance" />
      <StatCard title="My Attendance" value={stats.myAttendanceRate == null ? '—' : `${stats.myAttendanceRate}%`} icon="📋" accent="blue" subtitle="Present in marked sessions" />
    </div>
  );
}

// --- Examination Controller view: pending approvals strip.
// There is no separate schedule-approval workflow in the data model
// yet: an examination in DRAFT status is one whose schedule is still
// awaiting approval, and a submitted mark is one whose result is still
// awaiting approval. Approval itself currently happens by changing the
// exam status / approving marks on the Examinations and Marks pages —
// those backend guards still need to admit the controller role.
function ControllerApprovals({ stats }: { stats: DashboardStats }) {
  const draftExams = stats.examsByStatus.find((e) => e.status === 'DRAFT')?.count ?? 0;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <StatCard title="Pending Schedule Approvals" value={draftExams} icon="🗓️" accent="red" subtitle="Examinations still in draft" trend={draftExams > 0 ? { label: 'Action needed', positive: false } : undefined} />
      <StatCard title="Pending Result Approvals" value={stats.pendingMarks} icon="⏳" accent="red" subtitle="Submitted marks awaiting approval" trend={stats.pendingMarks > 0 ? { label: 'Action needed', positive: false } : undefined} />
    </div>
  );
}

// --- Department Head view: their own department only.
// Counts come from the department-filtered list endpoints (limit=1, read
// the paginated total), never from the system-wide dashboard stats.
// Until the backend admits department_head on those list routes the
// calls fail and this section says so instead of showing other
// departments' numbers. No department linked to the account yet →
// empty state, not system-wide data.
function DeptHeadCards() {
  const { user } = useAuth();
  const deptId = user?.departmentId != null ? Number(user.departmentId) : null;
  const [counts, setCounts] = useState<{ students: number; lecturers: number; subjects: number; departmentName: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (deptId == null) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const [s, l, sub] = await Promise.all([
          studentsApi.list({ department_id: deptId, limit: 1 }),
          lecturersApi.list({ department_id: deptId, limit: 1 }),
          subjectsApi.list({ department_id: deptId, limit: 1 }),
        ]);
        if (cancelled) return;
        const total = (body: { pagination?: { total?: number }; data: unknown[] }) =>
          body.pagination?.total ?? (Array.isArray(body.data) ? body.data.length : 0);
        const firstStudent = (s.data.data as Array<{ department_name?: string }>)[0];
        setCounts({
          students: total(s.data),
          lecturers: total(l.data),
          subjects: total(sub.data),
          departmentName: firstStudent?.department_name ?? null,
        });
      } catch (err) {
        if (!cancelled) setError(apiErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [deptId]);

  if (deptId == null) {
    return (
      <div className="rounded-xl bg-amber-50 p-5 text-sm text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
        <h2 className="font-semibold">No department linked to your account yet</h2>
        <p className="mt-1">Ask the Super Admin to link your account to your department (through the lecturers record). Until then this dashboard stays empty — it will never show another department&apos;s students or results.</p>
      </div>
    );
  }
  if (loading) return <p className="p-4">Loading department overview…</p>;
  if (error || !counts) {
    return (
      <div role="alert" className="rounded-xl bg-red-50 p-5 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
        <h2 className="font-semibold">Department data is not available yet</h2>
        <p className="mt-1">The backend still needs to allow the Department Head role on the department-filtered student, lecturer and subject lists. {error}</p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard title="Department Students" value={counts.students} icon="🎓" accent="blue" subtitle={counts.departmentName ?? 'Your department'} />
        <StatCard title="Department Lecturers" value={counts.lecturers} icon="👩‍🏫" accent="violet" subtitle={counts.departmentName ?? 'Your department'} />
        <StatCard title="Department Subjects" value={counts.subjects} icon="📚" accent="amber" subtitle="Current semester" />
      </div>
      <p className="text-xs text-slate-500">
        Department examination results are not counted here yet — there is no department-scoped results endpoint. Use the Results page (once its backend guard admits Department Head) to review your department&apos;s published results.
      </p>
    </div>
  );
}

// --- Examination Invigilator view: assigned sessions only.
// Assignment data lives in room_allocations (invigilator_id → lecturers),
// and there is no invigilator-assignment endpoint yet, so this dashboard
// shows no system numbers at all — only the link to the sessions page,
// which lists the sessions and their halls. Incident reports have no
// submission endpoint yet either (see the sessions page).
function InvigilatorCards() {
  return (
    <div className="space-y-4">
      <section className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800" aria-label="Assigned examination sessions">
        <h2 className="font-semibold">Your assigned sessions</h2>
        <p className="mt-2 text-sm text-slate-500">
          Open your sessions to see the examination, hall and student list for each one, and to record attendance.
        </p>
        <Link to="/my-invigilation" className="mt-3 inline-block rounded-lg bg-navy-900 px-4 py-2 text-sm font-medium text-white hover:bg-navy-800">
          View my invigilation sessions →
        </Link>
      </section>
      <p className="text-xs text-slate-500">
        Sessions are assigned by the Examination Officer through room allocations. If no session lists you as invigilator, ask the officer to assign you — the sessions page shows each session&apos;s assigned invigilator.
      </p>
    </div>
  );
}

// --- Staff / lecturer / finance / controller view: the original 8 cards.
// Lecturer labels stay scoped to their own subjects (see the backend
// scoping). Controller labels are system-wide by design — the controller
// monitors all examinations.
function StaffCards({ stats, isLecturer, isController = false }: { stats: DashboardStats; isLecturer: boolean; isController?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard title={isLecturer ? 'My Students' : 'Total Students'} value={stats.totalStudents} icon="🎓" accent="blue" subtitle={isLecturer ? 'Enrolled in your subjects' : 'Active enrolments'} />
      <StatCard title="Total Lecturers" value={stats.totalLecturers} icon="👩‍🏫" accent="violet" subtitle={isLecturer ? 'You' : 'Across all departments'} />
      <StatCard title="Total Departments" value={stats.totalDepartments} icon="🏛️" accent="green" subtitle={isLecturer ? 'Your departments' : 'Faculties & departments'} />
      <StatCard title="Total Subjects" value={stats.totalSubjects} icon="📚" accent="amber" subtitle={isLecturer ? 'Assigned to you' : 'Current semester'} />
      <StatCard title="Upcoming Exams" value={stats.upcomingExams} icon="🗓️" accent="blue" subtitle={isLecturer ? 'In your subjects' : 'Scheduled, not yet held'} />
      <StatCard title="Completed Exams" value={stats.completedExams} icon="✅" accent="green" subtitle={isLecturer ? 'In your subjects' : 'This academic year'} />
      <StatCard title="Published Results" value={stats.publishedResults} icon="📊" accent="violet" subtitle={isLecturer ? 'In your subjects' : 'Visible to students'} />
      <StatCard title={isController ? 'Pending Result Approvals' : 'Pending Marks'} value={stats.pendingMarks} icon="⏳" accent="red" subtitle={isController ? 'Submitted marks awaiting approval' : isLecturer ? 'Your marks awaiting submission' : 'Awaiting lecturer submission'} trend={{ label: 'Action needed', positive: false }} />
    </div>
  );
}

// --- Charts (staff / lecturer / finance only — never rendered for students).
// Lecturer headings are relabelled to their own subjects; the data was
// already lecturer-scoped on the backend.
function Charts({ stats, isLecturer }: { stats: DashboardStats; isLecturer: boolean }) {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section className="rounded-xl bg-white p-5 shadow-card dark:bg-slate-800" aria-label="Exams per month">
          <h2 className="font-semibold">{isLecturer ? 'Your exams per month' : 'Exams per month'}</h2>
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
          <h2 className="font-semibold">{isLecturer ? 'Your exams by status' : 'Exams by status'}</h2>
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
        <h2 className="font-semibold">
          {isLecturer ? 'Results in your subjects — average GPA & pass rate' : 'Department performance — average GPA & pass rate'}
        </h2>
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
    </>
  );
}
