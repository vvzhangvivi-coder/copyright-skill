// ============================================================
// Playwright 版填表引擎
// ============================================================
// 复用 Chrome 扩展的 fieldMapping 配置和 template 生成逻辑，
// 用 Playwright 直接操控浏览器执行填表操作。

import type { CopyrightRecord, CompanyConfig, FieldSelector, FormStep } from "./src/types/index.js";
import {
  getSelectorsForStep,
} from "./src/utils/fieldMapping.js";
import {
  generateContentIntro,
  generateCreationProcess,
} from "./src/utils/template.js";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { constants as cryptoConstants, randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { getRecordAttachments, getRightsProofAttachments, downloadFeishuAttachment } from "./feishu-bot.js";
import * as b from "./browser.js";
import type { BrowserSession } from "./browser.js";
import type { ElementHandle, Frame, Locator } from "playwright";

export interface FillProgress {
  phase: "login" | "waiting_login" | "filling" | "step" | "record_done" | "all_done" | "error" | "restart_ready";
  message: string;
  step?: string;
  recordIndex?: number;
  totalRecords?: number;
  screenshot?: string;
  success?: number;
  failed?: number;
  retryable?: boolean;
  failedRecords?: Array<{ index: number; workName: string; error: string }>;
}

export type ProgressCallback = (progress: FillProgress) => void;

// ============================================================
// 上传超时时间：根据文件类型自动调整
// ============================================================

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".wmv", ".flv", ".webm", ".m4v", ".3gp"]);
const DEFAULT_UPLOAD_TIMEOUT_MS = 600_000;   // 普通文件 10 分钟：政务站上传偶尔很慢
const VIDEO_UPLOAD_TIMEOUT_MS = 600_000;     // 视频文件 600 秒（10 分钟）
const WORK_REGISTRATION_URL = "https://zwfw.hubei.gov.cn/webview/bszn/bsznpage.html?transactCode=11420000777570977B200073900100001&taskType=07";

function getUploadTimeout(filePath: string): number {
  const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";
  return VIDEO_EXTENSIONS.has(ext) ? VIDEO_UPLOAD_TIMEOUT_MS : DEFAULT_UPLOAD_TIMEOUT_MS;
}

// ============================================================
// ccct.net.cn 登录
// ============================================================

export async function loginToCcct(
  session: BrowserSession,
  onProgress: ProgressCallback
): Promise<string> {
  // 1. 打开湖北政务服务网办事指南页
  onProgress({ phase: "login", message: "正在打开作品登记页面..." });
  await b.navigateTo(session, WORK_REGISTRATION_URL);
  await b.waitForPageLoad(session);
  await b.wait(2000);

  // 2. 点击「在线办理」
  onProgress({ phase: "login", message: "点击在线办理..." });
  await b.clickByRole(session, "button", "在线办理");
  await b.wait(3000);

  // 3. 点击「去登录」
  onProgress({ phase: "login", message: "点击去登录..." });
  await b.clickByText(session, "去登录");
  await b.wait(5000);

  // 4. 切换到登录标签页
  let pages = session.context.pages();
  for (const p of pages) {
    const url = p.url();
    if (url.includes("oauth.hubei.gov.cn") || url.includes("mainChain.do")) {
      session.page = p;
      break;
    }
  }
  await b.waitForPageLoad(session);

  // 点击「法人登录」（必须成功，不能跳过）
  await b.wait(2000);
  let corporateClicked = false;
  for (let retry = 0; retry < 5 && !corporateClicked; retry++) {
    try {
      await session.page.getByText("法人登录").first().click({ timeout: 3000 });
      corporateClicked = true;
    } catch {}
    if (!corporateClicked) {
      try {
        await session.page.locator('a, span, div, li, button').filter({ hasText: "法人登录" }).first().click({ timeout: 2000 });
        corporateClicked = true;
      } catch {}
    }
    if (!corporateClicked) await b.wait(1000);
  }
  if (!corporateClicked) {
    // 最后兜底：JS 直接点
    try {
      await session.page.evaluate(() => {
        const els = Array.from(document.querySelectorAll("a, span, div, li, button"));
        const target = els.find(el => (el.textContent || "").includes("法人登录"));
        if (target) (target as HTMLElement).click();
      });
    } catch {}
  }
  await b.wait(1500);

  await b.screenshot(session, "00-login-page");

  onProgress({ phase: "waiting_login", message: "请在弹出的浏览器窗口中手动登录" });

  // 5. 轮询等待登录完成，然后处理前置页面
  const maxWait = 5 * 60 * 1000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await b.wait(2000);

    // 检查是否离开了登录页，进入了 sbIndex.html
    const allPages = session.context.pages();
    for (const p of allPages) {
      const url = p.url();
      // 找到了 sbIndex.html = 登录成功
      if (url.includes("sbIndex.html")) {
        session.page = p;
        onProgress({ phase: "login", message: "检测到登录成功！" });
        await b.wait(2000);
        await b.waitForPageLoad(session);
        const loginName = await readLoginDisplayName(session, 8000);
        if (loginName) {
          onProgress({ phase: "login", message: `当前登录主体：${loginName}` });
        }

        // === 登录成功，处理信用承诺/申请须知等前置页面 ===
        await advanceApplicationIntroPages(session, onProgress);

        await b.screenshot(session, "01-login-done");
        onProgress({ phase: "login", message: "登录完成，准备开始填表..." });
        return loginName;
      }
    }
  }

  throw new Error("等待登录超时（5分钟），请重新开始");
}

async function readLoginDisplayName(session: BrowserSession, timeoutMs = 0): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  do {
    for (const page of session.context.pages()) {
      for (const frame of page.frames()) {
        try {
          const name = await frame.evaluate(() => {
        function cleanup(value: string) {
          return String(value || "")
            .replace(/\u00a0/g, " ")
            .replace(/\s+/g, " ")
            .replace(/^您好[，,]?\s*/, "")
            .replace(/\s*(个人中心|修改密码|退出).*$/, "")
            .trim();
        }

        function candidateText(el: HTMLElement | null) {
          if (!el) return "";
          const inputValue = el instanceof HTMLInputElement ? el.value : "";
          return cleanup([
            el.textContent || "",
            el.innerText || "",
            el.getAttribute("title") || "",
            el.getAttribute("aria-label") || "",
            inputValue,
          ].filter(Boolean).join(" "));
        }

        const directSelectors = [
          ".name_s",
          "span.name_s",
          ".name",
          ".userName",
          ".username",
          ".user-name",
          ".loginName",
          ".login-name",
          "[class*='user'][class*='name']",
          "[class*='login'][class*='name']",
        ];

        for (const selector of directSelectors) {
          const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
          for (const el of elements) {
            const text = candidateText(el);
            if (text && text.length >= 2 && text.length <= 80) return text;
          }
        }

        const bodyText = cleanup(document.body?.innerText || document.body?.textContent || "");
        const greeting = bodyText.match(/您好[，,]?\s*(.{2,80}?)(?:个人中心|修改密码|退出)/);
        if (greeting?.[1]) {
          const text = cleanup(greeting[1]);
          if (text && text.length >= 2 && text.length <= 80) return text;
        }

        const candidates = Array.from(document.querySelectorAll<HTMLElement>("span, div, a, li"))
          .map(candidateText)
          .filter((text) => text.length >= 2 && text.length <= 80)
          .filter((text) => /公司|网络|科技|文化|传媒|工作室|中心|厂|店|社|网/.test(text))
          .filter((text) => !/在线办理|作品自愿登记|信用承诺|个人中心|修改密码|退出|全国一体化|政务服务/.test(text));

        return candidates[0] || "";
      });
          if (name) return name;
        } catch {}
      }
    }

    if (Date.now() < deadline) await b.wait(500);
  } while (Date.now() < deadline);

  return "";
}

/**
 * 为下一条记录准备申报页。
 * 优先复用当前页，避免每条记录堆出多个政务网窗口；只有当前页不可用时才新建页面兜底。
 */
export async function openFreshApplicationPage(
  session: BrowserSession,
  onProgress: ProgressCallback
): Promise<void> {
  if (await isApplicationIntroVisible(session)) {
    try {
      onProgress({ phase: "login", message: "复用当前申报页，准备下一条记录..." });
      await session.page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await b.waitForPageLoad(session);
      await b.wait(1500);
      await advanceApplicationIntroPages(session, onProgress);
      await closeInactiveApplicationPages(session);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onProgress({ phase: "login", message: `复用当前申报页失败，重新打开申报入口: ${message}` });
    }
  }

  onProgress({ phase: "login", message: "复用当前页面打开新的申报入口..." });
  try {
    await b.navigateTo(session, WORK_REGISTRATION_URL);
  } catch {
    const fallbackPage = await session.context.newPage();
    session.page = fallbackPage;
    await b.navigateTo(session, WORK_REGISTRATION_URL);
  }
  await b.waitForPageLoad(session);
  await b.wait(1500);

  onProgress({ phase: "login", message: "点击在线办理，准备下一条记录..." });
  const clicked = await b.clickByRole(session, "button", "在线办理") || await tryClick(session, "在线办理");
  if (!clicked) {
    throw new Error("新申报页未找到「在线办理」按钮");
  }
  await b.wait(4000);

  const entered = await waitForApplicationPage(session, 60_000);
  if (!entered) {
    throw new Error("打开新申报页超时，可能需要重新登录");
  }

  await advanceApplicationIntroPages(session, onProgress);
  await closeInactiveApplicationPages(session);
}

async function isApplicationIntroVisible(session: BrowserSession): Promise<boolean> {
  return pageContainsText(session.page, ["作品自愿登记", "信用承诺", "我已阅读并承诺"]);
}

async function closeInactiveApplicationPages(session: BrowserSession): Promise<void> {
  const active = session.page;
  for (const page of session.context.pages()) {
    if (page === active || page.isClosed()) continue;
    await page.close().catch(() => {});
  }
}

async function waitForApplicationPage(session: BrowserSession, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const pages = session.context.pages();
    for (const page of pages) {
      const url = page.url();
      if (url.includes("sbIndex.html")) {
        session.page = page;
        await b.waitForPageLoad(session);
        return true;
      }
      const hasApplicationShell = await pageContainsText(page, ["作品自愿登记", "信用承诺", "我已阅读并承诺"]);
      if (hasApplicationShell) {
        session.page = page;
        return true;
      }
      if (url.includes("oauth.hubei.gov.cn") || url.includes("mainChain.do")) {
        session.page = page;
      }
    }
    await b.wait(1000);
  }

  return false;
}

async function pageContainsText(page: BrowserSession["page"], texts: string[]): Promise<boolean> {
  try {
    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    if (texts.some((text) => bodyText.includes(text))) return true;
  } catch {}

  for (const frame of page.frames()) {
    try {
      const bodyText = await frame.evaluate(() => document.body?.innerText || "");
      if (texts.some((text) => bodyText.includes(text))) return true;
    } catch {}
  }

  return false;
}

async function advanceApplicationIntroPages(
  session: BrowserSession,
  onProgress: ProgressCallback
): Promise<void> {
  const deadline = Date.now() + 90_000;
  let commitmentClicked = false;
  let agreementClicks = 0;

  while (Date.now() < deadline) {
    await b.wait(1200);

    if (await isWorkInfoSectionVisible(session)) {
      onProgress({ phase: "login", message: "新申报页已进入作品基本信息" });
      await b.wait(1000);
      return;
    }

    if (await isCopyrightOwnerInfoVisible(session)) {
      onProgress({ phase: "login", message: "新申报页已进入著作权人信息" });
      await b.wait(1500);
      return;
    }

    const committed = await clickCommitmentButton(session) || await tryClick(session, "我已阅读并承诺");
    if (committed) {
      if (!commitmentClicked) onProgress({ phase: "login", message: "已确认信用承诺" });
      commitmentClicked = true;
      await b.wait(2500);
      continue;
    }

    const agreed = await tryClick(session, "同意并前往下一步");
    if (agreed) {
      agreementClicks++;
      onProgress({ phase: "login", message: `已同意第 ${agreementClicks} 个承诺页` });
      await b.wait(2500);
      continue;
    }

    const next = await tryClick(session, "下一步");
    if (next) {
      onProgress({ phase: "login", message: "已点击下一步，等待进入著作权人信息" });
      await b.wait(2500);
      continue;
    }
  }

  const screenshot = await b.screenshot(session, "fresh-next-click-failed");
  onProgress({ phase: "error", message: "新申报页未能进入著作权人信息", screenshot });
  throw new Error("新申报页未能进入著作权人信息");
}

async function isCopyrightOwnerInfoVisible(session: BrowserSession): Promise<boolean> {
  for (const frame of getCandidateFrames(session)) {
    try {
      const visible = await frame.evaluate(() => {
        const bodyText = document.body?.innerText || "";
        const compact = bodyText.replace(/\s+/g, "");

        // 进度条会一直显示“申办人信息填写”，所以必须先排除仍停在信用承诺正文/按钮的状态。
        const stillOnCommitment = compact.includes("我已阅读并承诺")
          || compact.includes("我单位（本人）经审慎研究")
          || compact.includes("郑重作出以下承诺")
          || compact.includes("特此承诺");
        if (stillOnCommitment) return false;

        const hasOwnerStageText = compact.includes("申办人信息填写")
          || compact.includes("著作权人信息")
          || compact.includes("申请人信息");
        if (!hasOwnerStageText) return false;

        function isVisible(el: HTMLElement) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && Number(style.opacity) !== 0
            && rect.width > 0
            && rect.height > 0;
        }

        const hasNextButton = Array.from(document.querySelectorAll<HTMLElement>(
          "button, a, input[type='button'], input[type='submit'], .layui-btn, [role='button'], [class*='btn'], [class*='button']"
        )).some((el) => {
          if (!isVisible(el)) return false;
          const text = `${el.textContent || ""} ${(el as HTMLInputElement).value || ""}`.replace(/\s+/g, "");
          return text.includes("下一步") || text.includes("继续");
        });

        return hasNextButton;
      });
      if (visible) return true;
    } catch {}
  }

  return false;
}

async function isWorkInfoSectionVisible(session: BrowserSession): Promise<boolean> {
  for (const frame of getCandidateFrames(session)) {
    try {
      const visible = await frame.evaluate(() => {
        const bodyText = document.body?.innerText || "";
        const compact = bodyText.replace(/\s+/g, "");
        const hasWorkInfoFields = compact.includes("作品创作性质")
          || compact.includes("创作过程")
          || (compact.includes("发表状态") && compact.includes("首次发表日期"))
          || compact.includes("请选择作品创作性质");
        const hasUploadFields = compact.includes("作品电子文件") && compact.includes("选择文件");
        return hasWorkInfoFields && !hasUploadFields;
      });
      if (visible) return true;
    } catch {}
  }

  return false;
}

async function waitForWorkInfoSection(session: BrowserSession, timeoutMs = 12000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isWorkInfoSectionVisible(session)) return true;
    await b.wait(600);
  }
  return false;
}

async function waitForCopyrightOwnerInfo(session: BrowserSession, timeoutMs = 12000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCopyrightOwnerInfoVisible(session)) return true;
    if (await isWorkInfoSectionVisible(session)) return true;
    await b.wait(600);
  }
  return false;
}

async function clickCommitmentButton(session: BrowserSession): Promise<boolean> {
  const texts = ["我已阅读并承诺", "我已阅读", "承诺"];
  for (const frame of getCandidateFrames(session)) {
    try {
      if (await clickLocator(frame.locator('input[type="button"][value*="我已阅读并承诺"], input[type="submit"][value*="我已阅读并承诺"]'))) return true;
      if (await clickLocator(frame.locator("button, a, .layui-btn, [role='button'], [class*='btn'], [class*='button']").filter({ hasText: "我已阅读并承诺" }))) return true;
      if (await clickLocator(frame.getByText("我已阅读并承诺", { exact: true }))) return true;
    } catch {}
  }

  for (const frame of getCandidateFrames(session)) {
    try {
      const clicked = await frame.evaluate((targets) => {
        const normalize = (value: string) => value.replace(/\s+/g, "");
        function isVisible(el: HTMLElement): boolean {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && Number(style.opacity) !== 0
            && rect.width > 0
            && rect.height > 0;
        }

        function scrollToElement(el: HTMLElement) {
          el.scrollIntoView({ block: "center", inline: "center" });
          for (let parent = el.parentElement; parent; parent = parent.parentElement) {
            if (parent.scrollHeight <= parent.clientHeight + 8) continue;
            const parentRect = parent.getBoundingClientRect();
            const elRect = el.getBoundingClientRect();
            parent.scrollTop += elRect.top - parentRect.top - parent.clientHeight / 2 + elRect.height / 2;
          }
        }

        function clickElement(el: HTMLElement) {
          scrollToElement(el);
          try { el.focus(); } catch {}
          for (const eventName of ["mouseover", "mousedown", "mouseup", "click"]) {
            el.dispatchEvent(new MouseEvent(eventName, { bubbles: true, cancelable: true, view: window }));
          }
          return true;
        }

        const nodes = Array.from(document.querySelectorAll<HTMLElement>("button, a, input[type='button'], input[type='submit'], .layui-btn, [role='button'], [class*='btn'], [class*='button'], div, span"))
          .filter(isVisible)
          .map((el) => {
            const text = `${el.textContent || ""} ${(el as HTMLInputElement).value || ""}`.trim();
            const compact = normalize(text);
            const exact = targets.some((target) => compact === normalize(target));
            const includes = targets.some((target) => compact.includes(normalize(target)));
            const clickable = el.matches("button, a, input, .layui-btn, [role='button'], [class*='btn'], [class*='button']")
              || window.getComputedStyle(el).cursor === "pointer"
              || el.onclick !== null
              || !!el.closest("button, a, .layui-btn, [role='button'], [class*='btn'], [class*='button']");
            return { el, text, compact, exact, includes, clickable };
          })
          .filter((item) => item.includes && item.compact.length <= 80)
          .sort((a, b) => {
            if (Number(b.exact) !== Number(a.exact)) return Number(b.exact) - Number(a.exact);
            if (Number(b.clickable) !== Number(a.clickable)) return Number(b.clickable) - Number(a.clickable);
            return a.compact.length - b.compact.length;
          });

        const target = nodes[0]?.el;
        if (!target) return false;
        const clickable = target.closest("button, a, .layui-btn, [role='button'], [class*='btn'], [class*='button']") as HTMLElement | null;
        return clickElement(clickable || target);
      }, texts);
      if (clicked) return true;
    } catch {}
  }
  return false;
}

// ============================================================
// 单条记录填表
// ============================================================

export async function fillOneRecord(
  session: BrowserSession,
  record: CopyrightRecord,
  company: CompanyConfig,
  recordIndex: number,
  totalRecords: number,
  onProgress: ProgressCallback,
  sourceRecordIndex = recordIndex
): Promise<boolean> {
  const workName = record.作品名称 || `记录 ${recordIndex + 1}`;

  try {
    // 登录后直接进入「著作权人信息」页面，申请须知已在前置流程中完成
    // 第 1 步：著作权人信息（已预填，直接点下一步）
    await doStep(session, "copyright_owner", record, company, recordIndex, totalRecords, onProgress, sourceRecordIndex);

    // 第 2 步：作品基本信息
    await doStep(session, "work_info", record, company, recordIndex, totalRecords, onProgress, sourceRecordIndex);

    // 第 3 步：上传作品（作品名称 + 作品类别 + 作品电子文件）
    await doStep(session, "upload", record, company, recordIndex, totalRecords, onProgress, sourceRecordIndex);

    // 第 4 步：权利状况说明
    await doStep(session, "rights_info", record, company, recordIndex, totalRecords, onProgress, sourceRecordIndex);

    // 第 5 步：上传权利归属证明材料（独立步骤）
    await doStep(session, "rights_proof", record, company, recordIndex, totalRecords, onProgress, sourceRecordIndex);

    // 第 6 步：预览 + 暂存
    await doStep(session, "preview", record, company, recordIndex, totalRecords, onProgress, sourceRecordIndex);

    onProgress({
      phase: "record_done",
      message: `✅ 第 ${recordIndex + 1}/${totalRecords} 条完成: ${workName}`,
      recordIndex, totalRecords,
      screenshot: await b.screenshot(session, `done-${recordIndex + 1}`),
    });

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onProgress({ phase: "error", message: `❌ ${workName}: ${msg}`, recordIndex, totalRecords });
    return false;
  }
}

// ============================================================
// 统一步骤处理
// ============================================================

const STEP_NAMES: Record<string, string> = {
  agreement: "申请须知",
  copyright_owner: "著作权人信息",
  work_info: "作品基本信息",
  upload: "上传作品",
  rights_info: "权利状况说明",
  rights_proof: "权利归属证明材料",
  preview: "预览提交",
};

