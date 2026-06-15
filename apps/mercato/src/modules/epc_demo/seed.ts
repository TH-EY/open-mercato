import { randomUUID } from 'crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import { hash } from 'bcryptjs'
import { hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  CustomerAddress,
  CustomerCompanyProfile,
  CustomerEntity,
} from '@open-mercato/core/modules/customers/data/entities'
import {
  CustomerRole,
  CustomerUser,
  CustomerUserRole,
} from '@open-mercato/core/modules/customer_accounts/data/entities'
import {
  SalesDocumentAddress,
  SalesNote,
  SalesOrder,
  SalesOrderLine,
  SalesQuote,
  SalesQuoteLine,
  type SalesLineKind,
} from '@open-mercato/core/modules/sales/data/entities'
import { seedSalesTaxRates } from '@open-mercato/core/modules/sales/lib/seeds'
import { seedSalesStatusDictionaries } from '@open-mercato/core/modules/sales/lib/dictionaries'
import type { SalesCalculationService } from '@open-mercato/core/modules/sales/services/salesCalculationService'

export type EpcDemoSeedScope = {
  tenantId: string
  organizationId: string
}

type EpcCompanySeed = {
  key: string
  name: string
  description: string
  email: string
  phone: string
  industry: string
  address: EpcAddressSeed
  user: {
    email: string
    displayName: string
    roleSlug: 'buyer' | 'viewer'
  }
}

type EpcAddressSeed = {
  name: string
  addressLine1: string
  addressLine2?: string
  city: string
  region: string
  postalCode: string
  country: string
}

type EpcLineSeed = {
  name: string
  description: string
  quantity: number
  unitPriceNet: number
  quantityUnit?: string
  taxRate?: number
}

type EpcQuoteSeed = {
  quoteNumber: string
  companyKey: string
  status: string
  comments: string
  validFromOffset: number
  validUntilOffset: number
  scenario: string
  lines: EpcLineSeed[]
  notes?: string[]
}

type EpcOrderSeed = {
  orderNumber: string
  companyKey: string
  status: string
  fulfillmentStatus: string
  paymentStatus: string
  comments: string
  placedOffset: number
  expectedOffset: number
  scenario: string
  lines: EpcLineSeed[]
  notes?: string[]
}

type CustomerContext = {
  entity: CustomerEntity
  seed: EpcCompanySeed
}

const SEED_ID = 'epc_demo'
const DEMO_PASSWORD = process.env.EPC_DEMO_CUSTOMER_PASSWORD ?? 'EpcDemo!2026-ChangeMe'

const COMPANY_SEEDS: EpcCompanySeed[] = [
  {
    key: 'essex-new-build',
    name: 'EPC-DEMO Essex Green Developments Ltd',
    description: 'Synthetic Essex/South East developer evaluating renewable packages for residential new-build plots.',
    email: 'projects@essex-green.epc-demo.they.dev',
    phone: '+44 1245 010 101',
    industry: 'Residential new build developer',
    address: {
      name: 'Essex Green Developments Project Office',
      addressLine1: 'Unit 4, Riverside Business Centre',
      city: 'Chelmsford',
      region: 'Essex',
      postalCode: 'CM2 6FD',
      country: 'GB',
    },
    user: {
      email: 'buyer.essex-green@epc-demo.they.dev',
      displayName: 'Essex Green Buyer',
      roleSlug: 'buyer',
    },
  },
  {
    key: 'chelmsford-retrofit',
    name: 'EPC-DEMO Chelmsford Retrofit Home',
    description: 'Synthetic domestic retrofit customer planning an air source heat pump and solar upgrade.',
    email: 'homeowner.chelmsford@epc-demo.they.dev',
    phone: '+44 1245 010 202',
    industry: 'Domestic retrofit',
    address: {
      name: 'Chelmsford Retrofit Home',
      addressLine1: '18 Beaulieu View',
      city: 'Chelmsford',
      region: 'Essex',
      postalCode: 'CM1 6UX',
      country: 'GB',
    },
    user: {
      email: 'customer.chelmsford-retrofit@epc-demo.they.dev',
      displayName: 'Chelmsford Retrofit Customer',
      roleSlug: 'buyer',
    },
  },
  {
    key: 'canvey-self-build',
    name: 'EPC-DEMO Canvey Island Self Build',
    description: 'Synthetic self-build customer comparing solar, battery storage and heat pump options.',
    email: 'selfbuild.canvey@epc-demo.they.dev',
    phone: '+44 1268 010 303',
    industry: 'Self-build residential',
    address: {
      name: 'Canvey Island Self Build',
      addressLine1: '7 Estuary Reach',
      city: 'Canvey Island',
      region: 'Essex',
      postalCode: 'SS8 7TJ',
      country: 'GB',
    },
    user: {
      email: 'customer.canvey-self-build@epc-demo.they.dev',
      displayName: 'Canvey Self Build Customer',
      roleSlug: 'buyer',
    },
  },
  {
    key: 'fryerning-renovation',
    name: 'EPC-DEMO Fryerning Renovation Studio',
    description: 'Synthetic renovation contractor coordinating underfloor heating, screed, MVHR and ASHP works.',
    email: 'renovation.fryerning@epc-demo.they.dev',
    phone: '+44 1277 010 404',
    industry: 'Renovation contractor',
    address: {
      name: 'Fryerning Renovation Studio',
      addressLine1: 'Barn 2, Mill Lane',
      city: 'Ingatestone',
      region: 'Essex',
      postalCode: 'CM4 0HQ',
      country: 'GB',
    },
    user: {
      email: 'buyer.fryerning-renovation@epc-demo.they.dev',
      displayName: 'Fryerning Renovation Buyer',
      roleSlug: 'buyer',
    },
  },
  {
    key: 'south-east-precision',
    name: 'EPC-DEMO South East Precision Works Ltd',
    description: 'Synthetic light manufacturing business reviewing commercial solar ROI and payback.',
    email: 'facilities@south-east-precision.epc-demo.they.dev',
    phone: '+44 1702 010 505',
    industry: 'Commercial solar prospect',
    address: {
      name: 'South East Precision Works',
      addressLine1: 'Unit 12, Aviation Way',
      city: 'Southend-on-Sea',
      region: 'Essex',
      postalCode: 'SS2 6UN',
      country: 'GB',
    },
    user: {
      email: 'facilities.south-east-precision@epc-demo.they.dev',
      displayName: 'South East Precision Facilities',
      roleSlug: 'buyer',
    },
  },
  {
    key: 'maldon-aftercare',
    name: 'EPC-DEMO Maldon Heat Pump Aftercare',
    description: 'Synthetic existing heat pump customer booking annual servicing and a repair visit.',
    email: 'aftercare.maldon@epc-demo.they.dev',
    phone: '+44 1621 010 606',
    industry: 'Existing heat pump customer',
    address: {
      name: 'Maldon Heat Pump Aftercare',
      addressLine1: '42 Saltmarsh Road',
      city: 'Maldon',
      region: 'Essex',
      postalCode: 'CM9 5HX',
      country: 'GB',
    },
    user: {
      email: 'viewer.maldon-aftercare@epc-demo.they.dev',
      displayName: 'Maldon Aftercare Viewer',
      roleSlug: 'viewer',
    },
  },
]

