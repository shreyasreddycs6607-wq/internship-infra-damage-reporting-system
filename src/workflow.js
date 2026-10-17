// Single source of truth for statuses, transitions and who may do what to a report.
const STATUSES = ['SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'REOPENED', 'CLOSED'];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

// Direct status changes. ASSIGNED is reached only through the assign endpoint (ACCEPTED/REOPENED -> ASSIGNED).
const TRANSITIONS = {
  SUBMITTED: ['UNDER_REVIEW', 'ACCEPTED', 'REJECTED'],
  UNDER_REVIEW: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: ['REJECTED'],
  ASSIGNED: ['IN_PROGRESS'],
  IN_PROGRESS: ['RESOLVED'],
  RESOLVED: ['CLOSED', 'REOPENED'],
  REOPENED: ['IN_PROGRESS'],
  REJECTED: [],
  CLOSED: [],
};
const ASSIGNABLE = ['ACCEPTED', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED'];
const TERMINAL_OR_DONE = ['RESOLVED', 'CLOSED', 'REJECTED'];
const NOTE_REQUIRED = ['REJECTED', 'RESOLVED', 'REOPENED'];

const canTransition = (from, to) => !!TRANSITIONS[from]?.includes(to);
const isOpen = (s) => !TERMINAL_OR_DONE.includes(s);

const sameDept = (u, r) => u.department_id != null && u.department_id === r.department_id;

// View: admin all; officer = assigned to them or in their department; citizen = own.
const canView = (u, r) =>
  u.role === 'admin' || (u.role === 'officer' && (r.assigned_to_id === u.id || sameDept(u, r))) ||
  (u.role === 'citizen' && r.user_id === u.id);

// Manage (status, remarks, priority): admin; the assignee; or a department officer when the report is
// unassigned, or a department lead (can_assign) at any time.
const canManage = (u, r) =>
  u.role === 'admin' ||
  (u.role === 'officer' && (r.assigned_to_id === u.id || (sameDept(u, r) && (u.can_assign || !r.assigned_to_id))));

// Assign: admin; department lead; or an officer claiming an unassigned report for themselves.
const canAssign = (u, r, assigneeId) =>
  u.role === 'admin' ||
  (u.role === 'officer' && sameDept(u, r) && (!!u.can_assign || (!r.assigned_to_id && assigneeId === u.id)));

// SQL fragment limiting a query to the reports `u` may view (alias r).
const scopeSql = (u) =>
  u.role === 'admin' ? { sql: '1=1', params: [] }
    : u.role === 'officer' ? { sql: '(r.assigned_to_id = ? OR (? IS NOT NULL AND r.department_id = ?))', params: [u.id, u.department_id ?? null, u.department_id ?? null] }
      : { sql: 'r.user_id = ?', params: [u.id] };

module.exports = { STATUSES, PRIORITIES, TRANSITIONS, ASSIGNABLE, NOTE_REQUIRED, canTransition, isOpen, canView, canManage, canAssign, scopeSql };