async function doStep(
  session: BrowserSession,
  step: string,
  record: CopyrightRecord,
  company: CompanyConfig,
  recordIndex: number,
  totalRecords: number,
  onProgress: ProgressCallback,
  sourceRecordIndex = recordIndex
): Promise<void> {
  const name = STEP_NAMES[step] || step;
  onProgress({ phase: "step", message: `步骤: ${name}`, step, recordIndex, totalRecords });
  const frame = b.getFormFrame(session);

  await b.wait(800);

  switch (step) {
    case "agreement":
      // 勾选同意（在 iframe 内）
      try { await frame.getByLabel("同意").check(); } catch {}
      try { await frame.getByLabel("已阅读").check(); } catch {}
      try { await frame.getByLabel("承诺").check(); } catch {}
      break;

    case "work_info": {
      await dismissValidationDialog(session);

      // 等待 iframe 内容渲染
      await b.wait(2000);
      for (const frame of getCandidateFrames(session)) {
        try {
          await frame.evaluate(() => {
            try { (window as any).layui?.form?.render?.(); } catch {}
            try { (window as any).layui?.form?.render?.("select"); } catch {}
          });
        } catch {}
      }
      await b.wait(1500);

      // 填字段（只填作品基本信息，不做任何上传）
      const workResult = await fillStepFields(session, "work_info", record, company, (fieldName) => {
        onProgress({ phase: "step", message: `  已填写: ${fieldName}`, step, recordIndex, totalRecords });
      });
      let requiredStillFailed = workResult.failedRequired;
      if (requiredStillFailed.length) {
        requiredStillFailed = await retryFailedRequiredFields(
          session,
          "work_info",
          requiredStillFailed,
          record,
          company,
          (fieldName) => {
            onProgress({ phase: "step", message: `  重试已填写: ${fieldName}`, step, recordIndex, totalRecords });
          }
        );
      }

      onProgress({
        phase: "step",
        message: `${name}: 填写 ${workResult.filled}/${workResult.total} 项${workResult.failed.length ? `，未填: ${workResult.failed.join("、")}` : ""}`,
        step, recordIndex, totalRecords,
      });
      if (requiredStillFailed.length) {
        const screenshot = await b.screenshot(session, `step-work_info-required-missing-${recordIndex + 1}`);
        onProgress({
          phase: "error",
          message: `作品基本信息仍缺少必填项: ${requiredStillFailed.join("、")}`,
          step,
          recordIndex,
          totalRecords,
          screenshot,
        });
        throw new Error(`作品基本信息仍缺少必填项: ${requiredStillFailed.join("、")}`);
      }

      // 直接点下一步进入上传页
      await b.scrollToBottom(session);
      await b.wait(500);
      await b.screenshot(session, `step-${step}-${recordIndex + 1}`);
      await clickNextButton(session);
      await b.wait(2000);
      if (!(await isUploadFormVisible(session))) {
        const screenshot = await b.screenshot(session, `step-upload-not-entered-${recordIndex + 1}`);
        onProgress({
          phase: "error",
          message: "点击下一步后未进入「上传作品」页",
          step,
          recordIndex,
          totalRecords,
          screenshot,
        });
        throw new Error("点击下一步后未进入「上传作品」页");
      }
      return;
    }

    case "rights_info": {
      await dismissValidationDialog(session);

      // 等待 iframe 内容渲染
      await b.wait(2000);
      for (const frame of getCandidateFrames(session)) {
        try {
          await frame.evaluate(() => {
            try { (window as any).layui?.form?.render?.(); } catch {}
            try { (window as any).layui?.form?.render?.("select"); } catch {}
          });
        } catch {}
      }
      await b.wait(1500);

      // 填字段（权利状况说明）
      const rightsResult = await fillStepFields(session, "rights_info", record, company, (fieldName) => {
        onProgress({ phase: "step", message: `  已填写: ${fieldName}`, step, recordIndex, totalRecords });
      });

      onProgress({
        phase: "step",
        message: `${name}: 填写 ${rightsResult.filled}/${rightsResult.total} 项${rightsResult.failed.length ? `，未填: ${rightsResult.failed.join("、")}` : ""}`,
        step, recordIndex, totalRecords,
      });

      await b.scrollToBottom(session);
      await b.wait(500);
      await b.screenshot(session, `step-${step}-${recordIndex + 1}`);
      await b.wait(300);
      onProgress({ phase: "step", message: "权利状况说明完成，点击下一步进入权利归属证明材料...", step, recordIndex, totalRecords });
      const enteredRightsProof = await clickNextAndWaitFor(
        session,
        () => waitForRightsProofSection(session, 12_000),
        "权利归属证明材料"
      );
      if (!enteredRightsProof) {
        const screenshot = await b.screenshot(session, `step-rights-proof-not-entered-${recordIndex + 1}`);
        onProgress({
          phase: "error",
          message: "权利状况说明后未进入「权利归属证明材料」页",
          step,
          recordIndex,
          totalRecords,
          screenshot,
        });
        throw new Error("权利状况说明后未进入「权利归属证明材料」页");
      }
      onProgress({ phase: "step", message: "已进入权利归属证明材料", step, recordIndex, totalRecords });
      return;
    }

    case "copyright_owner": {
      await dismissValidationDialog(session);
      if (await isWorkInfoSectionVisible(session)) {
        onProgress({ phase: "step", message: "已在作品基本信息页，跳过著作权人信息下一步", step, recordIndex, totalRecords });
        return;
      }

      if (!(await waitForCopyrightOwnerInfo(session, 12_000))) {
        const screenshot = await b.screenshot(session, `copyright-owner-not-ready-${recordIndex + 1}`);
        onProgress({
          phase: "error",
          message: "未进入「著作权人信息」页",
          step,
          recordIndex,
          totalRecords,
          screenshot,
        });
        throw new Error("未进入「著作权人信息」页");
      }

      if (await isWorkInfoSectionVisible(session)) {
        onProgress({ phase: "step", message: "已在作品基本信息页，跳过著作权人信息下一步", step, recordIndex, totalRecords });
        return;
      }

      await b.scrollToBottom(session);
      await b.wait(500);
      await b.screenshot(session, `step-${step}-${recordIndex + 1}`);
      onProgress({ phase: "step", message: "著作权人信息完成，点击下一步进入作品基本信息...", step, recordIndex, totalRecords });
      const enteredWorkInfo = await clickNextAndWaitFor(
        session,
        () => waitForWorkInfoSection(session, 10_000),
        "作品基本信息"
      );
      if (!enteredWorkInfo) {
        const screenshot = await b.screenshot(session, `work-info-not-entered-${recordIndex + 1}`);
        onProgress({
          phase: "error",
          message: "著作权人信息后未进入「作品基本信息」页",
          step,
          recordIndex,
          totalRecords,
          screenshot,
        });
        throw new Error("著作权人信息后未进入「作品基本信息」页");
      }
      onProgress({ phase: "step", message: "已进入作品基本信息", step, recordIndex, totalRecords });
      return;
    }

    case "upload": {
      await dismissValidationDialog(session);
      if (!(await waitForUploadFormReady(session, 25000))) {
        const screenshot = await b.screenshot(session, `step-upload-not-ready-${recordIndex + 1}`);
        onProgress({
          phase: "error",
          message: "未真正进入「上传作品」页，当前页面不是上传表单",
          step, recordIndex, totalRecords, screenshot,
        });
        throw new Error("未真正进入「上传作品」页，当前页面不是上传表单");
      }
      await renderFormWidgets(session);

      const uploadFields = getSelectorsForStep("upload");
      const categoryField = uploadFields.find(f => f.bitableField === "作品类别");
      if (categoryField) {
        const catValue = resolveFieldValue(categoryField, record, company);
        if (catValue) {
          const catCandidates = getWorkCategoryCandidates(catValue);
          onProgress({ phase: "step", message: `先选择作品类别: ${catCandidates.join(" / ")}`, step, recordIndex, totalRecords });
          let catFilled = false;
          let selectedCatValue = catValue;
          for (const candidate of catCandidates) {
            catFilled = await fillUploadCategory(session, categoryField, candidate);
            if (catFilled) {
              selectedCatValue = candidate;
              break;
            }
            await dismissValidationDialog(session);
            await dismissInfoDialogs(session);
            await renderFormWidgets(session);
            await b.wait(300);
          }
          if (!catFilled) {
            const screenshot = await b.screenshot(session, `step-upload-category-missing-${recordIndex + 1}`);
            onProgress({ phase: "error", message: `作品类别未能选择: ${catCandidates.join(" / ")}`, step, recordIndex, totalRecords, screenshot });
            throw new Error(`作品类别未能选择: ${catCandidates.join(" / ")}`);
          }
          onProgress({ phase: "step", message: `  ✅ 已选择作品类别: ${selectedCatValue}`, step, recordIndex, totalRecords });
          await assertStillOnUploadForm(session, "选择作品类别", recordIndex, step, totalRecords, onProgress);
        }
      }

      // 作品名称使用低干扰写入：只同步 DOM 值和 input 事件，不主动 blur/change。
      const nameField = uploadFields.find(f => f.bitableField === "作品名称");
      if (nameField) {
        const nameValue = resolveFieldValue(nameField, record, company);
        if (nameValue) {
          const nameFilled = await fillUploadWorkName(session, nameValue);
          if (!nameFilled) {
            const screenshot = await b.screenshot(session, `step-upload-name-missing-${recordIndex + 1}`);
            onProgress({ phase: "error", message: "作品名称未能填写", step, recordIndex, totalRecords, screenshot });
            throw new Error("作品名称未能填写");
          }
          onProgress({ phase: "step", message: `  已填写: 作品名称`, step, recordIndex, totalRecords });
          await assertStillOnUploadForm(session, "填写作品名称", recordIndex, step, totalRecords, onProgress);
        }
      }
      await b.wait(500);

      // 上传作品电子文件
      await assertStillOnUploadForm(session, "准备上传作品电子文件", recordIndex, step, totalRecords, onProgress);

      const attachments = getRecordAttachments(sourceRecordIndex);
      if (attachments.length === 0) {
        onProgress({ phase: "step", message: "上传作品: 无附件，跳过上传", step, recordIndex, totalRecords });
      } else {
        const tempDir = join(process.cwd(), "temp", `record-${sourceRecordIndex}`);
        if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

        const downloadedFiles: string[] = [];
        for (let ai = 0; ai < attachments.length; ai++) {
          const att = attachments[ai];
          const ext = att.name.includes(".") ? att.name.slice(att.name.lastIndexOf(".")) : ".png";
          const workName = record.作品名称 || `work_${recordIndex}`;
          const safeName = attachments.length === 1 ? `${workName}${ext}` : `${workName}_${ai + 1}${ext}`;
          const destPath = join(tempDir, safeName);
          onProgress({ phase: "step", message: `下载附件: ${att.name} → ${safeName} (${(att.size / 1024).toFixed(0)}KB)`, step, recordIndex, totalRecords });
          try {
            await downloadFeishuAttachment(att.file_token, destPath);
            downloadedFiles.push(destPath);
          } catch (e: any) {
            onProgress({ phase: "step", message: `下载失败: ${att.name} - ${e.message}`, step, recordIndex, totalRecords });
          }
        }

        if (downloadedFiles.length > 0) {
          onProgress({ phase: "step", message: `正在上传 ${downloadedFiles.length} 个文件...`, step, recordIndex, totalRecords });

          let uploadSuccess = false;
          for (const file of downloadedFiles) {
            const shortName = file.split("/").pop() || file;
            onProgress({ phase: "step", message: `上传文件: ${shortName}`, step, recordIndex, totalRecords });

            let outcome = await uploadWorkFileBySiteApi(session, file);
            if (outcome.status !== "success" && outcome.status !== "duplicate") {
              onProgress({ phase: "step", message: `接口上传未完成，尝试页面上传: ${outcome.message || outcome.status}`, step, recordIndex, totalRecords });
              const chosen = await chooseWorkFile(session, file);
              if (!chosen.ok) {
                onProgress({
                  phase: "step",
                  message: `⚠️ 无法触发上传: ${shortName}${chosen.message ? ` - ${chosen.message}` : ""}`,
                  step,
                  recordIndex,
                  totalRecords
                });
                continue;
              }
              onProgress({
                phase: "step",
                message: chosen.method === "filechooser"
                  ? `已点击「选择文件」并选择文件，等待上传...`
                  : `已直接设置文件 input，等待上传...`,
                step,
                recordIndex,
                totalRecords
              });
              const uploadTimeoutMs = getUploadTimeout(file);
              outcome = await waitForUploadOutcome(session, shortName, uploadTimeoutMs);
            }
            if (outcome.status === "page_navigated") {
              const screenshot = await b.screenshot(session, `step-upload-page-nav-${recordIndex + 1}`);
              onProgress({ phase: "error", message: `上传后页面跳转了: ${outcome.message || ""}`, step, recordIndex, totalRecords, screenshot });
              throw new Error("上传后页面离开了上传表单");
            }
            if (outcome.status === "duplicate") {
              const message = `作品电子文件已存在，跳过本条: ${shortName}`;
              onProgress({ phase: "error", message, step, recordIndex, totalRecords });
              throw new Error(message);
            } else if (outcome.status === "success") {
              onProgress({ phase: "step", message: `✅ 上传完成: ${shortName}`, step, recordIndex, totalRecords });
            } else {
              onProgress({ phase: "step", message: `⚠️ 上传未确认: ${outcome.message || outcome.status}`, step, recordIndex, totalRecords });
              continue;
            }
            uploadSuccess = true;
            await b.wait(1000);
          }

          if (!uploadSuccess) {
            const screenshot = await b.screenshot(session, `step-upload-failed-${recordIndex + 1}`);
            onProgress({ phase: "error", message: "上传作品失败", step, recordIndex, totalRecords, screenshot });
            throw new Error("上传作品失败：未检测到任何文件上传成功");
          }
        }
      }

      await assertStillOnUploadForm(session, "上传作品电子文件", recordIndex, step, totalRecords, onProgress);
      await dismissValidationDialog(session);
      await dismissInfoDialogs(session);
      await b.wait(500);

      onProgress({ phase: "step", message: "上传作品完成，点击下一步进入权利状况说明...", step, recordIndex, totalRecords });
      const enteredRightsInfo = await clickNextAndWaitFor(
        session,
        () => waitForRightsInfoSection(session, 12_000),
        "权利状况说明"
      );
      if (!enteredRightsInfo) {
        const screenshot = await b.screenshot(session, `step-rights-info-not-entered-${recordIndex + 1}`);
        onProgress({
          phase: "error",
          message: "上传作品后未进入「权利状况说明」页",
          step,
          recordIndex,
          totalRecords,
          screenshot,
        });
        throw new Error("上传作品后未进入「权利状况说明」页");
      }
      onProgress({ phase: "step", message: "已进入权利状况说明", step, recordIndex, totalRecords });
      return;
    }

    case "rights_proof": {
      await dismissValidationDialog(session);
      if (!(await waitForRightsProofSection(session))) {
        const screenshot = await b.screenshot(session, `step-rights-proof-not-ready-${recordIndex + 1}`);
        onProgress({
          phase: "error",
          message: "未看到「权利归属证明材料」上传区域",
          step,
          recordIndex,
          totalRecords,
          screenshot,
        });
        throw new Error("未看到「权利归属证明材料」上传区域");
      }

      const attachments = getRightsProofAttachments(sourceRecordIndex);
      if (attachments.length === 0) {
        const screenshot = await b.screenshot(session, `step-rights-proof-no-attachment-${recordIndex + 1}`);
        onProgress({
          phase: "error",
          message: "缺少飞书字段「权利归属证明材料」附件",
          step,
          recordIndex,
          totalRecords,
          screenshot,
        });
        throw new Error("缺少权利归属证明材料附件");
      }

      const tempDir = join(process.cwd(), "temp", `record-${sourceRecordIndex}`, "rights-proof");
      if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

      const downloadedFiles: string[] = [];
      for (let ai = 0; ai < attachments.length; ai++) {
        const att = attachments[ai];
        const ext = att.name.includes(".") ? att.name.slice(att.name.lastIndexOf(".")) : ".png";
        const safeBase = record.作品名称 || `rights_proof_${recordIndex}`;
        const safeName = attachments.length === 1 ? `${safeBase}_权利归属证明${ext}` : `${safeBase}_权利归属证明_${ai + 1}${ext}`;
        const destPath = join(tempDir, safeName);
        onProgress({ phase: "step", message: `下载权利归属证明材料: ${att.name} → ${safeName} (${(att.size / 1024).toFixed(0)}KB)`, step, recordIndex, totalRecords });
        try {
          await downloadFeishuAttachment(att.file_token, destPath);
          downloadedFiles.push(destPath);
        } catch (e: any) {
          onProgress({ phase: "step", message: `下载权利归属证明材料失败: ${att.name} - ${e.message}`, step, recordIndex, totalRecords });
        }
      }

      let uploadSuccess = false;
      for (const file of downloadedFiles) {
        const shortName = file.split("/").pop() || file;
        onProgress({ phase: "step", message: `上传权利归属证明材料: ${shortName}`, step, recordIndex, totalRecords });

        const chosen = await chooseRightsProofFile(session, file);
        if (!chosen.ok) {
          onProgress({
            phase: "step",
            message: `⚠️ 无法触发权利归属证明材料上传: ${shortName}${chosen.message ? ` - ${chosen.message}` : ""}`,
            step,
            recordIndex,
            totalRecords,
          });
          continue;
        }

        onProgress({
          phase: "step",
          message: chosen.method === "filechooser"
            ? `已点击「本地上传」并选择权利归属证明材料，等待上传...`
            : `已直接设置权利归属证明材料 file input，等待上传...`,
          step,
          recordIndex,
          totalRecords,
        });

        const expectedUrl = b.getCurrentUrl(session);
        const outcome = await waitForRightsProofUploadOutcome(session, getUploadTimeout(file), expectedUrl);
        if (outcome.status === "page_navigated") {
          const screenshot = await b.screenshot(session, `step-rights-proof-page-nav-${recordIndex + 1}`);
          onProgress({ phase: "error", message: `权利归属证明材料上传后页面跳转了: ${outcome.message || ""}`, step, recordIndex, totalRecords, screenshot });
          throw new Error("权利归属证明材料上传后页面离开了表单");
        }
        if (outcome.status === "duplicate") {
          const message = `权利归属证明材料已存在，跳过本条: ${shortName}`;
          onProgress({ phase: "error", message, step, recordIndex, totalRecords });
          throw new Error(message);
        } else if (outcome.status === "success") {
          onProgress({ phase: "step", message: `✅ 权利归属证明材料上传完成: ${shortName}`, step, recordIndex, totalRecords });
        } else {
          onProgress({ phase: "step", message: `⚠️ 权利归属证明材料上传未确认: ${outcome.message || outcome.status}`, step, recordIndex, totalRecords });
          continue;
        }
        uploadSuccess = true;
        break;
      }

      if (!uploadSuccess) {
        const screenshot = await b.screenshot(session, `step-rights-proof-upload-failed-${recordIndex + 1}`);
        onProgress({ phase: "error", message: "上传权利归属证明材料失败", step, recordIndex, totalRecords, screenshot });
        throw new Error("上传权利归属证明材料失败：未检测到任何文件上传成功");
      }

      await b.wait(500);
      break;
    }

    case "preview":
      {
        const previewReady = await waitForPreviewSection(session);
        if (!previewReady) {
          const screenshot = await b.screenshot(session, `preview-not-ready-${recordIndex + 1}`);
          onProgress({
            phase: "error",
            message: "未真正进入预览页：未检测到“暂存/提交”区域",
            step,
            recordIndex,
            totalRecords,
            screenshot,
          });
          throw new Error("未真正进入预览页：未检测到“暂存/提交”区域");
        }
      }
      await b.scrollToBottom(session);
      await b.wait(1000);
      await b.screenshot(session, `preview-${recordIndex + 1}`);
      onProgress({ phase: "step", message: "暂存中...", step, recordIndex, totalRecords });
      if (await tryClick(session, "暂存")) {
        onProgress({ phase: "step", message: "✅ 已暂存", step, recordIndex, totalRecords });
      } else {
        const screenshot = await b.screenshot(session, `preview-save-missing-${recordIndex + 1}`);
        onProgress({
          phase: "error",
          message: "预览页暂存失败：未找到“暂存”按钮",
          step,
          recordIndex,
          totalRecords,
          screenshot,
        });
        throw new Error("预览页暂存失败：未找到“暂存”按钮");
      }
      await b.wait(3000);
      return;
  }

  await b.screenshot(session, `step-${step}-${recordIndex + 1}`);
  await b.wait(300);

  if (step !== "preview") {
    await clickNextButton(session);
    await b.wait(2000);
  }
}

