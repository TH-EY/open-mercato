import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomInt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
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
} from '@open-mercato/core/helpers/integration/projectsFixtures';
import { deleteAttachmentIfExists } from '@open-mercato/core/helpers/integration/attachmentsFixtures';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function setEnglishLocale(page: Page) {
  await page.context().addCookies([{ name: 'locale', value: 'en', url: BASE_URL, sameSite: 'Lax' }]);
}

async function loginEnglish(page: Page) {
  await setEnglishLocale(page);
  await login(page, 'admin');
  await setEnglishLocale(page);
}

async function createSalesOrder(request: APIRequestContext, token: string, orderNumber: string): Promise<string> {
  const response = await apiRequest(request, 'POST', '/api/sales/orders', {
    token,
    data: { orderNumber, currencyCode: 'USD' },
  });
  const body = await readJsonSafe<{ id?: string; orderId?: string }>(response);
  expect(response.status(), 'POST /api/sales/orders should return 201').toBe(201);
  expect(typeof (body?.id ?? body?.orderId) === 'string', 'Sales order response should include id').toBe(true);
  return (body?.id ?? body?.orderId) as string;
}

test.describe('TC-PROJ-002: Projects UI Kanban flow', () => {
  test.describe.configure({ timeout: 45_000 });

  test('should create a project through the English UI and show it in the table', async ({ page, request }) => {
    const adminToken = await getAuthToken(request, 'admin');
    const stamp = `${Date.now()}-${randomInt(1_000_000)}`;
    const projectName = `QA UI Project ${stamp}`;
    let projectId: string | null = null;

    try {
      await loginEnglish(page);
      await page.goto('/backend/projects/create', { waitUntil: 'domcontentloaded' });

      await expect(page.getByRole('main').getByText('Create project').first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Operations' }).first()).toBeVisible();
      await page.getByRole('main').getByRole('textbox').fill(projectName);
      await page.getByRole('main').getByRole('button', { name: 'Create project' }).last().click();

      await page.waitForURL(/\/backend\/projects\/[0-9a-f-]+(?:\?.*)?$/, { timeout: 10_000 });
      projectId = page.url().match(/\/backend\/projects\/([0-9a-f-]+)/)?.[1] ?? null;
      expect(projectId, 'Created project detail URL should include id').toBeTruthy();
      await expect(page.getByRole('heading', { name: projectName })).toBeVisible();

      await page.goto('/backend/projects', { waitUntil: 'domcontentloaded' });
      const projectRow = page.getByRole('row', { name: new RegExp(projectName) });
      await expect(projectRow).toBeVisible();
      await expect(projectRow).toContainText('0 open / 0 done');
      await projectRow.getByRole('button', { name: 'Open actions' }).click();
      await page.getByRole('menuitem', { name: 'Kanban board' }).click();
      await page.waitForURL(new RegExp(`/backend/projects/${projectId}/board(?:\\?.*)?$`), { timeout: 10_000 });
      await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
      await expect(page.getByText('Todo', { exact: true })).toBeVisible();

      const createdProjectResponse = await apiRequest(request, 'GET', `/api/projects?id=${projectId}`, {
        token: adminToken,
      });
      expect(createdProjectResponse.status(), 'Created project should be discoverable through API').toBe(200);
    } finally {
      await deleteProjectIfExists(request, adminToken, projectId);
    }
  });

  test('should create and edit tasks from board columns and upload an attachment through AttachmentInput', async ({ page, request }, testInfo) => {
    const adminToken = await getAuthToken(request, 'admin');
    const { userId } = getTokenScope(adminToken);
    const stamp = `${Date.now()}-${randomInt(1_000_000)}`;
    const projectName = `QA UI Board Project ${stamp}`;
    const taskAName = `QA UI Task A ${stamp}`;
    const taskDoneName = `QA UI Task Done ${stamp}`;
    let orderId: string | null = null;
    let projectId: string | null = null;
    let taskAId: string | null = null;
    let taskDoneId: string | null = null;
    let attachmentId: string | null = null;

    try {
      orderId = await createSalesOrder(request, adminToken, `QA-PROJ-BOARD-${stamp}`);
      projectId = await createProjectFixture(request, adminToken, {
        name: projectName,
        orderId,
        ownerUserId: userId,
      });

      await loginEnglish(page);
      await page.goto(`/backend/projects/${projectId}/board`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
      await expect(page.getByText('Todo', { exact: true })).toBeVisible();
      await expect(page.getByText('In progress', { exact: true })).toBeVisible();
      await expect(page.getByText('Done', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Add task to Todo' }).click();
      let taskDialog = page.getByRole('dialog');
      await expect(taskDialog.getByRole('heading', { name: 'Create task' })).toBeVisible();
      await taskDialog.getByLabel('Name').fill(taskAName);
      await taskDialog.getByLabel('Deadline').fill('2026-07-01');
      await taskDialog.getByLabel('Description').fill('Task A created from the Todo column.');
      await taskDialog.getByRole('button', { name: 'Save' }).click();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: new RegExp(taskAName) })).toBeVisible();

      await page.getByRole('button', { name: 'Add task to Done' }).click();
      taskDialog = page.getByRole('dialog');
      await taskDialog.getByLabel('Name').fill(taskDoneName);
      await taskDialog.getByLabel('Deadline').fill('2026-07-02');
      await taskDialog.getByLabel('Description').fill('Task created directly in Done.');
      await taskDialog.getByRole('button', { name: 'Save' }).click();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: new RegExp(taskDoneName) })).toBeVisible();

      const tasks = await readProjectTasks(request, adminToken, projectId);
      taskAId = tasks.find((task) => task.name === taskAName)?.id ?? null;
      taskDoneId = tasks.find((task) => task.name === taskDoneName)?.id ?? null;
      expect(taskAId, 'Task A should exist').toBeTruthy();
      expect(taskDoneId, 'Done task should exist').toBeTruthy();

      await page.getByRole('button', { name: new RegExp(taskAName) }).click();
      taskDialog = page.getByRole('dialog');
      await expect(taskDialog.getByRole('heading', { name: 'Edit task' })).toBeVisible();
      await taskDialog.getByLabel('Status').selectOption('in_progress');
      await taskDialog.getByLabel('Description').fill('Task A edited through the board dialog.');
      await taskDialog.getByLabel('Deadline').fill('2026-07-04');
      await taskDialog.getByRole('button', { name: 'Save' }).click();
      await expect(taskDialog).toBeHidden();

      const attachmentPath = testInfo.outputPath(`qa-projects-${stamp}.txt`);
      writeFileSync(attachmentPath, `QA Projects attachment ${stamp}`, 'utf8');
      await page.getByRole('button', { name: new RegExp(taskAName) }).click();
      taskDialog = page.getByRole('dialog');
      await taskDialog.locator('input[type="file"]').setInputFiles(attachmentPath);
      await expect(taskDialog.getByRole('link', { name: `qa-projects-${stamp}.txt` })).toBeVisible();
      await taskDialog.getByRole('button', { name: 'Cancel' }).click();

      const attachmentResponse = await apiRequest(
        request,
        'GET',
        `/api/attachments?entityId=${encodeURIComponent('projects:project_task')}&recordId=${encodeURIComponent(taskAId as string)}`,
        { token: adminToken },
      );
      const attachmentBody = await readJsonSafe<{ items?: Array<{ id?: string; fileName?: string }> }>(attachmentResponse);
      attachmentId = attachmentBody?.items?.find((item) => item.fileName === `qa-projects-${stamp}.txt`)?.id ?? null;
      expect(attachmentId, 'Uploaded task attachment should be discoverable through API').toBeTruthy();

      const tasksAfterEdit = await readProjectTasks(request, adminToken, projectId);
      expect(tasksAfterEdit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: taskAId, status: 'in_progress' }),
          expect.objectContaining({ id: taskDoneId, status: 'done', position: 0 }),
        ]),
      );
    } finally {
      await deleteAttachmentIfExists(request, adminToken, attachmentId);
      await deleteProjectTaskIfExists(request, adminToken, taskDoneId);
      await deleteProjectTaskIfExists(request, adminToken, taskAId);
      await deleteProjectIfExists(request, adminToken, projectId);
      await deleteSalesEntityIfExists(request, adminToken, '/api/sales/orders', orderId);
    }
  });

  test('should persist drag/drop status changes and ordering after reload', async ({ page, request }) => {
    const adminToken = await getAuthToken(request, 'admin');
    const { userId } = getTokenScope(adminToken);
    const stamp = `${Date.now()}-${randomInt(1_000_000)}`;
    const projectName = `QA UI Reorder Project ${stamp}`;
    const taskAName = `QA UI Reorder Task A ${stamp}`;
    const taskBName = `QA UI Reorder Task B ${stamp}`;
    let orderId: string | null = null;
    let projectId: string | null = null;
    let taskAId: string | null = null;
    let taskBId: string | null = null;

    try {
      orderId = await createSalesOrder(request, adminToken, `QA-PROJ-REORDER-${stamp}`);
      projectId = await createProjectFixture(request, adminToken, {
        name: projectName,
        orderId,
        ownerUserId: userId,
      });
      taskAId = await createProjectTaskFixture(request, adminToken, {
        projectId,
        name: taskAName,
        status: 'in_progress',
        position: 0,
      });
      taskBId = await createProjectTaskFixture(request, adminToken, {
        projectId,
        name: taskBName,
        status: 'todo',
        position: 0,
      });

      await loginEnglish(page);
      await page.goto(`/backend/projects/${projectId}/board`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: projectName })).toBeVisible();

      await page.getByRole('button', { name: new RegExp(taskBName) }).dragTo(
        page.getByRole('button', { name: new RegExp(taskAName) }),
      );
      await page.waitForTimeout(500);
      await page.reload({ waitUntil: 'domcontentloaded' });

      await expect(page.getByRole('button', { name: new RegExp(taskBName) })).toBeVisible();
      await expect(page.getByRole('button', { name: new RegExp(taskAName) })).toBeVisible();
      const tasks = await readProjectTasks(request, adminToken, projectId);
      expect(tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: taskBId, status: 'in_progress', position: 0 }),
          expect.objectContaining({ id: taskAId, status: 'in_progress', position: 1 }),
        ]),
      );
    } finally {
      await deleteProjectTaskIfExists(request, adminToken, taskBId);
      await deleteProjectTaskIfExists(request, adminToken, taskAId);
      await deleteProjectIfExists(request, adminToken, projectId);
      await deleteSalesEntityIfExists(request, adminToken, '/api/sales/orders', orderId);
    }
  });
});
