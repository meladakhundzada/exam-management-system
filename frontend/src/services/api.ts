import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';

export const API_BASE_URL =
  import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api';

const api: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: false,
});

const TOKEN_KEY = 'uems_access_token';
const REFRESH_KEY = 'uems_refresh_token';

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  getRefresh: () => localStorage.getItem(REFRESH_KEY),
  set: (access: string, refresh?: string) => {
    localStorage.setItem(TOKEN_KEY, access);
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

// Attach JWT to every request.
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = tokenStore.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// On 401, try one refresh, then force logout. On 403, surface the RBAC error.
let refreshing = false;
let refreshQueue: Array<(token: string | null) => void> = [];

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    if (error.response?.status === 401 && original && !original._retry) {
      original._retry = true;
      if (!refreshing) {
        refreshing = true;
        try {
          const refresh = tokenStore.getRefresh();
          // POST /auth/refresh re-issues an access token from the current
          // one (there is no refresh-token table); send the access token
          // in the Authorization header so the backend can verify it.
          const { data } = await axios.post(`${API_BASE_URL}/auth/refresh`, { refreshToken: refresh }, {
            headers: tokenStore.get() ? { Authorization: `Bearer ${tokenStore.get()}` } : {},
          });
          tokenStore.set(data.data.accessToken, data.data.refreshToken);
          refreshQueue.forEach((cb) => cb(data.data.accessToken));
          refreshQueue = [];
          refreshing = false;
          original.headers.Authorization = `Bearer ${data.data.accessToken}`;
          return api(original);
        } catch {
          refreshQueue.forEach((cb) => cb(null));
          refreshQueue = [];
          refreshing = false;
          tokenStore.clear();
          // Full-page navigation (not client-side routing): on a static
          // host without an SPA rewrite this used to land on a plain
          // "Not Found" document. Only navigate when not already there;
          // the rewrite in render.yaml / public/_redirects makes /login
          // serve index.html.
          if (window.location.pathname !== '/login') window.location.href = '/login';
          return Promise.reject(error);
        }
      }
      return new Promise((resolve, reject) => {
        refreshQueue.push((token) => {
          if (!token) return reject(error);
          original.headers.Authorization = `Bearer ${token}`;
          resolve(api(original));
        });
      });
    }
    return Promise.reject(error);
  },
);

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  meta?: { page: number; limit: number; total: number; totalPages: number };
  pagination?: { page: number; limit: number; total: number; totalPages: number };
}

export interface PaginatedParams {
  page?: number;
  limit?: number;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  [key: string]: string | number | boolean | undefined;
}

const buildQuery = (params: PaginatedParams = {}) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '' && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

export const authApi = {
  login: (email: string, password: string) =>
    api.post<ApiResponse<{ accessToken: string; refreshToken: string; user: AuthUser }>>('/auth/login', { email, password }),
  logout: () => api.post('/auth/logout', { refreshToken: tokenStore.getRefresh() }),
  me: () => api.get<ApiResponse<AuthUser>>('/auth/me'),
  // Backend validates snake_case fields (current_password / new_password);
  // camelCase here used to fail validation with a 400.
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post('/auth/change-password', { current_password: currentPassword, new_password: newPassword }),
  // Profile photo (PUT/DELETE /auth/photo). The photo is a client-
  // downscaled JPEG data URL (max 512px, <= 200 KB); the backend stores
  // it in users.avatar_url and validates type and size.
  uploadPhoto: (photo: string) =>
    api.put<ApiResponse<{ avatar_url: string | null }>>('/auth/photo', { photo }),
  removePhoto: () => api.delete<ApiResponse<{ avatar_url: string | null }>>('/auth/photo'),
  // One-time first Super Admin setup. Works only while no users exist;
  // afterwards the backend returns 403 "Setup already completed: users exist".
  setupFirstAdmin: (fullName: string, email: string, password: string) =>
    api.post<ApiResponse<{ id: number; full_name: string; email: string }>>(
      '/auth/setup-first-admin',
      { full_name: fullName, email, password },
    ),
};

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: 'SUPER_ADMIN' | 'EXAM_OFFICER' | 'LECTURER' | 'STUDENT' | 'FINANCE' | 'EXAM_CONTROLLER' | 'DEPARTMENT_HEAD' | 'INVIGILATOR';
  // Profile photo: downscaled JPEG data URL from users.avatar_url, or
  // null when the user has no photo. Returned by login and /auth/me.
  photoUrl?: string | null;
  departmentId?: string | null;
  studentId?: string | null;
  lecturerId?: string | null;
}