async function clickNextButton(session: BrowserSession): Promise<void> {
  if (await clickPrimaryBottomNext(session)) return;
  if (await tryClick(session, "下一步")) return;
  if (await tryClick(session, "继续")) return;
  await b.scrollToBottom(session);
  if (await clickPrimaryBottomNext(session)) return;
  if (await tryClick(session, "下一步")) return;
  if (await tryClick(session, "继续")) return;
  throw new Error("没有找到或无法点击「下一步/继续」按钮");
}

async function clickNextAndWaitFor(
  session: BrowserSession,
  isTargetReady: () => Promise<boolean>,
  targetName: string
): Promise<boolean> {
  void targetName;
  if (await isTargetReady()) return true;

  for (let attempt = 1; attempt <= 3; attempt++) {
    await dismissValidationDialog(session);
    await dismissInfoDialogs(session);
    await b.scrollToBottom(session);
    await b.wait(attempt === 1 ? 500 : 1500);

    try {
      await clickNextButton(session);
    } catch {
      if (attempt === 3) return await isTargetReady();
    }

    if (await isTargetReady()) return true;
    await dismissValidationDialog(session);
    await dismissInfoDialogs(session);
  }

  return await isTargetReady();
}

async function clickPrimaryBottomNext(session: BrowserSession): Promise<boolean> {
  for (const frame of getCandidateFrames(session)) {
    try {
      const clicked = await frame.evaluate(() => {
        function isVisible(el: HTMLElement) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && Number(style.opacity) !== 0
            && rect.width > 0
            && rect.height > 0;
        }

        const nodes = Array.from(document.querySelectorAll<HTMLElement>("button, a, input[type='button'], input[type='submit'], .layui-btn"))
          .filter(isVisible)
          .map((el) => {
            const text = (el.textContent || (el as HTMLInputElement).value || "").trim();
            const rect = el.getBoundingClientRect();
            return { el, text, top: rect.top, left: rect.left };
          })
          .filter((item) => item.text === "下一步")
          .sort((a, b) => {
            if (b.top !== a.top) return b.top - a.top; // 越靠下优先
            return b.left - a.left; // 同一行右侧优先
          });

        const target = nodes[0]?.el;
        if (!target) return false;
        target.scrollIntoView({ block: "center", inline: "center" });
        target.click();
        return true;
      });
      if (clicked) return true;
    } catch {}
  }
  return false;
}

async function dispatchFileInputEvents(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const inputs = document.querySelectorAll('input[type="file"]');
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i] as HTMLInputElement;
      if (inp.files && inp.files.length > 0) {
        inp.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  });
}

function shortFrameUrl(frame: Frame): string {
  try {
    const url = frame.url() || "about:blank";
    return url.length > 72 ? `${url.slice(0, 72)}...` : url;
  } catch {
    return "unknown-frame";
  }
}

/**
 * 检测当前页面是否仍在表单填写流程中（未跳转到登记首页或其他页面）
 */
async function checkStillOnFormPage(session: BrowserSession): Promise<boolean> {
  const currentUrl = session.page.url();
  // 检查 iframe 是否仍然有表单内容
  for (const frame of getCandidateFrames(session)) {
    try {
      const hasForm = await frame.evaluate(() => {
        var bodyText = document.body?.innerText || '';
        // 有表单标签就说明还在表单页
        return bodyText.includes('作品名称') || bodyText.includes('作品类别') ||
               bodyText.includes('权利归属') || bodyText.includes('著作权人') ||
               bodyText.includes('作品电子文件') || bodyText.includes('创作性质');
      });
      if (hasForm) return true;
    } catch {}
  }
  // 如果没有任何表单内容，又回到了办事指南页，说明表单浮层/申报页已经丢失。
  if (currentUrl.includes("bsznpage.html") || currentUrl.includes("办事指南")) {
    return false;
  }
  return false;
}

async function waitForUploadFormReady(session: BrowserSession, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUploadFormVisible(session)) return true;
    await b.wait(600);
  }
  return false;
}

async function isUploadFormVisible(session: BrowserSession): Promise<boolean> {
  for (const frame of getCandidateFrames(session)) {
    try {
      const visible = await frame.evaluate(() => {
        const text = document.body?.innerText || "";
        const normalize = (value: string) => String(value || "").replace(/[\s*：:（）()\[\]【】]/g, "").trim();
        const hasWorkInfoOnlyFields = text.includes("首次发表日期") || text.includes("发表状态") || text.includes("创作过程");
        const hasUploadFieldLabel = Array.from(document.querySelectorAll<HTMLElement>(".layui-form-label, .form_label, label, td, th, span, div"))
          .some((el) => {
            const normalized = normalize(el.textContent || "");
            return normalized === "作品电子文件" || normalized === "作品电子文件注意";
          });
        const hasUploadStep = text.includes("上传作品") || hasUploadFieldLabel || text.includes("上传电子文件");
        const hasGuideOnly = text.includes("办事指南")
          && text.includes("在线办理")
          && !text.includes("网上申报")
          && !text.includes("湖北省著作权登记系统");
        const hasUploadControl = !!document.querySelector('input[type="file"]')
          || Array.from(document.querySelectorAll("button, a, input, span, .webuploader-pick"))
            .some((el) => /选择文件|本地上传|拖拽到这里/.test(`${el.textContent || ""} ${(el as HTMLInputElement).value || ""}`));
        const hasUploadedMarker = /已上传|上传成功|上传完成|重新上传|删除/.test(text)
          || !!document.querySelector(".file-item, .upload-list li, .filelist .file-item, .webuploader .filelist li, [class*='upload'] [class*='item']");
        return !hasGuideOnly && !hasWorkInfoOnlyFields && hasUploadStep && hasUploadFieldLabel && (hasUploadControl || hasUploadedMarker);
      });
      if (visible) return true;
    } catch {}
  }
  return false;
}

async function assertStillOnUploadForm(
  session: BrowserSession,
  actionName: string,
  recordIndex: number,
  step: string,
  totalRecords: number,
  onProgress: ProgressCallback
): Promise<void> {
  if (await isUploadFormVisible(session)) return;
  const screenshot = await b.screenshot(session, `step-upload-page-nav-${recordIndex + 1}`);
  onProgress({
    phase: "error",
    message: `${actionName}后页面离开了「上传作品」表单`,
    step,
    recordIndex,
    totalRecords,
    screenshot,
  });
  throw new Error(`${actionName}后页面离开了「上传作品」表单`);
}

async function fillUploadCategory(session: BrowserSession, field: FieldSelector, value: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await dismissValidationDialog(session);
      await dismissInfoDialogs(session);
      await b.wait(600);
      await renderFormWidgets(session);
    }

    for (const frame of getCandidateFrames(session)) {
      try {
        if (await fillFieldInFrame(frame, field, value)) return true;
        if (await forceSelectByExactLabels(frame, getFieldLabels(field), value)) return true;
      } catch {}
    }
  }
  return false;
}

async function fillUploadWorkName(session: BrowserSession, value: string): Promise<boolean> {
  for (const frame of getCandidateFrames(session)) {
    if (await fillUploadWorkNameInFrame(frame, value)) return true;
  }
  return false;
}

async function fillUploadWorkNameInFrame(frame: Frame, value: string): Promise<boolean> {
  try {
    return await frame.evaluate((nextValue) => {
      const normalize = (text: string) => text.replace(/[\s*：:（）()\[\]【】]/g, "");
      const labels = Array.from(document.querySelectorAll<HTMLElement>(".layui-form-label, .form_label, label, td, th, span"));

      function isVisible(el: HTMLElement): boolean {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) !== 0
          && rect.width > 0
          && rect.height > 0;
      }

      function isPlainTextInput(input: HTMLInputElement): boolean {
        const type = (input.getAttribute("type") || "text").toLowerCase();
        if (!["", "text"].includes(type)) return false;
        if (input.readOnly || input.disabled) return false;
        if (input.closest(".layui-form-select, .el-select, .ant-select")) return false;
        return isVisible(input);
      }

      function setQuietly(input: HTMLInputElement): boolean {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        try { input.focus({ preventScroll: true }); } catch {}
        if (setter) setter.call(input, nextValue);
        else input.value = nextValue;
        input.setAttribute("value", nextValue);
        try {
          input.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextValue, inputType: "insertText" }));
        } catch {
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return input.value === nextValue;
      }

      const matched = labels
        .filter((label) => {
          const text = normalize(label.textContent || "");
          return text === "作品名称" || text === "作品名称中文";
        })
        .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);

      for (const label of matched) {
        const scope = label.closest(".layui-form-item, .el-form-item, .ant-form-item, .form-group, .row, tr, li")
          || label.parentElement?.parentElement
          || label.parentElement;
        const input = Array.from(scope?.querySelectorAll<HTMLInputElement>("input") || []).find(isPlainTextInput);
        if (input && setQuietly(input)) return true;
      }

      return false;
    }, value);
  } catch {
    return false;
  }
}

async function forceSelectByExactLabels(frame: Frame, labels: string[], value: string): Promise<boolean> {
  try {
    return await frame.evaluate(({ targetLabels, targetValue }) => {
      const normalize = (text: string) => text.replace(/[\s*：:（）()\[\]【】]/g, "");
      const expectedLabels = targetLabels.map(normalize).filter(Boolean);
      const expectedValue = normalize(targetValue);
      const labelEls = Array.from(document.querySelectorAll<HTMLElement>(".layui-form-label, .form_label, label, td, th, span"));

      function dispatch(el: Element) {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }

      function choose(select: HTMLSelectElement): boolean {
        const options = Array.from(select.options);
        const option = options.find((opt) => normalize(opt.text) === expectedValue || normalize(opt.value) === expectedValue)
          || options.find((opt) => {
            const text = normalize(opt.text || opt.value || "");
            return !!text && (text.includes(expectedValue) || expectedValue.includes(text));
          });
        if (!option) return false;
        select.value = option.value;
        dispatch(select);
        try { (window as any).layui?.form?.render?.("select"); } catch {}

        const widget = select.nextElementSibling instanceof HTMLElement ? select.nextElementSibling : select.parentElement?.querySelector<HTMLElement>(".layui-form-select");
        const input = widget?.querySelector<HTMLInputElement>("input");
        if (input) {
          input.value = option.text.trim();
          input.setAttribute("value", option.text.trim());
        }
        return select.value === option.value;
      }

      for (const label of labelEls) {
        const text = normalize(label.textContent || "");
        if (!expectedLabels.some((expected) => text === expected || text.includes(expected))) continue;
        const scope = label.closest(".layui-form-item, .el-form-item, .ant-form-item, .form-group, .row, tr, li")
          || label.parentElement?.parentElement
          || label.parentElement;
        const select = scope?.querySelector<HTMLSelectElement>("select");
        if (select && choose(select)) return true;
      }

      return false;
    }, { targetLabels: labels, targetValue: value });
  } catch {
    return false;
  }
}

type SiteUploadedWorkFile = {
  works_file_id: string | number;
  file_size: string;
  file_name: string;
  file_format: string;
  file_url: string;
};

async function uploadWorkFileBySiteApi(session: BrowserSession, file: string): Promise<UploadOutcome> {
  try {
    if (!(await isUploadFormVisible(session))) {
      return { status: "page_navigated", message: b.getCurrentUrl(session) };
    }

    const registerId = await getCurrentRegisterId(session);
    if (!registerId) return { status: "upload_error", message: "未找到 register_id" };

    const fileStat = statSync(file);
    const fileBuffer = readFileSync(file);
    const size = fileStat.size;
    const fileName = file.split("/").pop() || file;
    const fileType = mimeTypeForFile(fileName);
    const modified = fileStat.mtime.toString();
    const origin = getSiteOrigin(session);
    const referer = getSiteReferer(session);

    const tokenParams = new URLSearchParams({
      name: fileName,
      type: fileType,
      size: String(size),
      modified,
    });
    const tokenUrl = `${origin}/site/tokenServlet?${tokenParams.toString()}&${randomQueryTail()}`;
    const tokenResp = await siteHttpsRequest(session, tokenUrl, {
      method: "GET",
      headers: { Referer: referer },
      timeoutMs: 30000,
    });
    if (tokenResp.statusCode < 200 || tokenResp.statusCode >= 300) {
      return { status: "upload_error", message: `tokenServlet HTTP ${tokenResp.statusCode}` };
    }

    const tokenJson = parseJsonResponse(tokenResp.body);
    const token = String(tokenJson?.token || "");
    if (!token || tokenJson?.success === false) {
      return { status: "upload_error", message: `tokenServlet失败: ${tokenJson?.message || "无 token"}` };
    }

    const uploadSessionId = randomUUID();
    const streamParams = new URLSearchParams({
      register_id: registerId,
      form_code: "1",
      sessionId: uploadSessionId,
      token,
      client: "html5",
      name: fileName,
      size: String(size),
    });
    const streamBaseUrl = `${origin}/site/streamServlet?${streamParams.toString()}`;

    const initResp = await siteHttpsRequest(session, `${streamBaseUrl}&${randomQueryTail()}`, {
      method: "GET",
      headers: { Referer: referer },
      timeoutMs: 30000,
    });
    if (initResp.statusCode < 200 || initResp.statusCode >= 300) {
      return { status: "upload_error", message: `streamServlet初始化 HTTP ${initResp.statusCode}` };
    }

    const initJson = parseJsonResponse(initResp.body);
    if (initJson?.success === false) {
      return { status: "upload_error", message: `streamServlet初始化失败: ${initJson?.message || ""}` };
    }

    const start = Number(initJson?.start || 0);
    const uploadBuffer = start > 0 && start < fileBuffer.length ? fileBuffer.subarray(start) : fileBuffer;
    const uploadResp = await siteHttpsRequest(session, streamBaseUrl, {
      method: "POST",
      body: uploadBuffer,
      headers: {
        Accept: "*/*",
        Origin: origin,
        Referer: referer,
        "Content-Range": `bytes ${start}-${size}/${size}`,
        "Content-Type": fileType || "application/octet-stream",
      },
      timeoutMs: getUploadTimeout(file),
    });
    if (uploadResp.statusCode < 200 || uploadResp.statusCode >= 300) {
      const bodyHint = uploadResp.body ? `: ${uploadResp.body.replace(/\s+/g, " ").slice(0, 160)}` : "";
      return { status: "upload_error", message: `streamServlet上传 HTTP ${uploadResp.statusCode}${bodyHint}` };
    }

    const uploadJson = parseJsonResponse(uploadResp.body);
    if (uploadJson?.success === false) {
      const message = String(uploadJson?.message || "上传失败");
      if (/文件已存在|已有相同名称|已上传过|重复/.test(message)) return { status: "duplicate", message };
      return { status: "upload_error", message };
    }

    const worksFiles = normalizeUploadedWorkFiles(uploadJson?.works_files);
    if (!worksFiles.length) {
      return { status: "upload_error", message: "streamServlet未返回 works_files" };
    }

    const synced = await syncUploadedWorkFilesToPage(session, worksFiles);
    if (!synced) {
      return { status: "upload_error", message: "上传成功但未能同步页面文件列表" };
    }

    return { status: "success" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "upload_error", message };
  }
}

async function getCurrentRegisterId(session: BrowserSession): Promise<string> {
  const urls = [session.page.url(), ...session.page.frames().map((frame) => {
    try { return frame.url(); } catch { return ""; }
  })];

  for (const url of urls) {
    try {
      const value = new URL(url).searchParams.get("register_id");
      if (value) return value;
    } catch {}
  }

  for (const frame of getCandidateFrames(session)) {
    try {
      const value = await frame.evaluate(() => {
        const direct = document.querySelector<HTMLInputElement>('input[name="register_id"], #register_id')?.value;
        if (direct) return direct;
        const text = document.body?.innerHTML || "";
        const match = text.match(/register_id["'=:\s]+(\d+)/i);
        return match?.[1] || "";
      });
      if (value) return String(value);
    } catch {}
  }

  return "";
}

function getSiteOrigin(session: BrowserSession): string {
  for (const candidate of [session.page.url(), ...session.page.frames().map((frame) => {
    try { return frame.url(); } catch { return ""; }
  })]) {
    try {
      const url = new URL(candidate);
      if (url.origin.includes("cp.ccct.net.cn")) return url.origin;
    } catch {}
  }
  return "https://cp.ccct.net.cn:8443";
}

function getSiteReferer(session: BrowserSession): string {
  for (const candidate of session.page.frames().map((frame) => {
    try { return frame.url(); } catch { return ""; }
  })) {
    try {
      const url = new URL(candidate);
      if (url.origin.includes("cp.ccct.net.cn")) return candidate;
    } catch {}
  }
  return session.page.url();
}

type SiteHttpsResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

async function siteHttpsRequest(
  session: BrowserSession,
  rawUrl: string,
  options: {
    method: "GET" | "POST";
    headers?: Record<string, string>;
    body?: Buffer;
    timeoutMs: number;
  }
): Promise<SiteHttpsResponse> {
  const url = new URL(rawUrl);
  const cookies = await session.context.cookies(url.origin);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const body = options.body;
  const headers: Record<string, string | number> = {
    Accept: "*/*",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    ...(options.headers || {}),
  };
  if (cookieHeader) headers.Cookie = cookieHeader;
  if (body) headers["Content-Length"] = body.length;

  const secureOptions = cryptoConstants.SSL_OP_LEGACY_SERVER_CONNECT
    | cryptoConstants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION;

  return await new Promise<SiteHttpsResponse>((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers,
        secureOptions,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );

    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error(`请求超时(${Math.round(options.timeoutMs / 1000)}s): ${url.pathname}`));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function randomQueryTail(): string {
  return String(Math.floor(Math.random() * 100000));
}

function mimeTypeForFile(fileName: string): string {
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase() : "";
  const types: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    bmp: "image/bmp",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    pdf: "application/pdf",
    txt: "text/plain",
    wav: "audio/wav",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    wmv: "video/x-ms-wmv",
    psd: "image/vnd.adobe.photoshop",
  };
  return types[ext] || "application/octet-stream";
}

function parseJsonResponse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { success: false, message: text.slice(0, 200) };
  }
}

function normalizeUploadedWorkFiles(value: unknown): SiteUploadedWorkFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item: any) => ({
      works_file_id: item?.works_file_id,
      file_size: String(item?.file_size || ""),
      file_name: String(item?.file_name || ""),
      file_format: String(item?.file_format || ""),
      file_url: String(item?.file_url || ""),
    }))
    .filter((item) => item.works_file_id && item.file_name && item.file_url);
}

async function syncUploadedWorkFilesToPage(session: BrowserSession, worksFiles: SiteUploadedWorkFile[]): Promise<boolean> {
  for (const frame of getCandidateFrames(session)) {
    try {
      const synced = await frame.evaluate((files) => {
        const queue = document.querySelector<HTMLElement>("#i_stream_files_queue");
        if (!queue) return false;

        let scroll = queue.querySelector<HTMLElement>(".stream-files-scroll");
        if (!scroll) {
          scroll = document.createElement("div");
          scroll.className = "stream-files-scroll";
          scroll.style.height = "400px";
          queue.appendChild(scroll);
        }

        let list = scroll.querySelector<HTMLUListElement>("ul");
        if (!list) {
          list = document.createElement("ul");
          list.id = `files-container_${Date.now()}_bot_1`;
          scroll.appendChild(list);
        }

        let hiddenBox = queue.querySelector<HTMLDivElement>("#copyright-bot-upload-fields");
        if (!hiddenBox) {
          hiddenBox = document.createElement("div");
          hiddenBox.id = "copyright-bot-upload-fields";
          hiddenBox.style.display = "none";
          queue.appendChild(hiddenBox);
        }

        function makeInput(name: string, value: string) {
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = name;
          input.value = value;
          hiddenBox!.appendChild(input);
        }

        let changed = false;
        for (const file of files) {
          const fileId = String(file.works_file_id || "");
          if (!fileId) continue;

          let item = list.querySelector<HTMLLIElement>(`li[col_index="${CSS.escape(fileId)}"]`);
          if (!item) {
            item = document.createElement("li");
            item.id = "file_data_cell";
            item.className = "stream-cell-file";
            item.setAttribute("col_index", fileId);
            item.innerHTML = '<b class="stream-uploading-ico"></b><div class="stream-file-name"><strong></strong><a class="btn-link" style="width: auto;" href="javascript:void(0)" id="del_click">删除</a></div>';
            list.appendChild(item);
            changed = true;
          }
          const strong = item.querySelector("strong");
          if (strong) strong.textContent = file.file_name || fileId;
          item.setAttribute("data-file-size", file.file_size || "");
          item.setAttribute("data-file-name", file.file_name || "");
          item.setAttribute("data-file-format", file.file_format || "");
          item.setAttribute("data-file-url", file.file_url || "");

          const existingIds = Array.from(hiddenBox.querySelectorAll<HTMLInputElement>('input[name$="[works_file_id]"]'))
            .map((input) => input.value);
          if (!existingIds.includes(fileId)) {
            const index = existingIds.length;
            makeInput(`works_files[${index}][works_file_id]`, fileId);
            makeInput(`works_files[${index}][file_size]`, file.file_size || "");
            makeInput(`works_files[${index}][file_name]`, file.file_name || "");
            makeInput(`works_files[${index}][file_format]`, file.file_format || "");
            makeInput(`works_files[${index}][file_url]`, file.file_url || "");
          }
        }

        try { queue.dispatchEvent(new Event("change", { bubbles: true })); } catch {}
        try { queue.dispatchEvent(new Event("input", { bubbles: true })); } catch {}
        return changed || files.length > 0;
      }, worksFiles);
      if (synced) return true;
    } catch {}
  }

  return false;
}

