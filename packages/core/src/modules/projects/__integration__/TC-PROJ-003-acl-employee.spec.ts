import { expect, test } from '@playwright/test';
import { randomInt } from 'node:crypto';
import { login } from '@open-mercato/core/helpers/integration/auth';
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

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function createSalesOrder(request: Parameters<typeof apiRequest>[0], token: string, orderNumber: string): Promise<string> {
  const response = await apiRequest(request, 'POST', '/api/sales/orders', {
    token,
    data: { orderNumber, currencyCode: 'USD' },
  });
  const body = await readJsonSafe<{ id?: string; orderId?: string }>(response);
  expect(response.status(), 'POST /api/sales/orders should return 201').toBe(201);
  expect(typeof (body?.id ?? body?.orderId) === 'string', 'Sales order response should include id').toBe(true);
  return (body?.id ?? body?.orderId) as string;
}

test.describe('TC-PROJ-003: Projects employee ACL', () => {
  test.describe.configure({ timeout: 45_000 });

  test('employee should view projects and manage tasks but not project metadata', async ({ page, request }) => {
    const adminToken = await getAuthToken(request, 'admin');
    const employeeToken = await getAuthToken(request, 'employee');
    const { userId: adminUserId } = getTokenScope(adminToken);
    const { userId: employeeUserId } = getTokenScope(employeeToken);
    const stamp = `${Date.now()}-${randomInt(1_000_000)}`;
    const projectName = `QA ACL Project ${stamp}`;
    let orderId: string | null = null;
    let projectId: string | null = null;
    let adminTaskId: string | null = null;
    let employeeTaskId: string | null = null;

    try {
      orderId = await createSalesOrder(request, adminToken, `QA-PROJ-ACL-${stamp}`);
      projectId = await createProjectFixture(request, adminToken, {
        name: projectName,
        orderId,
        ownerUserId: adminUserId,
      });
      adminTaskId = await createProjectTaskFixture(request, adminToken, {
        projectId,
        name: `QA ACL Admin Task ${stamp}`,
        status: 'todo',
        ownerUserId: adminUserId,
        position: 0,
      });

      const employeeFeatureCheck = await apiRequest(request, 'POST', '/api/auth/feature-check', {
        token: employeeToken,
        data: { features: ['projects.view', 'projects.tasks.manage', 'projects.manage'] },
      });
      const employeeFeatureBody = await readJsonSafe<{ granted?: string[] }>(employeeFeatureCheck);
      expect(employeeFeatureBody?.granted ?? []).toEqual(
        expect.arrayContaining(['projects.view', 'projects.tasks.manage']),
      );
      expect(employeeFeatureBody?.granted ?? []).not.toContain('projects.manage');

      const employeeProjectList = await apiRequest(
        request,
        'GET',
        `/api/projects?ids=${encodeURIComponent(projectId)}&pageSize=1`,
        { token: employeeToken },
      );
      expect(employeeProjectList.status(), 'Employee should be able to list projects').toBe(200);

      const employeeCreateProject = await apiRequest(request, 'POST', '/api/projects', {
        token: employeeToken,
        data: { name: `QA forbidden project ${stamp}` },
      });
      expect(employeeCreateProject.status(), 'Employee should not create projects').toBe(403);

      const employeeUpdateProject = await apiRequest(request, 'PUT', '/api/projects', {
        token: employeeToken,
        data: { id: projectId, name: `${projectName} forbidden` },
      });
      expect(employeeUpdateProject.status(), 'Employee should not update project metadata').toBe(403);

      const employeeDeleteProject = await apiRequest(
        request,
        'DELETE',
        `/api/projects?id=${encodeURIComponent(projectId)}`,
        { token: employeeToken },
      );
      expect(employeeDeleteProject.status(), 'Employee should not delete projects').toBe(403);

      employeeTaskId = await createProjectTaskFixture(request, employeeToken, {
        projectId,
        name: `QA ACL Employee Task ${stamp}`,
        status: 'todo',
        ownerUserId: employeeUserId,
        position: 1,
      });

      const employeeUpdateTask = await apiRequest(request, 'PUT', '/api/projects/tasks', {
        token: employeeToken,
        data: {
          id: employeeTaskId,
          projectId,
          name: `QA ACL Employee Task ${stamp} updated`,
          status: 'in_progress',
          ownerUserId: employeeUserId,
          position: 0,
        },
      });
      expect(employeeUpdateTask.status(), 'Employee should update project tasks').toBe(200);

      await reorderProjectTasks(request, employeeToken, {
        projectId,
        moves: [
          { id: employeeTaskId, status: 'in_progress', position: 0 },
          { id: adminTaskId, status: 'todo', position: 0 },
        ],
      });
      const tasksAfterEmployeeMove = await readProjectTasks(request, employeeToken, projectId);
      expect(tasksAfterEmployeeMove).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: employeeTaskId, status: 'in_progress', position: 0 }),
          expect.objectContaining({ id: adminTaskId, status: 'todo', position: 0 }),
        ]),
      );

      await page.context().addCookies([{ name: 'locale', value: 'en', url: BASE_URL, sameSite: 'Lax' }]);
      await login(page, 'employee');
      await page.context().addCookies([{ name: 'locale', value: 'en', url: BASE_URL, sameSite: 'Lax' }]);
      await page.goto('/backend/projects', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
      await expect(page.getByRole('row', { name: new RegExp(projectName) })).toBeVisible();
      await expect(page.getByRole('link', { name: /New project|Create project/i })).toHaveCount(0);

      await page.goto(`/backend/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
      await expect(page.getByRole('main').getByRole('textbox')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);

      const projectAfterUiAttempt = await apiRequest(
        request,
        'GET',
        `/api/projects?ids=${encodeURIComponent(projectId)}&pageSize=1`,
        { token: adminToken },
      );
      const projectAfterUiAttemptBody = await readJsonSafe<{ items?: Array<{ name?: string }> }>(projectAfterUiAttempt);
      expect(projectAfterUiAttemptBody?.items?.[0]?.name, 'Employee UI save should not update project metadata').toBe(projectName);
    } finally {
      await deleteProjectTaskIfExists(request, adminToken, employeeTaskId);
      await deleteProjectTaskIfExists(request, adminToken, adminTaskId);
      await deleteProjectIfExists(request, adminToken, projectId);
      await deleteSalesEntityIfExists(request, adminToken, '/api/sales/orders', orderId);
    }
  });
});