export interface Student {
  id: string;
  studentNo: string;
  fullName: string;
  email: string;
  phone?: string;
  departmentId: string;
  departmentName: string;
  facultyName: string;
  academicYear: string;
  admissionYear: number;
  gender?: string;
  semester: number;
  status: 'ACTIVE' | 'SUSPENDED' | 'GRADUATED' | 'WITHDRAWN';
  enrollmentDate: string;
}

// Payloads for POST/PUT /api/students — the backend expects snake_case.
// (The old code sent the camelCase Student shape, which the backend
// rejected: department_id must be an integer and password is required.)
export interface CreateStudentPayload {
  student_id: string;
  full_name: string;
  email: string;
  phone?: string;
  department_id: number;
  admission_year: number;
  current_semester?: number;
  gender?: 'male' | 'female' | 'other';
  password: string;
}

export type UpdateStudentPayload = Omit<CreateStudentPayload, 'password'> & {
  status?: 'active' | 'suspended' | 'graduated' | 'dropped';
};

export interface Exam {
  id: string;
  title: string;
  subjectId: string;
  subjectName: string;
  subjectCode: string;
  academicYear: string;
  semester: number;
  examDate: string;
  startTime: string;
  endTime: string;
  roomId?: string | null;
  roomName?: string | null;
  status: 'DRAFT' | 'SCHEDULED' | 'ONGOING' | 'COMPLETED' | 'CANCELLED';
  totalMarks: number;
  // Snake_case fields the backend actually returns (see normalizeExam).
  examType?: string;
  startDate?: string;
  endDate?: string;
  semesterName?: string;
  scheduleCount?: number;
  publishedResults?: number;
}

export const studentsApi = {
  list: (params: PaginatedParams = {}) =>
    api.get<ApiResponse<Student[]>>(`/students?${buildQuery(params)}`),
  get: (id: string) => api.get<ApiResponse<Student>>(`/students/${id}`),
  create: (payload: CreateStudentPayload) =>
    api.post<ApiResponse<Student>>('/students', payload),
  update: (id: string, payload: UpdateStudentPayload) =>
    api.put<ApiResponse<Student>>(`/students/${id}`, payload),
  remove: (id: string) => api.delete(`/students/${id}`),
  // GET /api/reports/students/export — the backend has no /students/export
  // route (and no CSV format); the real export is xlsx (default) or pdf.
  exportCsv: () => api.get('/reports/students/export', { responseType: 'blob' }),
  // Student's own enrolled courses (GET /api/students/:id/enrollments).
  enrollments: (id: string) =>
    api.get<ApiResponse<EnrollmentRow[]>>(`/students/${encodeURIComponent(id)}/enrollments`),
  // Student's own examination attendance (GET /api/students/:id/attendance).
  attendance: (id: string) =>
    api.get<ApiResponse<StudentAttendanceRow[]>>(`/students/${encodeURIComponent(id)}/attendance`),
  // Admit-card timetable data (GET /api/students/:id/admit-card?exam_id=).
  admitCardData: (id: string, examId: string) =>
    api.get<ApiResponse<{ student: Record<string, unknown>; exam_id: number; timetable: AdmitCardRow[] }>>(
      `/students/${encodeURIComponent(id)}/admit-card?exam_id=${encodeURIComponent(examId)}`,
    ),
};

export interface EnrollmentRow {
  id: number;
  status: string;
  enrolled_at: string;
  subject_id: number;
  subject_code: string;
  subject_title: string;
  credit_hours: number;
  semester_name: string;
  academic_year: string;
  lecturer_name?: string | null;
}

export interface StudentAttendanceRow {
  id: number;
  status: 'present' | 'absent' | 'late';
  marked_at: string;
  exam_date: string;
  start_time: string;
  end_time: string;
  subject_code: string;
  subject_title: string;
  exam_title: string;
  exam_type: string;
  room_name?: string | null;
}