type WorkFileChooseResult = {
  ok: boolean;
  method?: "filechooser" | "input";
  message?: string;
};

async function chooseWorkFile(session: BrowserSession, file: string): Promise<WorkFileChooseResult> {
  let lastError = "";

  for (const frame of getCandidateFrames(session)) {
    let triggerHandle: ElementHandle | null = null;
    try {
      triggerHandle = await findWorkUploadTriggerHandle(frame);
      if (!triggerHandle) continue;
      await triggerHandle.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      const [fc] = await Promise.all([
        session.page.waitForEvent("filechooser", { timeout: 10000 }),
        triggerHandle.click({ timeout: 5000 }),
      ]);
      await fc.setFiles(file);
      return { ok: true, method: "filechooser" };
    } catch (e: any) {
      lastError = e?.message || String(e);
    } finally {
      await triggerHandle?.dispose?.().catch(() => {});
    }
  }

  for (const frame of getCandidateFrames(session)) {
    let inputHandle: ElementHandle | null = null;
    try {
      inputHandle = await findWorkFileInputHandle(frame);
      if (!inputHandle) continue;
      await (inputHandle as any).setInputFiles(file);
      await dispatchFileInputEvents(frame);
      return { ok: true, method: "input" };
    } catch (e: any) {
      lastError = e?.message || String(e);
    } finally {
      await inputHandle?.dispose?.().catch(() => {});
    }
  }

  return {
    ok: false,
    message: lastError || "未找到作品电子文件区域的选择文件按钮或 file input",
  };
}

async function findWorkFileInputHandle(frame: Frame): Promise<ElementHandle | null> {
  try {
    const handle = await frame.evaluateHandle(() => {
      const normalize = (value: string) => String(value || "").replace(/[\s*：:（）()\[\]【】]/g, "");
      const labels = Array.from(document.querySelectorAll<HTMLElement>(".layui-form-label, .form_label, label, td, th, span, div"));
      const labelKeywords = ["作品电子文件", "上传作品", "上传电子文件"];

      for (const label of labels) {
        const text = normalize(label.textContent || "");
        if (!labelKeywords.some((keyword) => text.includes(keyword))) continue;

        let scope: HTMLElement | null = label;
        for (let depth = 0; depth < 7 && scope; depth++) {
          const input = scope.querySelector<HTMLInputElement>("input[type='file']");
          if (input) return input;
          scope = scope.parentElement;
        }
      }

      const bodyText = document.body?.innerText || "";
      if (bodyText.includes("作品电子文件") || bodyText.includes("上传作品")) {
        return document.querySelector<HTMLInputElement>("input[type='file']");
      }

      return null;
    });

    return handle.asElement();
  } catch {
    return null;
  }
}

async function findWorkUploadTriggerHandle(frame: Frame): Promise<ElementHandle | null> {
  try {
    const handle = await frame.evaluateHandle(() => {
      const normalize = (value: string) => String(value || "").replace(/[\s*：:（）()\[\]【】]/g, "");
      const labels = Array.from(document.querySelectorAll<HTMLElement>(".layui-form-label, .form_label, label, td, th, span, div"));
      const triggerSelector = [
        "#i_select_files button",
        ".stream-browse-files button",
        "[z_name='worksFiles']",
        "button",
        "a",
        "input[type='button']",
        "span",
        ".webuploader-pick"
      ].join(",");
      const labelKeywords = ["作品电子文件", "上传作品", "上传电子文件"];

      function isUsableTrigger(el: Element): boolean {
        const node = el as HTMLElement;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) return false;
        const text = `${node.textContent || ""} ${(node as HTMLInputElement).value || ""}`;
        return /选择文件|本地上传|上传/.test(text)
          || node.classList.contains("webuploader-pick")
          || node.getAttribute("z_name") === "worksFiles";
      }

      const explicitTrigger = document.querySelector<HTMLElement>("[z_name='worksFiles'], #i_select_files button, .stream-browse-files button");
      if (explicitTrigger && isUsableTrigger(explicitTrigger)) return explicitTrigger;

      for (const label of labels) {
        const text = normalize(label.textContent || "");
        if (!labelKeywords.some((keyword) => text.includes(keyword))) continue;

        let scope: HTMLElement | null = label;
        for (let depth = 0; depth < 7 && scope; depth++) {
          const trigger = Array.from(scope.querySelectorAll<HTMLElement>(triggerSelector)).find(isUsableTrigger);
          if (trigger) return trigger;
          scope = scope.parentElement;
        }
      }

      return Array.from(document.querySelectorAll<HTMLElement>(triggerSelector)).find(isUsableTrigger) || null;
    });

    return handle.asElement();
  } catch {
    return null;
  }
}

async function findRightsProofFileInputHandle(frame: Frame): Promise<ElementHandle | null> {
  try {
    const handle = await frame.evaluateHandle(() => {
      const normalize = (value: string) => String(value || "").replace(/[\s*：:（）()\[\]【】]/g, "");
      const labels = Array.from(document.querySelectorAll<HTMLElement>(".layui-form-label, .form_label, label, td, th, span, div"));
      const labelKeywords = ["权利归属证明材料", "权利归属证明", "归属证明材料"];

      for (const label of labels) {
        const text = normalize(label.textContent || "");
        if (!labelKeywords.some((keyword) => text.includes(keyword))) continue;

        let scope: HTMLElement | null = label;
        for (let depth = 0; depth < 8 && scope; depth++) {
          const input = scope.querySelector<HTMLInputElement>("input[type='file']");
          if (input) return input;
          scope = scope.parentElement;
        }
      }

      return null;
    });

    return handle.asElement();
  } catch {
    return null;
  }
}

async function chooseRightsProofFile(session: BrowserSession, file: string): Promise<WorkFileChooseResult> {
  let lastError = "";

  for (const frame of getCandidateFrames(session)) {
    let triggerHandle: ElementHandle | null = null;
    try {
      triggerHandle = await findRightsProofUploadTriggerHandle(frame);
      if (!triggerHandle) continue;
      await triggerHandle.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      const [fc] = await Promise.all([
        session.page.waitForEvent("filechooser", { timeout: 10000 }),
        triggerHandle.click({ timeout: 5000 }),
      ]);
      await fc.setFiles(file);
      return { ok: true, method: "filechooser" };
    } catch (e: any) {
      lastError = e?.message || String(e);
    } finally {
      await triggerHandle?.dispose?.().catch(() => {});
    }
  }

  for (const frame of getCandidateFrames(session)) {
    let inputHandle: ElementHandle | null = null;
    try {
      inputHandle = await findRightsProofFileInputHandle(frame);
      if (!inputHandle) continue;
      await (inputHandle as any).setInputFiles(file);
      await dispatchFileInputEvents(frame);
      return { ok: true, method: "input" };
    } catch (e: any) {
      lastError = e?.message || String(e);
    } finally {
      await inputHandle?.dispose?.().catch(() => {});
    }
  }

  return {
    ok: false,
    message: lastError || "未找到权利归属证明材料区域的本地上传按钮或 file input",
  };
}

async function findRightsProofUploadTriggerHandle(frame: Frame): Promise<ElementHandle | null> {
  try {
    const handle = await frame.evaluateHandle(() => {
      const normalize = (value: string) => String(value || "").replace(/[\s*：:（）()\[\]【】]/g, "");
      const labels = Array.from(document.querySelectorAll<HTMLElement>(".layui-form-label, .form_label, label, td, th, span, div"));
      const triggerSelector = [
        "button",
        "a",
        "input[type='button']",
        "span",
        ".layui-btn",
        ".btn",
        ".input-group-addon",
        ".webuploader-pick"
      ].join(",");
      const labelKeywords = ["权利归属证明材料", "权利归属证明", "归属证明材料"];

      function isVisible(el: HTMLElement): boolean {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) !== 0
          && rect.width > 0
          && rect.height > 0;
      }

      function isUsableTrigger(el: Element): boolean {
        const node = el as HTMLElement;
        if (!isVisible(node)) return false;
        const text = `${node.textContent || ""} ${(node as HTMLInputElement).value || ""}`;
        return /本地上传|选择文件|上传/.test(text)
          || node.classList.contains("webuploader-pick");
      }

      for (const label of labels) {
        const text = normalize(label.textContent || "");
        if (!labelKeywords.some((keyword) => text.includes(keyword))) continue;

        let scope: HTMLElement | null = label;
        for (let depth = 0; depth < 8 && scope; depth++) {
          const trigger = Array.from(scope.querySelectorAll<HTMLElement>(triggerSelector)).find(isUsableTrigger);
          if (trigger) return trigger;
          scope = scope.parentElement;
        }
      }

      return null;
    });

    return handle.asElement();
  } catch {
    return null;
  }
}

async function waitForUploadSection(session: BrowserSession): Promise<boolean> {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    for (const frame of getCandidateFrames(session)) {
      try {
        const ready = await frame.evaluate(() => {
          const text = document.body?.innerText || "";
          const hasUploadText = text.includes("作品电子文件")
            || text.includes("上传电子文件");
          const hasFileInput = !!document.querySelector('input[type="file"]');
          const hasUploadButton = Array.from(document.querySelectorAll("button, a, input, .webuploader-pick"))
            .some((el) => /选择文件|上传|作品电子文件/.test(`${el.textContent || ""} ${(el as HTMLInputElement).value || ""}`));
          return hasUploadText || hasFileInput || hasUploadButton;
        });
        if (ready) return true;
      } catch {}
    }
    await b.wait(800);
  }
  return false;
}

async function waitForRightsInfoSection(session: BrowserSession, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of getCandidateFrames(session)) {
      try {
        const ready = await frame.evaluate(() => {
          const normalize = (value: string) => String(value || "").replace(/[\s*：:（）()\[\]【】]/g, "").trim();
          const text = document.body?.innerText || "";
          const labels = Array.from(document.querySelectorAll<HTMLElement>(".layui-form-label, .form_label, label, td, th, span, div"))
            .map((el) => normalize(el.textContent || ""))
            .filter(Boolean);
          const hasRightsInfoLabel = labels.some((label) =>
            label === "权利取得方式"
            || label === "权利归属方式"
            || label === "权利拥有状况"
            || label === "权利拥有状况及其说明"
          );
          const hasRightsInfoText = text.includes("权利取得方式")
            || text.includes("权利归属方式")
            || text.includes("权利拥有状况");
          const stillUploadPage = text.includes("作品电子文件") && text.includes("选择文件");
          const alreadyRightsProof = text.includes("权利归属证明材料") && /本地上传|选择文件/.test(text);
          return !stillUploadPage && !alreadyRightsProof && (hasRightsInfoLabel || hasRightsInfoText);
        });
        if (ready) return true;
      } catch {}
    }
    await b.wait(600);
  }
  return false;
}

async function waitForRightsProofSection(session: BrowserSession, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of getCandidateFrames(session)) {
      try {
        const ready = await frame.evaluate(() => {
          const text = document.body?.innerText || "";
          const hasLabel = text.includes("权利归属证明材料");
          const hasUploadBtn = Array.from(document.querySelectorAll("button, a, span, input, .webuploader-pick"))
            .some((el) => /本地上传|选择文件/.test(`${el.textContent || ""} ${(el as HTMLInputElement).value || ""}`));
          const hasFileInput = !!document.querySelector('input[type="file"]');
          return hasLabel && (hasUploadBtn || hasFileInput);
        });
        if (ready) return true;
      } catch {}
    }
    await b.wait(600);
  }
  return false;
}

async function waitForPreviewSection(session: BrowserSession): Promise<boolean> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    for (const frame of getCandidateFrames(session)) {
      try {
        const ready = await frame.evaluate(() => {
          const text = document.body?.innerText || "";
          const hasPreviewText = text.includes("申请表预览")
            || text.includes("登记表预览")
            || text.includes("预览提交")
            || text.includes("预览");
          const hasSaveBtn = Array.from(document.querySelectorAll("button, a, input, .layui-btn"))
            .some((el) => /暂存|提交|确认/.test(`${el.textContent || ""} ${(el as HTMLInputElement).value || ""}`));
          return hasPreviewText && hasSaveBtn;
        });
        if (ready) return true;
      } catch {}
    }
    await b.wait(600);
  }
  return false;
}

async function waitForRightsProofUploadOutcome(
  session: BrowserSession,
  timeoutMs: number,
  expectedUrl: string
): Promise<UploadOutcome> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // 快速检测页面跳转（每次循环先检查）
    const currentUrl = b.getCurrentUrl(session);
    if (currentUrl !== expectedUrl) {
      return { status: "page_navigated", message: currentUrl };
    }

    await b.wait(2000);

    let stillUploading = false;
    let hasProofMarker = false;
    let duplicateMessage = "";
    let validationMessage = "";
    let errorMessage = "";

    for (const frame of getCandidateFrames(session)) {
      try {
        const state = await frame.evaluate(() => {
          const normalize = (value: string) => String(value || "").replace(/\s+/g, "");

          function isVisible(el: Element): boolean {
            const node = el as HTMLElement;
            const style = window.getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== "none"
              && style.visibility !== "hidden"
              && Number(style.opacity) !== 0
              && rect.width > 0
              && rect.height > 0;
          }

          const dialogTexts = Array.from(document.querySelectorAll<HTMLElement>(".layui-layer-dialog, .layui-layer-msg, .el-message-box, .ant-modal, .modal, [role=dialog]"))
            .filter(isVisible)
            .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
            .filter(Boolean);

          const uploadingByDialog = dialogTexts.some((text) => text.includes("上传中"));
          const uploadingBySpinner = Array.from(document.querySelectorAll<HTMLElement>(".layui-layer-loading, .upload-loading, .state-uploading, [class*='progress']"))
            .some(isVisible);

          let hasMarker = false;
          const labels = Array.from(document.querySelectorAll<HTMLElement>(".layui-form-label, .form_label, label, td, th, span, div"));
          for (const label of labels) {
            const labelText = normalize(label.textContent || "");
            if (!labelText.includes("权利归属证明材料")) continue;

            let scope: HTMLElement | null = label;
            for (let depth = 0; depth < 6 && scope; depth++) {
              const scopeText = scope.innerText || scope.textContent || "";
              if (scopeText.includes("本地上传")) {
                if (scopeText.includes("/uploads/")) {
                  hasMarker = true;
                  break;
                }

                const inputs = Array.from(scope.querySelectorAll<HTMLInputElement>("input:not([type='file']):not([type='button']):not([type='submit'])"));
                if (inputs.some((input) => {
                  const value = (input.value || "").trim();
                  return !!value && value !== "本地上传" && value !== "选择文件";
                })) {
                  hasMarker = true;
                  break;
                }

                const hiddenInputs = Array.from(scope.querySelectorAll<HTMLInputElement>("input[type='hidden']"));
                if (hiddenInputs.some((input) => {
                  const value = (input.value || "").trim();
                  return !!value && value !== "0";
                })) {
                  hasMarker = true;
                  break;
                }
              }
              scope = scope.parentElement;
            }

            if (hasMarker) break;
          }

          let duplicate = "";
          let validation = "";
          let uploadError = "";
          for (const text of dialogTexts) {
            if (!duplicate && /文件已存在|已有相同名称|已上传过|重复/.test(text)) duplicate = text;
            if (!validation && /请上传权利归属证明材料|请上传权利归属证明/.test(text)) validation = text;
            if (!uploadError && /上传失败|上传出错|格式不支持|大小.*超|系统异常|网络异常|上传异常/.test(text)) uploadError = text;
          }

          return {
            stillUploading: uploadingByDialog || uploadingBySpinner,
            hasMarker,
            duplicate,
            validation,
            uploadError,
          };
        });

        if (state.stillUploading) stillUploading = true;
        if (state.hasMarker) hasProofMarker = true;
        if (!duplicateMessage && state.duplicate) duplicateMessage = state.duplicate;
        if (!validationMessage && state.validation) validationMessage = state.validation;
        if (!errorMessage && state.uploadError) errorMessage = state.uploadError;
      } catch {}
    }

    if (duplicateMessage) {
      await dismissInfoDialogs(session);
      return { status: "duplicate", message: duplicateMessage };
    }

    if (validationMessage) {
      await dismissInfoDialogs(session);
      return { status: "validation_error", message: validationMessage };
    }

    if (errorMessage) {
      await dismissInfoDialogs(session);
      return { status: "upload_error", message: errorMessage };
    }

    if (!stillUploading && hasProofMarker) return { status: "success" };
  }

  await dismissInfoDialogs(session);
  return { status: "timeout", message: `等待权利归属证明材料上传超时(${Math.round(timeoutMs / 1000)}s)` };
}

type UploadOutcomeStatus = "success" | "duplicate" | "validation_error" | "upload_error" | "timeout" | "page_navigated";
type UploadOutcome = { status: UploadOutcomeStatus; message?: string };

async function waitForUploadOutcome(
  session: BrowserSession,
  fileName: string,
  timeoutMs: number
): Promise<UploadOutcome> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await b.wait(2000);
    if (!(await isUploadFormVisible(session))) {
      return { status: "page_navigated", message: b.getCurrentUrl(session) };
    }

    let stillUploading = false;
    let hasUploadedMarker = false;
    let duplicateMessage = "";
    let validationMessage = "";
    let errorMessage = "";

    for (const frame of getCandidateFrames(session)) {
      try {
        const state = await frame.evaluate((targetFileName) => {
          const normalize = (value: string) => String(value || "").replace(/\s+/g, "");
          const expectedName = normalize(targetFileName);

          function isVisible(el: Element): boolean {
            const node = el as HTMLElement;
            const style = window.getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== "none"
              && style.visibility !== "hidden"
              && Number(style.opacity) !== 0
              && rect.width > 0
              && rect.height > 0;
          }

          const dialogTexts = Array.from(document.querySelectorAll<HTMLElement>(".layui-layer-dialog, .layui-layer-msg, .el-message-box, .ant-modal, .modal, [role=dialog]"))
            .filter(isVisible)
            .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
            .filter(Boolean);

          const uploadingByDialog = dialogTexts.some((text) => text.includes("上传中"));
          const uploadingBySpinner = Array.from(document.querySelectorAll<HTMLElement>(".layui-layer-loading, .upload-loading, .state-uploading, [class*='progress']"))
            .some(isVisible);

          const allText = document.body?.innerText || "";
          const compactText = normalize(allText);
          const fileItems = document.querySelectorAll(".file-item, .upload-list li, .filelist .file-item, .webuploader .filelist li, [class*='upload'] [class*='item'], #i_stream_files_queue li, .stream-cell-file");
          const streamUploadedItems = document.querySelectorAll("#i_stream_files_queue li[col_index], .stream-cell-file[col_index]");
          const hasUploadedHint = /已上传|上传成功|上传完成/.test(allText);
          const hasFileName = expectedName.length > 0 && compactText.includes(expectedName);

          let duplicate = "";
          let validation = "";
          let uploadError = "";
          for (const text of dialogTexts) {
            if (!duplicate && /文件已存在|已有相同名称|已上传过|重复/.test(text)) duplicate = text;
            if (!validation && /请上传作品|请选择作品类型|请选择作品类别|请选择作品创作性质|请上传权利归属证明/.test(text)) validation = text;
            if (!uploadError && /上传失败|上传出错|格式不支持|大小.*超|系统异常|网络异常|上传异常/.test(text)) uploadError = text;
          }

          return {
            stillUploading: uploadingByDialog || uploadingBySpinner,
            hasUploadedMarker: fileItems.length > 0 || hasUploadedHint || hasFileName,
            hasStrongUploadedMarker: streamUploadedItems.length > 0,
            duplicate,
            validation,
            uploadError,
          };
        }, fileName);

        if (state.stillUploading) stillUploading = true;
        if (state.hasUploadedMarker || state.hasStrongUploadedMarker) hasUploadedMarker = true;
        if (state.hasStrongUploadedMarker) stillUploading = false;
        if (!duplicateMessage && state.duplicate) duplicateMessage = state.duplicate;
        if (!validationMessage && state.validation) validationMessage = state.validation;
        if (!errorMessage && state.uploadError) errorMessage = state.uploadError;
      } catch {}
    }

    if (duplicateMessage) {
      await dismissInfoDialogs(session);
      return { status: "duplicate", message: duplicateMessage };
    }

    if (validationMessage) {
      await dismissInfoDialogs(session);
      return { status: "validation_error", message: validationMessage };
    }

    if (errorMessage) {
      await dismissInfoDialogs(session);
      return { status: "upload_error", message: errorMessage };
    }

    if (!stillUploading && hasUploadedMarker) return { status: "success" };
  }

  await dismissInfoDialogs(session);
  return { status: "timeout", message: `等待上传超时(${Math.round(timeoutMs / 1000)}s)` };
}