const QUOTE_SEEDS: EpcQuoteSeed[] = [
  {
    quoteNumber: 'EPC-DEMO-Q-1001',
    companyKey: 'chelmsford-retrofit',
    status: 'sent',
    validFromOffset: -12,
    validUntilOffset: 18,
    scenario: 'ASHP retrofit with MCS certification and BUS support',
    comments: 'Air source heat pump retrofit quotation including cylinder, MCS certification, Boiler Upgrade Scheme support and customer handover.',
    lines: [
      line('Air source heat pump installation package', 'Survey-led ASHP installation with outdoor unit, controls, commissioning and homeowner handover.', 1, 10950),
      line('Hot water cylinder and hydraulic materials', 'Cylinder, buffer/ancillary materials and integration works for the retrofit installation.', 1, 2450),
      line('MCS certification and BUS application support', 'Documentation pack, MCS handover and Boiler Upgrade Scheme application support.', 1, 650),
    ],
    notes: ['Customer asked for a late-summer installation window after grant paperwork is ready.'],
  },
  {
    quoteNumber: 'EPC-DEMO-Q-1002',
    companyKey: 'canvey-self-build',
    status: 'draft',
    validFromOffset: -8,
    validUntilOffset: 22,
    scenario: 'Solar PV with Tesla Powerwall 3',
    comments: 'Solar PV and Tesla Powerwall 3 package for a self-build property, including commissioning and app handover.',
    lines: [
      line('Solar PV installation package', 'Roof-mounted solar PV design, supply, installation, MCS commissioning and handover.', 1, 7350),
      line('Tesla Powerwall 3 battery storage', 'Powerwall 3 battery supply, installation, commissioning and customer app handover.', 1, 8495),
      line('SolarEdge inverter and optimiser allowance', 'SolarEdge inverter/optimiser allowance for panel-level monitoring and performance management.', 1, 1850),
    ],
  },
  {
    quoteNumber: 'EPC-DEMO-Q-1003',
    companyKey: 'chelmsford-retrofit',
    status: 'sent',
    validFromOffset: -6,
    validUntilOffset: 24,
    scenario: 'Solar-only domestic installation',
    comments: 'Solar-only domestic installation quotation with 0% VAT eligibility assumed for the demo scenario.',
    lines: [
      line('Solar-only domestic PV installation', 'Solar PV design, panels, inverter, installation, commissioning and MCS handover.', 1, 4995),
      line('Scaffold and roof access allowance', 'Access allowance for two-storey residential roof works.', 1, 850),
    ],
  },
  {
    quoteNumber: 'EPC-DEMO-Q-1004',
    companyKey: 'canvey-self-build',
    status: 'sent',
    validFromOffset: -5,
    validUntilOffset: 25,
    scenario: 'FoxESS battery-only retrofit',
    comments: 'Battery-only retrofit for an existing solar system, using FoxESS storage and grid/solar charging configuration.',
    lines: [
      line('FoxESS battery storage retrofit', 'FoxESS battery storage supply, installation and commissioning for an existing solar PV system.', 1, 5150),
      line('Battery control configuration and handover', 'Grid/solar charge settings, app setup and customer operating handover.', 1, 420),
    ],
  },
  {
    quoteNumber: 'EPC-DEMO-Q-1005',
    companyKey: 'essex-new-build',
    status: 'sent',
    validFromOffset: -15,
    validUntilOffset: 15,
    scenario: 'New-build renewable package',
    comments: 'New-build package combining ASHP, underfloor heating and MVHR for a small residential plot.',
    lines: [
      line('Air source heat pump new-build package', 'ASHP design coordination, supply, installation, commissioning and MCS handover.', 2, 11250),
      line('Underfloor heating ground floor package', 'UFH manifold, pipework, controls and commissioning for two detached plots.', 2, 4650),
      line('MVHR supply and installation allowance', 'MVHR unit, ducting allowance and commissioning for new-build ventilation strategy.', 2, 3850),
    ],
  },
  {
    quoteNumber: 'EPC-DEMO-Q-1006',
    companyKey: 'south-east-precision',
    status: 'sent',
    validFromOffset: -10,
    validUntilOffset: 20,
    scenario: 'Commercial solar desktop appraisal and installation estimate',
    comments: 'Commercial solar estimate for a light manufacturing site, including desktop appraisal and ROI/payback summary.',
    lines: [
      line('Commercial solar desktop appraisal', 'Desktop appraisal, consumption review, indicative system size and payback summary.', 1, 950),
      line('Commercial solar PV installation estimate', 'Indicative commercial PV supply and install allowance pending site survey and structural review.', 1, 32750),
      line('Monitoring and handover package', 'Generation monitoring setup and facilities team handover.', 1, 1250),
    ],
  },
  {
    quoteNumber: 'EPC-DEMO-Q-1007',
    companyKey: 'fryerning-renovation',
    status: 'draft',
    validFromOffset: -4,
    validUntilOffset: 26,
    scenario: 'Underfloor heating and screed renovation package',
    comments: 'Renovation package for underfloor heating and screed ahead of low-temperature heating system handover.',
    lines: [
      line('Underfloor heating renovation package', 'UFH design, manifold, pipework and controls for renovation ground-floor zones.', 1, 6850),
      line('Liquid screed installation allowance', 'Screed installation allowance coordinated around UFH pipe pressure testing.', 1, 4200),
    ],
  },
  {
    quoteNumber: 'EPC-DEMO-Q-1008',
    companyKey: 'maldon-aftercare',
    status: 'sent',
    validFromOffset: -3,
    validUntilOffset: 27,
    scenario: 'Annual heat pump service and repair visit',
    comments: 'Annual heat pump service plus diagnostic repair visit for an existing EPC-supported system.',
    lines: [
      line('Annual heat pump service visit', 'System inspection, filter checks, performance review and service report.', 1, 285),
      line('Heat pump diagnostic repair visit allowance', 'Engineer visit allowance for fault diagnosis and minor repair materials.', 1, 245),
    ],
  },
  {
    quoteNumber: 'EPC-DEMO-Q-1009',
    companyKey: 'essex-new-build',
    status: 'accepted',
    validFromOffset: -18,
    validUntilOffset: 12,
    scenario: 'Solar and battery upgrade for new-build show home',
    comments: 'Solar PV plus GivEnergy battery storage for a new-build show home demonstration plot.',
    lines: [
      line('Solar PV show home installation', 'Domestic solar PV installation, commissioning and MCS handover for show home plot.', 1, 6150),
      line('GivEnergy battery storage package', 'Battery storage installation, commissioning and app handover.', 1, 5450),
    ],
  },
  {
    quoteNumber: 'EPC-DEMO-Q-1010',
    companyKey: 'south-east-precision',
    status: 'draft',
    validFromOffset: -2,
    validUntilOffset: 28,
    scenario: 'Commercial solar with battery option',
    comments: 'Commercial solar proposal with a battery storage option to improve self-consumption and payback.',
    lines: [
      line('Commercial solar PV phase one', 'Phase-one commercial solar PV installation allowance following desktop appraisal.', 1, 24800),
      line('Battery storage option for commercial solar', 'Battery storage option for peak shaving and solar self-consumption review.', 1, 11950),
      line('ROI and payback review update', 'Updated ROI/payback review using final half-hourly consumption data.', 1, 650),
    ],
  },
  {
    quoteNumber: 'EPC-DEMO-Q-1011',
    companyKey: 'fryerning-renovation',
    status: 'sent',
    validFromOffset: -1,
    validUntilOffset: 29,
    scenario: 'MVHR and ASHP coordination for renovation',
    comments: 'MVHR and ASHP installation coordination for a deep renovation with low-temperature heating design.',
    lines: [
      line('MVHR installation package', 'MVHR unit, ductwork allowance, commissioning and customer handover.', 1, 5900),
      line('ASHP design coordination and installation', 'ASHP installation coordination with UFH zones and hot water strategy.', 1, 11850),
    ],
  },
  {
    quoteNumber: 'EPC-DEMO-Q-1012',
    companyKey: 'canvey-self-build',
    status: 'sent',
    validFromOffset: -7,
    validUntilOffset: 23,
    scenario: 'Air source heat pump for self-build',
    comments: 'Self-build ASHP quotation including MCS handover and support package.',
    lines: [
      line('Self-build ASHP installation', 'Air source heat pump supply, install, commissioning and controls setup.', 1, 9875),
      line('Customer handover and ongoing support package', 'Handover documentation and initial support package after commissioning.', 1, 495),
    ],
  },
  {
    quoteNumber: 'EPC-DEMO-Q-1013',
    companyKey: 'chelmsford-retrofit',
    status: 'draft',
    validFromOffset: -1,
    validUntilOffset: 29,
    scenario: 'SolarEdge solar plus battery storage review',
    comments: 'SolarEdge-led solar plus battery review for a domestic retrofit customer considering staged installation.',
    lines: [
      line('SolarEdge solar PV installation allowance', 'Solar PV installation with SolarEdge inverter and optimiser allowance.', 1, 6850),
      line('Battery storage staged option', 'Battery storage option for a second-stage installation decision.', 1, 5750),
    ],
  },
]