export interface AdmitCardRow {
  exam_date: string;
  start_time: string;
  end_time: string;
  subject_code: string;
  subject_title: string;
  room_name?: string | null;
  building?: string | null;
  exam_title: string;
}

export const examsApi = {
  list: (params: PaginatedParams = {}) =>
    api.get<ApiResponse<Exam[]>>(`/exams?${buildQuery(params)}`),
  get: (id: string) => api.get<ApiResponse<Exam>>(`/exams/${id}`),
  create: (payload: Omit<Partial<Exam>, 'status'> & { academic_year_id?: number; semester_id?: number; exam_type?: string; start_date?: string; end_date?: string; status?: 'draft' | 'scheduled' | 'ongoing' | 'completed' | 'cancelled' }) =>
    api.post<ApiResponse<Exam>>('/exams', payload),
  update: (id: string, payload: Partial<Exam>) =>
    api.put<ApiResponse<Exam>>(`/exams/${id}`, payload),
  remove: (id: string) => api.delete(`/exams/${id}`),
  timetable: (academicYear: string, semester: number) =>
    api.get<ApiResponse<Exam[]>>(`/exams/timetable?academicYear=${academicYear}&semester=${semester}`),
};

export interface MarkRow {
  id?: string;
  examId: string;
  subjectId?: string;
  subjectCode?: string;
  subjectTitle?: string;
  studentId: string; // internal students.id (what /bulk needs)
  studentNo: string; // public student number (e.g. 001)
  studentName: string;
  marksObtained: number | null;
  totalMarks: number;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
}

// Backend GET /api/marks rows are snake_case (student_pk = internal id,
// student_no = public student number (e.g. 001)); map them to the camelCase MarkRow.
export function normalizeMarkRow(raw: Record<string, unknown>): MarkRow {
  return {
    id: raw.id != null ? String(raw.id) : undefined,
    examId: String(raw.exam_id ?? ''),
    subjectId: raw.subject_id != null ? String(raw.subject_id) : undefined,
    subjectCode: (raw.subject_code as string | undefined) ?? undefined,
    subjectTitle: (raw.subject_title as string | undefined) ?? undefined,
    studentId: String(raw.student_pk ?? raw.student_id ?? ''),
    studentNo: String(raw.student_no ?? raw.student_id ?? ''),
    studentName: String(raw.student_name ?? ''),
    marksObtained: raw.obtained_marks == null ? null : Number(raw.obtained_marks),
    totalMarks: Number(raw.total_marks ?? 100),
    status: (String(raw.status ?? 'draft') as MarkRow['status']),
  };
}

export interface RosterRow {
  studentPk: string;
  studentNo: string;
  studentName: string;
  markId?: string | null;
  marksObtained: number | null;
  totalMarks: number;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
}

export function normalizeRosterRow(raw: Record<string, unknown>): RosterRow {
  return {
    studentPk: String(raw.student_pk ?? ''),
    studentNo: String(raw.student_no ?? ''),
    studentName: String(raw.student_name ?? ''),
    markId: raw.mark_id != null ? String(raw.mark_id) : null,
    marksObtained: raw.obtained_marks == null ? null : Number(raw.obtained_marks),
    totalMarks: Number(raw.total_marks ?? 100),
    status: (String(raw.status ?? 'draft') as RosterRow['status']),
  };
}

// Real marks endpoints (backend/routes/marks.js). There are no
// /exams/:id/marks routes on the backend — the old calls 404'd.
export const marksApi = {
  byExam: (examId: string, subjectId?: string) =>
    api.get<ApiResponse<Record<string, unknown>[]>>(
      `/marks?exam_id=${encodeURIComponent(examId)}${subjectId ? `&subject_id=${encodeURIComponent(subjectId)}` : ''}&limit=500`,
    ),
  roster: (examId: string, subjectId: string) =>
    api.get<ApiResponse<Record<string, unknown>[]>>(
      `/marks/roster?exam_id=${encodeURIComponent(examId)}&subject_id=${encodeURIComponent(subjectId)}`,
    ),
  bulk: (examId: string, subjectId: string, marks: Array<{ student_id: number; obtained_marks: number }>) =>
    api.post<ApiResponse<Record<string, unknown>[]>>('/marks/bulk', {
      exam_id: Number(examId), subject_id: Number(subjectId), marks,
    }),
  submit: (id: string) => api.post<ApiResponse<Record<string, unknown>>>(`/marks/${id}/submit`),
  approve: (id: string) => api.post<ApiResponse<Record<string, unknown>>>(`/marks/${id}/approve`),
  reject: (id: string, reason?: string) => api.post<ApiResponse<Record<string, unknown>>>(`/marks/${id}/reject`, { reason }),
};