async function dismissInfoDialogs(session: BrowserSession): Promise<void> {
  const dialogSelector = ".layui-layer-dialog, .layui-layer-msg, .el-message-box, .ant-modal, .modal, [role=dialog]";

  for (const frame of getCandidateFrames(session)) {
    try {
      const dialogs = frame.locator(dialogSelector);
      const count = Math.min(await dialogs.count(), 5);

      for (let i = 0; i < count; i++) {
        const dialog = dialogs.nth(i);
        const isVisible = await dialog.isVisible().catch(() => false);
        if (!isVisible) continue;
        const text = (await dialog.textContent({ timeout: 500 }).catch(() => "")) || "";
        if (looksLikeMainApplyForm(text)) continue;

        const candidates = [
          dialog.getByRole("button", { name: /确定|关闭|知道了|明白了|OK/i }),
          dialog.locator(".layui-layer-btn0, .layui-layer-btn1"),
          dialog.locator("button, a").filter({ hasText: /确定|关闭|知道了|明白了|OK/i }),
        ];

        let clicked = false;
        for (const candidate of candidates) {
          if (await clickLocator(candidate)) {
            clicked = true;
            await b.wait(200);
            break;
          }
        }

        if (!clicked) continue;
      }
    } catch {}
  }
}

type StepFillResult = {
  total: number;
  filled: number;
  failed: string[];
  failedRequired: string[];
};

const WORK_INFO_FIELD_ORDER: string[] = [
  "作品名称",
  "作品类别",
  "作品创作性质",
  "创作完成日期",
  "内容简介",
  "创作过程",
  "创作完成地点",
  "省创作",
  "市创作",
  "发表状态",
  "首次发表日期",
  "首次发表地点",
  "省发表",
  "市发表",
];

const RIGHTS_INFO_FIELD_ORDER: string[] = [
  "权利取得方式",
  "权利归属方式",
  "权利拥有状况",
  "作者名称",
  "署名",
  "署名名称",
];

async function fillStepFields(
  session: BrowserSession,
  step: Extract<FormStep, "work_info" | "rights_info">,
  record: CopyrightRecord,
  company: CompanyConfig,
  onFieldFilled: (fieldName: string) => void
): Promise<StepFillResult> {
  const selectors = getSelectorsForStep(step);
  console.log(`[fillStepFields] step=${step} 字段数=${selectors.length} 字段列表=${selectors.map(s => s.bitableField).join(",")}`);
  const order = step === "work_info" ? WORK_INFO_FIELD_ORDER : RIGHTS_INFO_FIELD_ORDER;
  const orderedSelectors = [...selectors].sort((a, b) => {
    const ai = order.indexOf(a.bitableField);
    const bi = order.indexOf(b.bitableField);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  const result: StepFillResult = { total: 0, filled: 0, failed: [], failedRequired: [] };

  for (const field of orderedSelectors) {
    const value = resolveFieldValue(field, record, company);
    const publishedStatus = record.发表状态 || "已发表";
    const requiredByState = field.bitableField === "首次发表日期" && publishedStatus === "已发表";
    if (!value) {
      if (field.bitableField === "首次发表日期") {
        console.log(`[首次发表日期] value为空! record.首次发表日期="${record.首次发表日期}" record.发表状态="${record.发表状态}"`);
      }
      if (field.required || requiredByState) result.failedRequired.push(field.bitableField);
      continue;
    }
    if (field.bitableField === "首次发表日期") {
      console.log(`[首次发表日期] 准备填写 value="${value}"`);
    }

    // 填写前先滚动，确保目标区域可见
    if (["发表状态", "首次发表日期", "首次发表地点", "省发表", "市发表"].includes(field.bitableField)) {
      await b.scrollToBottom(session);
      await b.wait(500);
    }

    result.total++;
    if (field.bitableField === "发表状态") console.log(`[发表状态] 开始填写 value="${value}"`);
    const filled = await fillMappedField(session, field, value);
    if (field.bitableField === "发表状态") console.log(`[发表状态] 填写结果: ${filled}`);
    if (filled) {
      result.filled++;
      onFieldFilled(field.bitableField);
      // 发表状态选完后，等待日期/地点字段动态渲染出来
      if (field.bitableField === "发表状态") {
        await b.wait(2000);
        // 尝试等待首次发表日期输入框出现
        for (let waitRetry = 0; waitRetry < 3; waitRetry++) {
          const hasDateField = await (async () => {
            for (const f of getCandidateFrames(session)) {
              try {
                const found = await f.evaluate(() => {
                  const labels = document.querySelectorAll(".layui-form-label, .form_label, label, td, th, span");
                  for (var i = 0; i < labels.length; i++) {
                    var text = (labels[i].textContent || "").replace(/[\s*：:]/g, "");
                    if (text.indexOf("首次发表日期") !== -1 || text.indexOf("发表日期") !== -1 || text.indexOf("发表时间") !== -1) return true;
                  }
                  return false;
                });
                if (found) return true;
              } catch {}
            }
            return false;
          })();
          if (hasDateField) break;
          await b.wait(1000);
        }
      }
    } else {
      result.failed.push(field.bitableField);
      if (field.required || requiredByState) result.failedRequired.push(field.bitableField);
    }
  }

  return result;
}

async function retryFailedRequiredFields(
  session: BrowserSession,
  step: Extract<FormStep, "work_info" | "rights_info">,
  failedRequired: string[],
  record: CopyrightRecord,
  company: CompanyConfig,
  onFieldFilled: (fieldName: string) => void
): Promise<string[]> {
  const selectors = getSelectorsForStep(step);
  const stillFailed: string[] = [];

  for (const fieldName of Array.from(new Set(failedRequired))) {
    const field = selectors.find((candidate) => candidate.bitableField === fieldName);
    if (!field) {
      stillFailed.push(fieldName);
      continue;
    }

    const value = resolveFieldValue(field, record, company);
    if (!value) {
      stillFailed.push(fieldName);
      continue;
    }

    let filled = false;
    for (let attempt = 0; attempt < 4 && !filled; attempt++) {
      await b.wait(attempt === 0 ? 500 : 1000);
      await renderFormWidgets(session);
      filled = await fillMappedField(session, field, value);
    }

    if (filled) onFieldFilled(fieldName);
    else stillFailed.push(fieldName);
  }

  return stillFailed;
}

async function renderFormWidgets(session: BrowserSession): Promise<void> {
  for (const frame of getCandidateFrames(session)) {
    try {
      await frame.evaluate(() => {
        try { (window as any).layui?.form?.render?.(); } catch {}
        try { (window as any).layui?.form?.render?.("select"); } catch {}
        try { (window as any).layui?.form?.render?.("radio"); } catch {}
      });
    } catch {}
  }
}

async function waitForAnyFieldLabel(
  session: BrowserSession,
  labels: string[],
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const normalizedLabels = labels.map(normalizeLooseText);

  while (Date.now() < deadline) {
    for (const frame of getCandidateFrames(session)) {
      try {
        const found = await frame.evaluate((targets) => {
          const normalize = (text: string) => text.replace(/[\s*：:（）()\[\]【】]/g, "");
      const labelEls = Array.from(document.querySelectorAll<HTMLElement>(".layui-form-label, .form_label, label, td, th, span"));
          return labelEls.some((label) => {
            const text = normalize(label.textContent || "");
            return targets.some((target) => text === target || text.includes(target));
          });
        }, normalizedLabels);
        if (found) return true;
      } catch {}
    }
    await b.wait(500);
  }

  return false;
}

function resolveFieldValue(
  field: FieldSelector,
  record: CopyrightRecord,
  company: CompanyConfig
): string {
  const recordObj = record as unknown as Record<string, string | undefined>;
  let value = recordObj[field.bitableField];

  if (field.bitableField === "创作完成日期" && !value) {
    value = recordObj["创作/制作完成日期"];
  }
  if (field.bitableField === "首次发表日期" && !value) {
    value = recordObj["发表日期"];
  }

  if (field.bitableField === "作品类别" && value) value = normalizeWorkCategory(value);
  if (field.bitableField === "创作过程") value = generateCreationProcess(record, company);
  if (field.bitableField === "内容简介") value = value || generateContentIntro(record);
  if (field.bitableField === "作者名称" && !value) value = company.name;
  // 署名名称：当署名方式为"本名"时，填入作者名称
  if (field.bitableField === "署名名称") {
    const signature = record.署名 || "本名";
    value = signature === "本名" ? (record.作者名称 || company.name) : "";
  }

  if (!value) return "";

  const mapped = field.valueMap?.[value] || value;
  return field.type === "date" ? normalizeDateForForm(mapped) : String(mapped).trim();
}

function normalizeDateForForm(value: string): string {
  const cleaned = String(value || "").replace(/\s.*$/, "").trim();
  if (!cleaned) return "";

  const chinese = cleaned.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?/);
  if (chinese) {
    const [, year, month, day] = chinese;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const numeric = cleaned.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (numeric) {
    const [, year, month, day] = numeric;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  if (/^\d{13}$/.test(cleaned)) {
    const date = new Date(Number(cleaned));
    if (!Number.isNaN(date.getTime())) {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }
  }

  return cleaned;
}

function normalizeWorkCategory(value: string): string {
  const cleaned = normalizeLooseText(value);
  const aliases: Record<string, string> = {
    美术作品: "美术",
    文字作品: "文字",
    音乐作品: "音乐",
    摄影作品: "摄影",
    电影作品: "电影",
    建筑作品: "建筑",
    模型作品: "模型",
    其他作品: "其他",
  };
  return aliases[cleaned] || value.trim();
}

function getWorkCategoryCandidates(value: string): string[] {
  const normalized = normalizeLooseText(value);
  const candidates = [value.trim()];

  if (normalized.includes("类似摄制电影") || normalized.includes("摄制电影方法") || normalized.includes("视听")) {
    candidates.push(
      "类似摄制电影的方法创作的作品",
      "类似摄制电影方法创作的作品",
      "电影和类似摄制电影方法创作的作品",
      "电影和以类似摄制电影的方法创作的作品",
      "视听作品",
      "电影"
    );
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

function normalizeLooseText(value: string): string {
  return String(value || "").replace(/[\s*：:（）()\[\]【】]/g, "").trim();
}

export async function fillMappedField(
  session: BrowserSession,
  field: FieldSelector,
  value: string
): Promise<boolean> {
  // 单字段 10 秒超时保护，避免卡死整个流程
  try {
    const result = await Promise.race([
      (async () => {
        for (const frame of getCandidateFrames(session)) {
          if (await fillFieldInFrame(frame, field, value)) return true;
        }
        return false;
      })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10000)),
    ]);
    return result;
  } catch {
    return false;
  }
}

function getCandidateFrames(session: BrowserSession): Frame[] {
  return [...session.page.frames()].sort((a, bFrame) => frameScore(bFrame) - frameScore(a));
}

function frameScore(frame: Frame): number {
  const url = frame.url();
  let score = 0;
  if (url.includes("sbIndex") || url.includes("sbform") || url.includes("copreg")) score += 10;
  if (url.includes("zwfw.hubei.gov.cn")) score += 3;
  return score;
}

async function fillFieldInFrame(frame: Frame, field: FieldSelector, value: string): Promise<boolean> {
  await installEvaluateHelpers(frame);
  if (field.bitableField === "署名名称") return await fillSignatureNameByAnchor(frame, value);
  if (field.bitableField === "作品名称") return await fillTextInputByExactLabel(frame, ["作品名称", "作品名称（中文）"], value);
  if (field.bitableField === "创作完成日期") return await fillDateByExactLabel(frame, ["创作/制作完成日期", "创作完成日期", "制作完成日期"], value);
  if (field.bitableField === "内容简介") return await fillTextareaByExactLabel(frame, ["内容简介"], value);
  if (field.bitableField === "创作过程") return await fillTextareaByExactLabel(frame, ["创作过程"], value);
  if (field.bitableField === "作者名称") return await fillTextInputByExactLabel(frame, ["作者名称", "作者", "作者姓名"], value);
  if (field.bitableField === "首次发表日期") {
    // 优先通过 id 直接填写
    if (await fillDateById(frame, "publish_time", value)) return true;
    return await fillDateByExactLabel(frame, ["首次发表日期", "发表日期", "发表时间", "首次发表时间"], value);
  }
  if (field.type === "radio") {
    for (const label of getFieldLabels(field)) {
      if (await fillRadioByExactLabel(frame, label, value)) return true;
    }
  }
  // 权利拥有状况：选"全部"后，需要触发页面 JS 自动勾选所有子项
  if (field.bitableField === "权利拥有状况" || field.bitableField === "权利拥有状况及其说明") {
    const radioOk = await fillByFormItem(frame, field, value);
    if (radioOk && value === "全部") {
      await b.wait(500);
      // 页面 JS 应该自动勾选了所有 checkbox，但手动触发确保
      await checkAllRightsCheckboxes(frame);
    }
    return radioOk;
  }
  // 这两个字段必须走可见下拉点击，不回退到 native select 直接赋值。
  if (field.bitableField === "作品类别" || field.bitableField === "作品创作性质") {
    const labelsToTry = [field.bitableField, ...(field.labelAliases || [])];
    for (const label of labelsToTry) {
      if (await selectNativeByExactLabel(frame, label, value)) return true;
      if (await fillStrictSelectByExactLabel(frame, label, value)) return true;
    }
    if (await selectCustomByExactVisualLabel(frame, field, value)) return true;
    if (await selectCustomByLabel(frame, field, value)) return true;
    return await selectCustomByVisualLabel(frame, field, value);
  }
  if (isRegionSelectField(field)) return await fillRegionSelectByAnchor(frame, field, value);
  if (field.type === "select" && await selectCustomByExactVisualLabel(frame, field, value)) return true;
  if (field.type === "select" && await selectCustomByLabel(frame, field, value)) return true;
  if (field.type === "select" && await selectCustomByVisualLabel(frame, field, value)) return true;
  if (await fillByFormItem(frame, field, value)) return true;
  if (await fillByAccessibleLabel(frame, field, value)) return true;
  if (await fillByDom(frame, field, value)) return true;
  if (await fillByVisualLabel(frame, field, value)) return true;
  if (await fillBySelector(frame, field, value)) return true;
  return false;
}

async function fillRadioByExactLabel(frame: Frame, fieldName: string, value: string): Promise<boolean> {
  try {
    return await frame.evaluate(({ fieldLabel, targetValue }) => {
      const normalize = (text: string) => String(text || "").replace(/[\s*：:（）()\[\]【】]/g, "").trim();
      const expectedLabel = normalize(fieldLabel);
      const expectedValue = normalize(targetValue);

      function isVisible(el: Element | null): el is HTMLElement {
        if (!el || !(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) !== 0
          && rect.width > 0
          && rect.height > 0;
      }

      function radioWidget(radio: HTMLInputElement): HTMLElement | null {
        const next = radio.nextElementSibling;
        if (next instanceof HTMLElement && /radio/i.test(next.className || "")) return next;
        const label = radio.id ? document.querySelector<HTMLElement>(`label[for="${CSS.escape(radio.id)}"]`) : null;
        if (label) return label;
        const parentLabel = radio.closest("label");
        if (parentLabel instanceof HTMLElement) return parentLabel;
        return radio.parentElement;
      }

      function optionText(radio: HTMLInputElement): string {
        const pieces = [
          radio.value,
          radio.getAttribute("title") || "",
          radioWidget(radio)?.textContent || "",
          radio.id ? document.querySelector(`label[for="${CSS.escape(radio.id)}"]`)?.textContent || "" : "",
        ];
        return pieces.map(normalize).filter(Boolean).join("|");
      }

      function optionMatches(radio: HTMLInputElement): boolean {
        const parts = optionText(radio).split("|").filter(Boolean);
        return parts.some((part) => part === expectedValue || (expectedValue.length >= 3 && part.length <= 12 && part.includes(expectedValue)));
      }

      function dispatchRadio(radio: HTMLInputElement) {
        for (const eventName of ["input", "change", "click", "blur"]) {
          radio.dispatchEvent(new Event(eventName, { bubbles: true }));
        }
        try { (window as any).$?.(radio).trigger?.("change"); } catch {}
        try { (window as any).jQuery?.(radio).trigger?.("change"); } catch {}
      }

      function chooseRadio(radio: HTMLInputElement, group: HTMLInputElement[]) {
        const widget = radioWidget(radio);
        try { radio.scrollIntoView({ block: "center", inline: "nearest" }); } catch {}
        if (isVisible(widget)) {
          try { widget.click(); } catch {}
        } else {
          try { radio.click(); } catch {}
        }

        for (const item of group) {
          item.checked = item === radio;
          const itemWidget = radioWidget(item);
          if (itemWidget) itemWidget.classList.toggle("layui-form-radioed", item === radio);
        }
        dispatchRadio(radio);
        try { (window as any).layui?.form?.render?.("radio"); } catch {}
        dispatchRadio(radio);
        return radio.checked;
      }

      function groupedRadios(radios: HTMLInputElement[]): HTMLInputElement[][] {
        const groups = new Map<string, HTMLInputElement[]>();
        const withoutName: HTMLInputElement[][] = [];
        for (const radio of radios) {
          if (!radio.name) {
            withoutName.push([radio]);
            continue;
          }
          const key = radio.name;
          const group = groups.get(key) || [];
          group.push(radio);
          groups.set(key, group);
        }
        return [...groups.values(), ...withoutName];
      }

      function chooseFromRadios(radios: HTMLInputElement[]) {
        for (const group of groupedRadios(radios)) {
          const target = group.find(optionMatches);
          if (target && chooseRadio(target, group)) return true;
        }
        return false;
      }

      const labels = Array.from(document.querySelectorAll<HTMLElement>(".layui-form-label, .form_label, label, td, th, span, div"))
        .filter((label) => {
          const text = normalize(label.textContent || "");
          return text === expectedLabel || (text.length <= expectedLabel.length + 2 && text.includes(expectedLabel));
        })
        .sort((a, b) => (normalize(a.textContent || "").length - normalize(b.textContent || "").length));

      for (const label of labels) {
        const scopes = [
          label.closest(".layui-form-item, .el-form-item, .ant-form-item, .form-group, .row, tr, li"),
          label.parentElement,
          label.parentElement?.parentElement,
        ].filter(Boolean) as Element[];

        for (const scope of scopes) {
          const radios = Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
          if (radios.length && chooseFromRadios(radios)) return true;
        }

        const labelRect = label.getBoundingClientRect();
        const nearby = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
          .map((radio) => {
            const widget = radioWidget(radio);
            const rect = (widget || radio).getBoundingClientRect();
            const sameRow = rect.top < labelRect.bottom + 28 && rect.bottom > labelRect.top - 28;
            const toRight = rect.left >= labelRect.left - 8;
            if (!sameRow || !toRight) return null;
            return { radio, score: Math.max(0, rect.left - labelRect.right) + Math.abs(rect.top - labelRect.top) * 6 };
          })
          .filter(Boolean)
          .sort((a, b) => a!.score - b!.score)
          .map((item) => item!.radio);

        if (nearby.length && chooseFromRadios(nearby)) return true;
      }

      return false;
    }, { fieldLabel: fieldName, targetValue: value });
  } catch {
    return false;
  }
}

async function selectNativeByExactLabel(frame: Frame, fieldName: string, value: string): Promise<boolean> {
  try {
    return await frame.evaluate(({ fieldLabel, targetValue }) => {
      const normalize = (text: string) => String(text || "").replace(/[\s*：:（）()\[\]【】]/g, "").trim();
      const normalizeLoose = (text: string) => normalize(text).replace(/的/g, "");
      const expectedLabel = normalize(fieldLabel);
      const expected = normalize(targetValue);
      const looseExpected = normalizeLoose(targetValue);

      function isOptionMatch(textValue: string, rawValue: string) {
        const text = normalize(textValue);
        const looseText = normalizeLoose(textValue);
        const optionValue = normalize(rawValue);
        if (!text) return false;
        if (rawValue === targetValue || optionValue === expected) return true;
        if (text === expected || looseText === looseExpected) return true;

        // 只允许长文本互相包含，避免“电影”误命中“类似摄制电影...”。
        if (text.length >= 4 && expected.length >= 4 && (text.includes(expected) || expected.includes(text))) return true;
        if (looseText.length >= 4 && looseExpected.length >= 4 && (looseText.includes(looseExpected) || looseExpected.includes(looseText))) return true;
        return false;
      }

      function dispatchSelect(select: HTMLSelectElement) {
        for (const eventName of ["input", "change", "blur"]) {
          select.dispatchEvent(new Event(eventName, { bubbles: true }));
        }
        try { (window as any).$?.(select).trigger?.("change"); } catch {}
        try { (window as any).jQuery?.(select).trigger?.("change"); } catch {}
      }

      function syncLayuiWidget(select: HTMLSelectElement, option: HTMLOptionElement) {
        try { (window as any).layui?.form?.render?.("select"); } catch {}
        const widget = (
          select.nextElementSibling instanceof HTMLElement && select.nextElementSibling.classList.contains("layui-form-select")
            ? select.nextElementSibling
            : select.parentElement?.querySelector<HTMLElement>(".layui-form-select")
        ) || null;
        if (!widget) return;

        const input = widget.querySelector<HTMLInputElement>("input");
        if (input) {
          input.value = option.text.trim();
          input.setAttribute("value", option.text.trim());
          input.setAttribute("title", option.text.trim());
        }

        const items = Array.from(widget.querySelectorAll<HTMLElement>("dd"));
        for (const item of items) {
          item.classList.toggle(
            "layui-this",
            item.getAttribute("lay-value") === option.value || normalize(item.textContent || "") === normalize(option.text)
          );
        }
        widget.classList.remove("layui-form-selected");
      }

      function chooseSelect(select: HTMLSelectElement) {
        const options = Array.from(select.options);
        const option = options.find((opt) => isOptionMatch(opt.text, opt.value));
        if (!option) return false;

        select.selectedIndex = option.index;
        select.value = option.value;
        dispatchSelect(select);
        syncLayuiWidget(select, option);
        dispatchSelect(select);

        const selectedText = select.selectedOptions?.[0]?.text || "";
        return isOptionMatch(selectedText, select.value);
      }

      const labels = Array.from(document.querySelectorAll<HTMLElement>(".layui-form-label, .form_label, label, td, th, span"));
      for (const label of labels) {
        const labelText = normalize(label.textContent || "");
        if (labelText !== expectedLabel) continue;

        const scope = label.closest(".layui-form-item, .el-form-item, .ant-form-item, .form-group, .row, tr, li")
          || label.parentElement?.parentElement
          || label.parentElement;
        const scopedSelects = Array.from(scope?.querySelectorAll<HTMLSelectElement>("select") || []);
        for (const select of scopedSelects) {
          if (chooseSelect(select)) return true;
        }

        const labelRect = label.getBoundingClientRect();
        const nearbySelects = Array.from(document.querySelectorAll<HTMLSelectElement>("select"))
          .map((select) => {
            const widget = select.nextElementSibling instanceof HTMLElement ? select.nextElementSibling : select.parentElement?.querySelector<HTMLElement>(".layui-form-select");
            const rect = (widget || select).getBoundingClientRect();
            const sameRow = rect.top < labelRect.bottom + 30 && rect.bottom > labelRect.top - 30;
            const below = rect.top >= labelRect.top && rect.top - labelRect.bottom < 160;
            const toRight = rect.left >= labelRect.left - 10;
            if (!toRight || (!sameRow && !below)) return null;
            return { select, score: Math.max(0, rect.left - labelRect.right) + Math.abs(rect.top - labelRect.top) * 8 };
          })
          .filter(Boolean)
          .sort((a, b) => a!.score - b!.score) as Array<{ select: HTMLSelectElement; score: number }>;

        for (const item of nearbySelects) {
          if (chooseSelect(item.select)) return true;
        }
      }

      return false;
    }, { fieldLabel: fieldName, targetValue: value });
  } catch {
    return false;
  }
}

async function fillStrictSelectByExactLabel(frame: Frame, fieldName: string, value: string): Promise<boolean> {
  let handle;
  try {
    handle = await frame.evaluateHandle(({ fieldLabel }) => {
      const normalize = (text: string) => text.replace(/[\s*：:（）()\[\]【】]/g, "");
      const expected = normalize(fieldLabel);
      const labels = Array.from(document.querySelectorAll<HTMLElement>(".layui-form-label, .form_label, label, td, th, span"));

      function isVisible(el: HTMLElement): boolean {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) !== 0
          && rect.width > 0
          && rect.height > 0;
      }

      for (const label of labels) {
        const text = normalize(label.textContent || "");
        if (text !== expected) continue;
        const scope = label.closest(".layui-form-item, .el-form-item, .ant-form-item, .form-group, .row, tr, li")
          || label.parentElement?.parentElement
          || label.parentElement;
        if (!scope) continue;

        const widget = scope.querySelector<HTMLElement>(".layui-form-select, .el-select, .ant-select, [role=combobox]");
        if (widget && isVisible(widget)) return widget;

        const select = scope.querySelector<HTMLSelectElement>("select");
        if (select && isVisible(select)) return select;
      }

      return null;
    }, { fieldLabel: fieldName });

    const element = handle.asElement();
    if (!element) return false;
    const selected = await chooseSelectElement(frame, element, value);
    if (!selected) return false;

    return await frame.evaluate(({ fieldLabel, targetValue }) => {
      const normalize = (text: string) => text.replace(/[\s*：:（）()\[\]【】]/g, "");
      const expectedLabel = normalize(fieldLabel);
      const expectedValue = normalize(targetValue);
      const labels = Array.from(document.querySelectorAll<HTMLElement>(".layui-form-label, .form_label, label, td, th, span"));

      for (const label of labels) {
        const text = normalize(label.textContent || "");
        if (text !== expectedLabel) continue;
        const scope = label.closest(".layui-form-item, .el-form-item, .ant-form-item, .form-group, .row, tr, li")
          || label.parentElement?.parentElement
          || label.parentElement;
        if (!scope) continue;

        const widgetInput = scope.querySelector<HTMLInputElement>(".layui-form-select input, .el-select input, .ant-select-selection-search-input");
        const widgetText = normalize(widgetInput?.value || widgetInput?.getAttribute("value") || "");
        if (widgetText && (
          widgetText === expectedValue
          || widgetText.replace(/的/g, "") === expectedValue.replace(/的/g, "")
          || (widgetText.length >= 4 && expectedValue.length >= 4 && (widgetText.includes(expectedValue) || expectedValue.includes(widgetText)))
        )) return true;

        const select = scope.querySelector<HTMLSelectElement>("select");
        const selectedText = normalize(select?.selectedOptions?.[0]?.text || select?.value || "");
        if (selectedText && (
          selectedText === expectedValue
          || selectedText.replace(/的/g, "") === expectedValue.replace(/的/g, "")
          || (selectedText.length >= 4 && expectedValue.length >= 4 && (selectedText.includes(expectedValue) || expectedValue.includes(selectedText)))
        )) return true;
      }

      return false;
    }, { fieldLabel: fieldName, targetValue: value });
  } catch {
    return false;
  } finally {
    await handle?.dispose?.().catch(() => {});
  }
}

async function fillTextareaByExactLabel(frame: Frame, labels: string[], value: string): Promise<boolean> {
  try {
    return await frame.evaluate(({ labels: targetLabels, textValue }) => {
      const normalize = (text: string) => text.replace(/[\s*：:（）()\[\]【】]/g, "");
      const expected = targetLabels.map(normalize);
      const labelEls = Array.from(document.querySelectorAll<HTMLElement>(".layui-form-label, .form_label, label, td, th, span"));

      function setTextAreaValue(textarea: HTMLTextAreaElement): boolean {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (setter) setter.call(textarea, textValue);
        else textarea.value = textValue;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
        textarea.dispatchEvent(new Event("blur", { bubbles: true }));
        return textarea.value === textValue;
      }

      for (const label of labelEls) {
        const labelText = normalize(label.textContent || "");
        if (!expected.some((e) => labelText === e || labelText.includes(e))) continue;
        const scope = label.closest(".layui-form-item, .el-form-item, .ant-form-item, .form-group, .row, tr, li")
          || label.parentElement?.parentElement
          || label.parentElement;
        const textarea = scope?.querySelector<HTMLTextAreaElement>("textarea");
        if (textarea && setTextAreaValue(textarea)) return true;
      }

      return false;
    }, { labels, textValue: value });
  } catch {
    return false;
  }
}

async function fillTextInputByExactLabel(frame: Frame, labels: string[], value: string): Promise<boolean> {
  try {
    return await frame.evaluate(({ labels: targetLabels, textValue }) => {
      const normalize = (text: string) => text.replace(/[\s*：:（）()\[\]【】]/g, "");
      const expected = targetLabels.map(normalize);
      const labelEls = Array.from(document.querySelectorAll<HTMLElement>(".layui-form-label, .form_label, label, td, th, span"));

      function isTextInput(input: HTMLInputElement): boolean {
        const type = (input.type || "text").toLowerCase();
        if (!["text", ""].includes(type)) return false;
        if (input.readOnly) return false;
        if (input.closest(".layui-form-select, .el-select, .ant-select")) return false;
        const style = window.getComputedStyle(input);
        const rect = input.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }

      function setInputValue(input: HTMLInputElement): boolean {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(input, textValue);
        else input.value = textValue;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("blur", { bubbles: true }));
        return input.value === textValue;
      }

      for (const label of labelEls) {
        const labelText = normalize(label.textContent || "");
        if (!expected.some((e) => labelText === e || labelText.includes(e))) continue;
        const scope = label.closest(".layui-form-item, .el-form-item, .ant-form-item, .form-group, .row, tr, li")
          || label.parentElement?.parentElement
          || label.parentElement;
        const input = Array.from(scope?.querySelectorAll<HTMLInputElement>("input") || []).find(isTextInput);
        if (input && setInputValue(input)) return true;
      }

      return false;
    }, { labels, textValue: value });
  } catch {
    return false;
  }
}

async function fillDateById(frame: Frame, inputId: string, value: string): Promise<boolean> {
  try {
    return await frame.evaluate(({ id, nextValue }) => {
      var input = document.getElementById(id) as HTMLInputElement | null;
      if (!input) return false;
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      try { input.focus(); } catch {}
      if (setter) setter.call(input, nextValue);
      else input.value = nextValue;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      return input.value === nextValue;
    }, { id: inputId, nextValue: value });
  } catch {
    return false;
  }
}

async function fillDateByExactLabel(frame: Frame, labels: string[], value: string): Promise<boolean> {
  try {
    return await frame.evaluate(({ targetLabels, nextValue }) => {
      const normalize = (text: string) => text.replace(/[\s*：:（）()\[\]【】]/g, "");
      const expected = targetLabels.map(normalize);
      const labelEls = Array.from(document.querySelectorAll<HTMLElement>(".layui-form-label, .form_label, label, td, th, span"));

      function isVisible(el: HTMLElement): boolean {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) !== 0
          && rect.width > 0
          && rect.height > 0;
      }

      function isDateLike(input: HTMLInputElement): boolean {
        const hint = `${input.type} ${input.placeholder || ""} ${input.className || ""} ${input.name || ""} ${input.id || ""}`.toLowerCase();
        return hint.includes("date")
          || hint.includes("yyyy")
          || hint.includes("publish")
          || hint.includes("发表")
          || hint.includes("laydate")
          || hint.includes("wdate");
      }

      function setInputValue(input: HTMLInputElement): boolean {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        try { input.focus(); } catch {}
        if (setter) setter.call(input, nextValue);
        else input.value = nextValue;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
        input.dispatchEvent(new Event("blur", { bubbles: true }));
        return input.value === nextValue;
      }

      function setNearbyHiddenInputs(target: HTMLInputElement) {
        const roots = [
          target.parentElement,
          target.parentElement?.parentElement,
          target.closest(".layui-input-inline, .layui-input-block, .layui-form-item, .row, td, li"),
        ].filter(Boolean) as Element[];

        const seen = new Set<HTMLInputElement>();
        for (const root of roots) {
          const hiddenInputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="hidden"]'))
            .filter((input) => !seen.has(input))
            .filter(isDateLike);
          for (const hidden of hiddenInputs) {
            seen.add(hidden);
            setInputValue(hidden);
          }
        }
      }

      type LabelCandidate = { label: HTMLElement; score: number };
      const matchedLabels: LabelCandidate[] = [];
      for (const label of labelEls) {
        const labelText = normalize(label.textContent || "");
        const exactIndex = expected.findIndex((e) => labelText === e);
        if (exactIndex !== -1) {
          matchedLabels.push({ label, score: exactIndex * 10 });
          continue;
        }
        const fuzzyIndex = expected.findIndex((e) => labelText.includes(e));
        if (fuzzyIndex !== -1) {
          matchedLabels.push({ label, score: 500 + fuzzyIndex * 10 + Math.max(0, labelText.length - expected[fuzzyIndex].length) });
        }
      }

      matchedLabels.sort((a, b) => a.score - b.score);

      function gatherCandidates(label: HTMLElement): HTMLInputElement[] {
        const scope = label.closest(".layui-form-item, .el-form-item, .ant-form-item, .form-group, .row, tr, li")
          || label.parentElement?.parentElement
          || label.parentElement;
        const scoped = Array.from(scope?.querySelectorAll<HTMLInputElement>("input") || []);
        const pageWide = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
        return [...scoped, ...pageWide].filter((input, index, arr) => arr.indexOf(input) === index);
      }

      for (const { label, score: labelScore } of matchedLabels) {
        const labelRect = label.getBoundingClientRect();
        const visibleCandidates = gatherCandidates(label)
          .filter((input) => input.type !== "hidden" && isVisible(input))
          .map((input) => {
            const rect = input.getBoundingClientRect();
            const sameRow = rect.top < labelRect.bottom + 24 && rect.bottom > labelRect.top - 24;
            const below = rect.top >= labelRect.top - 8 && rect.top - labelRect.bottom < 140;
            const toRight = rect.left >= labelRect.right - 12;
            if (!toRight || (!sameRow && !below)) return null;
            const dx = Math.max(0, rect.left - labelRect.right);
            const dy = Math.abs((rect.top + rect.height / 2) - (labelRect.top + labelRect.height / 2));
            const datePenalty = isDateLike(input) ? 0 : 5000;
            const rowPenalty = sameRow ? 0 : 800;
            return { input, score: labelScore + rowPenalty + datePenalty + dx + dy * 6 };
          })
          .filter(Boolean)
          .sort((a, b) => a!.score - b!.score) as Array<{ input: HTMLInputElement; score: number }>;

        for (const candidate of visibleCandidates.slice(0, 4)) {
          if (setInputValue(candidate.input)) {
            setNearbyHiddenInputs(candidate.input);
            return true;
          }
        }

        const hiddenCandidates = gatherCandidates(label)
          .filter((input) => input.type === "hidden" && isDateLike(input));
        for (const hidden of hiddenCandidates) {
          if (setInputValue(hidden)) return true;
        }
      }

      return false;
    }, { targetLabels: labels, nextValue: value });
  } catch {
    return false;
  }
}