const ORDER_SEEDS: EpcOrderSeed[] = [
  {
    orderNumber: 'EPC-DEMO-O-2001',
    companyKey: 'chelmsford-retrofit',
    status: 'confirmed',
    fulfillmentStatus: 'scheduled',
    paymentStatus: 'deposit_received',
    placedOffset: -21,
    expectedOffset: 24,
    scenario: 'Accepted ASHP installation',
    comments: 'Accepted ASHP retrofit order with expected install window after BUS grant support is complete.',
    lines: [
      line('Air source heat pump installation package', 'ASHP retrofit installation, commissioning and customer handover.', 1, 10950),
      line('MCS certification and BUS support', 'MCS documentation and Boiler Upgrade Scheme support pack.', 1, 650),
    ],
    notes: ['Install window held pending final grant confirmation.'],
  },
  {
    orderNumber: 'EPC-DEMO-O-2002',
    companyKey: 'canvey-self-build',
    status: 'confirmed',
    fulfillmentStatus: 'scheduled',
    paymentStatus: 'deposit_received',
    placedOffset: -18,
    expectedOffset: 18,
    scenario: 'Confirmed solar and battery install',
    comments: 'Confirmed solar PV and Tesla Powerwall 3 installation for self-build handover.',
    lines: [
      line('Solar PV installation package', 'Solar PV design, installation, commissioning and MCS handover.', 1, 7350),
      line('Tesla Powerwall 3 battery storage', 'Powerwall 3 installation, commissioning and app handover.', 1, 8495),
    ],
  },
  {
    orderNumber: 'EPC-DEMO-O-2003',
    companyKey: 'south-east-precision',
    status: 'confirmed',
    fulfillmentStatus: 'phase_1_ordered',
    paymentStatus: 'deposit_received',
    placedOffset: -14,
    expectedOffset: 45,
    scenario: 'Commercial solar phase deposit',
    comments: 'Commercial solar phase-one order following desktop appraisal and ROI/payback review.',
    lines: [
      line('Commercial solar PV phase one deposit', 'Phase-one commercial solar installation deposit and pre-installation survey coordination.', 1, 9250),
      line('Commercial solar project management', 'Project management and facilities team coordination for installation planning.', 1, 1850),
    ],
  },
  {
    orderNumber: 'EPC-DEMO-O-2004',
    companyKey: 'maldon-aftercare',
    status: 'confirmed',
    fulfillmentStatus: 'completed',
    paymentStatus: 'paid',
    placedOffset: -35,
    expectedOffset: -28,
    scenario: 'Heat pump service order',
    comments: 'Completed annual heat pump service for an existing customer.',
    lines: [
      line('Annual heat pump service visit', 'System inspection, filter checks, performance review and service report.', 1, 285),
      line('Minor repair materials allowance', 'Small parts allowance used during service visit.', 1, 75),
    ],
  },
  {
    orderNumber: 'EPC-DEMO-O-2005',
    companyKey: 'essex-new-build',
    status: 'confirmed',
    fulfillmentStatus: 'in_progress',
    paymentStatus: 'part_paid',
    placedOffset: -25,
    expectedOffset: 36,
    scenario: 'New-build UFH and MVHR package',
    comments: 'New-build UFH, screed and MVHR package order for the first two plots.',
    lines: [
      line('Underfloor heating package', 'UFH manifold, pipework, controls and commissioning for two plots.', 2, 4650),
      line('MVHR supply and installation', 'MVHR installation and commissioning allowance for two plots.', 2, 3850),
      line('Screed installation allowance', 'Screed installation coordinated around UFH pressure testing.', 2, 3100),
    ],
  },
  {
    orderNumber: 'EPC-DEMO-O-2006',
    companyKey: 'fryerning-renovation',
    status: 'confirmed',
    fulfillmentStatus: 'scheduled',
    paymentStatus: 'deposit_received',
    placedOffset: -11,
    expectedOffset: 21,
    scenario: 'Renovation UFH and screed order',
    comments: 'Renovation contractor order for underfloor heating and screed works.',
    lines: [
      line('Underfloor heating renovation package', 'UFH design, manifold, pipework and controls for renovation zones.', 1, 6850),
      line('Liquid screed installation allowance', 'Screed installation after pressure testing and pre-pour checks.', 1, 4200),
    ],
  },
  {
    orderNumber: 'EPC-DEMO-O-2007',
    companyKey: 'essex-new-build',
    status: 'confirmed',
    fulfillmentStatus: 'scheduled',
    paymentStatus: 'deposit_received',
    placedOffset: -9,
    expectedOffset: 30,
    scenario: 'Show home solar plus battery install',
    comments: 'Show home solar PV and GivEnergy battery order for developer marketing plot.',
    lines: [
      line('Solar PV show home installation', 'Solar PV installation, commissioning and MCS handover for the show home.', 1, 6150),
      line('GivEnergy battery storage package', 'Battery installation, commissioning and app handover.', 1, 5450),
    ],
  },
  {
    orderNumber: 'EPC-DEMO-O-2008',
    companyKey: 'canvey-self-build',
    status: 'confirmed',
    fulfillmentStatus: 'materials_ordered',
    paymentStatus: 'deposit_received',
    placedOffset: -7,
    expectedOffset: 28,
    scenario: 'Self-build ASHP order',
    comments: 'Self-build ASHP order including MCS handover and initial support package.',
    lines: [
      line('Self-build ASHP installation', 'Air source heat pump supply, install, commissioning and controls setup.', 1, 9875),
      line('Customer handover and ongoing support package', 'Handover documentation and first support package after commissioning.', 1, 495),
    ],
  },
  {
    orderNumber: 'EPC-DEMO-O-2009',
    companyKey: 'south-east-precision',
    status: 'confirmed',
    fulfillmentStatus: 'survey_booked',
    paymentStatus: 'invoice_sent',
    placedOffset: -5,
    expectedOffset: 35,
    scenario: 'Commercial solar pre-install survey',
    comments: 'Commercial solar pre-install survey and updated ROI/payback review order.',
    lines: [
      line('Commercial solar site survey', 'Site survey and roof/access confirmation after desktop appraisal.', 1, 1450),
      line('ROI and payback review update', 'Final ROI/payback update using confirmed system size and consumption profile.', 1, 650),
    ],
  },
  {
    orderNumber: 'EPC-DEMO-O-2010',
    companyKey: 'maldon-aftercare',
    status: 'confirmed',
    fulfillmentStatus: 'scheduled',
    paymentStatus: 'invoice_sent',
    placedOffset: -3,
    expectedOffset: 9,
    scenario: 'Heat pump repair visit',
    comments: 'Scheduled heat pump diagnostic repair visit for an existing EPC-supported customer.',
    lines: [
      line('Heat pump diagnostic repair visit', 'Engineer visit for fault diagnosis, system checks and minor repair works.', 1, 245),
      line('Ongoing support package renewal', 'Support package renewal following service/repair visit.', 1, 180),
    ],
  },
]

