"use client"

import { FormEvent, useMemo, useState } from 'react'
import { Check } from 'lucide-react'
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

const EPC_LOGO_URL = 'https://a.storyblok.com/f/121993/300x102/47817a7e1d/epc-colour.svg'
const EPC_MCS_BADGE_URL = 'https://epc-improvements.co.uk/_nuxt/mcs-certified.BUgcThi5.svg'
const EPC_SUPPORT_ICON_URL =
  'https://a.storyblok.com/f/121993/x/e0b6de1f1d/icon_support-customer-support.svg'
const EPC_EMAIL_ICON_URL = 'https://a.storyblok.com/f/121993/36x35/23896d5668/email-icon.svg'
const EPC_CHAT_ICON_URL = 'https://a.storyblok.com/f/121993/150x150/1aeb8d263a/icon_support-live-chat.svg'

const EPC_UTILITY_NAV_ITEMS = [
  { labelKey: 'epcDemo.leadCapture.utilityNav.about', label: 'About Us', href: 'https://epc-improvements.co.uk/about-us' },
  { labelKey: 'epcDemo.leadCapture.utilityNav.contact', label: 'Contact Us', href: 'https://epc-improvements.co.uk/contact-us' },
  { labelKey: 'epcDemo.leadCapture.utilityNav.blog', label: 'Blog', href: 'https://epc-improvements.co.uk/blog' },
  { labelKey: 'epcDemo.leadCapture.utilityNav.quote', label: 'Get a Quote', href: 'https://epc-improvements.co.uk/get-a-quote' },
]

const EPC_NAV_ITEMS = [
  { labelKey: 'epcDemo.leadCapture.nav.products', label: 'Products', href: 'https://epc-improvements.co.uk/products' },
  { labelKey: 'epcDemo.leadCapture.nav.residential', label: 'Residential', href: 'https://epc-improvements.co.uk/residential' },
  { labelKey: 'epcDemo.leadCapture.nav.commercial', label: 'Commercial', href: 'https://epc-improvements.co.uk/commercial' },
  { labelKey: 'epcDemo.leadCapture.nav.servicing', label: 'Servicing', href: 'https://epc-improvements.co.uk/servicing' },
  { labelKey: 'epcDemo.leadCapture.nav.finance', label: 'Finance', href: 'https://epc-improvements.co.uk/finance' },
]

const inputClassName =
  'h-12 rounded-md border-[#d7e0e3] bg-white text-[#00293D] shadow-none hover:bg-white focus-within:border-[#00755f] focus-within:shadow-none'