async function installEvaluateHelpers(frame: Frame): Promise<void> {
  try {
    await frame.evaluate(() => {
      (window as any).__name = (fn: any) => fn;
    });
  } catch {}
}

async function fillSignatureNameByAnchor(frame: Frame, value: string): Promise<boolean> {
  try {
    return await frame.evaluate((nextValue) => {
      var __name = function(fn: Function, _name: string) { return fn as any; };
      const normalize = (text: string) => text.replace(/[\s*：:（）()\[\]【】]/g, "");

      function matchesLabel(text: string) {
        const normalizedText = normalize(text || "");
        return normalizedText === "署名" || normalizedText.includes("署名方式");
      }

      function isTextInput(input: HTMLInputElement) {
        const type = (input.getAttribute("type") || "text").toLowerCase();
        if (!["", "text"].includes(type)) return false;
        if (input.readOnly) return false;
        if (input.closest(".layui-form-select, .el-select, .ant-select")) return false;
        const style = window.getComputedStyle(input);
        const rect = input.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }

      function setNativeValue(input: HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(input, nextValue);
        else input.value = nextValue;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("blur", { bubbles: true }));
        return input.value === nextValue;
      }

      const labels = Array.from(document.querySelectorAll<HTMLElement>(".layui-form-label, .form_label, label, td, th, span"))
        .filter((el) => matchesLabel(el.textContent || ""));

      for (const label of labels) {
        const scope = label.closest(".layui-form-item, .el-form-item, .ant-form-item, .form-group, .row, tr, li")
          || label.parentElement?.parentElement
          || label.parentElement;
        const input = Array.from(scope?.querySelectorAll<HTMLInputElement>("input") || []).find(isTextInput);
        if (input && setNativeValue(input)) return true;
      }

      return false;
    }, value);
  } catch {
    return false;
  }
}

function isRegionSelectField(field: FieldSelector): boolean {
  return ["省创作", "市创作", "省发表", "市发表"].includes(field.bitableField);
}

