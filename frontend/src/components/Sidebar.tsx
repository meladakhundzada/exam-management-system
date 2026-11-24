import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth, ROLE_LABELS } from '../context/AuthContext';
import { Avatar } from './ProfilePhoto';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  roles: Array<'SUPER_ADMIN' | 'EXAM_OFFICER' | 'FINANCE' | 'LECTURER' | 'STUDENT' | 'EXAM_CONTROLLER' | 'DEPARTMENT_HEAD' | 'INVIGILATOR'>;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: '▦', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'FINANCE', 'LECTURER', 'STUDENT', 'EXAM_CONTROLLER', 'DEPARTMENT_HEAD', 'INVIGILATOR'] },
  { to: '/profile', label: 'My Profile', icon: '👤', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'FINANCE', 'LECTURER', 'STUDENT', 'EXAM_CONTROLLER', 'DEPARTMENT_HEAD', 'INVIGILATOR'] },
  { to: '/students', label: 'Students', icon: '🎓', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'LECTURER', 'DEPARTMENT_HEAD'] },
  { to: '/lecturers', label: 'Lecturers', icon: '👩‍🏫', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'DEPARTMENT_HEAD'] },
  { to: '/departments', label: 'Departments', icon: '🏛️', roles: ['SUPER_ADMIN', 'EXAM_OFFICER'] },
  { to: '/subjects', label: 'Subjects', icon: '📚', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'LECTURER', 'DEPARTMENT_HEAD'] },
  { to: '/exams', label: 'Examinations', icon: '📝', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'LECTURER', 'EXAM_CONTROLLER', 'DEPARTMENT_HEAD'] },
  { to: '/exam-management', label: 'Exam Management', icon: '🪑', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'EXAM_CONTROLLER'] },
  { to: '/timetable', label: 'Timetable', icon: '🗓️', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'LECTURER', 'STUDENT', 'EXAM_CONTROLLER', 'DEPARTMENT_HEAD', 'INVIGILATOR'] },
  { to: '/my-invigilation', label: 'My Invigilation Sessions', icon: '👁️', roles: ['INVIGILATOR'] },
  { to: '/my-courses', label: 'My Courses', icon: '📚', roles: ['STUDENT'] },
  { to: '/my-attendance', label: 'My Attendance', icon: '✅', roles: ['STUDENT'] },
  { to: '/attendance', label: 'Attendance', icon: '✅', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'LECTURER', 'EXAM_CONTROLLER', 'INVIGILATOR'] },
  { to: '/marks', label: 'Marks Entry', icon: '✏️', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'LECTURER', 'EXAM_CONTROLLER'] },
  { to: '/results', label: 'Results', icon: '📊', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'LECTURER', 'STUDENT', 'EXAM_CONTROLLER', 'DEPARTMENT_HEAD'] },
  { to: '/fees', label: 'Fees', icon: '💰', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'FINANCE', 'STUDENT'] },
  { to: '/pay-online', label: 'Pay Online', icon: '💳', roles: ['STUDENT'] },
  { to: '/scholarships', label: 'Scholarships', icon: '🎖️', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'FINANCE'] },
  { to: '/fines', label: 'Fines', icon: '⚠️', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'FINANCE'] },
  { to: '/online-transactions', label: 'Online Transactions', icon: '🧾', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'FINANCE'] },
  { to: '/admit-card', label: 'Admit Card', icon: '🎫', roles: ['STUDENT'] },
  { to: '/complaints', label: 'Complaints / Rechecking', icon: '🔍', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'LECTURER', 'STUDENT'] },
  { to: '/reports', label: 'Reports', icon: '📄', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'FINANCE', 'LECTURER', 'EXAM_CONTROLLER', 'DEPARTMENT_HEAD'] },
  { to: '/notifications', label: 'Notifications', icon: '🔔', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'LECTURER'] },
  { to: '/users', label: 'User Management', icon: '👥', roles: ['SUPER_ADMIN'] },
  { to: '/audit-logs', label: 'Audit Logs', icon: '🧾', roles: ['SUPER_ADMIN'] },
  { to: '/settings', label: 'Settings & Backup', icon: '⚙️', roles: ['SUPER_ADMIN', 'STUDENT', 'LECTURER'] },
];

export default function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  if (!user) return null;
  const items = NAV_ITEMS.filter((item) => item.roles.includes(user.role));

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <>
      {open && (
        <button
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={onClose}
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-navy-900 text-white transition-transform lg:static lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-3 px-5 py-5">
          <img src="/logo.png" alt="Alfalah University logo" className="h-10 w-10 rounded-lg bg-white object-contain p-0.5" />
          <div>
            <p className="text-sm font-bold leading-tight">University Exams</p>
            <p className="text-xs text-blue-200">Examination Department</p>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-2" aria-label="Main navigation">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onClose}
              className={({ isActive }) =>
                `mb-1 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                  isActive ? 'bg-white text-navy-900 font-semibold' : 'text-blue-100 hover:bg-navy-800'
                }`
              }
            >
              <span aria-hidden="true" className="w-6 text-center">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-navy-800 p-4">
          <div className="flex items-center gap-3">
            <Avatar name={user.fullName} photoUrl={user.photoUrl} size={40} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{user.fullName}</p>
              <p className="truncate text-xs text-blue-200">{ROLE_LABELS[user.role]} · {user.email}</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="mt-3 w-full rounded-lg bg-white/10 px-3 py-2 text-sm font-medium hover:bg-white/20"
          >
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}