const inputElementClassName = 'text-[#00293D] placeholder:text-[#607076]'
const textareaClassName =
  'rounded-md border-[#d7e0e3] bg-white text-[#00293D] shadow-none placeholder:text-[#607076] hover:bg-white focus-visible:border-[#00755f] focus-visible:shadow-none'

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
    <main className="min-h-screen bg-[#eef3f4] pb-40 text-[#00293D] md:pb-48">
      <EpcHeader />

      <section className="px-5 py-12 md:px-8 md:py-16 lg:px-10">
        <div className="mx-auto max-w-[1320px]">
          <div className="mx-auto mb-10 max-w-[920px] text-center md:mb-14">
            <h1 className="text-[2.65rem] font-semibold leading-tight tracking-normal text-[#00293D] md:text-[4.2rem]">
              {t('epcDemo.leadCapture.title', 'Reach out to the team.')}
            </h1>
            <p className="mx-auto mt-5 max-w-[760px] text-base leading-7 text-[#607076] md:text-lg">
              {t(
                'epcDemo.leadCapture.intro',
                "Renewable energy installation will help with electricity bills and lower your carbon emissions. Ready to talk? Complete the contact form below and we'll be in touch.",
              )}
            </p>
          </div>

          <div className="grid gap-7 lg:grid-cols-12 lg:gap-9">
            <form
              className="self-start rounded-[18px] bg-white p-5 shadow-[0_18px_45px_rgba(0,41,61,0.08)] md:p-8 lg:col-span-8"
              onSubmit={(event) => void handleSubmit(event)}
            >
              <div className="grid gap-6">
                <div>
                  <h2 className="text-2xl font-semibold text-[#00293D]">
                    {t('epcDemo.leadCapture.formTitle', 'Get in contact with us')}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-[#607076]">
                    {t('epcDemo.leadCapture.formSubtitle', 'Fields marked with an asterisk are required.')}
                  </p>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <Field label={t('epcDemo.leadCapture.fullName', 'Full Name')} required>
                    <Input
                      className={inputClassName}
                      inputClassName={inputElementClassName}
                      value={form.fullName}
                      onChange={(event) => updateField('fullName', event.target.value)}
                      required
                    />
                  </Field>
                  <Field label={t('epcDemo.leadCapture.email', 'Email Address')} required>
                    <EmailInput
                      className={inputClassName}
                      inputClassName={inputElementClassName}
                      placeholder="name@example.com"
                      value={form.email}
                      onChange={(event) => updateField('email', event.target.value)}
                      required
                    />
                  </Field>
                  <Field label={t('epcDemo.leadCapture.phone', 'Contact Number')}>
                    <Input
                      className={inputClassName}
                      inputClassName={inputElementClassName}
                      value={form.phone}
                      onChange={(event) => updateField('phone', event.target.value)}
                    />
                  </Field>
                  <Field label={t('epcDemo.leadCapture.postalCode', 'Postcode')} required>
                    <Input
                      className={inputClassName}
                      inputClassName={inputElementClassName}
                      value={form.postalCode}
                      onChange={(event) => updateField('postalCode', event.target.value)}
                      required
                    />
                  </Field>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <Field label={t('epcDemo.leadCapture.addressLine1', 'Address line 1')} required>
                    <Input
                      className={inputClassName}
                      inputClassName={inputElementClassName}
                      value={form.addressLine1}
                      onChange={(event) => updateField('addressLine1', event.target.value)}
                      required
                    />
                  </Field>
                  <Field label={t('epcDemo.leadCapture.addressLine2', 'Address line 2')}>
                    <Input
                      className={inputClassName}
                      inputClassName={inputElementClassName}
                      value={form.addressLine2}
                      onChange={(event) => updateField('addressLine2', event.target.value)}
                    />
                  </Field>
                  <Field label={t('epcDemo.leadCapture.city', 'Town or city')} required>
                    <Input
                      className={inputClassName}
                      inputClassName={inputElementClassName}
                      value={form.city}
                      onChange={(event) => updateField('city', event.target.value)}
                      required
                    />
                  </Field>
                  <Field label={t('epcDemo.leadCapture.region', 'County or region')}>
                    <Input
                      className={inputClassName}
                      inputClassName={inputElementClassName}
                      value={form.region}
                      onChange={(event) => updateField('region', event.target.value)}
                    />
                  </Field>
                </div>

                <fieldset className="grid gap-3">
                  <legend className="text-sm font-semibold text-[#00293D]">
                    {t('epcDemo.leadCapture.serviceNeeded', "I'm interested in")} *
                  </legend>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
                  <legend className="text-sm font-semibold text-[#00293D]">
                    {t('epcDemo.leadCapture.projectType', 'What best describes your project')} *
                  </legend>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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

                <Field label={t('epcDemo.leadCapture.message', 'Message')}>
                  <Textarea
                    value={form.message}
                    onChange={(event) => updateField('message', event.target.value)}
                    rows={5}
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
                  <div className="rounded-md border border-[#b7ddcc] bg-[#edf8f3] p-4 text-sm font-medium text-[#00644f]">
                    {t('epcDemo.leadCapture.success', 'Thanks. Your enquiry has been submitted.')}
                  </div>
                ) : null}

                {submitState === 'error' ? (
                  <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
                    {errorMessage}
                  </div>
                ) : null}

                <Button
                  type="submit"
                  disabled={!canSubmit || submitState === 'submitting'}
                  className="sticky bottom-6 z-20 h-12 w-full scroll-mb-24 rounded-full bg-[#00755f] px-8 text-base font-semibold text-white shadow-none hover:bg-[#00644f] disabled:bg-[#9bb7b1] disabled:text-white md:static md:w-auto md:justify-self-start"
                >
                  {submitState === 'submitting'
                    ? t('epcDemo.leadCapture.submitting', 'Sending...')
                    : t('epcDemo.leadCapture.submit', 'Send')}
                </Button>
              </div>
            </form>

            <ContactDetails />
          </div>
        </div>
      </section>

      <section className="bg-white px-5 py-16 md:px-8 md:py-24 lg:px-10">
        <div className="mx-auto max-w-[1320px]">
          <h2 className="text-center text-3xl font-semibold tracking-normal text-[#00293D] md:text-5xl">
            {t('epcDemo.leadCapture.getInTouchTitle', 'Get in touch with EPC')}
          </h2>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            <ContactMethodCard
              iconUrl={EPC_SUPPORT_ICON_URL}
              iconAlt={t('epcDemo.leadCapture.phoneIconAlt', 'Customer support')}
              title={t('epcDemo.leadCapture.phoneTitle', 'Phone')}
              body={t('epcDemo.leadCapture.phoneBody', 'Speak to one of our friendly team members today.')}
              linkLabel="01245 408 792"
              href="tel:01245408792"
            />
            <ContactMethodCard
              iconUrl={EPC_EMAIL_ICON_URL}
              iconAlt={t('epcDemo.leadCapture.emailIconAlt', 'Email')}
              title={t('epcDemo.leadCapture.emailTitle', 'Email')}
              body={t('epcDemo.leadCapture.emailBody', 'Send us an email and we will get back to you.')}
              linkLabel="sales@epc-improvements.co.uk"
              href="mailto:sales@epc-improvements.co.uk"
              iconSizeClassName="h-10 w-10"
            />
            <ContactMethodCard
              iconUrl={EPC_CHAT_ICON_URL}
              iconAlt={t('epcDemo.leadCapture.whatsappIconAlt', 'Live chat')}
              title={t('epcDemo.leadCapture.whatsappTitle', 'Whatsapp')}
              body={t('epcDemo.leadCapture.whatsappBody', 'Chat with us directly about your project.')}
              linkLabel="Start a chat"
              href="https://wa.me/447397903133"
            />
          </div>
        </div>
      </section>
    </main>
  )
}

