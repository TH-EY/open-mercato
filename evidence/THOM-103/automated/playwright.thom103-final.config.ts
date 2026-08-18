import { defineConfig } from '@playwright/test';
import path from 'node:path';
import baseConfig from './playwright.config';

const projectRoot = path.resolve(__dirname, '..', '..', '..');

export default defineConfig({
  ...baseConfig,
  testDir: path.join(projectRoot, 'apps', 'mercato', 'src', 'modules'),
  testMatch: [
    'finoo_affiliates/__integration__/TC-FINOO-AFF-009-016.spec.ts',
    'finoo_intermediaries/__integration__/TC-FINOO-INT-MGMT-014.spec.ts',
    'finoo_intermediaries/__integration__/TC-FINOO-INT-MGMT-015-018.spec.ts',
  ],
});
