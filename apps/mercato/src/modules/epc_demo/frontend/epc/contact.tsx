"use client"

import { FormEvent, useMemo, useState } from 'react'
import { Check, Send } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { EmailInput } from '@open-mercato/ui/primitives/email-input'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import {
  EPC_PROJECT_TYPE_OPTIONS,
  EPC_SERVICE_NEEDED_OPTIONS,
} from '../../lib/leadCaptureConstants'

type SubmitState = 'idle' | 'submitting' | 'success' | 'error'

type LeadFormState = {
  fullName: string
  email: string
  phone: string
  addressLine1: string
  addressLine2: string
  city: string
  region: string
  postalCode: string
  country: string
  message: string
  serviceNeeded: string[]
  projectType: string[]
  companyWebsite: string
}

const initialFormState: LeadFormState = {
  fullName: '',
  email: '',
  phone: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  region: '',
  postalCode: '',
  country: 'GB',
  message: '',
  serviceNeeded: [],
  projectType: [],
  companyWebsite: '',
}

const inputClassName =
  'border-slate-300 bg-white text-slate-950 hover:bg-slate-50 focus-within:border-emerald-700'
const inputElementClassName = 'text-slate-950 placeholder:text-slate-400'
const textareaClassName =
  'border-slate-300 bg-white text-slate-950 placeholder:text-slate-400 hover:bg-slate-50 focus-visible:border-emerald-700'

