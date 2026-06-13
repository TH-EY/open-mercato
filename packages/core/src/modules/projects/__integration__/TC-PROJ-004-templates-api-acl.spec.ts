import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { getTokenScope, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures';
import {
  createProjectFixture,
  createProjectTaskTemplateFixture,
  createProjectTemplateFixture,
  createProjectTemplateTaskFixture,
  deleteProjectIfExists,
  deleteProjectTaskTemplateIfExists,
  deleteProjectTemplateIfExists,
  deleteProjectTemplateTaskIfExists,
  readProjectTasks,
  readProjectTemplateTasks,
} from '@open-mercato/core/helpers/integration/projectsFixtures';

test.describe('TC-PROJ-004: Project and task templates API, ACL, and create-from-template', () => {
  test('should manage templates and instantiate project tasks from a template', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin');
    const employeeToken = await getAuthToken(request, 'employee');
    const { userId } = getTokenScope(adminToken);
    const stamp = Date.now();
    let taskTemplateId: string | null = null;
    let projectTemplateId: string | null = null;
    let templateTaskAId: string | null = null;
    let templateTaskBId: string | null = null;
    let projectId: string | null = null;

    try {
      const employeeCreateResponse = await apiRequest(request, 'POST', '/api/projects/task-templates', {
        token: employeeToken,
        data: { name: `QA forbidden task template ${stamp}`, status: 'todo' },
      });
      expect(employeeCreateResponse.status(), 'Employee should not manage task templates').toBe(403);

      taskTemplateId = await createProjectTaskTemplateFixture(request, adminToken, {
        name: `QA Template Task ${stamp}`,
        status: 'todo',
        description: 'Reusable task template description',
        ownerUserId: userId,
        dueInDays: 3,
      });

      projectTemplateId = await createProjectTemplateFixture(request, adminToken, {
        name: `QA Project Template ${stamp}`,
        description: 'Reusable project template description',
      });

      templateTaskAId = await createProjectTemplateTaskFixture(request, adminToken, {
        projectTemplateId,
        taskTemplateId,
        status: 'in_progress',
        position: 0,
      });
      templateTaskBId = await createProjectTemplateTaskFixture(request, adminToken, {
        projectTemplateId,
        name: `QA Inline Template Task ${stamp}`,
        status: 'done',
        description: 'Inline project template task description',
        ownerUserId: userId,
        dueInDays: 5,
        position: 1,
      });

      const templateTasks = await readProjectTemplateTasks(request, adminToken, projectTemplateId);
      expect(templateTasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: templateTaskAId, task_template_id: taskTemplateId, status: 'in_progress', position: 0 }),
          expect.objectContaining({ id: templateTaskBId, name: `QA Inline Template Task ${stamp}`, status: 'done', position: 1 }),
        ]),
      );

      projectId = await createProjectFixture(request, adminToken, {
        name: `QA Project From Template ${stamp}`,
        ownerUserId: userId,
        templateId: projectTemplateId,
      });

      const tasks = await readProjectTasks(request, adminToken, projectId);
      expect(tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: `QA Template Task ${stamp}`,
            status: 'in_progress',
            description: 'Reusable task template description',
            owner_user_id: userId,
            position: 0,
          }),
          expect.objectContaining({
            name: `QA Inline Template Task ${stamp}`,
            status: 'done',
            description: 'Inline project template task description',
            owner_user_id: userId,
            position: 1,
          }),
        ]),
      );
      const taskA = tasks.find((task) => task.name === `QA Template Task ${stamp}`);
      const taskB = tasks.find((task) => task.name === `QA Inline Template Task ${stamp}`);
      expect(taskA?.deadline_at ?? taskA?.deadlineAt, 'Task template dueInDays should become a deadline').toBeTruthy();
      expect(taskB?.deadline_at ?? taskB?.deadlineAt, 'Inline dueInDays should become a deadline').toBeTruthy();

      const softDeleteResponse = await apiRequest(
        request,
        'DELETE',
        `/api/projects/templates?id=${encodeURIComponent(projectTemplateId)}`,
        { token: adminToken },
      );
      expect(softDeleteResponse.status(), 'DELETE /api/projects/templates should return 200').toBe(200);
      const deletedProjectTemplateId = projectTemplateId;
      projectTemplateId = null;
      templateTaskAId = null;
      templateTaskBId = null;

      const deletedTemplateCreateResponse = await apiRequest(request, 'POST', '/api/projects', {
        token: adminToken,
        data: {
          name: `QA Project From Deleted Template ${stamp}`,
          templateId: deletedProjectTemplateId,
        },
      });
      expect(deletedTemplateCreateResponse.status(), 'Project create should reject missing/deleted templates').toBe(400);
    } finally {
      await deleteProjectIfExists(request, adminToken, projectId);
      await deleteProjectTemplateTaskIfExists(request, adminToken, templateTaskBId);
      await deleteProjectTemplateTaskIfExists(request, adminToken, templateTaskAId);
      await deleteProjectTemplateIfExists(request, adminToken, projectTemplateId);
      await deleteProjectTaskTemplateIfExists(request, adminToken, taskTemplateId);
    }
  });
});
