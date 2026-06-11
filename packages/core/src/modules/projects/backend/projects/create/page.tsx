"use client"

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { createCrud } from '@open-mercato/ui/backend/utils/crud'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ProjectForm, type ProjectFormValues } from '../../../components/ProjectForm'

export default function CreateProjectPage() {
  const t = useT()
  const router = useRouter()

  return (
    <Page>
      <PageBody>
        <ProjectForm
          title={t('projects.create.title', 'Create project')}
          backHref="/backend/projects"
          cancelHref="/backend/projects"
          submitLabel={t('projects.create.submit', 'Create project')}
          initialValues={{ name: '', orderId: null, ownerUserId: null, isActive: true }}
          onSubmit={async (values: ProjectFormValues) => {
            const { result } = await createCrud<{ id?: string }>('projects', values)
            flash(t('projects.create.flash.created', 'Project created.'), 'success')
            if (result?.id) router.push(`/backend/projects/${result.id}`)
            else router.push('/backend/projects')
          }}
        />
      </PageBody>
    </Page>
  )
}
