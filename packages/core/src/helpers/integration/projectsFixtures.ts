import { expect, type APIRequestContext } from '@playwright/test';
import { apiRequest } from './api';
import { expectId, readJsonSafe } from './generalFixtures';

export type ProjectTaskStatus = 'todo' | 'in_progress' | 'done';

export type ProjectTaskListItem = {
  id?: string;
  project_id?: string;
  projectId?: string;
  name?: string;
  status?: ProjectTaskStatus;
  description?: string | null;
  owner_user_id?: string | null;
  ownerUserId?: string | null;
  deadline_at?: string | null;
  deadlineAt?: string | null;
  position?: number;
};

function readFirstId(payload: unknown, keys: string[]): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = readFirstId(value, keys);
      if (nested) return nested;
    }
  }
  return '';
}

export async function createProjectFixture(
  request: APIRequestContext,
  token: string,
  input: {
    name: string;
    orderId?: string | null;
    ownerUserId?: string | null;
    isActive?: boolean;
  },
): Promise<string> {
  const response = await apiRequest(request, 'POST', '/api/projects', { token, data: input });
  const body = await readJsonSafe(response);
  expect(response.status(), 'POST /api/projects should return 201').toBe(201);
  return expectId(readFirstId(body, ['id', 'projectId']), 'Project creation response should include id');
}

export async function deleteProjectIfExists(
  request: APIRequestContext,
  token: string | null,
  projectId: string | null,
): Promise<void> {
  if (!token || !projectId) return;
  await apiRequest(request, 'DELETE', `/api/projects?id=${encodeURIComponent(projectId)}`, { token }).catch(() => undefined);
}

export async function createProjectTaskFixture(
  request: APIRequestContext,
  token: string,
  input: {
    projectId: string;
    name: string;
    status?: ProjectTaskStatus;
    description?: string | null;
    ownerUserId?: string | null;
    deadlineAt?: string | null;
    position?: number;
  },
): Promise<string> {
  const response = await apiRequest(request, 'POST', '/api/projects/tasks', { token, data: input });
  const body = await readJsonSafe(response);
  expect(response.status(), 'POST /api/projects/tasks should return 201').toBe(201);
  return expectId(readFirstId(body, ['id', 'taskId']), 'Project task creation response should include id');
}

export async function deleteProjectTaskIfExists(
  request: APIRequestContext,
  token: string | null,
  taskId: string | null,
): Promise<void> {
  if (!token || !taskId) return;
  await apiRequest(request, 'DELETE', `/api/projects/tasks?id=${encodeURIComponent(taskId)}`, { token }).catch(() => undefined);
}

export async function readProjectTasks(
  request: APIRequestContext,
  token: string,
  projectId: string,
): Promise<ProjectTaskListItem[]> {
  const response = await apiRequest(
    request,
    'GET',
    `/api/projects/tasks?projectId=${encodeURIComponent(projectId)}&pageSize=100&sortField=position&sortDir=asc`,
    { token },
  );
  expect(response.status(), 'GET /api/projects/tasks should return 200').toBe(200);
  const body = await readJsonSafe<{ items?: ProjectTaskListItem[] }>(response);
  return Array.isArray(body?.items) ? body.items : [];
}

export async function reorderProjectTasks(
  request: APIRequestContext,
  token: string,
  input: {
    projectId: string;
    moves: Array<{ id: string; status: ProjectTaskStatus; position: number }>;
  },
): Promise<number> {
  const response = await apiRequest(request, 'POST', '/api/projects/tasks/reorder', { token, data: input });
  const body = await readJsonSafe<{ ok?: boolean; moved?: number }>(response);
  expect(response.status(), 'POST /api/projects/tasks/reorder should return 200').toBe(200);
  expect(body?.ok, 'Reorder response should report ok=true').toBe(true);
  return typeof body?.moved === 'number' ? body.moved : 0;
}
