// Tests de interfaz (navegador real). Localmente usa el Chrome instalado (PW_CHANNEL=chrome);
// en CI, el Chromium de Playwright (npx playwright install chromium).
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'test',
  testMatch: /.*\.spec\.js$/,
  timeout: 45_000,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    channel: process.env.PW_CHANNEL || undefined,
    viewport: { width: 1600, height: 900 },
    headless: true,
  },
});