export interface ResultRow {
  studentId: string; // internal students.id
  studentNo: string; // public student number (e.g. 001)
  studentName: string;
  subjectCode: string;
  subjectName: string;
  marksObtained: number;
  totalMarks: number;
  grade: string;
  gradePoint: number;
  gpa: number | null; // per-row semester-GPA snapshot (null until calculated)
  creditHours: number;
  examTitle?: string;
  status: 'PUBLISHED' | 'UNPUBLISHED';
}

// Backend GET /api/results rows are snake_case; map them to ResultRow.
// The list endpoint has no gpa field on the wrapper — GPA is computed
// from the rows (credit-weighted grade points) by the Results page.
export function normalizeResultRow(raw: Record<string, unknown>): ResultRow {
  return {
    studentId: String(raw.student_pk ?? raw.student_id ?? ''),
    studentNo: String(raw.student_no ?? raw.student_id ?? ''),
    studentName: String(raw.student_name ?? ''),
    subjectCode: String(raw.subject_code ?? ''),
    subjectName: String(raw.subject_title ?? ''),
    marksObtained: Number(raw.obtained_marks ?? 0),
    totalMarks: 100,
    grade: String(raw.grade ?? ''),
    gradePoint: Number(raw.grade_point ?? 0),
    gpa: raw.gpa == null ? null : Number(raw.gpa),
    creditHours: Number(raw.credit_hours ?? 3),
    examTitle: (raw.exam_title as string | undefined) ?? undefined,
    status: raw.is_published ? 'PUBLISHED' : 'UNPUBLISHED',
  };
}

// Credit-weighted GPA from result rows (same formula as backend gpa.js).
export function gpaFromRows(rows: ResultRow[]): number | null {
  let points = 0;
  let credits = 0;
  for (const r of rows) {
    points += r.gradePoint * r.creditHours;
    credits += r.creditHours;
  }
  if (credits === 0) return null;
  return Math.round((points / credits) * 1000) / 1000;
}

// Backend GET /api/exams rows are snake_case examinations (no subject,
// no per-subject date/time — those live on exam_schedules); map them to
// the camelCase Exam shape the pages render.
export function normalizeExam(raw: Record<string, unknown>): Exam {
  const status = String(raw.status ?? 'draft').toUpperCase() as Exam['status'];
  return {
    id: String(raw.id ?? ''),
    title: String(raw.title ?? ''),
    subjectId: '',
    subjectName: '',
    subjectCode: '',
    academicYear: String(raw.academic_year ?? ''),
    semester: Number(raw.semester_id ?? 0),
    examDate: String(raw.start_date ?? '').slice(0, 10),
    startTime: '',
    endTime: '',
    roomId: null,
    roomName: null,
    status,
    totalMarks: 100,
    examType: String(raw.exam_type ?? ''),
    startDate: String(raw.start_date ?? '').slice(0, 10),
    endDate: String(raw.end_date ?? '').slice(0, 10),
    semesterName: (raw.semester_name as string | undefined) ?? undefined,
    scheduleCount: raw.schedule_count != null ? Number(raw.schedule_count) : undefined,
    publishedResults: raw.published_results != null ? Number(raw.published_results) : undefined,
  };
}

