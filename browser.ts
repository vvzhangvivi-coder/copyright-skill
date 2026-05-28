// ============================================================
// Playwright 浏览器封装层
// ============================================================
// 为每条填表任务创建独立的浏览器上下文（headed 模式），
// 用户可在本地看到浏览器操作过程。

import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface BrowserSession {
  sessionId: string;
  page: Page;
  browser: Browser;
  context: BrowserContext;
  screenshotDir: string;
}

const BASE_SCREENSHOT_DIR = join(process.cwd(), "screenshots");

/** 创建浏览器会话（headed 模式，使用 Safari/WebKit 内核） */
export async function createBrowserSession(sessionId: string): Promise<BrowserSession> {
  const screenshotDir = join(BASE_SCREENSHOT_DIR, sessionId);
  if (!existsSync(screenshotDir)) {
    mkdirSync(screenshotDir, { recursive: true });
  }

  const browser = await chromium.launch({
    headless: false,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
  });

  const page = await context.newPage();

  return { sessionId, page, browser, context, screenshotDir };
}

/** 通过 CDP 重连已有浏览器（服务器重启后使用） */
export async function connectToExistingBrowser(sessionId: string): Promise<BrowserSession | null> {
  const screenshotDir = join(BASE_SCREENSHOT_DIR, sessionId);
  if (!existsSync(screenshotDir)) {
    mkdirSync(screenshotDir, { recursive: true });
  }

  // Playwright 的 WebKit/Safari 内核不支持 Chromium CDP 重连。
  return null;
}

/** 关闭浏览器会话 */
export async function closeSession(session: BrowserSession): Promise<void> {
  try {
    await session.page.close();
    await session.context.close();
    await session.browser.close();
  } catch {
    // 忽略关闭错误
  }
}

// ============================================================
// 导航
// ============================================================

export async function navigateTo(session: BrowserSession, url: string): Promise<void> {
  await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
}

export async function waitForPageLoad(session: BrowserSession): Promise<void> {
  await session.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

// ============================================================
// 页面信息
// ============================================================

export function getCurrentUrl(session: BrowserSession): string {
  return session.page.url();
}

export async function getPageTitle(session: BrowserSession): Promise<string> {
  return await session.page.title();
}

// ============================================================
// 页面交互
// ============================================================

/** 按 CSS 选择器点击 */
export async function clickSelector(session: BrowserSession, selector: string): Promise<void> {
  await session.page.click(selector, { timeout: 5000 });
}

/** 按文本查找并点击 */
export async function clickByText(session: BrowserSession, text: string): Promise<boolean> {
  try {
    await session.page.getByText(text, { exact: true }).first().click({ timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** 按 role + name 点击 */
export async function clickByRole(
  session: BrowserSession,
  role: "button" | "link" | "checkbox",
  name: string
): Promise<boolean> {
  try {
    await session.page.getByRole(role, { name }).first().click({ timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** 按 label 填写输入框 */
export async function fillByLabel(
  session: BrowserSession,
  label: string,
  value: string
): Promise<boolean> {
  try {
    await session.page.getByLabel(label).first().fill(value, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** 按 label 选择下拉框 */
export async function selectByLabel(
  session: BrowserSession,
  label: string,
  value: string
): Promise<boolean> {
  try {
    await session.page.getByLabel(label).first().selectOption(value, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** 按 label 勾选复选框 */
export async function checkByLabel(
  session: BrowserSession,
  label: string
): Promise<boolean> {
  try {
    await session.page.getByLabel(label).first().check({ timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** 按 CSS 选择器填写输入框 */
export async function fillSelector(
  session: BrowserSession,
  selector: string,
  value: string
): Promise<void> {
  await session.page.fill(selector, value, { timeout: 5000 });
}

/** 按 CSS 选择器选择下拉项 */
export async function selectOption(
  session: BrowserSession,
  selector: string,
  value: string
): Promise<void> {
  await session.page.selectOption(selector, value, { timeout: 5000 });
}

/** 等待指定毫秒 */
export async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** 滚动到页面底部，包括 iframe 和内层 overflow 容器 */
export async function scrollToBottom(session: BrowserSession): Promise<void> {
  await Promise.all(
    session.page.frames().map(async (frame: Frame) => {
      try {
        await frame.evaluate(() => {
          const scrollRoot = document.scrollingElement || document.documentElement || document.body;
          const maxHeight = Math.max(
            document.body?.scrollHeight || 0,
            document.documentElement?.scrollHeight || 0,
            scrollRoot?.scrollHeight || 0
          );

          window.scrollTo(0, maxHeight);
          if (scrollRoot) scrollRoot.scrollTop = scrollRoot.scrollHeight;

          for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
            const canScroll = el.scrollHeight > el.clientHeight + 8;
            if (canScroll) el.scrollTop = el.scrollHeight;
          }
        });
      } catch {
        // frame 可能跨域、跳转中或已经 detach；跳过即可
      }
    })
  );

  try {
    await session.page.mouse.wheel(0, 3000);
  } catch {}
}

/** 切换到主表单 iframe（sbIndex.html 页面内） */
export function getFormFrame(session: BrowserSession) {
  return session.page.frameLocator("#sbform");
}

// ============================================================
// 截图
// ============================================================

export async function screenshot(
  session: BrowserSession,
  name: string
): Promise<string> {
  const path = join(session.screenshotDir, `${name}.png`);
  try {
    await session.page.screenshot({ path, fullPage: false, timeout: 10000 });
  } catch {
    // 截图失败不影响主流程
  }
  return path;
}
