// ============================================================
// 飞书多维表格数据访问层（通过 lark-cli）
// ============================================================
// 不再依赖 App ID/Secret，使用 lark-cli 当前登录用户的身份操作。

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ============================================================
// 运行时配置
// ============================================================

interface RuntimeConfig {
  baseToken: string;
  tableId: string;
  port: number;
}

let _config: RuntimeConfig = {
  baseToken: "",
  tableId: "",
  port: 3456,
};

// 启动时从 .env 读取默认值
function loadEnvDefaults(): void {
  try {
    const envPath = join(process.cwd(), ".env");
    const envContent = readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx);
      const value = trimmed.slice(eqIdx + 1);
      if (key === "BITABLE_BASE_TOKEN" && value) _config.baseToken = value;
      if (key === "BITABLE_TABLE_ID" && value) _config.tableId = value;
      if (key === "BOT_PORT" && value) _config.port = parseInt(value) || 3456;
    }
  } catch {
    // .env 不存在时使用环境变量
    _config.baseToken = process.env.BITABLE_BASE_TOKEN || "";
    _config.tableId = process.env.BITABLE_TABLE_ID || "";
    _config.port = parseInt(process.env.BOT_PORT || "3456");
  }
}

loadEnvDefaults();

/** 运行时覆盖 baseToken / tableId（由 /api/config 调用） */
export function setRuntimeConfig(overrides: {
  baseToken?: string;
  tableId?: string;
}): void {
  if (overrides.baseToken) _config.baseToken = overrides.baseToken;
  if (overrides.tableId) _config.tableId = overrides.tableId;
}

// ============================================================
// lark-cli 执行器
// ============================================================

async function runLarkCli(args: string[], timeoutMs = 60_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync("lark-cli", args, {
      timeout: timeoutMs,
    });
    return stdout;
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    const details = [e.message, e.stderr, e.stdout]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 500);
    throw new Error(`lark-cli 执行失败: ${details}`);
  }
}

function parseLarkCliJson(stdout: string): any {
  const json = JSON.parse(stdout);
  if (json.ok === false) {
    const errMsg = json.error?.message || json.error?.hint || "未知错误";
    throw new Error(`lark-cli 返回错误: ${errMsg}`);
  }
  return json;
}

// ============================================================
// Bitable 数据读取
// ============================================================

interface RawRecordEntry {
  recordId: string;
  fields: Record<string, unknown>;
  fieldNames: string[];
}

let rawRecordsCache: RawRecordEntry[] = [];

/** 从多维表格读取著作权登记记录 */
export async function fetchRecords(): Promise<{
  records: Array<Record<string, string>>;
  total: number;
}> {
  if (!_config.baseToken || !_config.tableId) {
    throw new Error("未配置 baseToken 或 tableId，请先调用 /api/config 设置");
  }

  // 先获取字段列表（用于字段名映射）
  const fieldNames = await getFieldNames();

  // 分页读取所有记录
  const allItems: Array<Record<string, string>> = [];
  rawRecordsCache = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const stdout = await runLarkCli([
      "base",
      "+record-list",
      "--base-token",
      _config.baseToken,
      "--table-id",
      _config.tableId,
      "--offset",
      String(offset),
      "--limit",
      String(limit),
      "--format",
      "json",
      "--as",
      "user",
    ]);

    const result = parseLarkCliJson(stdout);
    const data = result.data;
    if (!data) break;

    // lark-cli +record-list --format json 返回格式：
    // data.fields = 字段名数组
    // data.field_id_list = 字段ID数组
    // data.record_id_list = record ID 数组
    // data.data = 二维数组（每行是字段值数组，按 fields 顺序）
    // data.has_more = boolean
    const rows: any[] = data.data || [];
    const columns: string[] = data.fields || fieldNames;
    const recordIds: string[] = data.record_id_list || [];

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      const recordId = recordIds[rowIdx] || "";
      const record: Record<string, string> = {};
      const rawFields: Record<string, unknown> = {};

      if (Array.isArray(row)) {
        for (let i = 0; i < columns.length && i < row.length; i++) {
          const fieldName = columns[i];
          rawFields[fieldName] = row[i];
          record[fieldName] = formatFieldValue(row[i]);
        }
      } else if (row && typeof row === "object") {
        const fields = row.fields || row;
        for (const [key, value] of Object.entries(fields)) {
          rawFields[key] = value;
          record[key] = formatFieldValue(value);
        }
      }

      // 标准化字段名
      normalizeRecordFieldNames(record);

      // 只取有作品名称、且尚未写入提交日期的待录入记录
      if (
        record["作品名称"] &&
        record["作品名称"].length > 0 &&
        !hasCellValue(record["作品登记提交日期"])
      ) {
        allItems.push(record);
        rawRecordsCache.push({
          recordId,
          fields: rawFields,
          fieldNames: columns,
        });
      }
    }

    // 检查是否还有更多
    offset += rows.length;
    if (!rows.length || !data.has_more) break;
  }

  return { records: allItems, total: allItems.length };
}

