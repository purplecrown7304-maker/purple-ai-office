// Browser acceptance against the real production app, GoTrue, PostgreSQL and Realtime.
// Called by test-http.mjs inside its disposable loopback stack.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
export async function testBrowser({ origin, email, password, sql }) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mkdir("test-results/ui", { recursive: true });
  try {
    await page.goto(origin + "/tasks/new");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("이메일", { exact: true }).fill(email);
    await page.getByLabel("비밀번호", { exact: true }).fill(password);
    await page.getByRole("button", { name: "오피스 입장" }).click();
    await expect(
      page.getByRole("heading", { name: "오피스", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "새 작업", exact: true }).click();
    await page.getByLabel("제목", { exact: true }).fill("브라우저 데모 검증");
    await page
      .getByLabel("설명", { exact: true })
      .fill("실제 DB와 Realtime으로 진행합니다.");
    await page
      .getByLabel("수락 조건 (한 줄에 하나)")
      .fill("정상 사례 통과\n경계값 사례 통과");
    await page.getByLabel("구현 에이전트").selectOption({ label: "Claude" });
    await page.getByLabel("검수 에이전트").selectOption({ label: "GPT" });
    await page.getByLabel("단계 간격 (ms)").fill("1000");
    await page.getByRole("button", { name: "작업 만들기" }).click();
    await expect(page).toHaveURL(/\?task=/);
    const id = new URL(page.url()).searchParams.get("task");
    await expect(page.getByText("실시간 연결", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    const observer = await context.newPage();
    await observer.goto(origin + "/?task=" + id);
    await expect(
      observer.getByText("실시간 연결", { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    // Observe actual DOM changes, never inject application state or intercept data.
    await page.evaluate(() => {
      window.__observed = { activities: [], parcels: [] };
      new MutationObserver(() => {
        for (const el of document.querySelectorAll("[data-activity]"))
          window.__observed.activities.push(el.getAttribute("data-activity"));
        for (const el of document.querySelectorAll("[data-message-id]"))
          window.__observed.parcels.push(el.getAttribute("data-message-id"));
      }).observe(document.body, {
        subtree: true,
        attributes: true,
        childList: true,
      });
    });
    await page.getByRole("button", { name: "데모 실행", exact: true }).click();
    await expect(page.locator(".speech")).toContainText("정상·경계·실패", {
      timeout: 25000,
    });
    await page.screenshot({
      path: "test-results/ui/01-question-desktop.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "일시정지", exact: true }).click();
    await expect
      .poll(async () =>
        Boolean(
          (await sql`select demo_paused from public.tasks where id=${id}`)[0]
            .demo_paused,
        ),
      )
      .toBe(true);
    await expect
      .poll(async () =>
        Number(
          (
            await sql`select count(*) n from public.agent_runs where task_id=${id} and status='STARTED'`
          )[0].n,
        ),
      )
      .toBe(0);
    const paused = (
      await sql`select count(*) n from public.agent_runs where task_id=${id}`
    )[0].n;
    await page.reload();
    await expect(
      page.getByRole("button", { name: "데모 실행", exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-message-id]")).toHaveCount(0);
    await expect(page.locator(".desk:not(.activity-idle)")).toHaveCount(0);
    assert.equal(
      (
        await sql`select count(*) n from public.agent_runs where task_id=${id}`
      )[0].n,
      paused,
    );
    // Observe the second half after reload too.
    await page.evaluate(() => {
      window.__observed = { activities: [], parcels: [] };
      new MutationObserver(() => {
        for (const el of document.querySelectorAll("[data-activity]"))
          window.__observed.activities.push(el.getAttribute("data-activity"));
        for (const el of document.querySelectorAll("[data-message-id]"))
          window.__observed.parcels.push(el.getAttribute("data-message-id"));
      }).observe(document.body, {
        subtree: true,
        attributes: true,
        childList: true,
      });
    });
    await page.getByRole("button", { name: "데모 실행", exact: true }).click();
    await expect(page.locator(".speech")).toContainText("수정 요청", {
      timeout: 25000,
    });
    await page.screenshot({
      path: "test-results/ui/02-revision-desktop.png",
      fullPage: true,
    });
    await expect(
      page.getByRole("heading", { name: "승인이 필요해요" }),
    ).toBeVisible({ timeout: 25000 });
    await expect(
      observer.getByRole("heading", { name: "승인이 필요해요" }),
    ).toBeVisible({ timeout: 15000 });
    await page.screenshot({
      path: "test-results/ui/03-approval-desktop.png",
      fullPage: true,
    });
    const observed = await page.evaluate(() => window.__observed);
    assert.ok(
      observed.activities.includes("typing"),
      "DB working lead drives typing",
    );
    assert.ok(
      observed.activities.includes("scan"),
      "DB working reviewer drives scan",
    );
    assert.ok(observed.parcels.length > 0, "New DB messages drive parcels");
    await expect(page.locator(".desk:not(.activity-idle)")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator(".waiting-banner")).toBeVisible();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      "No 390px horizontal overflow",
    );
    await page.screenshot({
      path: "test-results/ui/04-approval-mobile.png",
      fullPage: true,
    });
    await page
      .getByLabel("결정 사유")
      .fill("실제 브라우저와 DB에서 검수·테스트를 확인했습니다.");
    await page.getByRole("button", { name: "승인하고 완료" }).click();
    await expect
      .poll(
        async () =>
          (await sql`select status from public.tasks where id=${id}`)[0].status,
      )
      .toBe("DONE");
    await expect(observer.locator(".demo-badge")).toContainText("완료");
    const [stored] =
      await sql`select cost_usd,demo_step from public.tasks where id=${id}`;
    assert.equal(Number(stored.cost_usd), 0.55);
    assert.equal(stored.demo_step, 11);
    assert.equal(
      (
        await sql`select * from public.agent_runs where task_id=${id} and status='APPLIED'`
      ).length,
      11,
    );
    await page.getByRole("link", { name: /TASK-.* 상세/ }).click();
    await expect(
      page.getByRole("heading", { name: "상태 전이 이력" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "테스트 결과" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Claude", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "실행 기록" }),
    ).toBeVisible();
    await page.goto(origin + "/?task=" + id);
    await page.getByRole("link", { name: "HTTP demo", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "결정 기록" }),
    ).toBeVisible();
    await expect(page.getByText(/실제 브라우저와 DB에서 검수/)).toBeVisible();
    await page.goto(origin + "/?task=" + id);
    await page.getByRole("button", { name: "새 데모 만들기" }).click();
    await expect(page).not.toHaveURL(new RegExp(id));
    const restarted = new URL(page.url()).searchParams.get("task");
    assert.ok(restarted && restarted !== id);
    assert.equal(
      (await sql`select status from public.tasks where id=${id}`)[0].status,
      "DONE",
    );
    await page.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto(origin + "/tasks/" + id);
    await expect(page).toHaveURL(/\/login$/);
    assert.deepEqual(errors, [], "No browser runtime errors");
    console.log(
      "PASS: browser login, create/assign, real Realtime observer, DB animations, pause/reload, 11 steps, CEO approval, detail pages, 390px/reduced motion, restart audit and logout",
    );
  } catch (e) {
    await page
      .screenshot({ path: "test-results/ui/failure.png", fullPage: true })
      .catch(() => {});
    console.error((await page.locator("body").innerText()).slice(0, 7000));
    throw e;
  } finally {
    await browser.close();
  }
}