export const resultsApi = {
  // GET /api/results/student/:studentId — { results, cgpa, total_subjects }.
  // Takes the INTERNAL students.id; the Results page resolves public
  // plain student numbers (e.g. 001) to it first. No semester param exists on the backend.
  byStudent: (studentId: string) =>
    api.get<ApiResponse<{ results: Record<string, unknown>[]; cgpa: number | null; total_subjects: number }>>(
      `/results/student/${encodeURIComponent(studentId)}`,
    ),
  list: (params: PaginatedParams = {}) =>
    api.get<ApiResponse<Record<string, unknown>[]>>(`/results?${buildQuery(params)}`),
  calculate: (examId: string) => api.post<ApiResponse<Record<string, unknown>[]>>(`/results/calculate/${examId}`),
  publish: (examId: string) => api.post(`/results/publish/${examId}`),
  unpublish: (examId: string) => api.post(`/results/unpublish/${examId}`),
  // GET /api/reports/admit-card/:studentId?exam_id= (PDF blob).
  admitCard: (studentId: string, examId: string) =>
    api.get(`/reports/admit-card/${encodeURIComponent(studentId)}?exam_id=${encodeURIComponent(examId)}`, { responseType: 'blob' }),
  // GET /api/reports/student/:studentId/result-pdf (PDF blob).
  transcript: (studentId: string) =>
    api.get(`/reports/student/${encodeURIComponent(studentId)}/result-pdf`, { responseType: 'blob' }),
};

// --- Fees (amounts in AFN; backend returns snake_case rows, as sent by pg) ---
export function formatAfn(amount: number | string): string {
  const n = typeof amount === 'string' ? Number(amount) : amount;
  return `${Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : amount} AFN`;
}

export interface FeeType {
  id: number;
  name: string;
  description?: string | null;
  amount: number;
  department_id?: number | null;
  semester_id?: number | null;
  academic_year_id?: number | null;
  is_active: boolean;
}

export interface FeePayment {
  id: number;
  student_fee_id: number;
  amount: number;
  payment_method: 'cash' | 'bank' | 'mobile_money' | 'other';
  receipt_no: string;
  received_by?: number | null;
  received_by_name?: string | null;
  payment_date: string;
  note?: string | null;
}

export interface StudentFee {
  id: number;
  student_id: number;
  student_name: string;
  email?: string;
  student_email?: string;
  department_name?: string | null;
  fee_type_id: number;
  fee_type_name: string;
  amount_due: number;
  amount_paid: number;
  balance: number;
  due_date?: string | null;
  status: 'unpaid' | 'partial' | 'paid' | 'overdue';
  display_status: 'unpaid' | 'partial' | 'paid' | 'overdue';
  academic_year_id?: number | null;
  semester_id?: number | null;
  payments?: FeePayment[];
}

export interface FeeReport {
  totals: { total_due: number; total_collected: number; outstanding: number; fee_count: number; paid_count: number; unpaid_count: number };
  by_fee_type: Array<{ fee_type: string; total_due: number; total_collected: number; outstanding: number; fee_count: number }>;
}

export interface FeePaymentRecord extends FeePayment {
  student_name: string;
  student_no: string;
  fee_type_name: string;
}

export const feesApi = {
  types: () => api.get<ApiResponse<FeeType[]>>('/fees/types'),
  createType: (payload: { name: string; amount: number; description?: string; department_id?: number; semester_id?: number; academic_year_id?: number }) =>
    api.post<ApiResponse<FeeType>>('/fees/types', payload),
  updateType: (id: number, payload: { name?: string; amount?: number; description?: string; is_active?: boolean }) =>
    api.patch<ApiResponse<FeeType>>(`/fees/types/${id}`, payload),
  byStudent: (studentId: string | number) =>
    api.get<ApiResponse<{ fees: StudentFee[]; totals: { total_due: number; total_paid: number; outstanding: number } }>>(`/fees/student/${studentId}`),
  due: (params: PaginatedParams = {}) =>
    api.get<ApiResponse<StudentFee[]>>(`/fees/due?${buildQuery(params)}`),
  report: (params: PaginatedParams = {}) =>
    api.get<ApiResponse<FeeReport>>(`/fees/report?${buildQuery(params)}`),
  assign: (payload: { fee_type_id: number; amount?: number; student_id?: number | string; department_id?: number; semester_id?: number; academic_year_id?: number; due_date?: string }) =>
    api.post<ApiResponse<StudentFee[]> & { count: number }>('/fees/assign', payload),
  get: (id: number) => api.get<ApiResponse<StudentFee>>(`/fees/${id}`),
  pay: (id: number, payload: { amount: number; payment_method?: string; payment_date?: string; note?: string }) =>
    api.post<ApiResponse<{ payment: FeePayment; fee: StudentFee }>>(`/fees/${id}/pay`, payload),
  payments: (params: PaginatedParams = {}) =>
    api.get<ApiResponse<FeePaymentRecord[]>>(`/fees/payments?${buildQuery(params)}`),
  updatePayment: (id: number, payload: { amount?: number; payment_method?: string; payment_date?: string; note?: string }) =>
    api.patch<ApiResponse<FeePayment>>(`/fees/payments/${id}`, payload),
  exportPayments: (params: PaginatedParams = {}) =>
    api.get(`/fees/export?${buildQuery(params)}`, { responseType: 'blob' }),
};

