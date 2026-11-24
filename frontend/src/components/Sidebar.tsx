import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth, ROLE_LABELS } from '../context/AuthContext';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  roles: Array<'SUPER_ADMIN' | 'EXAM_OFFICER' | 'LECTURER' | 'STUDENT'>;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: '▦', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'LECTURER', 'STUDENT'] },
  { to: '/students', label: 'Students', icon: '🎓', roles: ['SUPER_ADMIN', 'EXAM_OFFICER'] },
  { to: '/lecturers', label: 'Lecturers', icon: '👩‍🏫', roles: ['SUPER_ADMIN', 'EXAM_OFFICER'] },
  { to: '/departments', label: 'Departments', icon: '🏛️', roles: ['SUPER_ADMIN', 'EXAM_OFFICER'] },
  { to: '/subjects', label: 'Subjects', icon: '📚', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'LECTURER'] },
  { to: '/exams', label: 'Examinations', icon: '📝', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'LECTURER'] },
  { to: '/timetable', label: 'Timetable', icon: '🗓️', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'LECTURER', 'STUDENT'] },
  { to: '/attendance', label: 'Attendance', icon: '✅', roles: ['SUPER_ADMIN', 'EXAM_OFFICER'] },
  { to: '/marks', label: 'Marks Entry', icon: '✏️', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'LECTURER'] },
  { to: '/results', label: 'Results', icon: '📊', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'LECTURER', 'STUDENT'] },
  { to: '/fees', label: 'Fees', icon: '💰', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'STUDENT'] },
  { to: '/admit-card', label: 'Admit Card', icon: '🎫', roles: ['STUDENT'] },
  { to: '/complaints', label: 'Complaints / Rechecking', icon: '🔍', roles: ['SUPER_ADMIN', 'EXAM_OFFICER', 'STUDENT'] },
  { to: '/reports', label: 'Reports', icon: '📄', roles: ['SUPER_ADMIN', 'EXAM_OFFICER'] },
  { to: '/notifications', label: 'Notifications', icon: '🔔', roles: ['SUPER_ADMIN', 'EXAM_OFFICER'] },
  { to: '/users', label: 'User Management', icon: '👥', roles: ['SUPER_ADMIN'] },
  { to: '/audit-logs', label: 'Audit Logs', icon: '🧾', roles: ['SUPER_ADMIN'] },
  { to: '/settings', label: 'Settings & Backup', icon: '⚙️', roles: ['SUPER_ADMIN'] },
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
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-white text-xl font-bold text-navy-800">U</span>
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
          <p className="truncate text-sm font-semibold">{user.fullName}</p>
          <p className="text-xs text-blue-200">{ROLE_LABELS[user.role]} · {user.email}</p>
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