async function fillByFormItem(frame: Frame, field: FieldSelector, value: string): Promise<boolean> {
  try {
    return await frame.evaluate(
      ({ labels, value: rawValue, type }) => {
        var __name = function(fn: Function, _name: string) { return fn as any; };
        const normalize = (text: string) => text.replace(/[\s*：:（）()\[\]【】]/g, "");
        const expectedLabels = labels.map(normalize).filter(Boolean);
        const value = type === "date" ? normalizeDate(rawValue) : rawValue;

        function normalizeDate(raw: string) {
          const cleaned = String(raw || "").replace(/\s.*$/, "").trim();
          const parts = cleaned.split(/[\/\-.]/);
          if (parts.length < 3) return cleaned;
          const [year, month, day] = parts;
          return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
        }

        function matchesLabel(text: string) {
          const normalizedText = normalize(text || "");
          if (!normalizedText || normalizedText.length > 60) return false;
          return expectedLabels.some((label) => normalizedText.includes(label) || (label.length > 2 && label.includes(normalizedText)));
        }

        function dispatch(el: Element) {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        }

        function renderFormWidgets() {
          try { (window as any).layui?.form?.render?.(); } catch {}
          try { (window as any).layui?.form?.render?.("select"); } catch {}
          try { (window as any).layui?.form?.render?.("radio"); } catch {}
        }

        function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, nextValue: string) {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, nextValue);
          else el.value = nextValue;
          dispatch(el);
          return true;
        }

        function normalizeOption(text: string) {
          return normalize(text).replace(/的/g, "");
        }

        function chooseSelect(select: HTMLSelectElement, nextValue: string) {
          const normalizedValue = normalize(nextValue);
          const looseValue = normalizeOption(nextValue);
          const options = Array.from(select.options);
          const option = options.find((opt) => opt.value === nextValue || opt.text.trim() === nextValue)
            || options.find((opt) => {
              const text = normalize(opt.text);
              const looseText = normalizeOption(opt.text);
              return !!text && (
                text.includes(normalizedValue)
                || normalizedValue.includes(text)
                || looseText.includes(looseValue)
                || looseValue.includes(looseText)
              );
            });
          if (!option) return false;
          select.value = option.value;
          dispatch(select);
          renderFormWidgets();
          return select.value === option.value;
        }

        function chooseRadio(radio: HTMLInputElement, nextValue: string) {
          const group = radio.name
            ? Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(radio.name)}"]`))
            : [radio];
          const normalizedValue = normalize(nextValue);
          function radioOptionText(item: HTMLInputElement) {
            const next = item.nextElementSibling;
            const labelFor = item.id ? document.querySelector(`label[for="${CSS.escape(item.id)}"]`)?.textContent || "" : "";
            const parentLabel = item.closest("label")?.textContent || "";
            const shortParent = parentLabel && normalize(parentLabel).length <= 12 ? parentLabel : "";
            return [
              item.value,
              item.getAttribute("title") || "",
              next instanceof HTMLElement ? next.textContent || "" : "",
              labelFor,
              shortParent,
            ].map(normalize).filter(Boolean).join("|");
          }
          const matched = group.find((item) => normalize(item.value) === normalizedValue)
            || group.find((item) => radioOptionText(item).split("|").some((text) => text === normalizedValue || (text.length <= 12 && text.includes(normalizedValue))));
          const target = matched || radio;
          try {
            const widget = target.nextElementSibling instanceof HTMLElement && /radio/i.test(target.nextElementSibling.className || "")
              ? target.nextElementSibling
              : target.closest("label");
            (widget as HTMLElement | null)?.click?.();
          } catch {}
          target.checked = true;
          target.dispatchEvent(new Event("click", { bubbles: true }));
          dispatch(target);
          renderFormWidgets();
          return target.checked;
        }

        function chooseCheckbox(checkbox: HTMLInputElement, nextValue: string) {
          const root = checkbox.closest(".layui-form-item, .el-form-item, .ant-form-item, .form-group, .row, tr, li") || checkbox.parentElement;
          const group = checkbox.name
            ? Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][name="${CSS.escape(checkbox.name)}"]`))
            : Array.from(root?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') || [checkbox]);
          const normalizedValue = normalize(nextValue);
          const matched = group.find((item) => normalize(item.value) === normalizedValue)
            || group.find((item) => normalize(item.parentElement?.textContent || "").includes(normalizedValue))
            || group.find((item) => {
              const id = item.id ? document.querySelector(`label[for="${CSS.escape(item.id)}"]`)?.textContent || "" : "";
              return normalize(id).includes(normalizedValue);
            });
          const target = matched || checkbox;
          target.checked = true;
          dispatch(target);
          renderFormWidgets();
          return target.checked;
        }

        function nearestNativeSelect(el: HTMLElement): HTMLSelectElement | null {
          const prev = el.previousElementSibling;
          if (prev instanceof HTMLSelectElement) return prev;
          const parent = el.parentElement;
          return parent?.querySelector("select") || null;
        }

        function setControl(target: Element | null): boolean {
          if (!target) return false;
          const el = target as HTMLElement;

          if (el instanceof HTMLSelectElement) return chooseSelect(el, value);
          if (el.matches(".layui-form-select, .el-select, .ant-select, [role=combobox]")) {
            const select = nearestNativeSelect(el);
            if (select) return chooseSelect(select, value);
          }
          if (el instanceof HTMLTextAreaElement) return setNativeValue(el, value);
          if (el instanceof HTMLInputElement) {
            if (el.type === "radio") return chooseRadio(el, value);
            if (el.type === "checkbox") return chooseCheckbox(el, value);
            if (type === "select" && el.readOnly) {
              const select = nearestNativeSelect(el.closest(".layui-form-select") as HTMLElement || el);
              return select ? chooseSelect(select, value) : false;
            }
            return setNativeValue(el, value);
          }
          if (el.isContentEditable) {
            el.textContent = value;
            dispatch(el);
            return true;
          }
          const nested = pickControl(el);
          return nested ? setControl(nested) : false;
        }

        function scoreControl(el: Element) {
          if (type === "radio") return el instanceof HTMLInputElement && el.type === "radio" ? 0 : 1000;
          if (type === "checkbox") return el instanceof HTMLInputElement && el.type === "checkbox" ? 0 : 1000;
          if (type === "select") return el instanceof HTMLSelectElement || (el as HTMLElement).matches(".layui-form-select, .el-select, .ant-select, [role=combobox]") ? 0 : 1000;
          if (type === "textarea") return el instanceof HTMLTextAreaElement ? 0 : 1000;
          if (type === "date") {
            if (!(el instanceof HTMLInputElement)) return 1000;
            const hint = `${el.type} ${el.placeholder || ""} ${el.className || ""}`;
            return /date|YYYY|MM|DD|Wdate|laydate/i.test(hint) ? 0 : 10;
          }
          if (el instanceof HTMLInputElement && ["hidden", "radio", "checkbox", "button", "submit"].includes(el.type)) return 1000;
          return 0;
        }

        function pickControl(scope: Element): Element | null {
          const controls = Array.from(scope.querySelectorAll<Element>(
            "select, textarea, input, [contenteditable=true], .layui-form-select, .el-select, .ant-select, [role=combobox]"
          )).filter((el) => {
            if (el instanceof HTMLInputElement && ["hidden", "button", "submit"].includes(el.type) && type !== "select") return false;
            return true;
          });
          controls.sort((a, b) => scoreControl(a) - scoreControl(b));
          return controls.find((el) => scoreControl(el) < 1000) || null;
        }

        const labelElements = Array.from(document.querySelectorAll<HTMLElement>(
          ".layui-form-label, label, .el-form-item__label, .ant-form-item-label, td, th, span"
        ))
          .filter((el) => matchesLabel(el.textContent || ""))
          .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);

        for (const label of labelElements) {
          const forId = label.getAttribute("for");
          if (forId && setControl(document.getElementById(forId))) return true;

          const scopes = [
            label.closest(".layui-form-item, .el-form-item, .ant-form-item, .form-group, .row, tr, li"),
            label.parentElement,
            label.parentElement?.parentElement,
          ].filter(Boolean) as Element[];

          for (const scope of scopes) {
            const control = pickControl(scope);
            if (control && setControl(control)) return true;
          }
        }

        return false;
      },
      { labels: getFieldLabels(field), value, type: field.type }
    );
  } catch {
    return false;
  }
}

/**
 * 当选择"全部"权利拥有状况时，勾选所有著作权 checkbox
 * 发表权、署名权、修改权、保护作品完整权、复制权、发行权、出租权、
 * 展览权、表演权、放映权、广播权、信息网络传播权、摄制权、改编权、翻译权、汇编权、其他
 */
async function checkAllRightsCheckboxes(frame: Frame): Promise<void> {
  try {
    await frame.evaluate(() => {
      var __name = function(fn: Function, _name: string) { return fn; };
      var checkboxes = document.querySelectorAll('input[type="checkbox"]');
      for (var i = 0; i < checkboxes.length; i++) {
        var cb = checkboxes[i] as HTMLInputElement;
        if (!cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event("change", { bubbles: true }));
          cb.dispatchEvent(new Event("click", { bubbles: true }));
        }
      }
    });
  } catch {
    // 非关键，忽略
  }
}

async function fillRegionSelectByAnchor(frame: Frame, field: FieldSelector, value: string): Promise<boolean> {
  let handle;
  try {
    const role = field.bitableField.includes("省") ? "province" : "city";
    const group = field.bitableField.includes("创作") ? "creation" : "publish";
    handle = await frame.evaluateHandle(
      ({ role, group }) => {
        var __name = function(fn: Function, _name: string) { return fn as any; };
        const normalize = (text: string) => text.replace(/[\s*：:（）()\[\]【】]/g, "");
        const anchorLabels = group === "creation"
          ? ["创作/制作完成地点", "创作完成地点", "制作完成地点"]
          : ["发表地点", "首次发表地点"];

        function isVisibleEnough(el: Element) {
          if (el instanceof HTMLSelectElement) return true;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        }

        function matchesAnchor(text: string) {
          const normalizedText = normalize(text || "");
          if (!normalizedText || normalizedText.length > 80) return false;
          return anchorLabels.some((label) => {
            const normalizedLabel = normalize(label);
            return normalizedText.includes(normalizedLabel) || normalizedLabel.includes(normalizedText);
          });
        }

        function visibleWidgetForSelect(select: HTMLSelectElement): HTMLElement {
          const next = select.nextElementSibling;
          if (next instanceof HTMLElement && next.matches(".layui-form-select, .el-select, .ant-select, [role=combobox]")) return next;
          const parent = select.parentElement;
          const widget = parent?.querySelector<HTMLElement>(".layui-form-select, .el-select, .ant-select, [role=combobox]");
          return widget || select;
        }

        const labels = Array.from(document.querySelectorAll<HTMLElement>(
          ".layui-form-label, label, .el-form-item__label, .ant-form-item-label, td, th, span"
        )).filter((el) => matchesAnchor(el.textContent || ""));

        for (const label of labels) {
          const scope = label.closest(".layui-form-item, .el-form-item, .ant-form-item, .form-group, .row, tr, li")
            || label.parentElement?.parentElement
            || label.parentElement;
          const scopedSelects = scope
            ? Array.from(scope.querySelectorAll<HTMLSelectElement>("select")).filter(isVisibleEnough)
            : [];
          if (scopedSelects.length >= 2) {
            const target = scopedSelects[role === "province" ? 0 : 1];
            if (target) return visibleWidgetForSelect(target);
          }

          const labelRect = label.getBoundingClientRect();
          const nearbySelects = Array.from(document.querySelectorAll<HTMLSelectElement>("select"))
            .filter(isVisibleEnough)
            .map((select) => {
              const rect = select.getBoundingClientRect();
              const belowOrSame = rect.top >= labelRect.top - 20 && rect.top - labelRect.bottom < 180;
              const toRight = rect.left >= labelRect.left - 10;
              if (!belowOrSame || !toRight) return null;
              return { select, score: Math.max(0, rect.top - labelRect.bottom) * 4 + Math.max(0, rect.left - labelRect.right) };
            })
            .filter(Boolean)
            .sort((a, b) => a!.score - b!.score) as Array<{ select: HTMLSelectElement; score: number }>;

          const target = nearbySelects[role === "province" ? 0 : 1]?.select;
          if (target) return visibleWidgetForSelect(target);
        }

        return null;
      },
      { role, group }
    );

    const element = handle.asElement();
    if (!element) return false;
    return await chooseSelectElement(frame, element, value);
  } catch (err) {
    console.warn(`[填表] 省市下拉定位失败: ${field.bitableField}`, err);
    return false;
  } finally {
    await handle?.dispose?.().catch(() => {});
  }
}

async function fillBySelector(frame: Frame, field: FieldSelector, value: string): Promise<boolean> {
  if (!field.selector) return false;

  try {
    if (await fillLocatorValue(frame.locator(field.selector), field, value)) return true;
  } catch {}

  return false;
}

async function fillByAccessibleLabel(frame: Frame, field: FieldSelector, value: string): Promise<boolean> {
  for (const label of getFieldLabels(field)) {
    try {
      if (await fillLocatorValue(frame.getByLabel(label, { exact: false }), field, value)) return true;
    } catch {}
  }

  return false;
}

async function fillLocatorValue(locator: Locator, field: FieldSelector, value: string): Promise<boolean> {
  let count = 0;
  try {
    count = Math.min(await locator.count(), 6);
  } catch {
    return false;
  }

  for (let i = 0; i < count; i++) {
    const target = locator.nth(i);
    try {
      const info = await target.evaluate((el) => ({
        tagName: el.tagName.toLowerCase(),
        inputType: el instanceof HTMLInputElement ? el.type : "",
        editable: (el as HTMLElement).isContentEditable,
      }));

      if (info.tagName === "select") {
        if (await selectNativeOption(target, value)) return true;
        continue;
      }

      if (info.tagName === "textarea" || info.tagName === "input" || info.editable) {
        if (info.inputType === "radio" || info.inputType === "checkbox") {
          await target.check({ timeout: 2000 });
        } else {
          await target.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
          await target.fill(value, { timeout: 3000 });
        }
        return true;
      }
    } catch {}
  }

  return false;
}

async function selectNativeOption(locator: Locator, value: string): Promise<boolean> {
  try {
    await locator.selectOption({ label: value }, { timeout: 2000 });
    return true;
  } catch {}

  try {
    await locator.selectOption(value, { timeout: 2000 });
    return true;
  } catch {}

  try {
    const optionValue = await locator.evaluate((el, targetValue) => {
      if (!(el instanceof HTMLSelectElement)) return null;
      const normalized = (text: string) => text.replace(/\s+/g, "");
      const expected = normalized(targetValue);
      const options = Array.from(el.options);
      const option = options.find((opt) => {
        const text = normalized(opt.text);
        return !!text && (text.includes(expected) || expected.includes(text));
      });
      return option?.value ?? null;
    }, value);
    if (!optionValue) return false;
    await locator.selectOption(optionValue, { timeout: 2000 });
    return true;
  } catch {}

  return false;
}

async function chooseSelectElement(frame: Frame, target: Locator | ElementHandle, value: string): Promise<boolean> {
  try {
    const tagName = await target.evaluate((el) => el.tagName.toLowerCase());
    if (tagName === "select") {
      const widgetHandle = await target.evaluateHandle((select) => {
        const next = select.nextElementSibling;
        if (next instanceof HTMLElement && next.matches(".layui-form-select, .el-select, .ant-select, [role=combobox]")) return next;
        const widget = select.parentElement?.querySelector(".layui-form-select, .el-select, .ant-select, [role=combobox]");
        return widget || select;
      });
      const widget = widgetHandle.asElement();
      try {
        if (widget && widget !== target) return await chooseSelectElement(frame, widget, value);
      } finally {
        await widgetHandle.dispose().catch(() => {});
      }
      return await selectNativeElement(target, value);
    }
  } catch {}

  try {
    await target.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await target.click({ timeout: 3000 });
  } catch {
    try {
      await target.click({ timeout: 1500, force: true });
    } catch {
      return false;
    }
  }

  await frame.waitForTimeout(250);

  const clicked = await clickVisibleOptionByLocator(frame, value) || await clickVisibleOption(frame, value);
  if (!clicked) return false;

  await frame.waitForTimeout(250);
  return true;
}

async function clickVisibleOptionByLocator(frame: Frame, value: string): Promise<boolean> {
  const optionLocator = frame.locator("dd:not(.layui-disabled), .el-select-dropdown__item, .ant-select-item-option, [role=option], li");
  let count = 0;
  try {
    count = Math.min(await optionLocator.count(), 240);
  } catch {
    return false;
  }

  for (let i = 0; i < count; i++) {
    const option = optionLocator.nth(i);
    let matched = false;
    try {
      matched = await option.evaluate((el, targetValue) => {
        const normalize = (text: string) => String(text || "").replace(/[\s*：:（）()\[\]【】]/g, "").trim();
        const normalizeLoose = (text: string) => normalize(text).replace(/的/g, "");
        const expected = normalize(targetValue);
        const looseExpected = normalizeLoose(targetValue);
        const text = normalize(el.textContent || "");
        const looseText = normalizeLoose(el.textContent || "");
        if (!text) return false;

        const style = window.getComputedStyle(el);
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0) {
          return false;
        }

        if (text === expected || looseText === looseExpected) return true;
        if (text.length >= 4 && expected.length >= 4 && (text.includes(expected) || expected.includes(text))) return true;
        if (looseText.length >= 4 && looseExpected.length >= 4 && (looseText.includes(looseExpected) || looseExpected.includes(looseText))) return true;
        return false;
      }, value);
    } catch {}

    if (!matched) continue;

    try {
      await option.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await option.click({ timeout: 3000 });
      return true;
    } catch {
      try {
        await option.click({ timeout: 1500, force: true });
        return true;
      } catch {}
    }
  }

  return false;
}

async function selectNativeElement(target: Locator | ElementHandle, value: string): Promise<boolean> {
  try {
    return await target.evaluate(
      (el, targetValue) => {
        if (!(el instanceof HTMLSelectElement)) return false;
        const normalize = (text: string) => text.replace(/[\s*：:（）()\[\]【】]/g, "");
        const normalizeOption = (text: string) => normalize(text).replace(/的/g, "");
        const expected = normalize(targetValue);
        const looseExpected = normalizeOption(targetValue);
        const options = Array.from(el.options);
        const option = options.find((opt) => opt.value === targetValue || opt.text.trim() === targetValue)
          || options.find((opt) => {
            const text = normalize(opt.text);
            const looseText = normalizeOption(opt.text);
            return !!text && (
              text.includes(expected)
              || expected.includes(text)
              || looseText.includes(looseExpected)
              || looseExpected.includes(looseText)
            );
          });
        if (!option) return false;
        el.value = option.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
        try { (window as any).layui?.form?.render?.("select"); } catch {}
        return el.value === option.value;
      },
      value
    );
  } catch {
    return false;
  }
}

async function clickVisibleOption(frame: Frame, value: string): Promise<boolean> {
  return await frame.evaluate((targetValue) => {
    const normalize = (text: string) => text.replace(/[\s*：:（）()\[\]【】]/g, "");
    const normalizeOption = (text: string) => normalize(text).replace(/的/g, "");
    const expected = normalize(targetValue);
    const looseExpected = normalizeOption(targetValue);
    const optionSelectors = [
      "dd:not(.layui-disabled)",
      ".el-select-dropdown__item",
      ".ant-select-item-option",
      "[role=option]",
      "li",
    ];
    const panelSelectors = [
      ".layui-form-selected dl",
      ".layui-form-select dl",
      ".layui-anim",
      ".el-select-dropdown",
      ".ant-select-dropdown",
      "[role=listbox]",
      "ul",
    ];

    function isDisplayed(el: Element) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity) !== 0
        && rect.width > 0
        && rect.height > 0;
    }

    function optionMatches(el: HTMLElement) {
      const text = normalize(el.textContent || "");
      const looseText = normalizeOption(el.textContent || "");
      if (!text) return false;
      return text === expected
        || looseText === looseExpected
        || (text.length >= 4 && expected.length >= 4 && (text.includes(expected) || expected.includes(text)))
        || (looseText.length >= 4 && looseExpected.length >= 4 && (looseText.includes(looseExpected) || looseExpected.includes(looseText)));
    }

    function clickOption(el: HTMLElement) {
      const scrollParent = nearestScrollable(el);
      if (scrollParent) {
        const parentRect = scrollParent.getBoundingClientRect();
        const itemRect = el.getBoundingClientRect();
        scrollParent.scrollTop += itemRect.top - parentRect.top - parentRect.height / 2 + itemRect.height / 2;
      }
      el.scrollIntoView({ block: "center", inline: "nearest" });
      for (const eventName of ["mouseover", "mousedown", "mouseup", "click"]) {
        el.dispatchEvent(new MouseEvent(eventName, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    }

    function nearestScrollable(el: HTMLElement): HTMLElement | null {
      let current: HTMLElement | null = el.parentElement;
      while (current && current !== document.body) {
        if (current.scrollHeight > current.clientHeight + 4) return current;
        current = current.parentElement;
      }
      return null;
    }

    function getPanels() {
      const panels = panelSelectors
        .flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector)))
        .filter((el, index, arr) => arr.indexOf(el) === index)
        .filter(isDisplayed);
      return panels.length ? panels : [document.body];
    }

    function findInPanel(panel: HTMLElement): HTMLElement | null {
      const candidates = optionSelectors
        .flatMap((selector) => Array.from(panel.querySelectorAll<HTMLElement>(selector)))
        .filter((el, index, arr) => arr.indexOf(el) === index)
        .filter((el) => !el.classList.contains("layui-disabled"))
        .filter((el) => window.getComputedStyle(el).display !== "none" && window.getComputedStyle(el).visibility !== "hidden");

      return candidates.find((el) => normalize(el.textContent || "") === expected)
        || candidates.find(optionMatches)
        || null;
    }

    const panels = getPanels();
    for (const panel of panels) {
      const scrollable = panel.scrollHeight > panel.clientHeight + 4 ? panel : nearestScrollable(panel) || panel;
      const maxScroll = Math.max(0, scrollable.scrollHeight - scrollable.clientHeight);
      const step = Math.max(80, Math.floor((scrollable.clientHeight || 120) * 0.8));
      const startScroll = scrollable.scrollTop;

      for (let scrollTop = 0; scrollTop <= maxScroll + step; scrollTop += step) {
        scrollable.scrollTop = Math.min(scrollTop, maxScroll);
        const option = findInPanel(panel);
        if (option) return clickOption(option);
      }

      scrollable.scrollTop = startScroll;
    }

    const fallback = optionSelectors
      .flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector)))
      .find(optionMatches);
    if (fallback) return clickOption(fallback);

    return false;
  }, value).catch(() => false);
}

async function fillByDom(frame: Frame, field: FieldSelector, value: string): Promise<boolean> {
  try {
    return await frame.evaluate(
      ({ selector, labels, value: rawValue, type }) => {
        var __name = function(fn: Function, _name: string) { return fn as any; };
        const controlSelector = "select, textarea, input, [contenteditable=true]";
        const normalize = (text: string) => text.replace(/[\s*：:（）()\[\]【】]/g, "");
        const expectedLabels = labels.map(normalize).filter(Boolean);
        const value = type === "date" ? normalizeDate(rawValue) : rawValue;

        function normalizeDate(raw: string) {
          const cleaned = String(raw || "").replace(/\s.*$/, "").trim();
          const parts = cleaned.split(/[\/\-.]/);
          if (parts.length < 3) return cleaned;
          const [year, month, day] = parts;
          return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
        }

        function matchesLabel(text: string) {
          const normalizedText = normalize(text || "");
          if (!normalizedText || normalizedText.length > 120) return false;
          // 精确匹配优先
          if (expectedLabels.some((label) => normalizedText.includes(label) || (label.length > 2 && label.includes(normalizedText)))) return true;
          // 关键词匹配：提取2字以上中文词，检查重叠率
          const textWords = extractKeywords(normalizedText);
          if (textWords.length === 0) return false;
          return expectedLabels.some((label) => {
            const labelWords = extractKeywords(label);
            if (labelWords.length === 0) return false;
            const overlap = textWords.filter(w => labelWords.includes(w)).length;
            return overlap >= Math.min(labelWords.length, 2); // 至少匹配2个词或全部
          });
        }

        function extractKeywords(s: string): string[] {
          // 提取中文文本中的关键词：完整匹配 + 2字/3字滑动窗口
          const words: string[] = [];
          const matches = s.match(/[\u4e00-\u9fa5]{2,}/g);
          if (!matches) return words;
          for (const m of matches) {
            words.push(m); // 完整词
            // 2字滑动窗口
            for (let i = 0; i <= m.length - 2; i++) words.push(m.slice(i, i + 2));
            // 3字滑动窗口
            for (let i = 0; i <= m.length - 3; i++) words.push(m.slice(i, i + 3));
          }
          return [...new Set(words)];
        }

        function dispatch(el: Element) {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        }

        function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, nextValue: string) {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, nextValue);
          else el.value = nextValue;
          dispatch(el);
          return true;
        }

        function renderFormWidgets() {
          try { (window as any).layui?.form?.render?.(); } catch {}
          try { (window as any).layui?.form?.render?.("select"); } catch {}
          try { (window as any).$?.(document).trigger?.("change"); } catch {}
        }

        function chooseSelect(select: HTMLSelectElement, nextValue: string) {
          const normalizedValue = normalize(nextValue);
          const options = Array.from(select.options);
          const option = options.find((opt) => opt.value === nextValue || opt.text === nextValue)
            || options.find((opt) => {
              const text = normalize(opt.text);
              return !!text && (text.includes(normalizedValue) || normalizedValue.includes(text));
            });
          if (!option) return false;
          select.value = option.value;
          dispatch(select);
          renderFormWidgets();
          return true;
        }

        function setControl(target: Element | null): boolean {
          if (!target) return false;
          let el = target as HTMLElement;

          if (!el.matches(controlSelector)) {
            const nested = el.querySelector<HTMLElement>(controlSelector);
            if (!nested) return false;
            el = nested;
          }

          if (el instanceof HTMLSelectElement) return chooseSelect(el, value);

          if (el instanceof HTMLTextAreaElement) return setNativeValue(el, value);

          if (el instanceof HTMLInputElement) {
            if (el.type === "radio") {
              const group = el.name
                ? Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`))
                : [el];
              const normalizedValue = normalize(value);
              const matched = group.find((radio) => normalize(radio.value) === normalizedValue)
                || group.find((radio) => normalize(radio.parentElement?.textContent || "").includes(normalizedValue));
              const radio = matched || el;
              radio.checked = true;
              dispatch(radio);
              return true;
            }
            return setNativeValue(el, value);
          }

          if (el.isContentEditable) {
            el.textContent = value;
            dispatch(el);
            return true;
          }

          return false;
        }

        function querySelectorAllSafe(css: string) {
          try {
            return Array.from(document.querySelectorAll<Element>(css));
          } catch {
            return [];
          }
        }

        const labelElements = Array.from(document.querySelectorAll<HTMLElement>("label, span, div, td, th, p"))
          .filter((el) => matchesLabel(el.textContent || ""));

        for (const label of labelElements) {
          const forId = label.getAttribute("for");
          if (forId && setControl(document.getElementById(forId))) return true;

          const roots = [
            label.closest(".layui-form-item, .el-form-item, .ant-form-item, .form-group, .row, tr, li, p, div"),
            label.parentElement,
            label.parentElement?.parentElement,
            label.nextElementSibling,
          ].filter(Boolean) as Element[];

          for (const root of roots) {
            if (setControl(root.querySelector(controlSelector))) return true;
          }
        }

        for (const target of querySelectorAllSafe(selector)) {
          if (setControl(target)) return true;
        }

        return false;
      },
      {
        selector: field.selector,
        labels: getFieldLabels(field),
        value,
        type: field.type,
      }
    );
  } catch {
    return false;
  }
}