// --- Users (Super Admin only) ---
export type UserRole = 'super_admin' | 'exam_officer' | 'lecturer' | 'student' | 'finance' | 'exam_controller' | 'department_head' | 'invigilator';

export interface AppUser {
  id: number;
  full_name: string;
  email: string;
  phone?: string | null;
  role: UserRole;
  is_active: boolean;
  last_login_at?: string | null;
  created_at: string;
  lecturer_id?: number | null;
  student_id?: number | null;
}

export interface CreateUserPayload {
  full_name: string;
  email: string;
  password: string;
  role: UserRole;
  phone?: string;
  department_id?: number;
  employee_id?: string;
  student_id?: string;
  admission_year?: number;
  current_semester?: number;
}

export const usersApi = {
  list: (params: PaginatedParams = {}) =>
    api.get<ApiResponse<AppUser[]>>(`/users?${buildQuery(params)}`),
  get: (id: number) => api.get<ApiResponse<AppUser>>(`/users/${id}`),
  create: (payload: CreateUserPayload) =>
    api.post<ApiResponse<AppUser>>('/users', payload),
  update: (id: number, payload: Partial<Pick<AppUser, 'full_name' | 'phone' | 'role' | 'is_active'>>) =>
    api.put<ApiResponse<AppUser>>(`/users/${id}`, payload),
  remove: (id: number) => api.delete<ApiResponse<{ message: string }>>(`/users/${id}`),
};

export const referenceApi = {
  get: () => api.get<ApiResponse<{
    faculties: Array<{ id: number; name: string }>;
    departments: Array<{ id: number; name: string; code: string; faculty_id: number }>;
    academic_years: Array<{ id: number; name: string }>;
    semesters: Array<{ id: number; name: string; semester_number: number }>;
    subjects: Array<{ id: number; code: string; title: string }>;
  }>>('/reference'),
};

// --- Departments & faculties (backend returns snake_case rows, as sent by pg) ---
export interface Department {
  id: number;
  faculty_id: number;
  faculty_name: string;
  faculty_code: string;
  name: string;
  code: string;
  head_name?: string | null;
  description?: string | null;
  is_active: boolean;
}

export interface Faculty {
  id: number;
  name: string;
  code: string;
  dean_name?: string | null;
}

export interface CreateDepartmentPayload {
  name: string;
  code: string;
  faculty_id?: number;
  faculty_name?: string;
  faculty_code?: string;
  head_name?: string;
  description?: string;
}

export const departmentsApi = {
  list: () => api.get<ApiResponse<Department[]>>('/departments'),
  create: (payload: CreateDepartmentPayload) =>
    api.post<ApiResponse<Department>>('/departments', payload),
  remove: (id: number) => api.delete<ApiResponse<{ message: string }>>(`/departments/${id}`),
};

export const facultiesApi = {
  list: () => api.get<ApiResponse<Faculty[]>>('/departments/faculties'),
};

export const dashboardApi = {
  stats: () => api.get<ApiResponse<DashboardStats | StudentDashboardStats>>('/dashboard/stats'),
  recentActivity: () => api.get<ApiResponse<ActivityItem[]>>('/dashboard/activity?limit=10'),
};

// Personal dashboard numbers for a student — the backend returns ONLY
// these fields for students (no system-wide totals of any kind).
export interface StudentDashboardStats {
  mySubjects: number;
  myCgpa: number | null;
  myUpcomingExams: number;
  myCompletedExams: number;
  myPublishedResults: number;
  myFeesDue: number;
  myAttendanceRate: number | null;
}

export interface DashboardStats {
  totalStudents: number;
  totalLecturers: number;
  totalDepartments: number;
  totalSubjects: number;
  upcomingExams: number;
  completedExams: number;
  publishedResults: number;
  pendingMarks: number;
  examsByStatus: Array<{ status: string; count: number }>;
  resultsByDepartment: Array<{ department: string; averageGpa: number; passRate: number }>;
  monthlyExams: Array<{ month: string; scheduled: number; completed: number }>;
}