export default function EpcContactPage() {
  const t = useT()
  const [form, setForm] = useState<LeadFormState>(initialFormState)
  const [submitState, setSubmitState] = useState<SubmitState>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  const canSubmit = useMemo(
    () =>
      form.fullName.trim().length > 0 &&
      form.email.trim().length > 0 &&
      form.addressLine1.trim().length > 0 &&
      form.city.trim().length > 0 &&
      form.postalCode.trim().length > 0 &&
      form.serviceNeeded.length > 0 &&
      form.projectType.length > 0,
    [form],
  )

  function updateField(key: keyof LeadFormState, value: string) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function toggleArrayValue(key: 'serviceNeeded' | 'projectType', value: string) {
    setForm((current) => {
      const values = current[key]
      const nextValues = values.includes(value)
        ? values.filter((entry) => entry !== value)
        : [...values, value]
      return { ...current, [key]: nextValues }
    })
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit || submitState === 'submitting') return
    setSubmitState('submitting')
    setErrorMessage('')

    const response = await apiCall<{ ok?: boolean; error?: string; dealId?: string }>(
      '/api/epc/lead-capture',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      },
      { fallback: null },
    )

    if (response.ok && response.result?.ok !== false) {
      setSubmitState('success')
      setForm(initialFormState)
      return
    }

    setSubmitState('error')
    setErrorMessage(
      response.result?.error ??
      t('epcDemo.leadCapture.error', 'We could not submit your request. Please try again.'),
    )
  }

  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,#f8fafc_0%,#eef7f0_100%)] pb-40 text-slate-950 md:pb-48">
      <section className="mx-auto grid min-h-screen w-full max-w-6xl gap-10 px-5 pb-12 pt-8 md:grid-cols-[0.85fr_1.15fr] md:px-8 lg:px-10">
        <aside className="flex flex-col justify-between gap-8 py-4">
          <div>
            <div className="mb-10 flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-md bg-emerald-700 text-lg font-bold text-white">
                EPC
              </div>
              <div>
                <p className="text-sm font-semibold text-emerald-900">
                  {t('epcDemo.leadCapture.brand', 'EPC Improvements Ltd')}
                </p>
                <p className="text-xs text-slate-600">
                  {t('epcDemo.leadCapture.brandSubtitle', 'Renewable energy systems')}
                </p>
              </div>
            </div>
            <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-emerald-700">
              {t('epcDemo.leadCapture.eyebrow', 'Project enquiry')}
            </p>
            <h1 className="max-w-xl text-4xl font-semibold leading-tight text-slate-950 md:text-5xl">
              {t('epcDemo.leadCapture.title', 'Tell us about your renewable energy project')}
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-slate-650">
              {t(
                'epcDemo.leadCapture.intro',
                'Share your contact details, project address and the services you are interested in. The EPC team will use this to prepare the next step.',
              )}
            </p>
          </div>
          <div className="grid gap-3 text-sm text-slate-700">
            <div className="rounded-md border border-emerald-200 bg-white/75 p-4 shadow-sm">
              {t('epcDemo.leadCapture.noteOne', 'Heat pumps, solar PV, battery storage, MVHR, underfloor heating and aftercare.')}
            </div>
            <div className="rounded-md border border-emerald-200 bg-white/75 p-4 shadow-sm">
              {t('epcDemo.leadCapture.noteTwo', 'Your enquiry creates a web form lead in the EPC preview CRM.')}
            </div>
          </div>
        </aside>

        <form
          className="self-start rounded-lg border border-slate-200 bg-white p-5 shadow-xl md:p-7"
          onSubmit={(event) => void handleSubmit(event)}
        >
          <div className="grid gap-5">
            <div>
              <h2 className="text-xl font-semibold text-slate-950">
                {t('epcDemo.leadCapture.formTitle', 'Request a consultation')}
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {t('epcDemo.leadCapture.formSubtitle', 'Fields marked with an asterisk are required.')}
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t('epcDemo.leadCapture.fullName', 'Full name')} required>
                <Input className={inputClassName} inputClassName={inputElementClassName} value={form.fullName} onChange={(event) => updateField('fullName', event.target.value)} required />
              </Field>
              <Field label={t('epcDemo.leadCapture.email', 'Email')} required>
                <EmailInput className={inputClassName} inputClassName={inputElementClassName} placeholder="name@example.com" value={form.email} onChange={(event) => updateField('email', event.target.value)} required />
              </Field>
              <Field label={t('epcDemo.leadCapture.phone', 'Phone')}>
                <Input className={inputClassName} inputClassName={inputElementClassName} value={form.phone} onChange={(event) => updateField('phone', event.target.value)} />
              </Field>
              <Field label={t('epcDemo.leadCapture.postalCode', 'Postcode')} required>
                <Input className={inputClassName} inputClassName={inputElementClassName} value={form.postalCode} onChange={(event) => updateField('postalCode', event.target.value)} required />
              </Field>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t('epcDemo.leadCapture.addressLine1', 'Address line 1')} required>
                <Input className={inputClassName} inputClassName={inputElementClassName} value={form.addressLine1} onChange={(event) => updateField('addressLine1', event.target.value)} required />
              </Field>
              <Field label={t('epcDemo.leadCapture.addressLine2', 'Address line 2')}>
                <Input className={inputClassName} inputClassName={inputElementClassName} value={form.addressLine2} onChange={(event) => updateField('addressLine2', event.target.value)} />
              </Field>
              <Field label={t('epcDemo.leadCapture.city', 'Town or city')} required>
                <Input className={inputClassName} inputClassName={inputElementClassName} value={form.city} onChange={(event) => updateField('city', event.target.value)} required />
              </Field>
              <Field label={t('epcDemo.leadCapture.region', 'County or region')}>
                <Input className={inputClassName} inputClassName={inputElementClassName} value={form.region} onChange={(event) => updateField('region', event.target.value)} />
              </Field>
            </div>

            <fieldset className="grid gap-3">
              <legend className="text-sm font-semibold text-slate-950">
                {t('epcDemo.leadCapture.serviceNeeded', "I'm interested in")} *
              </legend>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {EPC_SERVICE_NEEDED_OPTIONS.map((option) => (
                  <CheckboxTile
                    key={option.value}
                    label={option.label}
                    checked={form.serviceNeeded.includes(option.value)}
                    onChange={() => toggleArrayValue('serviceNeeded', option.value)}
                  />
                ))}
              </div>
            </fieldset>

            <fieldset className="grid gap-3">
              <legend className="text-sm font-semibold text-slate-950">
                {t('epcDemo.leadCapture.projectType', 'What best describes your project')} *
              </legend>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {EPC_PROJECT_TYPE_OPTIONS.map((option) => (
                  <CheckboxTile
                    key={option.value}
                    label={option.label}
                    checked={form.projectType.includes(option.value)}
                    onChange={() => toggleArrayValue('projectType', option.value)}
                  />
                ))}
              </div>
            </fieldset>

            <Field label={t('epcDemo.leadCapture.message', 'Project notes')}>
              <Textarea
                value={form.message}
                onChange={(event) => updateField('message', event.target.value)}
                rows={4}
                placeholder={t('epcDemo.leadCapture.messagePlaceholder', 'Tell us about your property, timeline or any questions.')}
                className={textareaClassName}
              />
            </Field>

            <div className="hidden" aria-hidden="true">
              <label htmlFor="companyWebsite">{t('epcDemo.leadCapture.companyWebsite', 'Company website')}</label>
              <Input
                id="companyWebsite"
                tabIndex={-1}
                autoComplete="off"
                className={inputClassName}
                inputClassName={inputElementClassName}
                value={form.companyWebsite}
                onChange={(event) => updateField('companyWebsite', event.target.value)}
              />
            </div>

            {submitState === 'success' ? (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                {t('epcDemo.leadCapture.success', 'Thanks. Your enquiry has been submitted.')}
              </div>
            ) : null}

            {submitState === 'error' ? (
              <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
                {errorMessage}
              </div>
            ) : null}

            <Button type="submit" disabled={!canSubmit || submitState === 'submitting'} className="sticky bottom-48 z-20 w-full scroll-mb-48">
              <Send className="mr-2 size-4" aria-hidden="true" />
              {submitState === 'submitting'
                ? t('epcDemo.leadCapture.submitting', 'Submitting...')
                : t('epcDemo.leadCapture.submit', 'Submit enquiry')}
            </Button>
          </div>
        </form>
      </section>
    </main>
  )
}

function CheckboxTile({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: () => void
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-slate-200 bg-white p-3 text-sm font-medium text-slate-800 transition-colors hover:border-emerald-300 hover:bg-emerald-50/50">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="peer sr-only"
      />
      <span className="flex size-5 shrink-0 items-center justify-center rounded border border-slate-300 bg-white text-white peer-checked:border-emerald-700 peer-checked:bg-emerald-700">
        <Check className="size-3.5" aria-hidden="true" />
      </span>
      <span>{label}</span>
    </label>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="grid gap-1.5 text-sm font-medium text-slate-800">
      <span>
        {label}{required ? ' *' : ''}
      </span>
      {children}
    </label>
  )
}
