"use client"

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { createCrud } from '@open-mercato/ui/backend/utils/crud'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ProjectTemplateForm, type ProjectTemplateValues } from '../../../../components/TemplateForms'

export default function CreateProjectTemplatePage() {
  const t = useT()
  const router = useRouter()
  return (
    <Page>
      <PageBody>
        <ProjectTemplateForm
          title={t('projects.templates.project.create.title', 'Create project template')}
          backHref="/backend/projects/templates"
          cancelHref="/backend/projects/templates"
          submitLabel={t('projects.templates.project.create.submit', 'Create project template')}
          initialValues={{ name: '', description: '', isActive: true }}
          onSubmit={async (values: ProjectTemplateValues) => {
            const { result } = await createCrud<{ id?: string }>('projects/templates', values)
            flash(t('projects.templates.project.create.flash', 'Project template created.'), 'success')
            if (result?.id) router.push(`/backend/projects/templates/${result.id}`)
            else router.push('/backend/projects/templates')
          }}
        />
      </PageBody>
    </Page>
  )
}
