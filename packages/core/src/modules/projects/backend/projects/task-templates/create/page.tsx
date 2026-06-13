"use client"

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { createCrud } from '@open-mercato/ui/backend/utils/crud'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ProjectTaskTemplateForm, type ProjectTaskTemplateValues } from '../../../../components/TemplateForms'

export default function CreateProjectTaskTemplatePage() {
  const t = useT()
  const router = useRouter()
  return (
    <Page>
      <PageBody>
        <ProjectTaskTemplateForm
          title={t('projects.templates.task.create.title', 'Create task template')}
          backHref="/backend/projects/task-templates"
          cancelHref="/backend/projects/task-templates"
          submitLabel={t('projects.templates.task.create.submit', 'Create task template')}
          initialValues={{ name: '', status: 'todo', description: '', ownerUserId: null, dueInDays: null, isActive: true }}
          onSubmit={async (values: ProjectTaskTemplateValues) => {
            const { result } = await createCrud<{ id?: string }>('projects/task-templates', values)
            flash(t('projects.templates.task.create.flash', 'Task template created.'), 'success')
            if (result?.id) router.push(`/backend/projects/task-templates/${result.id}`)
            else router.push('/backend/projects/task-templates')
          }}
        />
      </PageBody>
    </Page>
  )
}