export interface ActivityItem {
  id: string;
  actorName: string;
  action: string;
  entity: string;
  createdAt: string;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function apiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    // The backend returns errors as { success: false, error: "..." },
    // not { message: ... } — read both. Validation failures carry a
    // `details` array with the specific field message (e.g. the name
    // rule) — show that first, not the generic "Validation failed".
    const data = error.response?.data as { message?: string; error?: string; details?: Array<{ field?: string; message?: string }> } | undefined;
    if (data?.details?.length && data.details[0]?.message) return data.details[0].message;
    if (data?.error) return data.error;
    if (data?.message) return data.message;
    if (error.response?.status === 403) return 'You do not have permission to perform this action.';
    if (error.response?.status === 404) return 'The requested record was not found.';
    if (!error.response) return 'Cannot reach the server. Check your connection and try again.';
  }
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

// --- Subjects (backend returns snake_case rows, as sent by pg) ---
// Schema note: the table has credit_hours (not `credits`) and
// semester_id (not a plain `semester` column).
export interface Subject {
  id: number;
  code: string;
  title: string;
  department_id: number;
  department_name?: string;
  department_code?: string;
  semester_id?: number | null;
  semester_name?: string | null;
  lecturer_id?: number | null;
  lecturer_name?: string | null;
  credit_hours: number;
  description?: string | null;
  is_active: boolean;
}

export interface SubjectPayload {
  code: string;
  title: string;
  department_id: number;
  credit_hours?: number;
  semester_id?: number;
  lecturer_id?: number;
  description?: string;
  is_active?: boolean;
}

export const subjectsApi = {
  list: (params: PaginatedParams = {}) =>
    api.get<ApiResponse<Subject[]>>(`/subjects?${buildQuery(params)}`),
  get: (id: number) => api.get<ApiResponse<Subject>>(`/subjects/${id}`),
  create: (payload: SubjectPayload) =>
    api.post<ApiResponse<Subject>>('/subjects', payload),
  update: (id: number, payload: Partial<SubjectPayload>) =>
    api.put<ApiResponse<Subject>>(`/subjects/${id}`, payload),
  remove: (id: number) => api.delete(`/subjects/${id}`),
};

// --- Lecturers (read-only page; creation happens via Users) ---
export interface Lecturer {
  id: number;
  employee_id: string;
  full_name: string;
  email: string;
  phone?: string | null;
  department_id: number;
  department_name?: string;
  designation?: string | null;
  qualification?: string | null;
  is_active: boolean;
  subjects?: Array<{ id: number; code: string; title: string; credit_hours: number }>;
}

export const lecturersApi = {
  list: (params: PaginatedParams = {}) =>
    api.get<ApiResponse<Lecturer[]>>(`/lecturers?${buildQuery(params)}`),
  get: (id: number) => api.get<ApiResponse<Lecturer>>(`/lecturers/${id}`),
};

// --- Attendance (per exam schedule) ---
export interface AttendanceRecord {
  id?: number;
  exam_schedule_id?: number;
  student_id: number;
  studentNo?: string;
  full_name?: string;
  room_id?: number | null;
  status: 'present' | 'absent' | 'late';
  marked_at?: string;
}

export const attendanceApi = {
  get: (scheduleId: number) =>
    api.get<ApiResponse<AttendanceRecord[]>>(`/exams/schedules/${scheduleId}/attendance`),
  mark: (scheduleId: number, records: Array<{ student_id: number; status: 'present' | 'absent' | 'late'; room_id?: number }>) =>
    api.post<ApiResponse<AttendanceRecord[]>>(`/exams/schedules/${scheduleId}/attendance`, { records }),
  rooms: () => api.get<ApiResponse<Array<{ id: number; name: string; building?: string | null; capacity: number }>>>('/exams/rooms/list'),
};

// --- Complaints ---
export type ComplaintType = 'rechecking' | 'marks_correction' | 'absent_marked' | 'other';
export type ComplaintStatus = 'pending' | 'under_review' | 'resolved' | 'rejected';