/** 获取表格字段名列表 */
async function getFieldNames(): Promise<string[]> {
  try {
    const stdout = await runLarkCli([
      "base",
      "+field-list",
      "--base-token",
      _config.baseToken,
      "--table-id",
      _config.tableId,
      "--as",
      "user",
    ]);
    const result = parseLarkCliJson(stdout);
    const items = result.data?.items || [];
    return items
      .map((item: any) => item.name || item.field_name || "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ============================================================
// 回写提交日期
// ============================================================

/** 成功暂存后写回「作品登记提交日期」 */
export async function markRecordSubmitDate(
  recordIndex: number,
  date = new Date(),
): Promise<string> {
  const raw = rawRecordsCache[recordIndex];
  if (!raw) {
    throw new Error(`未找到第 ${recordIndex + 1} 条记录的飞书 record_id`);
  }
  if (!raw.recordId) {
    throw new Error(`第 ${recordIndex + 1} 条记录缺少 record_id，无法回写`);
  }

  const submitDate = formatShanghaiDateTime(date);
  const payload = JSON.stringify({ 作品登记提交日期: submitDate });

  await runLarkCli([
    "base",
    "+record-upsert",
    "--base-token",
    _config.baseToken,
    "--table-id",
    _config.tableId,
    "--record-id",
    raw.recordId,
    "--json",
    payload,
    "--as",
    "user",
  ]);

  return submitDate;
}

// ============================================================
// 附件缓存与下载
// ============================================================

export interface FeishuAttachment {
  file_token: string;
  name: string;
  size: number;
  type: string;
}

/** 获取指定记录索引的附件列表（作品电子文件字段） */
export function getRecordAttachments(recordIndex: number): FeishuAttachment[] {
  const raw = rawRecordsCache[recordIndex];
  if (!raw) return [];

  const rawValue = findAttachmentField(raw.fields, [
    "作品电子文件",
    "电子文件",
    "作品文件",
  ]);
  if (!Array.isArray(rawValue)) return [];

  return rawValue
    .filter((item: any) => item && item.file_token)
    .map((item: any) => ({
      file_token: item.file_token,
      name: item.name || "unknown",
      size: item.size || 0,
      type: item.type || "",
    }));
}

/** 获取指定记录索引的"权利归属证明材料"附件列表 */
export function getRightsProofAttachments(
  recordIndex: number,
): FeishuAttachment[] {
  const raw = rawRecordsCache[recordIndex];
  if (!raw) return [];

  const rawValue = findAttachmentField(raw.fields, [
    "权利归属证明材料",
    "权利归属证明",
    "归属证明材料",
    "归属证明",
  ]);
  if (!Array.isArray(rawValue)) return [];

  return rawValue
    .filter((item: any) => item && item.file_token)
    .map((item: any) => ({
      file_token: item.file_token,
      name: item.name || "unknown",
      size: item.size || 0,
      type: item.type || "",
    }));
}

/**
 * 从记录字段中按名称模糊匹配查找附件字段值
 */
function findAttachmentField(
  fields: Record<string, unknown>,
  names: string[],
): unknown {
  // 1. 精确匹配字段名
  for (const name of names) {
    if (fields[name] !== undefined) return fields[name];
  }
  // 2. 包含匹配
  for (const key of Object.keys(fields)) {
    for (const name of names) {
      if (key.includes(name) || name.includes(key)) {
        const val = fields[key];
        if (Array.isArray(val) && val.length > 0 && val[0]?.file_token)
          return val;
      }
    }
  }
  return undefined;
}

/** 从飞书下载附件到本地（通过 lark-cli api） */
export async function downloadFeishuAttachment(
  fileToken: string,
  destPath: string,
): Promise<void> {
  // 确保目标目录存在
  const dir = dirname(destPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // lark-cli api 要求输出路径为相对路径，且相对于 cwd
  // 所以我们 cd 到目标目录，用文件名作为输出
  const fileName = destPath.split("/").pop() || "download";

  try {
    await execFileAsync(
      "lark-cli",
      [
        "api",
        "GET",
        `/open-apis/drive/v1/medias/${encodeURIComponent(fileToken)}/download`,
        "--as",
        "user",
        "-o",
        fileName,
      ],
      { cwd: dir, timeout: 120_000 },
    );
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    const details = [e.message, e.stderr, e.stdout]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 300);
    throw new Error(`下载附件失败: ${details}`);
  }

  if (!existsSync(destPath)) {
    throw new Error(`下载附件失败: 文件未生成 ${destPath}`);
  }
}

// ============================================================
// 字段值格式化
// ============================================================

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";

  // 日期字符串：lark-cli 返回 "2026-05-27 00:00:00" 格式，转为 YYYY/MM/DD
  if (typeof value === "string") {
    const dateMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})\s/);
    if (dateMatch) return `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}`;
    return value.trim();
  }

  // 日期：毫秒时间戳 → yyyy/MM/dd
  if (typeof value === "number" && value > 1000000000000) {
    const d = new Date(value);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}/${m}/${day}`;
  }

  // 数组：拼接（lark-cli 对 select 字段返回 ["value"]）
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item === "object" && item !== null) {
          // 附件对象不转为文本
          if ("file_token" in (item as Record<string, unknown>)) return "";
          if ("text" in (item as Record<string, unknown>))
            return (item as { text: string }).text;
          if ("name" in (item as Record<string, unknown>))
            return (item as { name: string }).name;
        }
        return String(item);
      })
      .filter(Boolean)
      .join(",");
  }

  // 对象
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["text", "name", "value"]) {
      const next = obj[key];
      if (typeof next === "string" && next.trim()) return next.trim();
      if (typeof next === "number") return String(next);
    }
    return "";
  }

  return String(value).trim();
}

// ============================================================
// 字段名标准化
// ============================================================

const STANDARD_FIELD_ALIASES: Array<{ standard: string; aliases: string[] }> = [
  { standard: "作品名称", aliases: ["作品名称", "作品名"] },
  { standard: "作品类别", aliases: ["作品类别", "作品类型", "作品分类"] },
  {
    standard: "创作/制作完成日期",
    aliases: ["创作/制作完成日期", "创作完成日期", "制作完成日期", "创作日期"],
  },
  {
    standard: "首次发表日期",
    aliases: ["首次发表日期", "发表日期", "首次发表时间"],
  },
  { standard: "发表状态", aliases: ["发表状态", "是否发表"] },
  {
    standard: "作者名称",
    aliases: ["作者名称", "作者", "作者姓名", "著作权人"],
  },
  {
    standard: "权利归属方式",
    aliases: ["权利归属方式", "归属方式", "权利归属"],
  },
  {
    standard: "权利取得方式",
    aliases: ["权利取得方式", "取得方式", "权利取得"],
  },
  {
    standard: "权利拥有状况及其说明",
    aliases: ["权利拥有状况及其说明", "权利拥有状况", "权利状况", "拥有状况"],
  },
  { standard: "署名", aliases: ["署名", "署名方式"] },
  {
    standard: "作品创作性质",
    aliases: ["作品创作性质", "创作性质", "作品性质"],
  },
  {
    standard: "内容简介",
    aliases: ["内容简介", "作品简介", "简介", "作品说明"],
  },
  { standard: "创作过程", aliases: ["创作过程", "创作说明", "创作经过"] },
  {
    standard: "创作完成地点",
    aliases: ["创作完成地点", "创作地点", "完成地点"],
  },
  { standard: "首次发表地点", aliases: ["首次发表地点", "发表地点"] },
  { standard: "类型", aliases: ["类型", "作品用途", "产品类型"] },
  {
    standard: "省（创作）",
    aliases: ["省（创作）", "省(创作)", "创作省份", "省创作"],
  },
  {
    standard: "市（创作）",
    aliases: ["市（创作）", "市(创作)", "创作城市", "市创作"],
  },
  {
    standard: "省（发表）",
    aliases: ["省（发表）", "省(发表)", "发表省份", "省发表"],
  },
  {
    standard: "市（发表）",
    aliases: ["市（发表）", "市(发表)", "发表城市", "市发表"],
  },
  {
    standard: "是否登记为系列作品",
    aliases: ["是否登记为系列作品", "是否系列作品", "系列作品"],
  },
  { standard: "系列作品名称", aliases: ["系列作品名称", "系列名称"] },
  { standard: "作品月份", aliases: ["作品月份", "月份"] },
  { standard: "登记证书号", aliases: ["登记证书号", "证书号", "证书编号"] },
  {
    standard: "作品登记提交日期",
    aliases: ["作品登记提交日期", "提交日期", "登记提交日期"],
  },
  {
    standard: "作品登记通过日期",
    aliases: ["作品登记通过日期", "通过日期", "登记通过日期"],
  },
  { standard: "其他证明材料", aliases: ["其他证明材料", "其他材料"] },
];

function normalizeRecordFieldNames(record: Record<string, string>): void {
  const actualKeys = Object.keys(record);

  for (const { standard, aliases } of STANDARD_FIELD_ALIASES) {
    if (record[standard]) continue;

    let bestMatch: string | null = null;
    let bestScore = 0;

    for (const actualKey of actualKeys) {
      if (!record[actualKey]) continue;
      const score = fieldMatchScore(actualKey, aliases);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = actualKey;
      }
    }

    if (bestMatch && bestScore > 0) {
      record[standard] = record[bestMatch];
    }
  }

  // 反向：确保别名也能取到值
  for (const { standard, aliases } of STANDARD_FIELD_ALIASES) {
    if (!record[standard]) continue;
    for (const alias of aliases) {
      if (!record[alias]) {
        record[alias] = record[standard];
      }
    }
  }
}

function fieldMatchScore(actualKey: string, aliases: string[]): number {
  const normalizedActual = actualKey.replace(/[\s]/g, "").toLowerCase();

  for (const alias of aliases) {
    const normalizedAlias = alias.replace(/[\s]/g, "").toLowerCase();

    if (normalizedActual === normalizedAlias) return 100;
    if (normalizedActual.includes(normalizedAlias)) return 80;
    if (normalizedAlias.includes(normalizedActual)) return 70;

    const strippedActual = actualKey.replace(/[（）()\/\s\-_]/g, "");
    const strippedAlias = alias.replace(/[（）()\/\s\-_]/g, "");
    if (strippedActual === strippedAlias) return 90;
    if (strippedActual.includes(strippedAlias)) return 60;
    if (strippedAlias.includes(strippedActual)) return 50;
  }

  return 0;
}

// ============================================================
// 工具函数
// ============================================================

function hasCellValue(value: string | undefined): boolean {
  return !!value && value.trim() !== "";
}

function formatShanghaiDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} 00:00:00`;
}
