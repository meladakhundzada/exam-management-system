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
          const { data } = await axios.post(`${API_BASE_URL}/auth/refresh`, { refreshToken: refresh });
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
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post('/auth/change-password', { currentPassword, newPassword }),
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
  role: 'SUPER_ADMIN' | 'EXAM_OFFICER' | 'LECTURER' | 'STUDENT';
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
  semester: number;
  status: 'ACTIVE' | 'SUSPENDED' | 'GRADUATED' | 'WITHDRAWN';
  enrollmentDate: string;
}

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
}

export const studentsApi = {
  list: (params: PaginatedParams = {}) =>
    api.get<ApiResponse<Student[]>>(`/students?${buildQuery(params)}`),
  get: (id: string) => api.get<ApiResponse<Student>>(`/students/${id}`),
  create: (payload: Omit<Student, 'id' | 'departmentName' | 'facultyName'>) =>
    api.post<ApiResponse<Student>>('/students', payload),
  update: (id: string, payload: Partial<Student>) =>
    api.put<ApiResponse<Student>>(`/students/${id}`, payload),
  remove: (id: string) => api.delete(`/students/${id}`),
  exportCsv: () => api.get('/students/export?format=csv', { responseType: 'blob' }),
};

export const examsApi = {
  list: (params: PaginatedParams = {}) =>
    api.get<ApiResponse<Exam[]>>(`/exams?${buildQuery(params)}`),
  get: (id: string) => api.get<ApiResponse<Exam>>(`/exams/${id}`),
  create: (payload: Partial<Exam>) => api.post<ApiResponse<Exam>>('/exams', payload),
  update: (id: string, payload: Partial<Exam>) =>
    api.put<ApiResponse<Exam>>(`/exams/${id}`, payload),
  remove: (id: string) => api.delete(`/exams/${id}`),
  timetable: (academicYear: string, semester: number) =>
    api.get<ApiResponse<Exam[]>>(`/exams/timetable?academicYear=${academicYear}&semester=${semester}`),
};

export interface MarkRow {
  id?: string;
  examId: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  marksObtained: number | null;
  totalMarks: number;
  status: 'PENDING' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
}

export const marksApi = {
  byExam: (examId: string) => api.get<ApiResponse<MarkRow[]>>(`/exams/${examId}/marks`),
  submit: (examId: string, marks: Array<{ studentId: string; marksObtained: number }>) =>
    api.post(`/exams/${examId}/marks`, { marks }),
  approve: (examId: string) => api.post(`/exams/${examId}/marks/approve`),
  reject: (examId: string, reason: string) => api.post(`/exams/${examId}/marks/reject`, { reason }),
};

export interface ResultRow {
  studentId: string;
  studentNo: string;
  studentName: string;
  subjectCode: string;
  subjectName: string;
  marksObtained: number;
  totalMarks: number;
  grade: string;
  gradePoint: number;
  gpa: number;
  status: 'PUBLISHED' | 'UNPUBLISHED';
}

export const resultsApi = {
  byStudent: (studentId: string, semester?: number) =>
    api.get<ApiResponse<{ results: ResultRow[]; gpa: number; cgpa: number }>>(
      `/results/student/${studentId}${semester ? `?semester=${semester}` : ''}`,
    ),
  publish: (examId: string) => api.post(`/results/publish/${examId}`),
  admitCard: (studentId: string, examId: string) =>
    api.get(`/results/admit-card/${studentId}/${examId}`, { responseType: 'blob' }),
  transcript: (studentId: string) =>
    api.get(`/results/transcript/${studentId}`, { responseType: 'blob' }),
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

export const feesApi = {
  types: () => api.get<ApiResponse<FeeType[]>>('/fees/types'),
  createType: (payload: { name: string; amount: number; description?: string; department_id?: number; semester_id?: number; academic_year_id?: number }) =>
    api.post<ApiResponse<FeeType>>('/fees/types', payload),
  byStudent: (studentId: string | number) =>
    api.get<ApiResponse<{ fees: StudentFee[]; totals: { total_due: number; total_paid: number; outstanding: number } }>>(`/fees/student/${studentId}`),
  due: (params: PaginatedParams = {}) =>
    api.get<ApiResponse<StudentFee[]>>(`/fees/due?${buildQuery(params)}`),
  report: (params: PaginatedParams = {}) =>
    api.get<ApiResponse<FeeReport>>(`/fees/report?${buildQuery(params)}`),
  assign: (payload: { fee_type_id: number; amount?: number; student_id?: number; department_id?: number; semester_id?: number; academic_year_id?: number; due_date?: string }) =>
    api.post<ApiResponse<StudentFee[]> & { count: number }>('/fees/assign', payload),
  get: (id: number) => api.get<ApiResponse<StudentFee>>(`/fees/${id}`),
  pay: (id: number, payload: { amount: number; payment_method?: string; payment_date?: string; note?: string }) =>
    api.post<ApiResponse<{ payment: FeePayment; fee: StudentFee }>>(`/fees/${id}/pay`, payload),
};

export const dashboardApi = {
  stats: () => api.get<ApiResponse<DashboardStats>>('/dashboard/stats'),
  recentActivity: () => api.get<ApiResponse<ActivityItem[]>>('/dashboard/activity?limit=10'),
};

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
    // not { message: ... } — read both.
    const data = error.response?.data as { message?: string; error?: string } | undefined;
    if (data?.error) return data.error;
    if (data?.message) return data.message;
    if (error.response?.status === 403) return 'You do not have permission to perform this action.';
    if (error.response?.status === 404) return 'The requested record was not found.';
    if (!error.response) return 'Cannot reach the server. Check your connection and try again.';
  }
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

export default api;
