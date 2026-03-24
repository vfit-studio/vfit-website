import { chromium } from 'playwright';

const SITE_URL = 'https://vfit-studio.netlify.app';

const plans = [
  { name: 'Signature', price: '$60', period: 'session', features: ['Weekly recurring group session/s (max 4 ppl)', '3-month minimum commitment', 'Best value per session'] },
  { name: 'Flexible', price: '$70', period: 'session', features: ['Weekly recurring group session/s (max 4 ppl)', 'No minimum contract', 'Full flexibility, no lock-in'] },
  { name: 'VIP',      price: '$190', period: 'session', features: ['Weekly private 1-on-1 PT session', 'Direct line to Georgie anytime', 'Fridge access (juices, waters & snacks)', '3-month commitment'] },
];

const firstNames = ['Emma','Liam','Olivia','Noah','Ava','James','Sophia','Will','Mia','Ben','Charlotte','Lucas','Amelia','Henry','Harper','Jack','Ella','Owen','Lily','Sam'];
const lastNames  = ['Smith','Jones','Brown','Wilson','Taylor','Clark','Walker','Hall','Young','King','Wright','Scott','Adams','Baker','Green','Hill','Moore','White','Lee','Martin'];

function testEmail(f, l, i) { return `test.${f.toLowerCase()}.${l.toLowerCase()}.${i}@vfittest.com`; }
function testPhone(i) { return `0400${String(100+i).padStart(3,'0')}${String(Math.floor(Math.random()*900)+100)}`; }

async function click(page, selector) {
  await page.locator(selector).first().click({ force: true });
  await page.waitForTimeout(300);
}

async function submitMembership(page, plan, userIndex) {
  const first = firstNames[userIndex % firstNames.length];
  const last  = lastNames[userIndex % lastNames.length];
  const name  = `Test ${first} ${last}`;
  const email = testEmail(first, last, userIndex);
  const phone = testPhone(userIndex);
  const isMorning = userIndex % 2 === 0;

  console.log(`  [${plan.name}] #${userIndex+1}: ${name}`);

  await page.goto(SITE_URL);
  await page.waitForTimeout(2000);
  await page.evaluate(() => showPage('memberships'));
  await page.waitForTimeout(1000);

  // Open wizard via JS (reliable cross-device)
  await page.evaluate((p) => openMembershipWizard(p.name, p.price, p.period, p.features), plan);
  await page.locator('#wizModal.open').waitFor({ timeout: 8000 });
  await page.waitForTimeout(500);

  // ── STEP 1: Review plan → Continue ──
  await click(page, 'button.wiz-next');
  await page.waitForTimeout(500);

  // ── STEP 2: Schedule ──
  // Sessions per week
  const sessionsIdx = userIndex % 4;
  await page.locator('#wizSessionPills .wiz-pill').nth(sessionsIdx).click({ force: true });
  await page.waitForTimeout(300);

  // Preferred days — click 3 days
  const dayChips = page.locator('#wizDayChips .wiz-day-chip');
  for (let d = 0; d < 3; d++) {
    await dayChips.nth((userIndex + d) % 6).click({ force: true });
    await page.waitForTimeout(200);
  }

  // Morning / Afternoon toggle
  await page.locator('#wizTimeToggle button').nth(isMorning ? 0 : 1).click({ force: true });
  await page.waitForTimeout(600);

  // Time slot(s) — click 1 or 2
  const slots = page.locator('.wiz-time-slot');
  const slotCount = await slots.count();
  if (slotCount > 0) {
    await slots.nth(userIndex % slotCount).click({ force: true });
    await page.waitForTimeout(200);
    if (userIndex % 3 === 0 && slotCount > 1) {
      await slots.nth((userIndex + 1) % slotCount).click({ force: true });
      await page.waitForTimeout(200);
    }
  }

  // Continue to step 3
  await click(page, 'button.wiz-next');
  await page.waitForTimeout(500);

  // ── STEP 3: Contact details ──
  await page.locator('#wizName').fill(name);
  await page.locator('#wizEmail').fill(email);
  await page.locator('#wizPhone').fill(phone);
  await page.locator('#wizNotes').fill(`Test #${userIndex+1} — ${plan.name}`);
  await page.waitForTimeout(300);

  // Continue to step 4
  await click(page, 'button.wiz-next');
  await page.waitForTimeout(500);

  // ── STEP 4: Review & Submit ──
  await page.locator('#wizSubmitBtn').click({ force: true });

  try {
    await page.locator('#wizSuccess.show').waitFor({ timeout: 20000 });
    console.log(`    ✓ Success`);
    return true;
  } catch {
    await page.screenshot({ path: `/tmp/vfit-fail-${userIndex}.png` });
    console.log(`    ✗ FAILED — screenshot at /tmp/vfit-fail-${userIndex}.png`);
    return false;
  }
}

async function run() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  let passed = 0, failed = 0;

  for (const plan of plans) {
    console.log(`\n=== ${plan.name} — 20 signups (iPhone 14) ===`);
    for (let i = 0; i < 20; i++) {
      const idx = plans.indexOf(plan) * 20 + i;
      try {
        const ok = await submitMembership(page, plan, idx);
        if (ok) passed++; else failed++;
      } catch (err) {
        console.log(`    ✗ ERROR: ${err.message.split('\n')[0]}`);
        await page.screenshot({ path: `/tmp/vfit-error-${idx}.png` }).catch(() => {});
        failed++;
      }
      await page.waitForTimeout(400);
    }
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`✓ Passed: ${passed}`);
  console.log(`✗ Failed: ${failed}`);
  console.log(`Total:    ${passed + failed}`);

  await browser.close();
}

run().catch(console.error);