function EpcHeader() {
  const t = useT()

  return (
    <header className="sticky top-0 z-40 border-b border-[#d7e0e3] bg-white">
      <div className="hidden bg-[#e3eaec] xl:block">
        <div className="mx-auto flex h-10 max-w-[1360px] items-center justify-end gap-7 px-8 text-sm font-medium text-[#00293D]">
          {EPC_UTILITY_NAV_ITEMS.map((item) => (
            <a key={item.href} className="transition-colors hover:text-[#00755f]" href={item.href}>
              {t(item.labelKey, item.label)}
            </a>
          ))}
        </div>
      </div>
      <div className="mx-auto flex h-[86px] max-w-[1360px] items-center justify-between gap-5 px-5 md:px-8 lg:px-10">
        <a
          href="https://epc-improvements.co.uk/"
          aria-label={t('epcDemo.leadCapture.homeAriaLabel', 'EPC Improvements home')}
          className="shrink-0"
        >
          <img
            src={EPC_LOGO_URL}
            alt={t('epcDemo.leadCapture.logoAlt', 'EPC Improvements Ltd')}
            className="h-[54px] w-auto"
          />
        </a>

        <nav className="hidden items-center gap-7 text-[15px] font-semibold text-[#00293D] xl:flex">
          {EPC_NAV_ITEMS.map((item) => (
            <a key={item.href} className="transition-colors hover:text-[#00755f]" href={item.href}>
              {t(item.labelKey, item.label)}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-5 xl:flex">
          <div className="text-right leading-tight">
            <p className="text-sm font-medium text-[#607076]">
              {t('epcDemo.leadCapture.adviserLabel', 'Speak to an adviser')}
            </p>
            <a className="text-xl font-semibold text-[#00755f]" href="tel:01245408792">
              01245 408 792
            </a>
          </div>
          <img
            src={EPC_MCS_BADGE_URL}
            alt={t('epcDemo.leadCapture.mcsAlt', 'MCS Certified')}
            className="h-14 w-auto"
          />
        </div>

        <a
          className="rounded-full bg-[#00755f] px-5 py-2 text-sm font-semibold text-white xl:hidden"
          href="tel:01245408792"
        >
          {t('epcDemo.leadCapture.callCta', 'Call')}
        </a>
      </div>
    </header>
  )
}

function ContactDetails() {
  const t = useT()

  return (
    <aside className="grid gap-5 self-start lg:col-span-4">
      <div
        className="min-h-[260px] rounded-[18px] bg-[#d7dfe2]"
        aria-label={t('epcDemo.leadCapture.mapPlaceholderAria', 'Map placeholder')}
      />
      <div className="rounded-[18px] bg-white p-7 shadow-[0_18px_45px_rgba(0,41,61,0.08)]">
        <p className="text-sm font-semibold uppercase tracking-[0.12em] text-[#00755f]">
          {t('epcDemo.leadCapture.contactEyebrow', 'Contact')}
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-[#00293D]">
          {t('epcDemo.leadCapture.companyName', 'EPC Improvements Ltd')}
        </h2>
        <div className="mt-6 grid gap-5 text-[15px] leading-7 text-[#607076]">
          <div>
            <p className="font-semibold text-[#00293D]">{t('epcDemo.leadCapture.addressLabel', 'Address')}</p>
            <p>15-17 Russell Way</p>
            <p>Chelmsford, Essex</p>
            <p>England, CM1 3AA</p>
          </div>
          <div>
            <p className="font-semibold text-[#00293D]">{t('epcDemo.leadCapture.phoneLabel', 'Phone')}</p>
            <a className="font-semibold text-[#00755f]" href="tel:01245408792">
              01245 408 792
            </a>
          </div>
          <div>
            <p className="font-semibold text-[#00293D]">{t('epcDemo.leadCapture.emailLabel', 'Email')}</p>
            <a className="font-semibold text-[#00755f]" href="mailto:info@epc-improvements.co.uk">
              info@epc-improvements.co.uk
            </a>
          </div>
        </div>
      </div>
    </aside>
  )
}

function ContactMethodCard({
  iconUrl,
  iconAlt,
  title,
  body,
  linkLabel,
  href,
  iconSizeClassName = 'h-16 w-16',
}: {
  iconUrl: string
  iconAlt: string
  title: string
  body: string
  linkLabel: string
  href: string
  iconSizeClassName?: string
}) {
  return (
    <article className="flex min-h-[260px] flex-col items-center justify-between rounded-[18px] bg-[#eef3f4] px-6 py-9 text-center">
      <img src={iconUrl} alt={iconAlt} className={`${iconSizeClassName} object-contain`} />
      <div className="mt-6">
        <h3 className="text-2xl font-semibold text-[#00293D]">{title}</h3>
        <p className="mx-auto mt-3 max-w-[260px] text-sm leading-6 text-[#607076]">{body}</p>
      </div>
      <a className="mt-6 text-base font-semibold text-[#00755f]" href={href}>
        {linkLabel}
      </a>
    </article>
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
    <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-md border border-[#d7e0e3] bg-white p-3 text-sm font-medium text-[#00293D] transition-colors hover:border-[#00755f] hover:bg-[#f7faf9]">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="peer sr-only"
      />
      <span className="flex size-5 shrink-0 items-center justify-center rounded border border-[#b7c5c9] bg-white text-white peer-checked:border-[#00755f] peer-checked:bg-[#00755f]">
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
    <label className="grid gap-2 text-sm font-semibold text-[#00293D]">
      <span>
        {label}{required ? ' *' : ''}
      </span>
      {children}
    </label>
  )
}