function line(
  name: string,
  description: string,
  quantity: number,
  unitPriceNet: number,
  taxRate = 0,
): EpcLineSeed {
  return { name, description, quantity, unitPriceNet, taxRate, quantityUnit: 'item' }
}

function daysFromNow(offset: number): Date {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + offset)
  return date
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function toAmount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '0.0000'
  return Math.round((value + Number.EPSILON) * 10000) / 10000 + ''
}

function toSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function buildCustomerSnapshot(seed: EpcCompanySeed) {
  return {
    displayName: seed.name,
    primaryEmail: seed.email,
    primaryPhone: seed.phone,
    industry: seed.industry,
  }
}

function buildAddressSnapshot(seed: EpcCompanySeed) {
  return {
    name: seed.address.name,
    companyName: seed.name,
    addressLine1: seed.address.addressLine1,
    addressLine2: seed.address.addressLine2 ?? null,
    city: seed.address.city,
    region: seed.address.region,
    postalCode: seed.address.postalCode,
    country: seed.address.country,
  }
}

function documentMetadata(scenario: string) {
  return {
    seed: SEED_ID,
    scenario,
    synthetic: true,
    factBase: [
      'heat_pumps',
      'solar_panels',
      'battery_storage',
      'mvhr',
      'underfloor_heating',
      'screed',
      'servicing_repairs',
      'commercial_solar',
    ],
  }
}

