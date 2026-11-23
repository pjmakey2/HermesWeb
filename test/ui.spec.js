import { test, expect } from '@playwright/test';
import { startServer, login } from './helpers.js';

const PORT = 7791;
let srv;

test.beforeAll(async () => {
  srv = startServer(PORT);
  for (const n of ['uno', 'dos']) srv.tmux('new-session', '-d', '-s', n, '-c', process.cwd(), '-x', '120', '-y', '40', 'bash --norc');
  srv.tmux('new-session', '-d', '-s', 'tres', '-x', '120', '-y', '40', `bash --norc -c 'printf "Do you want to proceed?\\n❯ 1. Yes\\n  2. No\\n"; exec cat'`);
});
test.afterAll(() => srv?.stop());

test.beforeEach(async ({ page, context }) => {
  const cookie = (await login(srv.url, srv.password)).split('=');
  await context.addCookies([{ name: cookie[0], value: cookie.slice(1).join('='), url: srv.url }]);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('init')) {
      sessionStorage.setItem('init', '1');
      localStorage.setItem('hermes.layout', JSON.stringify({ layout: 'tri', panes: ['uno', 'dos', 'tres'], focused: 0 }));
    }
  });
  page.on('pageerror', e => { throw e; });
  await page.goto(srv.url + '/');
  await expect(page.locator('#grid .pane')).toHaveCount(3);
  await expect(page.locator('#conn')).toHaveText('conectado');
});

const box = loc => loc.boundingBox();

test('distribución de tres: dos arriba y una abajo a todo el ancho', async ({ page }) => {
  const [a, b, c] = await Promise.all([0, 1, 2].map(i => box(page.locator('#grid .pane').nth(i))));
  expect(Math.abs(a.y - b.y)).toBeLessThan(2);
  expect(c.y).toBeGreaterThan(a.y + a.height - 1);
  expect(c.width).toBeGreaterThan(a.width * 1.9);
  await page.keyboard.press('Alt+Shift+5');
  await expect(page.locator('#grid .pane')).toHaveCount(4);
  await page.keyboard.press('Alt+Shift+4');
  await expect(page.locator('#grid .pane')).toHaveCount(3);
});

test('arrastrar el divisor cambia el tamaño y se recuerda', async ({ page }) => {
  const sp = page.locator('.splitter.h');
  const s = await box(sp);
  const top0 = await box(page.locator('#grid .pane').nth(0));
  await page.mouse.move(s.x + 200, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + 200, s.y - 150, { steps: 8 });
  await page.mouse.up();
  const top1 = await box(page.locator('#grid .pane').nth(0));
  expect(top1.height).toBeLessThan(top0.height - 100);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('hermes.split')).tri.r);
  expect(saved).toBeLessThan(0.45);
  await page.reload();
  const top2 = await box(page.locator('#grid .pane').nth(0));
  expect(Math.abs(top2.height - top1.height)).toBeLessThan(4);
  await page.locator('.splitter.h').dblclick();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('hermes.split')).tri.r)).toBe(0.5);
});

test('la barra de teclas aparece sola cuando Claude pide permiso y envía la respuesta', async ({ page }) => {
  await page.locator('#grid .pane').nth(2).click();
  const bar = page.locator('#quickbar');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveClass(/asking/);
  await expect(page.locator('#qb-target')).toContainText('pide permiso');
  await bar.locator('button[data-send="1"]').click();
  await expect.poll(() => srv.tmux('capture-pane', '-p', '-t', 'tres')).toMatch(/^1$/m);
  // en una sesión que no pide nada, la barra se muestra solo si se activa
  await page.locator('#grid .pane').nth(0).click();
  await expect(bar).toBeHidden();
  await page.keyboard.press('Alt+Shift+K');
  await expect(bar).toBeVisible();
  await bar.locator('button[data-send="/compact"]').click();
  await expect.poll(() => srv.tmux('capture-pane', '-p', '-t', 'uno')).toContain('/compact');
});

test('cambios, uso y ajustes', async ({ page }) => {
  await page.locator('#grid .pane').nth(0).click();
  await page.keyboard.press('Alt+Shift+D');
  await expect(page.locator('#dlg-diff')).toBeVisible();
  await expect(page.locator('#df-body .df-meta')).toContainText('⎇');
  await page.keyboard.press('Escape');

  await page.locator('#btn-usage').click();
  await expect(page.locator('#us-body .us-card').first()).toContainText('$1.25');
  await expect(page.locator('#us-body .us-table')).toContainText('Sesión de prueba');
  await page.keyboard.press('Escape');

  await page.locator('#btn-settings').click();
  await expect(page.locator('#st-body')).toContainText('Respaldos');
  await page.locator('#st-backup').click();
  await expect(page.locator('#toast')).toContainText('Respaldo creado');
});

test('ayuda de atajos incluye lo nuevo', async ({ page }) => {
  await page.keyboard.press('Alt+H');
  await expect(page.locator('#dlg-keys')).toContainText('Barra de teclas');
  await expect(page.locator('#dlg-keys')).toContainText('Arrastrar el borde');
});

test('los atajos que alternan funcionan desde dentro de la terminal (una sola vez)', async ({ page }) => {
  await page.locator('#grid .pane').nth(0).click();
  await page.keyboard.press('Alt+Z');
  await expect(page.locator('#grid')).toHaveClass(/zoomed/);
  await page.keyboard.press('Alt+Z');
  await expect(page.locator('#grid')).not.toHaveClass(/zoomed/);
  await page.keyboard.press('Alt+S');
  await expect(page.locator('body')).toHaveClass(/sidebar-collapsed/);
  await page.keyboard.press('Alt+S');
  await expect(page.locator('body')).not.toHaveClass(/sidebar-collapsed/);
});
