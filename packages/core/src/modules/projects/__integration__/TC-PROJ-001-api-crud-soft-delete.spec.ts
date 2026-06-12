import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { deleteSalesEntityIfExists } from '@open-mercato/core/helpers/integration/salesFixtures';
import { getTokenScope, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures';
import {
  createProjectFixture,
  createProjectTaskFixture,
  deleteProjectIfExists,
  deleteProjectTaskIfExists,
  readProjectTasks,
  reorderProjectTasks,
} from '@open-mercato/core/helpers/integration/projectsFixtures';

async function createSalesOrder(
  request: Parameters<typeof apiRequest>[0],
  token: string,
  orderNumber: string,
): Promise<string> {
  const response = await apiRequest(request, 'POST', '/api/sales/orders', {
    token,
    data: { orderNumber, currencyCode: 'USD' },
  });
  const body = await readJsonSafe<{ id?: string; orderId?: string }>(response);
  expect(response.status(), 'POST /api/sales/orders should return 201').toBe(201);
  expect(typeof (body?.id ?? body?.orderId) === 'string', 'Sales order response should include id').toBe(true);
  return (body?.id ?? body?.orderId) as string;
}

test.describe('TC-PROJ-001: Projects API CRUD, scoping, reorder, and soft-delete', () => {
  test('should manage projects and tasks with scoped order validation', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const { userId } = getTokenScope(token);
    const stamp = Date.now();
    const orderNumber = `QA-PROJ-API-${stamp}`;
    let orderId: string | null = null;
    let projectId: string | null = null;
    let taskAId: string | null = null;
    let taskBId: string | null = null;

    try {
      const invalidOrderResponse = await apiRequest(request, 'POST', '/api/projects', {
        token,
        data: {
          name: `QA invalid order project ${stamp}`,
          orderId: '11111111-1111-4111-8111-111111111111',
        },
      });
      expect(invalidOrderResponse.status(), 'Project create should reject an order outside scope').toBe(400);

      orderId = await createSalesOrder(request, token, orderNumber);
      projectId = await createProjectFixture(request, token, {
        name: `QA API Project ${stamp}`,
        orderId,
        ownerUserId: userId,
      });

      const listResponse = await apiRequest(
        request,
        'GET',
        `/api/projects?ids=${encodeURIComponent(projectId)}&pageSize=1`,
        { token },
      );
      expect(listResponse.status(), 'GET /api/projects by id should return 200').toBe(200);
      const listBody = await readJsonSafe<{
        items?: Array<{
          id?: string;
          name?: string;
          order_id?: string | null;
          owner_user_id?: string | null;
          openTaskCount?: number;
          doneTaskCount?: number;
        }>;
      }>(listResponse);
      expect(listBody?.items?.[0]).toMatchObject({
        id: projectId,
        name: `QA API Project ${stamp}`,
        order_id: orderId,
        owner_user_id: userId,
        openTaskCount: 0,
        doneTaskCount: 0,
      });

      const updateResponse = await apiRequest(request, 'PUT', '/api/projects', {
        token,
        data: { id: projectId, name: `QA API Project ${stamp} updated`, ownerUserId: null },
      });
      expect(updateResponse.status(), 'PUT /api/projects should return 200').toBe(200);

      taskAId = await createProjectTaskFixture(request, token, {
        projectId,
        name: `QA API Task A ${stamp}`,
        status: 'todo',
        description: 'Task A before update',
        ownerUserId: userId,
        deadlineAt: '2026-07-01T00:00:00.000Z',
        position: 0,
      });
      taskBId = await createProjectTaskFixture(request, token, {
        projectId,
        name: `QA API Task B ${stamp}`,
        status: 'todo',
        description: 'Task B for reorder',
        ownerUserId: userId,
        deadlineAt: '2026-07-02T00:00:00.000Z',
        position: 1,
      });

      const taskUpdateResponse = await apiRequest(request, 'PUT', '/api/projects/tasks', {
        token,
        data: {
          id: taskAId,
          projectId,
          name: `QA API Task A ${stamp} updated`,
          status: 'in_progress',
          description: 'Task A after update',
          deadlineAt: '2026-07-03T00:00:00.000Z',
          position: 1,
        },
      });
      expect(taskUpdateResponse.status(), 'PUT /api/projects/tasks should return 200').toBe(200);

      const moved = await reorderProjectTasks(request, token, {
        projectId,
        moves: [
          { id: taskBId, status: 'todo', position: 0 },
          { id: taskAId, status: 'in_progress', position: 0 },
        ],
      });
      expect(moved).toBe(2);

      const tasksAfterReorder = await readProjectTasks(request, token, projectId);
      expect(tasksAfterReorder).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: taskBId, status: 'todo', position: 0 }),
          expect.objectContaining({ id: taskAId, status: 'in_progress', position: 0 }),
        ]),
      );

      const deleteTaskResponse = await apiRequest(
        request,
        'DELETE',
        `/api/projects/tasks?id=${encodeURIComponent(taskBId)}`,
        { token },
      );
      expect(deleteTaskResponse.status(), 'DELETE /api/projects/tasks should return 200').toBe(200);
      taskBId = null;

      const listAfterTaskDelete = await apiRequest(
        request,
        'GET',
        `/api/projects?ids=${encodeURIComponent(projectId)}&pageSize=1`,
        { token },
      );
      const listAfterTaskDeleteBody = await readJsonSafe<{ items?: Array<{ openTaskCount?: number; doneTaskCount?: number }> }>(listAfterTaskDelete);
      expect(listAfterTaskDeleteBody?.items?.[0]).toMatchObject({ openTaskCount: 1, doneTaskCount: 0 });

      const deleteProjectResponse = await apiRequest(
        request,
        'DELETE',
        `/api/projects?id=${encodeURIComponent(projectId)}`,
        { token },
      );
      expect(deleteProjectResponse.status(), 'DELETE /api/projects should return 200').toBe(200);

      const projectAfterDeleteResponse = await apiRequest(
        request,
        'GET',
        `/api/projects?ids=${encodeURIComponent(projectId)}&pageSize=1`,
        { token },
      );
      const projectAfterDeleteBody = await readJsonSafe<{ items?: unknown[] }>(projectAfterDeleteResponse);
      expect(projectAfterDeleteBody?.items ?? [], 'Deleted project should disappear from active list').toHaveLength(0);

      const tasksAfterProjectDelete = await readProjectTasks(request, token, projectId);
      expect(tasksAfterProjectDelete, 'Deleting a project should remove its active tasks from the board').toHaveLength(0);
      projectId = null;
      taskAId = null;
    } finally {
      await deleteProjectTaskIfExists(request, token, taskBId);
      await deleteProjectTaskIfExists(request, token, taskAId);
      await deleteProjectIfExists(request, token, projectId);
      await deleteSalesEntityIfExists(request, token, '/api/sales/orders', orderId);
    }
  });
});