async function loadExistingCompanies(em: EntityManager, scope: EpcDemoSeedScope) {
  const companies = await findWithDecryption(
    em,
    CustomerEntity,
    {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      kind: 'company',
      deletedAt: null,
    },
    { populate: ['companyProfile'] },
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  return new Map(companies.map((company) => [normalize(company.displayName), company]))
}

async function ensureCompanies(em: EntityManager, scope: EpcDemoSeedScope): Promise<Map<string, CustomerContext>> {
  const existingByName = await loadExistingCompanies(em, scope)
  const contexts = new Map<string, CustomerContext>()

  for (const seed of COMPANY_SEEDS) {
    let entity = existingByName.get(normalize(seed.name)) ?? null
    if (!entity) {
      const now = new Date()
      entity = em.create(CustomerEntity, {
        id: randomUUID(),
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        kind: 'company',
        displayName: seed.name,
        description: seed.description,
        primaryEmail: seed.email,
        primaryPhone: seed.phone,
        status: 'active',
        lifecycleStage: 'customer',
        source: 'epc_demo',
        temperature: 'warm',
        createdAt: now,
        updatedAt: now,
      })
      em.persist(entity)
      em.persist(em.create(CustomerCompanyProfile, {
        id: randomUUID(),
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        legalName: seed.name,
        brandName: seed.name.replace(/^EPC-DEMO\s+/, ''),
        industry: seed.industry,
        entity,
        createdAt: now,
        updatedAt: now,
      }))
      em.persist(em.create(CustomerAddress, {
        id: randomUUID(),
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        entity,
        name: seed.address.name,
        purpose: 'billing',
        companyName: seed.name,
        addressLine1: seed.address.addressLine1,
        addressLine2: seed.address.addressLine2 ?? null,
        city: seed.address.city,
        region: seed.address.region,
        postalCode: seed.address.postalCode,
        country: seed.address.country,
        isPrimary: true,
        createdAt: now,
        updatedAt: now,
      }))
    }
    contexts.set(seed.key, { entity, seed })
  }

  await em.flush()
  return contexts
}

async function ensurePortalUsers(
  em: EntityManager,
  scope: EpcDemoSeedScope,
  companies: Map<string, CustomerContext>,
) {
  const roles = await em.find(CustomerRole, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    slug: { $in: ['buyer', 'viewer'] },
    deletedAt: null,
  })
  const roleBySlug = new Map(roles.map((role) => [role.slug, role]))
  const now = new Date()

  for (const context of companies.values()) {
    const { seed, entity } = context
    const emailHash = hashForLookup(seed.user.email)
    let user = await em.findOne(CustomerUser, {
      tenantId: scope.tenantId,
      emailHash,
      deletedAt: null,
    })
    if (!user) {
      user = em.create(CustomerUser, {
        id: randomUUID(),
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        email: seed.user.email,
        emailHash,
        passwordHash: await hash(DEMO_PASSWORD, 10),
        displayName: seed.user.displayName,
        emailVerifiedAt: now,
        failedLoginAttempts: 0,
        customerEntityId: entity.id,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      em.persist(user)
    } else {
      user.customerEntityId = entity.id
      user.displayName = seed.user.displayName
      user.emailVerifiedAt = user.emailVerifiedAt ?? now
      user.isActive = true
      em.persist(user)
    }

    const role = roleBySlug.get(seed.user.roleSlug)
    if (!role) continue
    const existingLink = await em.findOne(CustomerUserRole, { user, role, deletedAt: null })
    if (!existingLink) {
      em.persist(em.create(CustomerUserRole, {
        id: randomUUID(),
        user,
        role,
        createdAt: now,
      }))
    }
  }
  await em.flush()
}

function lineSnapshots(lines: EpcLineSeed[], currencyCode: string) {
  return lines.map((lineSeed) => ({
    id: randomUUID(),
    kind: 'service' as SalesLineKind,
    name: lineSeed.name,
    description: lineSeed.description,
    comment: null,
    quantity: lineSeed.quantity,
    quantityUnit: lineSeed.quantityUnit ?? null,
    normalizedQuantity: lineSeed.quantity,
    normalizedUnit: lineSeed.quantityUnit ?? null,
    uomSnapshot: null,
    currencyCode,
    unitPriceNet: lineSeed.unitPriceNet,
    unitPriceGross: lineSeed.unitPriceNet,
    taxRate: lineSeed.taxRate ?? 0,
    discountPercent: null,
    productId: null,
    productVariantId: null,
    catalogSnapshot: null,
    metadata: null,
  }))
}

function attachDocumentAddress(
  em: EntityManager,
  scope: EpcDemoSeedScope,
  params: {
    documentId: string
    documentKind: 'order' | 'quote'
    seed: EpcCompanySeed
    order?: SalesOrder
    quote?: SalesQuote
  },
) {
  const now = new Date()
  const address = params.seed.address
  em.persist(em.create(SalesDocumentAddress, {
    id: randomUUID(),
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    documentId: params.documentId,
    documentKind: params.documentKind,
    customerAddressId: null,
    name: address.name,
    purpose: 'billing',
    companyName: params.seed.name,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2 ?? null,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    country: address.country,
    buildingNumber: null,
    flatNumber: null,
    order: params.order ?? null,
    quote: params.quote ?? null,
    createdAt: now,
    updatedAt: now,
  }))
}

function attachNotes(
  em: EntityManager,
  scope: EpcDemoSeedScope,
  params: {
    contextId: string
    contextType: 'order' | 'quote'
    notes: string[]
    order?: SalesOrder
    quote?: SalesQuote
  },
) {
  for (const body of params.notes) {
    const now = new Date()
    em.persist(em.create(SalesNote, {
      id: randomUUID(),
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      contextType: params.contextType,
      contextId: params.contextId,
      body,
      appearanceIcon: 'lucide:leaf',
      appearanceColor: '#1f8f5f',
      order: params.order ?? null,
      quote: params.quote ?? null,
      createdAt: now,
      updatedAt: now,
    }))
  }
}

async function seedQuotes(
  em: EntityManager,
  calculationService: SalesCalculationService,
  scope: EpcDemoSeedScope,
  companies: Map<string, CustomerContext>,
) {
  for (const seed of QUOTE_SEEDS) {
    const exists = await em.findOne(SalesQuote, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      quoteNumber: seed.quoteNumber,
      deletedAt: null,
    })
    if (exists) continue

    const customer = companies.get(seed.companyKey)
    if (!customer) continue
    const quoteId = randomUUID()
    const snapshots = lineSnapshots(seed.lines, 'GBP')
    const calculation = await calculationService.calculateDocumentTotals({
      documentKind: 'quote',
      lines: snapshots,
      adjustments: [],
      context: {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        currencyCode: 'GBP',
      },
    })
    const totals = calculation.totals
    const customerSnapshot = buildCustomerSnapshot(customer.seed)
    const addressSnapshot = buildAddressSnapshot(customer.seed)
    const now = new Date()
    const quote = em.create(SalesQuote, {
      id: quoteId,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      quoteNumber: seed.quoteNumber,
      status: seed.status,
      customerEntityId: customer.entity.id,
      customerContactId: null,
      customerSnapshot: toSnapshot(customerSnapshot),
      billingAddressId: null,
      shippingAddressId: null,
      billingAddressSnapshot: toSnapshot(addressSnapshot),
      shippingAddressSnapshot: toSnapshot(addressSnapshot),
      currencyCode: 'GBP',
      validFrom: daysFromNow(seed.validFromOffset),
      validUntil: daysFromNow(seed.validUntilOffset),
      comments: seed.comments,
      metadata: documentMetadata(seed.scenario),
      subtotalNetAmount: toAmount(totals.subtotalNetAmount),
      subtotalGrossAmount: toAmount(totals.subtotalGrossAmount),
      discountTotalAmount: toAmount(totals.discountTotalAmount),
      taxTotalAmount: toAmount(totals.taxTotalAmount),
      grandTotalNetAmount: toAmount(totals.grandTotalNetAmount),
      grandTotalGrossAmount: toAmount(totals.grandTotalGrossAmount),
      totalsSnapshot: toSnapshot(totals),
      lineItemCount: seed.lines.length,
      createdAt: now,
      updatedAt: now,
    })
    em.persist(quote)

    calculation.lines.forEach((lineResult, index) => {
      const source = snapshots[index]
      em.persist(em.create(SalesQuoteLine, {
        id: source.id,
        quote,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        lineNumber: index + 1,
        kind: source.kind,
        name: source.name,
        description: source.description,
        comment: source.comment,
        quantity: toAmount(source.quantity),
        quantityUnit: source.quantityUnit,
        normalizedQuantity: toAmount(source.normalizedQuantity),
        normalizedUnit: source.normalizedUnit,
        uomSnapshot: null,
        currencyCode: source.currencyCode,
        unitPriceNet: toAmount(source.unitPriceNet),
        unitPriceGross: toAmount(source.unitPriceGross),
        discountAmount: toAmount(lineResult.discountAmount),
        discountPercent: '0',
        taxRate: toAmount(source.taxRate),
        taxAmount: toAmount(lineResult.taxAmount),
        totalNetAmount: toAmount(lineResult.netAmount),
        totalGrossAmount: toAmount(lineResult.grossAmount),
        metadata: null,
        createdAt: now,
        updatedAt: now,
      }))
    })
    attachDocumentAddress(em, scope, { documentId: quoteId, documentKind: 'quote', seed: customer.seed, quote })
    attachNotes(em, scope, {
      contextId: quoteId,
      contextType: 'quote',
      notes: seed.notes ?? [`${seed.scenario} prepared as synthetic EPC demo data.`],
      quote,
    })
  }
  await em.flush()
}

async function seedOrders(
  em: EntityManager,
  calculationService: SalesCalculationService,
  scope: EpcDemoSeedScope,
  companies: Map<string, CustomerContext>,
) {
  for (const seed of ORDER_SEEDS) {
    const exists = await em.findOne(SalesOrder, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      orderNumber: seed.orderNumber,
      deletedAt: null,
    })
    if (exists) continue

    const customer = companies.get(seed.companyKey)
    if (!customer) continue
    const orderId = randomUUID()
    const snapshots = lineSnapshots(seed.lines, 'GBP')
    const calculation = await calculationService.calculateDocumentTotals({
      documentKind: 'order',
      lines: snapshots,
      adjustments: [],
      context: {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        currencyCode: 'GBP',
      },
    })
    const totals = calculation.totals
    const customerSnapshot = buildCustomerSnapshot(customer.seed)
    const addressSnapshot = buildAddressSnapshot(customer.seed)
    const now = new Date()
    const order = em.create(SalesOrder, {
      id: orderId,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      orderNumber: seed.orderNumber,
      status: seed.status,
      fulfillmentStatus: seed.fulfillmentStatus,
      paymentStatus: seed.paymentStatus,
      customerEntityId: customer.entity.id,
      customerContactId: null,
      customerSnapshot: toSnapshot(customerSnapshot),
      billingAddressId: null,
      shippingAddressId: null,
      billingAddressSnapshot: toSnapshot(addressSnapshot),
      shippingAddressSnapshot: toSnapshot(addressSnapshot),
      currencyCode: 'GBP',
      placedAt: daysFromNow(seed.placedOffset),
      expectedDeliveryAt: daysFromNow(seed.expectedOffset),
      comments: seed.comments,
      internalNotes: `${seed.scenario}; synthetic EPC demo record.`,
      metadata: documentMetadata(seed.scenario),
      subtotalNetAmount: toAmount(totals.subtotalNetAmount),
      subtotalGrossAmount: toAmount(totals.subtotalGrossAmount),
      discountTotalAmount: toAmount(totals.discountTotalAmount),
      taxTotalAmount: toAmount(totals.taxTotalAmount),
      shippingNetAmount: toAmount(totals.shippingNetAmount ?? 0),
      shippingGrossAmount: toAmount(totals.shippingGrossAmount ?? 0),
      surchargeTotalAmount: toAmount(totals.surchargeTotalAmount ?? 0),
      grandTotalNetAmount: toAmount(totals.grandTotalNetAmount),
      grandTotalGrossAmount: toAmount(totals.grandTotalGrossAmount),
      paidTotalAmount: toAmount(totals.paidTotalAmount ?? 0),
      refundedTotalAmount: toAmount(totals.refundedTotalAmount ?? 0),
      outstandingAmount: toAmount(totals.outstandingAmount ?? totals.grandTotalGrossAmount),
      totalsSnapshot: toSnapshot(totals),
      lineItemCount: seed.lines.length,
      createdAt: now,
      updatedAt: now,
    })
    em.persist(order)

    calculation.lines.forEach((lineResult, index) => {
      const source = snapshots[index]
      em.persist(em.create(SalesOrderLine, {
        id: source.id,
        order,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        lineNumber: index + 1,
        kind: source.kind,
        name: source.name,
        description: source.description,
        comment: source.comment,
        quantity: toAmount(source.quantity),
        quantityUnit: source.quantityUnit,
        normalizedQuantity: toAmount(source.normalizedQuantity),
        normalizedUnit: source.normalizedUnit,
        uomSnapshot: null,
        reservedQuantity: '0',
        fulfilledQuantity: seed.fulfillmentStatus === 'completed' ? toAmount(source.quantity) : '0',
        invoicedQuantity: '0',
        returnedQuantity: '0',
        currencyCode: source.currencyCode,
        unitPriceNet: toAmount(source.unitPriceNet),
        unitPriceGross: toAmount(source.unitPriceGross),
        discountAmount: toAmount(lineResult.discountAmount),
        discountPercent: '0',
        taxRate: toAmount(source.taxRate),
        taxAmount: toAmount(lineResult.taxAmount),
        totalNetAmount: toAmount(lineResult.netAmount),
        totalGrossAmount: toAmount(lineResult.grossAmount),
        metadata: null,
        createdAt: now,
        updatedAt: now,
      }))
    })
    attachDocumentAddress(em, scope, { documentId: orderId, documentKind: 'order', seed: customer.seed, order })
    attachNotes(em, scope, {
      contextId: orderId,
      contextType: 'order',
      notes: seed.notes ?? [`${seed.scenario} accepted as synthetic EPC demo data.`],
      order,
    })
  }
  await em.flush()
}

export async function seedEpcDemoExamples(
  em: EntityManager,
  container: AwilixContainer,
  scope: EpcDemoSeedScope,
) {
  await seedSalesTaxRates(em, scope)
  await seedSalesStatusDictionaries(em, scope)
  await em.flush()

  const companies = await ensureCompanies(em, scope)
  await ensurePortalUsers(em, scope, companies)

  const calculationService = container.resolve<SalesCalculationService>('salesCalculationService')
  await seedQuotes(em, calculationService, scope, companies)
  await seedOrders(em, calculationService, scope, companies)
}

