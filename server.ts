// 本地版著作权登记填表服务
// 打开 http://localhost:3456/console 即可使用
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CopyrightRecord, CompanyConfig } from "./src/types/index.js";
import {
  fetchRecords,
  markRecordSubmitDate,
  setRuntimeConfig,
} from "./feishu-bot.js";
import {
  loginToCcct,
  openFreshApplicationPage,
  fillOneRecord,
  fillMappedField,
  type FillProgress,
} from "./filler.js";
import type { FieldSelector } from "./src/types/index.js";
import {
  createBrowserSession,
  closeSession,
  connectToExistingBrowser,
} from "./browser.js";
import type { BrowserSession } from "./browser.js";

// ============================================================
// SSE 实时进度
// ============================================================

const sseConnections = new Map<string, (data: FillProgress) => void>();
function sendProgress(connId: string, progress: FillProgress) {
  const send = sseConnections.get(connId);
  if (send) {
    try {
      send(progress);
    } catch {
      sseConnections.delete(connId);
    }
  }
}

// ============================================================
// 内存缓存拉取到的记录
// ============================================================

let cachedRecords: Record<string, string>[] = [];

// 公司配置（通过 /api/config 动态设置）
let activeCompany: CompanyConfig = {
  name: "",
  creditCode: "",
  establishmentDate: "",
  address: "",
  creationTool: "Photoshop",
};

// ============================================================
// 填表主流程
// ============================================================

let activeBrowser: BrowserSession | null = null;
let filling = false;

type QueuedRecord = { record: Record<string, string>; originalIndex: number };

function buildExecutionQueue(
  records: Record<string, string>[],
  loginSubject: string,
): QueuedRecord[] {
  const subject = normalizeSubjectName(loginSubject);
  if (!subject)
    return records.map((record, originalIndex) => ({ record, originalIndex }));

  return records
    .map((record, originalIndex) => ({ record, originalIndex }))
    .filter(({ record }) =>
      isSameSubject(record["作者名称"] || "", loginSubject),
    );
}

