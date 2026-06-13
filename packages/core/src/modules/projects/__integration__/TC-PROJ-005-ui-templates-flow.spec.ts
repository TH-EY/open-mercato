import { expect, test, type Page } from '@playwright/test';
import { randomInt } from 'node:crypto';
import { login } from '@open-mercato/core/helpers/integration/auth';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import {
  deleteProjectIfExists,
  deleteProjectTaskTemplateIfExists,
  deleteProjectTemplateIfExists,
  readProjectTasks,
  readProjectTemplateTasks,
} from '@open-mercato/core/helpers/integration/projectsFixtures';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function setEnglishLocale(page: Page) {
  await page.context().addCookies([{ name: 'locale', value: 'en', url: BASE_URL, sameSite: 'Lax' }]);
}

async function loginEnglish(page: Page, role: 'admin' | 'employee' = 'admin') {
  await setEnglishLocale(page);
  await login(page, role);
  await setEnglishLocale(page);
}

test.describe('TC-PROJ-005: Projects templates UI flow', () => {
  test.describe.configure({ timeout: 60_000 });

  test('should create templates through UI and instantiate a project from a template', async ({ page, request }) => {
    const adminToken = await getAuthToken(request, 'admin');
    const stamp = `${Date.now()}-${randomInt(1_000_000)}`;
    const taskTemplateName = `QA UI Task Template ${stamp}`;
    const projectTemplateName = `QA UI Project Template ${stamp}`;
    const projectName = `QA UI Project From Template ${stamp}`;
    let taskTemplateId: string | null = null;
    let projectTemplateId: string | null = null;
    let projectId: string | null = null;

    try {
      await loginEnglish(page);

      await page.goto('/backend/projects/task-templates/create', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('main').getByText('Create task template').first()).toBeVisible();
      await page.locator('main input').nth(0).fill(taskTemplateName);
      await page.locator('main select').nth(0).selectOption('todo');
      await page.locator('main textarea').nth(0).fill('Reusable task template from UI.');
      await page.locator('main input').nth(1).fill('4');
      await page.getByRole('main').getByRole('button', { name: 'Create task template' }).last().click();
      await page.waitForURL(/\/backend\/projects\/task-templates\/[0-9a-f-]+(?:\?.*)?$/, { timeout: 10_000 });
      taskTemplateId = page.url().match(/\/backend\/projects\/task-templates\/([0-9a-f-]+)/)?.[1] ?? null;
      expect(taskTemplateId, 'Task template detail URL should include id').toBeTruthy();

      await page.goto('/backend/projects/templates/create', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('main').getByText('Create project template').first()).toBeVisible();
      await page.locator('main input').nth(0).fill(projectTemplateName);
      await page.locator('main textarea').nth(0).fill('Reusable project template from UI.');
      await page.getByRole('main').getByRole('button', { name: 'Create project template' }).last().click();
      await page.waitForURL(/\/backend\/projects\/templates\/[0-9a-f-]+(?:\?.*)?$/, { timeout: 10_000 });
      projectTemplateId = page.url().match(/\/backend\/projects\/templates\/([0-9a-f-]+)/)?.[1] ?? null;
      expect(projectTemplateId, 'Project template detail URL should include id').toBeTruthy();

      await page.getByRole('button', { name: 'Add task' }).click();
      await page.locator('main select').nth(0).selectOption(taskTemplateId as string);
      await page.locator('main input').nth(0).fill('0');
      await page.getByRole('button', { name: 'Save' }).last().click();
      await expect(page.getByText(`From ${taskTemplateName}`)).toBeVisible();

      const templateTasks = await readProjectTemplateTasks(request, adminToken, projectTemplateId as string);
      expect(templateTasks).toHaveLength(1);

      await page.goto('/backend/projects/create', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('main').getByText('Create project').first()).toBeVisible();
      await page.locator('main input').nth(0).fill(projectName);
      await page.locator('main select').nth(0).selectOption(projectTemplateId as string);
      await expect(page.getByText(taskTemplateName).first()).toBeVisible();
      await page.getByRole('main').getByRole('button', { name: 'Create project' }).last().click();
      await page.waitForURL(/\/backend\/projects\/[0-9a-f-]+(?:\?.*)?$/, { timeout: 10_000 });
      projectId = page.url().match(/\/backend\/projects\/([0-9a-f-]+)/)?.[1] ?? null;
      expect(projectId, 'Project detail URL should include id').toBeTruthy();

      await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
      await expect(page.getByRole('button', { name: new RegExp(taskTemplateName) })).toBeVisible();
      const tasks = await readProjectTasks(request, adminToken, projectId as string);
      expect(tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: taskTemplateName,
            status: 'todo',
            description: 'Reusable task template from UI.',
            position: 0,
          }),
        ]),
      );
      expect(tasks[0]?.deadline_at ?? tasks[0]?.deadlineAt, 'Created task should have deadline from dueInDays').toBeTruthy();
    } finally {
      await deleteProjectIfExists(request, adminToken, projectId);
      await deleteProjectTemplateIfExists(request, adminToken, projectTemplateId);
      await deleteProjectTaskTemplateIfExists(request, adminToken, taskTemplateId);
    }
  });

  test('should not expose template management screens to employee users', async ({ page }) => {
    await loginEnglish(page, 'employee');
    await page.goto('/backend/projects/templates', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('main').getByText('Project templates')).toHaveCount(0);
    await page.goto('/backend/projects/task-templates', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('main').getByText('Task templates')).toHaveCount(0);
  });
});
