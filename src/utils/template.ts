// ============================================================
// 内容简介 & 创作过程 模板引擎
// ============================================================
// 基于飞书文档「湖北省著作权登记系统操作指南」十一-4 中的模板

import type { TemplateVars, CopyrightRecord, CompanyConfig } from "@/types";

/**
 * 默认内容简介模板（产品说明）
 * 对应 Bitable 中"内容简介"字段的手动填写内容
 */
export const DEFAULT_CONTENT_INTRO_TEMPLATE =
  "申请登记的作品为\u201C{productName}\u201D产品{workType}，缤纷多彩的{workType}丰富产品内容，给用户更好的使用体验。";

/**
 * 默认创作过程模板
 * 对应 Bitable 中"创作过程"公式字段的内容
 * 模板变量：
 *   {companyName}        — 公司全称
 *   {creditCode}         — 统一社会信用代码
 *   {establishmentDate}  — 成立日期
 *   {address}            — 公司地址
 *   {creationMonth}      — 创作开始月份，如 2026年03月
 *   {completionDate}     — 创作完成日期，如 2026年03月03日
 *   {publicationDate}    — 发表日期，如 2026年03月19日
 *   {creationTool}       — 创作工具，默认 Photoshop
 *   {revisionCount}      — 修改次数，默认 1
 *   {revisionDetail}     — 修改细节说明
 */
export const DEFAULT_CREATION_PROCESS_TEMPLATE =
  "1、著作权人{companyName}，统一社会信用代码{creditCode}，成立于{establishmentDate}，公司位于{address}；" +
  "2、为给公司产品增加多样性创作此作品，该作品于{creationMonth}开始构思创作，" +
  "使用电脑{creationTool}进行创作，经过{revisionCount}次修改，修改了{revisionDetail}，" +
  "于{completionDate}创作完成；" +
  "3、该作品于{publicationDate}发表。";

/**
 * 将 YYYY/MM/DD 或 YYYY-MM-DD 格式的日期转为"YYYY年MM月DD日"
 */
export function formatDateToChinese(dateStr: string, format: "full" | "month" = "full"): string {
  if (!dateStr) return "";

  const normalized = normalizeDateParts(dateStr);
  if (!normalized) return dateStr;

  const [year, month, day] = normalized;

  if (format === "month") {
    return `${year}年${month.padStart(2, "0")}月`;
  }

  return `${year}年${month.padStart(2, "0")}月${day.padStart(2, "0")}日`;
}

function normalizeDateParts(dateStr: string): [string, string, string] | null {
  const cleaned = String(dateStr || "").replace(/\s.*$/, "").trim();
  const chinese = cleaned.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?/);
  if (chinese) return [chinese[1], chinese[2], chinese[3]];

  const numeric = cleaned.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (numeric) return [numeric[1], numeric[2], numeric[3]];

  return null;
}

/**
 * 从 CopyrightRecord 提取模板变量
 */
export function extractTemplateVars(
  record: CopyrightRecord,
  company: CompanyConfig
): TemplateVars {
  const creationDate = record.创作完成日期 || "";
  const publicationDate = record.首次发表日期 || "";

  return {
    companyName: company.name,
    creditCode: company.creditCode,
    establishmentDate: company.establishmentDate,
    address: company.address,
    creationMonth: formatDateToChinese(creationDate, "month"),
    creationDate: formatDateToChinese(creationDate, "full"),
    publicationDate: formatDateToChinese(publicationDate, "full"),
    creationTool: company.creationTool || "Photoshop",
    revisionCount: 1,
    revisionDetail: "细节",
    workName: record.作品名称 || "",
    productIntro: record.内容简介 || "",
  };
}

/**
 * 填充模板（替换 {变量名}）
 */
export function fillTemplate(
  template: string,
  vars: TemplateVars
): string {
  const map: Record<string, string | number | undefined> = { ...vars };
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = map[key];
    return value !== undefined ? String(value) : `{${key}}`;
  });
}

/**
 * 生成内容简介（产品说明）
 */
export function generateContentIntro(
  record: CopyrightRecord,
  template?: string
): string {
  const tpl = template || DEFAULT_CONTENT_INTRO_TEMPLATE;
  return tpl
    .replace(/\{productName\}/g, extractProductName(record.作品名称 || ""))
    .replace(/\{workType\}/g, record.类型 || record.作品类别 || "作品");
}

/**
 * 生成创作过程（详细说明）
 */
export function generateCreationProcess(
  record: CopyrightRecord,
  company: CompanyConfig,
  template?: string
): string {
  const vars = extractTemplateVars(record, company);
  const tpl = template || DEFAULT_CREATION_PROCESS_TEMPLATE;
  return fillTemplate(tpl, vars);
}

/**
 * 从作品名称中提取产品名称
 * 例如 "会玩礼物-白情糖果盒" → "会玩"
 */
function extractProductName(workName: string): string {
  const match = workName.match(/^([^-\s]+)/);
  return match ? match[1] : workName;
}