function normalizeSubjectName(value: string): string {
  return String(value || "")
    .replace(/^您好[，,]?\s*/, "")
    .replace(/\s*(个人中心|修改密码|退出).*$/, "")
    .replace(/[.\u2026]+$/g, "")
    .replace(/[\s　,，.。·、:：;；"'“”‘’()（）\[\]【】<>《》-]/g, "")
    .trim();
}

function isSameSubject(authorName: string, loginSubject: string): boolean {
  const author = normalizeSubjectName(authorName);
  const subject = normalizeSubjectName(loginSubject);
  if (!author || !subject) return false;
  if (author === subject) return true;
  if (author.includes(subject) || subject.includes(author)) return true;

  const truncatedSubject = /[.\u2026]{2,}\s*$/.test(loginSubject);
  if (truncatedSubject && subject.length >= 4 && author.startsWith(subject))
    return true;

  return false;
}

async function runFillTask(connId: string) {
  if (filling) {
    sendProgress(connId, { phase: "error", message: "已有填表任务进行中" });
    return;
  }
  filling = true;
  try {
    const records = cachedRecords;
    if (!records.length) {
      sendProgress(connId, { phase: "error", message: "没有待填表记录" });
      return;
    }
    const company = activeCompany;

    // 启动浏览器（headed 模式，本地可见）
    sendProgress(connId, { phase: "login", message: "正在启动浏览器..." });
    activeBrowser = await createBrowserSession("local");

    // 导航到登录页，等待用户手动登录
    const loginSubject = await loginToCcct(activeBrowser, (p) =>
      sendProgress(connId, p),
    );
    const taskRecords = buildExecutionQueue(records, loginSubject);
    if (loginSubject) {
      const skipped = records.length - taskRecords.length;
      sendProgress(connId, {
        phase: "step",
        message:
          skipped > 0
            ? `按当前登录主体「${loginSubject}」筛选：处理 ${taskRecords.length}/${records.length} 条，跳过 ${skipped} 条非当前主体记录`
            : `当前登录主体「${loginSubject}」与待处理记录作者名称均匹配`,
      });
    } else {
      sendProgress(connId, {
        phase: "step",
        message: "未读取到当前登录主体，跳过作者名称过滤",
      });
    }
    if (!taskRecords.length) {
      sendProgress(connId, {
        phase: "all_done",
        message: "没有匹配当前登录主体的待处理记录",
        success: 0,
        failed: 0,
        failedRecords: [],
      });
      return;
    }

    // 逐条填表
    let success = 0,
      failed = 0;
    const failedRecords: Array<{
      index: number;
      workName: string;
      error: string;
    }> = [];
    for (let i = 0; i < taskRecords.length; i++) {
      const { record: currentRecord, originalIndex } = taskRecords[i];
      if (i > 0) {
        try {
          await openFreshApplicationPage(activeBrowser, (p) =>
            sendProgress(connId, p),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendProgress(connId, {
            phase: "error",
            message: `打开下一条申报页失败: ${message}`,
            recordIndex: i,
            totalRecords: taskRecords.length,
          });
          failedRecords.push({
            index: i,
            workName: currentRecord["作品名称"] || `第 ${i + 1} 条`,
            error: `打开下一条申报页失败: ${message}`,
          });
          failed++;
          await sleep(1500);
          continue;
        }
      }

      const r = (k: string, d = "") =>
        (currentRecord as Record<string, string>)[k] || d;
      const rec: CopyrightRecord = {
        作品名称: r("作品名称"),
        作品类别: r("作品类别", "美术") as CopyrightRecord["作品类别"],
        创作完成日期: r("创作/制作完成日期") || r("创作完成日期"),
        首次发表日期: r("首次发表日期") || r("发表日期"),
        发表状态: r("发表状态", "已发表") as CopyrightRecord["发表状态"],
        作者名称: r("作者名称", company.name),
        权利归属方式: r(
          "权利归属方式",
          "法人作品",
        ) as CopyrightRecord["权利归属方式"],
        权利取得方式: r(
          "权利取得方式",
          "原始",
        ) as CopyrightRecord["权利取得方式"],
        权利拥有状况: r(
          "权利拥有状况及其说明",
          "全部",
        ) as CopyrightRecord["权利拥有状况"],
        内容简介: r("内容简介"),
        创作过程: r("创作过程"),
        署名: r("署名", "本名") as CopyrightRecord["署名"],
        作品创作性质: r(
          "作品创作性质",
          "原创",
        ) as CopyrightRecord["作品创作性质"],
        创作完成地点: r(
          "创作完成地点",
          "国内",
        ) as CopyrightRecord["创作完成地点"],
        首次发表地点: r(
          "首次发表地点",
          "国内",
        ) as CopyrightRecord["首次发表地点"],
        省创作: r("省（创作）"),
        市创作: r("市（创作）"),
        省发表: r("省（发表）"),
        市发表: r("市（发表）"),
        是否系列作品: r(
          "是否登记为系列作品",
          "否",
        ) as CopyrightRecord["是否系列作品"],
        系列作品名称: r("系列作品名称"),
        类型: r("类型") as CopyrightRecord["类型"],
        作品月份: r("作品月份"),
        登记证书号: r("登记证书号"),
        作品登记提交日期: r("作品登记提交日期"),
        作品登记通过日期: r("作品登记通过日期"),
      };

      let recordError = "";
      sendProgress(connId, {
        phase: "filling",
        message: `开始处理第 ${i + 1}/${taskRecords.length} 条: ${rec.作品名称}`,
        recordIndex: i,
        totalRecords: taskRecords.length,
      });

      const ok = await fillOneRecord(
        activeBrowser,
        rec,
        company,
        i,
        taskRecords.length,
        (p) => {
          if (p.phase === "error" && p.recordIndex === i && p.message)
            recordError = p.message;
          sendProgress(connId, p);
        },
        originalIndex,
      );

      if (ok) {
        try {
          const submitDate = await markRecordSubmitDate(originalIndex);
          success++;
          sendProgress(connId, {
            phase: "step",
            message: `已写回作品登记提交日期: ${submitDate}`,
            recordIndex: i,
            totalRecords: taskRecords.length,
          });
        } catch (err) {
          failed++;
          const error = `已暂存，但写回提交日期失败: ${err instanceof Error ? err.message : String(err)}`;
          failedRecords.push({ index: i, workName: rec.作品名称, error });
          sendProgress(connId, {
            phase: "error",
            message: `❌ ${rec.作品名称}: ${error}`,
            recordIndex: i,
            totalRecords: taskRecords.length,
          });
        }
      } else {
        failed++;
        const error = recordError || "填表失败，未返回具体错误";
        failedRecords.push({ index: i, workName: rec.作品名称, error });
      }

      await sleep(1500);
    }

    sendProgress(connId, {
      phase: "all_done",
      message: `全部完成：成功 ${success}/${taskRecords.length}，失败 ${failed}`,
      recordIndex: taskRecords.length - 1,
      totalRecords: taskRecords.length,
      success,
      failed,
      failedRecords,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isLoginTimeoutError(message)) {
      await resetActiveBrowser();
      sendProgress(connId, {
        phase: "restart_ready",
        message: "登录超时，已关闭旧浏览器，可重新开始",
        retryable: true,
      });
    } else {
      sendProgress(connId, { phase: "error", message: `异常: ${err}` });
    }
  } finally {
    filling = false;
    // 调试期间不自动关闭浏览器
    // if (activeBrowser) setTimeout(() => { closeSession(activeBrowser!); activeBrowser = null; }, 10000);
  }
}

function isLoginTimeoutError(message: string): boolean {
  return /等待登录超时|登录超时|请重新开始/.test(message);
}

async function resetActiveBrowser(): Promise<void> {
  if (!activeBrowser) return;
  const session = activeBrowser;
  activeBrowser = null;
  await closeSession(session).catch(() => {});
}

// ============================================================
// HTTP 路由
// ============================================================

const app = new Hono();
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("Access-Control-Allow-Origin", "*");
});

// 控制台页面
app.get("/console", (c) =>
  c.html(
    readFileSync(
      join(import.meta.dirname || process.cwd(), "console.html"),
      "utf-8",
    ),
  ),
);
app.get("/", (c) => c.redirect("/console"));

// 动态设置配置（公司名、Bitable 地址）
app.post("/api/config", async (c) => {
  const body = await c.req.json<{
    baseToken?: string;
    tableId?: string;
    company?: string;
  }>();
  if (body.baseToken) setRuntimeConfig({ baseToken: body.baseToken });
  if (body.tableId) setRuntimeConfig({ tableId: body.tableId });
  if (body.company) activeCompany = { ...activeCompany, name: body.company };
  return c.json({
    ok: true,
    company: activeCompany.name,
    baseToken: body.baseToken || "",
    tableId: body.tableId || "",
  });
});

// 拉取多维表格数据
app.get("/api/records", async (c) => {
  try {
    const { records } = await fetchRecords();
    // 如果设置了目标公司，按作者名称筛选
    const filtered = activeCompany.name
      ? records.filter((r) =>
          isSameSubject(r["作者名称"] || "", activeCompany.name),
        )
      : records;
    cachedRecords = filtered;
    return c.json({
      ok: true,
      count: filtered.length,
      totalBeforeFilter: records.length,
      company: activeCompany.name || null,
      records: filtered.map((r) => ({
        name: r["作品名称"],
        type: r["类型"] || "",
        category: r["作品类别"] || "",
      })),
    });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500);
  }
});

// 开始填表
app.post("/api/start", async (c) => {
  if (filling) return c.json({ error: "填表任务进行中" }, 409);
  if (!cachedRecords.length) return c.json({ error: "请先拉取数据" }, 400);
  const connId = "local";
  runFillTask(connId).catch(console.error);
  return c.json({ ok: true });
});

// SSE 进度
app.get("/api/progress", (c) => {
  const connId = "local";
  return streamSSE(c, async (stream) => {
    sseConnections.set(connId, (d) =>
      stream.writeSSE({ data: JSON.stringify(d) }),
    );
    const hb = setInterval(() => {
      try {
        stream.writeSSE({ data: '{"phase":"heartbeat"}' });
      } catch {
        clearInterval(hb);
      }
    }, 15000);
    await new Promise<void>((r) =>
      c.req.raw.signal?.addEventListener("abort", () => {
        clearInterval(hb);
        sseConnections.delete(connId);
        r();
      }),
    );
  });
});

// 停止填表
app.post("/api/stop", async (c) => {
  if (activeBrowser) {
    await closeSession(activeBrowser);
    activeBrowser = null;
  }
  filling = false;
  sendProgress("local", { phase: "error", message: "手动停止" });
  return c.json({ ok: true });
});

// 调试：在当前页面真正尝试填写一个字段（复用 fillMappedField 逻辑）
app.post("/api/debug/fill", async (c) => {
  if (!activeBrowser) activeBrowser = await connectToExistingBrowser("local");
  if (!activeBrowser)
    return c.json({ error: "浏览器未启动，请先通过控制台开始填表" }, 400);
  const { field, value, type } = await c.req.json<{
    field: string;
    value: string;
    type?: string;
  }>();
  if (!field || !value) return c.json({ error: "缺少 field 或 value" }, 400);

  const selector: FieldSelector = {
    bitableField: field,
    selector: "",
    type: (type as FieldSelector["type"]) || "text",
    step: "work_info",
    required: false,
    labelAliases: [],
  };

  // 5 秒超时保护，避免 curl 卡住
  const result = await Promise.race([
    fillMappedField(activeBrowser, selector, value),
    new Promise<boolean>((_, reject) =>
      setTimeout(() => reject(new Error("填写超时（5秒）")), 5000),
    ),
  ]).catch((e) => ({ error: e.message }));

  return c.json({ ok: !!(result === true), field, value, result });
});

// 调试：专项分析字段的 DOM 结构
app.post("/api/debug/analyze", async (c) => {
  if (!activeBrowser) activeBrowser = await connectToExistingBrowser("local");
  if (!activeBrowser) return c.json({ error: "浏览器未启动" }, 400);

  const body = await c.req.json().catch(() => ({}));
  const targetField = (body as any).field || "作品性质";

  // 先在所有 frame 注入 __name polyfill
  for (const f of activeBrowser.page.frames()) {
    try {
      await f.evaluate(() => {
        (window as any).__name = function (fn: any, _n: string) {
          return fn;
        };
      });
    } catch {}
  }

  const normalize = (s: string) => s.replace(/[\s*：:（）()\[\]【】]/g, "");
  const target = normalize(targetField);

  const allFrames = activeBrowser.page.frames();
  const results: string[] = [];

  for (const frame of allFrames) {
    const url = frame.url();
    if (!url || url === "about:blank") continue;

    try {
      const info = await frame.evaluate(
        ({ target: t }: { target: string }) => {
          const lines: string[] = [];
          const labels = document.querySelectorAll(
            "label, .layui-form-label, .el-form-item__label",
          );

          for (var i = 0; i < labels.length; i++) {
            var label = labels[i] as HTMLElement;
            var text = label.textContent || "";
            var normText = text.replace(/[\s*：:（）()\[\]【】]/g, "");
            if (normText.indexOf(t) === -1 && t.indexOf(normText) === -1)
              continue;

            lines.push(
              '\n=== 匹配: "' +
                text.trim() +
                '" (' +
                label.tagName +
                "." +
                (label.className || "").slice(0, 30) +
                ") ===",
            );
            var item = label.closest(
              ".layui-form-item, .el-form-item, .form-group, .row, tr",
            );
            if (item) {
              var controls = item.querySelectorAll(
                "input, select, textarea, .layui-form-select",
              );
              for (var j = 0; j < controls.length; j++) {
                var el = controls[j] as HTMLElement;
                lines.push(
                  "  " +
                    el.tagName +
                    "." +
                    ((el.className || "") as string).slice(0, 60) +
                    ' name="' +
                    (el.getAttribute("name") || "") +
                    '"' +
                    ' id="' +
                    (el.getAttribute("id") || "") +
                    '"' +
                    ' type="' +
                    (el.getAttribute("type") || "") +
                    '"' +
                    " readonly=" +
                    el.hasAttribute("readonly"),
                );
                if (el.tagName === "SELECT") {
                  var sel = el as HTMLSelectElement;
                  var optTexts = [];
                  for (var k = 0; k < sel.options.length; k++) {
                    optTexts.push('"' + sel.options[k].text.trim() + '"');
                  }
                  lines.push("    options: [" + optTexts.join(",") + "]");
                }
                lines.push("    html: " + el.outerHTML.slice(0, 300));
              }
            } else {
              var parent = label.parentElement;
              if (parent) {
                var nearby = parent.querySelector(
                  "input, select, textarea, .layui-form-select",
                );
                if (nearby) {
                  lines.push(
                    "  (label父级中找到) " +
                      nearby.tagName +
                      ' name="' +
                      (nearby.getAttribute("name") || "") +
                      '" type="' +
                      (nearby.getAttribute("type") || "") +
                      '"',
                  );
                } else {
                  lines.push("  (无 .layui-form-item 父容器，父级也无控件)");
                }
              }
            }
          }
          return lines.join("\n") || "(无匹配 label)";
        },
        { target },
      );

      results.push("[Frame: " + url.slice(0, 80) + "]\n" + info);
    } catch (e: any) {
      results.push("[Frame: " + url.slice(0, 80) + "] 错误: " + e.message);
    }
  }

  return c.json({
    ok: true,
    field: targetField,
    results: results.join("\n\n"),
  });
});

// 调试：在 iframe 内诊断 DOM 结构（列出 label+控件+下拉选项）
app.post("/api/debug/inspect", async (c) => {
  if (!activeBrowser) activeBrowser = await connectToExistingBrowser("local");
  if (!activeBrowser)
    return c.json({ error: "浏览器未启动，请先通过控制台开始填表" }, 400);

  const findings: string[] = [];
  const frames = activeBrowser.page.frames();

  for (const frame of frames) {
    const url = frame.url();
    if (!url || url === "about:blank") continue;
    try {
      const info = await Promise.race([
        frame.evaluate(() => {
          const items: string[] = [];
          try {
            (window as any).layui?.form?.render?.();
          } catch {}
          try {
            (window as any).layui?.form?.render?.("select");
          } catch {}

          // 遍历 layui 表单项结构
          const formItems = document.querySelectorAll(
            ".layui-form-item, .el-form-item, .ant-form-item, .form-group, .row",
          );
          items.push(`=== layui-form-item 共 ${formItems.length} 个 ===`);
          for (const item of formItems) {
            const labelEl = item.querySelector(
              ".layui-form-label, label, .el-form-item__label",
            );
            const labelText = (labelEl?.textContent || "")
              .replace(/[\s*：:（）()\[\]【】]/g, "")
              .trim()
              .slice(0, 40);
            if (!labelText) continue;

            // 找对应的控件
            const inputBlock = item.querySelector(
              ".layui-input-block, .el-form-item__content",
            );
            const scope = inputBlock || item;
            const controls = scope.querySelectorAll("input, select, textarea");
            const layuiSelect = scope.querySelector(".layui-form-select");

            const parts: string[] = [`  "${labelText}" →`];
            for (const c of controls) {
              const el = c as HTMLElement;
              const tag = el.tagName.toLowerCase();
              const name = el.getAttribute("name") || "";
              const id = el.getAttribute("id") || "";
              const type = (el as HTMLInputElement).type || "";
              const readonly = el.hasAttribute("readonly") ? " readonly" : "";
              const hidden = el.offsetParent === null ? " hidden" : "";
              const value = (el as HTMLInputElement).value?.slice(0, 30) || "";
              parts.push(
                ` ${tag}[name="${name}" id="${id}"] type=${type}${readonly}${hidden} val="${value}"`,
              );
            }
            if (layuiSelect) parts.push(` +layui-select`);
            if (controls.length === 0 && !layuiSelect) parts.push(` (无控件)`);

            items.push(parts.join(""));
          }

          // 原生 select
          const selects = document.querySelectorAll("select");
          if (selects.length) {
            items.push(`=== 原生 select ${selects.length} 个 ===`);
            for (const s of selects) {
              const el = s as HTMLSelectElement;
              const name = el.getAttribute("name") || "";
              const id = el.getAttribute("id") || "";
              const opts = Array.from(el.options)
                .slice(0, 30)
                .map((o) => o.text.trim())
                .join("|");
              const hidden = el.offsetParent === null ? " hidden" : "";
              items.push(
                `  select[name="${name}" id="${id}"]${hidden} opts:[${opts}]`,
              );
            }
          }

          return items.join("\n");
        }),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("inspect 超时")), 3000),
        ),
      ]);
      findings.push(`\n==== Frame: ${url.slice(0, 100)} ====\n${info}`);
    } catch (e: any) {
      findings.push(`\n==== Frame: ${url.slice(0, 100)} — ${e.message} ====`);
    }
  }

  return c.json({
    ok: true,
    frames: findings.length,
    details: findings.join("\n"),
  });
});

// ============================================================
// 启动
// ============================================================

const port = parseInt(process.env.BOT_PORT || "3456");
// 启动时尝试重连已有浏览器
connectToExistingBrowser("local").then((session) => {
  if (session) {
    activeBrowser = session;
    console.log("🔗 已连接到现有浏览器会话");
  }
});
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`\n🤖 著作权登记填表工具已启动`);
  console.log(`👉 打开控制台: http://localhost:${info.port}/console\n`);
});
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