export interface Complaint {
  id: number;
  student_id: number;
  student_name?: string;
  exam_id?: number | null;
  exam_title?: string | null;
  subject_id?: number | null;
  subject_code?: string | null;
  result_id?: number | null;
  type: ComplaintType;
  description: string;
  status: ComplaintStatus;
  resolution?: string | null;
  created_at: string;
}

export const complaintsApi = {
  // Student's own complaints (staff may also call it for any student).
  forStudent: (studentId: number) =>
    api.get<ApiResponse<Complaint[]>>(`/students/${studentId}/complaints`),
  file: (studentId: number, payload: { type: ComplaintType; description: string; exam_id?: number; subject_id?: number; result_id?: number }) =>
    api.post<ApiResponse<Complaint>>(`/students/${studentId}/complaints`, payload),
  // Officer review queue (super_admin / exam_officer only).
  reviewList: (status?: string) =>
    api.get<ApiResponse<Complaint[]>>(`/results/complaints/list${status ? `?status=${status}` : ''}`),
  review: (id: number, payload: { status: ComplaintStatus; resolution?: string }) =>
    api.put<ApiResponse<Complaint>>(`/results/complaints/${id}`, payload),
};

// --- Reports, notifications, audit logs, grade scales ---
export interface ReportDashboard {
  total_students: number;
  total_lecturers: number;
  total_departments: number;
  total_subjects: number;
  upcoming_exams: number;
  completed_exams: number;
  published_results: number;
  pending_marks: number;
  pending_complaints: number;
  students_by_department: Array<{ department: string; students: number }>;
  grade_distribution: Array<{ grade: string; count: number }>;
}

export interface NotificationItem {
  id: number;
  user_id?: number | null;
  role_id?: number | null;
  title: string;
  message: string;
  type: 'info' | 'exam' | 'result' | 'announcement' | 'alert';
  is_read: boolean;
  created_at: string;
}

export interface AuditLogItem {
  id: number;
  user_id?: number | null;
  user_name?: string | null;
  action: string;
  entity_type?: string | null;
  entity_id?: number | null;
  created_at: string;
}

export interface GradeScale {
  id: number;
  grade: string;
  min_marks: number;
  max_marks: number;
  grade_point: number;
  remarks?: string | null;
  is_passing: boolean;
}

export const reportsApi = {
  dashboard: () => api.get<ApiResponse<ReportDashboard>>('/reports/dashboard'),
  studentsExport: (format: 'xlsx' | 'pdf' = 'xlsx', departmentId?: number) =>
    api.get(`/reports/students/export?format=${format}${departmentId ? `&department_id=${departmentId}` : ''}`, { responseType: 'blob' }),
  scheduleExport: (examId: number, format: 'xlsx' | 'pdf' = 'xlsx') =>
    api.get(`/reports/exams/${examId}/schedule/export?format=${format}`, { responseType: 'blob' }),
  resultsExport: (examId: number, format: 'xlsx' | 'pdf' = 'xlsx') =>
    api.get(`/reports/results/${examId}/export?format=${format}`, { responseType: 'blob' }),
  admitCard: (studentId: number, examId: number) =>
    api.get(`/reports/admit-card/${studentId}?exam_id=${examId}`, { responseType: 'blob' }),
  resultPdf: (studentId: number) =>
    api.get(`/reports/student/${studentId}/result-pdf`, { responseType: 'blob' }),
  notifications: () => api.get<ApiResponse<NotificationItem[]>>('/reports/notifications'),
  createNotification: (payload: { title: string; message: string; type?: NotificationItem['type']; user_id?: number; role_id?: number; student_id?: number }) =>
    api.post<ApiResponse<NotificationItem>>('/reports/notifications', payload),
  auditLogs: (page = 1, limit = 50) =>
    api.get<ApiResponse<AuditLogItem[]>>(`/reports/audit-logs?page=${page}&limit=${limit}`),
};

export const gradeScalesApi = {
  list: () => api.get<ApiResponse<GradeScale[]>>('/results/grade-scales/list'),
  update: (grade: string, payload: { min_marks?: number; max_marks?: number; grade_point?: number; is_passing?: boolean }) =>
    api.put<ApiResponse<GradeScale>>(`/results/grade-scales/${encodeURIComponent(grade)}`, payload),
};

export default api;