async function fillByVisualLabel(frame: Frame, field: FieldSelector, value: string): Promise<boolean> {
  try {
    return await frame.evaluate(
      ({ labels, value: rawValue, type }) => {
        var __name = function(fn: Function, _name: string) { return fn as any; };
        const controlSelector = "select, textarea, input, [contenteditable=true]";
        const normalize = (text: string) => text.replace(/[\s*：:（）()\[\]【】]/g, "");
        const expectedLabels = labels.map(normalize).filter(Boolean);
        const value = type === "date" ? normalizeDate(rawValue) : rawValue;

        function normalizeDate(raw: string) {
          const cleaned = String(raw || "").replace(/\s.*$/, "").trim();
          const parts = cleaned.split(/[\/\-.]/);
          if (parts.length < 3) return cleaned;
          const [year, month, day] = parts;
          return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
        }

        function isVisible(el: Element) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && Number(style.opacity) !== 0
            && rect.width > 0
            && rect.height > 0;
        }

        function matchesLabel(text: string) {
          const normalizedText = normalize(text || "");
          if (!normalizedText || normalizedText.length > 80) return false;
          return expectedLabels.some((label) => normalizedText.includes(label) || label.includes(normalizedText));
        }

        function dispatch(el: Element) {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        }

        function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, nextValue: string) {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, nextValue);
          else el.value = nextValue;
          dispatch(el);
          return true;
        }

        function chooseSelect(select: HTMLSelectElement, nextValue: string) {
          const normalizedValue = normalize(nextValue);
          const options = Array.from(select.options);
          const option = options.find((opt) => opt.value === nextValue || opt.text === nextValue)
            || options.find((opt) => {
              const text = normalize(opt.text);
              return !!text && (text.includes(normalizedValue) || normalizedValue.includes(text));
            });
          if (!option) return false;
          select.value = option.value;
          dispatch(select);
          try { (window as any).layui?.form?.render?.("select"); } catch {}
          return true;
        }

        function setControl(el: HTMLElement) {
          if (el instanceof HTMLSelectElement) return chooseSelect(el, value);
          if (el instanceof HTMLTextAreaElement) return setNativeValue(el, value);
          if (el instanceof HTMLInputElement) {
            if (el.type === "radio") {
              const normalizedValue = normalize(value);
              const group = el.name
                ? Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`))
                : [el];
              const matched = group.find((radio) => normalize(radio.value) === normalizedValue)
                || group.find((radio) => normalize(radio.parentElement?.textContent || "").includes(normalizedValue));
              const radio = matched || el;
              radio.checked = true;
              dispatch(radio);
              return true;
            }
            return setNativeValue(el, value);
          }
          if (el.isContentEditable) {
            el.textContent = value;
            dispatch(el);
            return true;
          }
          return false;
        }

        const labelElements = Array.from(document.querySelectorAll<HTMLElement>("label, span, div, td, th, p"))
          .filter((el) => isVisible(el) && matchesLabel(el.textContent || ""));
        const controls = Array.from(document.querySelectorAll<HTMLElement>(controlSelector))
          .filter((el) => isVisible(el) || el instanceof HTMLSelectElement);

        for (const label of labelElements) {
          const labelRect = label.getBoundingClientRect();
          const candidates = controls
            .map((control) => {
              const rect = control.getBoundingClientRect();
              const sameRow = rect.top < labelRect.bottom + 30 && rect.bottom > labelRect.top - 30;
              const below = rect.top >= labelRect.top && rect.top - labelRect.bottom < 220;
              const toRight = rect.left >= labelRect.left - 10;
              if (!toRight || (!sameRow && !below)) return null;
              const dx = Math.max(0, rect.left - labelRect.right);
              const dy = Math.abs(rect.top - labelRect.top);
              const tagPenalty = type === "textarea" && !(control instanceof HTMLTextAreaElement) ? 10000 : 0;
              const selectPenalty = type === "select" && !(control instanceof HTMLSelectElement) && !(control instanceof HTMLInputElement) ? 10000 : 0;
              return { control, score: dx + dy * 4 + tagPenalty + selectPenalty };
            })
            .filter(Boolean)
            .sort((a, b) => a!.score - b!.score) as Array<{ control: HTMLElement; score: number }>;

          for (const candidate of candidates.slice(0, 4)) {
            if (setControl(candidate.control)) return true;
          }
        }

        return false;
      },
      { labels: getFieldLabels(field), value, type: field.type }
    );
  } catch {
    return false;
  }
}

async function selectCustomByExactVisualLabel(frame: Frame, field: FieldSelector, value: string): Promise<boolean> {
  let handle;

  try {
    handle = await frame.evaluateHandle(({ labels }) => {
      var __name = function(fn: Function, _name: string) { return fn as any; };
      const normalize = (text: string) => text.replace(/[\s*：:（）()\[\]【】]/g, "");
      const expectedLabels = labels.map(normalize).filter(Boolean);
      const controlSelector = ".layui-form-select, .el-select, .ant-select, .ivu-select, [role=combobox], input[readonly]";

      function isVisible(el: Element) {
        if (el instanceof HTMLSelectElement) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) !== 0
          && rect.width > 0
          && rect.height > 0;
      }

      function isExactLabel(el: HTMLElement) {
        const normalizedText = normalize(el.textContent || "");
        if (!normalizedText || normalizedText.length > 30) return false;
        return expectedLabels.includes(normalizedText);
      }

      function widgetForSelect(select: HTMLSelectElement): HTMLElement | null {
        const next = select.nextElementSibling;
        if (next instanceof HTMLElement && next.matches(controlSelector) && isVisible(next)) return next;
        const parent = select.parentElement;
        const widget = parent?.querySelector<HTMLElement>(controlSelector);
        return widget && isVisible(widget) ? widget : null;
      }

      const labelElements = Array.from(document.querySelectorAll<HTMLElement>(
        ".layui-form-label, label, .el-form-item__label, .ant-form-item-label, td, th, span"
      ))
        .filter((el) => isVisible(el) && isExactLabel(el))
        .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);

      for (const label of labelElements) {
        const scope = label.closest(".layui-form-item, .el-form-item, .ant-form-item, .form-group, .row, tr, li")
          || label.parentElement?.parentElement
          || label.parentElement;
        const scopedSelect = scope?.querySelector<HTMLSelectElement>("select");
        const scopedWidget = scopedSelect ? widgetForSelect(scopedSelect) : scope?.querySelector<HTMLElement>(controlSelector);
        if (scopedWidget && isVisible(scopedWidget)) return scopedWidget;

        const labelRect = label.getBoundingClientRect();
        const candidates = Array.from(document.querySelectorAll<HTMLElement>(controlSelector))
          .filter(isVisible)
          .map((control) => {
            const rect = control.getBoundingClientRect();
            const sameRow = rect.top < labelRect.bottom + 24 && rect.bottom > labelRect.top - 24;
            const below = rect.top >= labelRect.top && rect.top - labelRect.bottom < 120;
            const toRight = rect.left >= labelRect.right - 8;
            if (!toRight || (!sameRow && !below)) return null;
            return { control, score: Math.max(0, rect.left - labelRect.right) + Math.abs(rect.top - labelRect.top) * 8 };
          })
          .filter(Boolean)
          .sort((a, b) => a!.score - b!.score) as Array<{ control: HTMLElement; score: number }>;

        if (candidates[0]) return candidates[0].control;
      }

      return null;
    }, { labels: getFieldLabels(field) });

    const element = handle.asElement();
    if (!element) return false;
    return await chooseSelectElement(frame, element, value);
  } catch {
    return false;
  } finally {
    await handle?.dispose?.().catch(() => {});
  }
}

async function selectCustomByLabel(frame: Frame, field: FieldSelector, value: string): Promise<boolean> {
  const labels = getFieldLabels(field);
  let handle;

  try {
    handle = await frame.evaluateHandle(({ labels }) => {
      var __name = function(fn: Function, _name: string) { return fn as any; };
      const normalize = (text: string) => text.replace(/[\s*：:（）()\[\]【】]/g, "");
      const expectedLabels = labels.map(normalize).filter(Boolean);
      const controlSelector = ".layui-form-select, .el-select, .ant-select, .ivu-select, [role=combobox], input[readonly], .select, .dropdown";

      function matchesLabel(text: string) {
        const normalizedText = normalize(text || "");
        if (!normalizedText || normalizedText.length > 120) return false;
        return expectedLabels.some((label) => normalizedText.includes(label) || (label.length > 2 && label.includes(normalizedText)));
      }

      const labelElements = Array.from(document.querySelectorAll<HTMLElement>("label, span, div, td, th, p"))
        .filter((el) => matchesLabel(el.textContent || ""));

      for (const label of labelElements) {
        const roots = [
          label.closest(".layui-form-item, .el-form-item, .ant-form-item, .form-group, .row, tr, li, p, div"),
          label.parentElement,
          label.parentElement?.parentElement,
          label.nextElementSibling,
        ].filter(Boolean) as Element[];

        for (const root of roots) {
          const control = root.querySelector<HTMLElement>(controlSelector);
          if (control) return control;
        }
      }

      return null;
    }, { labels });

    const element = handle.asElement();
    if (!element) return false;
    return await chooseSelectElement(frame, element, value);
  } catch {
    return false;
  } finally {
    await handle?.dispose?.().catch(() => {});
  }

  return false;
}

async function selectCustomByVisualLabel(frame: Frame, field: FieldSelector, value: string): Promise<boolean> {
  let handle;

  try {
    handle = await frame.evaluateHandle(({ labels }) => {
      var __name = function(fn: Function, _name: string) { return fn as any; };
      const normalize = (text: string) => text.replace(/[\s*：:（）()\[\]【】]/g, "");
      const expectedLabels = labels.map(normalize).filter(Boolean);
      const controlSelector = ".layui-form-select, .el-select, .ant-select, .ivu-select, [role=combobox], input[readonly], .select, .dropdown";

      function isVisible(el: Element) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) !== 0
          && rect.width > 0
          && rect.height > 0;
      }

      function matchesLabel(text: string) {
        const normalizedText = normalize(text || "");
        if (!normalizedText || normalizedText.length > 80) return false;
        return expectedLabels.some((label) => normalizedText.includes(label) || label.includes(normalizedText));
      }

      const labelsEls = Array.from(document.querySelectorAll<HTMLElement>("label, span, div, td, th, p"))
        .filter((el) => isVisible(el) && matchesLabel(el.textContent || ""));
      const controls = Array.from(document.querySelectorAll<HTMLElement>(controlSelector)).filter(isVisible);

      for (const label of labelsEls) {
        const labelRect = label.getBoundingClientRect();
        const candidates = controls
          .map((control) => {
            const rect = control.getBoundingClientRect();
            const sameRow = rect.top < labelRect.bottom + 30 && rect.bottom > labelRect.top - 30;
            const below = rect.top >= labelRect.top && rect.top - labelRect.bottom < 220;
            const toRight = rect.left >= labelRect.left - 10;
            if (!toRight || (!sameRow && !below)) return null;
            const dx = Math.max(0, rect.left - labelRect.right);
            const dy = Math.abs(rect.top - labelRect.top);
            return { control, score: dx + dy * 4 };
          })
          .filter(Boolean)
          .sort((a, b) => a!.score - b!.score) as Array<{ control: HTMLElement; score: number }>;

        if (candidates[0]) return candidates[0].control;
      }

      return null;
    }, { labels: getFieldLabels(field) });

    const element = handle.asElement();
    if (!element) return false;
    return await chooseSelectElement(frame, element, value);
  } catch {
    return false;
  } finally {
    await handle?.dispose?.().catch(() => {});
  }

  return false;
}

function getFieldLabels(field: FieldSelector): string[] {
  return Array.from(new Set([field.bitableField, ...(field.labelAliases || [])].filter(Boolean)));
}

async function checkValidationDialog(session: BrowserSession): Promise<boolean> {
  const dialogSelector = ".layui-layer-dialog, .layui-layer-msg, .el-message-box, .ant-modal, .modal, [role=dialog]";
  for (const frame of getCandidateFrames(session)) {
    try {
      const count = await frame.locator(dialogSelector).count();
      if (count > 0) return true;
    } catch {}
  }
  return false;
}

async function dismissValidationDialog(session: BrowserSession): Promise<void> {
  const dialogSelector = ".layui-layer-dialog, .layui-layer-msg, .el-message-box, .ant-modal, .modal, [role=dialog]";

  for (const frame of getCandidateFrames(session)) {
    try {
      const dialogs = frame.locator(dialogSelector).filter({ hasText: /请选择|请填写|请上传|不能为空|必填|错误|失败|重复|已存在/ });
      const count = Math.min(await dialogs.count(), 3);
      for (let i = 0; i < count; i++) {
        const dialog = dialogs.nth(i);
        const text = (await dialog.textContent({ timeout: 500 }).catch(() => "")) || "";
        if (looksLikeMainApplyForm(text)) continue;
        const buttons = [
          dialog.getByRole("button", { name: /确定|关闭|OK/i }),
          dialog.locator("button, a, .layui-layer-btn0, .layui-layer-close").filter({ hasText: /确定|关闭|OK/i }),
          dialog.locator(".layui-layer-close"),
        ];
        for (const button of buttons) {
          if (await clickLocator(button)) {
            await b.wait(300);
            return;
          }
        }
      }
    } catch {}
  }
}

function looksLikeMainApplyForm(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  return compact.includes("作品名称")
    && compact.includes("作品电子文件")
    && (compact.includes("下一步") || compact.includes("上一步") || compact.includes("作品类别"));
}

// ============================================================
// 批量填表
// ============================================================

export async function fillAllRecords(
  session: BrowserSession,
  records: CopyrightRecord[],
  company: CompanyConfig,
  onProgress: ProgressCallback
): Promise<{ success: number; failed: number }> {
  let success = 0, failed = 0;

  for (let i = 0; i < records.length; i++) {
    const ok = await fillOneRecord(session, records[i], company, i, records.length, onProgress);
    if (ok) success++; else failed++;
    await b.wait(1500);
  }

  onProgress({
    phase: "all_done",
    message: `全部完成：成功 ${success}/${records.length}，失败 ${failed}`,
    recordIndex: records.length - 1,
    totalRecords: records.length,
    success, failed,
  });

  return { success, failed };
}

// ============================================================
// 辅助：在主页面和 #sbform iframe 中都尝试点击按钮
// ============================================================

const INTERACTIVE_SELECTOR = "button, a, input[type=button], input[type=submit], .layui-btn, [role=button]";

async function tryClick(session: BrowserSession, text: string): Promise<boolean> {
  if (await clickInteractive(session, text)) return true;

  await b.scrollToBottom(session);
  await b.wait(300);
  if (await clickInteractive(session, text)) return true;

  if (await clickInteractiveByDom(session, text)) return true;

  await b.scrollToBottom(session);
  await b.wait(300);
  return clickInteractiveByDom(session, text);
}

async function clickInteractive(session: BrowserSession, text: string): Promise<boolean> {
  const namePattern = new RegExp(escapeRegExp(text));

  try {
    if (await clickLocator(session.page.getByRole("button", { name: namePattern }))) return true;
    if (await clickLocator(session.page.locator(INTERACTIVE_SELECTOR).filter({ hasText: text }))) return true;
  } catch {}

  try {
    const form = b.getFormFrame(session);
    if (await clickLocator(form.getByRole("button", { name: namePattern }))) return true;
    if (await clickLocator(form.locator(INTERACTIVE_SELECTOR).filter({ hasText: text }))) return true;
  } catch {}

  for (const frame of session.page.frames()) {
    try {
      if (await clickLocator(frame.getByRole("button", { name: namePattern }))) return true;
      if (await clickLocator(frame.locator(INTERACTIVE_SELECTOR).filter({ hasText: text }))) return true;
    } catch {}
  }

  return false;
}

async function clickLocator(locator: Locator): Promise<boolean> {
  let count = 0;
  try {
    count = Math.min(await locator.count(), 8);
  } catch {
    return false;
  }

  for (let i = 0; i < count; i++) {
    const target = locator.nth(i);
    try {
      await target.scrollIntoViewIfNeeded({ timeout: 2000 });
      await target.click({ timeout: 3000 });
      return true;
    } catch {}

    try {
      await target.click({ timeout: 1500, force: true });
      return true;
    } catch {}
  }

  return false;
}

async function clickInteractiveByDom(session: BrowserSession, text: string): Promise<boolean> {
  for (const frame of session.page.frames()) {
    try {
      const clicked = await frame.evaluate(
        ({ selector, targetText }) => {
          var __name = function(fn: Function, _name: string) { return fn as any; };
          const normalize = (value: string) => value.replace(/\s+/g, "");
          const expected = normalize(targetText);
          const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));

          function isVisible(el: HTMLElement) {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== "none"
              && style.visibility !== "hidden"
              && Number(style.opacity) !== 0
              && rect.width > 0
              && rect.height > 0;
          }

          function labelOf(el: HTMLElement) {
            const inputValue = el instanceof HTMLInputElement ? el.value : "";
            return normalize([
              el.textContent || "",
              inputValue,
              el.getAttribute("aria-label") || "",
              el.getAttribute("title") || "",
            ].join(" "));
          }

          for (const el of elements) {
            if (!labelOf(el).includes(expected) || !isVisible(el)) continue;

            el.scrollIntoView({ block: "center", inline: "center" });
            for (let parent = el.parentElement; parent; parent = parent.parentElement) {
              if (parent.scrollHeight <= parent.clientHeight + 8) continue;
              const parentRect = parent.getBoundingClientRect();
              const elRect = el.getBoundingClientRect();
              parent.scrollTop += elRect.top - parentRect.top - parent.clientHeight / 2 + elRect.height / 2;
            }

            el.focus();
            el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
            el.click();
            return true;
          }

          return false;
        },
        { selector: INTERACTIVE_SELECTOR, targetText: text }
      );
      if (clicked) return true;
    } catch {}
  }

  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
