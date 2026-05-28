// ============================================================
// Bitable → ccct.net.cn 字段映射配置
// ============================================================
// 注意：ccct.net.cn 的实际 DOM 选择器需要在实际页面中确认，
// 当前选择器基于常见政府表单模式预设，部署后需验证调整。

import type { FieldSelector, FormStep } from "@/types";

/**
 * ccct.net.cn 表单步骤路由
 * 根据操作指南文档，表单包含以下步骤页面
 */
export const FORM_STEPS: { step: FormStep; label: string; pathPattern: string }[] = [
  { step: "agreement", label: "申请须知", pathPattern: "/web/copreg" },
  { step: "copyright_owner", label: "著作权人信息", pathPattern: "/web/copreg" },
  { step: "work_info", label: "作品基本信息", pathPattern: "/web/copreg" },
  { step: "upload", label: "上传作品", pathPattern: "/web/copreg" },
  { step: "rights_info", label: "权利状况说明", pathPattern: "/web/copreg" },
  { step: "preview", label: "预览", pathPattern: "/web/copreg" },
];

/**
 * Bitable 字段 → ccct.net.cn 表单字段选择器映射
 *
 * 选择器策略（按优先级）：
 * 1. label 文本匹配（最稳定）
 * 2. name/id 属性匹配
 * 3. placeholder 匹配
 * 4. CSS class 匹配（最不稳定，政府网站可能变动）
 */
export const FIELD_SELECTORS: FieldSelector[] = [
  // === 步骤3: 上传作品（作品名称 + 作品类别 + 作品电子文件 同页） ===
  {
    bitableField: "作品名称",
    selector: 'input[name="workName"], input[placeholder*="作品名称"], input[placeholder*="名称"], #workName',
    labelAliases: ["作品名称", "作品名称（中文）"],
    type: "text",
    step: "upload",
    required: true,
  },
  {
    bitableField: "作品类别",
    selector: 'select[name="workCategory"], select[id*="category"], [data-field="workCategory"]',
    labelAliases: ["作品类别", "作品类型", "作品分类"],
    type: "select",
    step: "upload",
    required: true,
    valueMap: {
      美术: "美术",
      美术作品: "美术",
      类似摄制电影方法创作的作品: "类似摄制电影方法创作的作品",
      文字: "文字",
      文字作品: "文字",
      音乐: "音乐",
      音乐作品: "音乐",
      录音制品: "录音制品",
      录像制品: "录像制品",
      摄影: "摄影",
      摄影作品: "摄影",
      电影: "电影",
      电影作品: "电影",
      建筑: "建筑",
      建筑作品: "建筑",
      模型: "模型",
      模型作品: "模型",
      其他作品: "其他",
    },
  },
  {
    bitableField: "创作完成日期",
    selector: 'input[name="finishDate"], input[placeholder*="YYYY-MM-DD"], input[placeholder*="创作"], input[id*="finishDate"], input[type="date"][name*="finish"]',
    labelAliases: ["创作/制作完成日期", "创作完成日期", "制作完成日期"],
    type: "date",
    step: "work_info",
    required: true,
  },
  {
    bitableField: "作品创作性质",
    selector: 'select[name="creationNature"], select[id*="nature"], select[name*="create"], select[name*="nature"]',
    labelAliases: ["作品创作性质", "创作性质"],
    type: "select",
    step: "work_info",
    required: true,
    valueMap: {
      原创: "原创",
      改编: "改编",
      翻译: "翻译",
      汇编: "汇编",
      注释: "注释",
      整理: "整理",
      其他: "其他",
    },
  },
  {
    bitableField: "创作完成地点",
    selector: 'input[type="radio"][name*="finish"], input[type="radio"][name*="create"], input[type="radio"]',
    labelAliases: ["创作完成地点", "创作/制作完成地点"],
    type: "radio",
    step: "work_info",
  },
  {
    bitableField: "省创作",
    selector: 'select[name*="province"], select[id*="province"]',
    labelAliases: ["省（创作）", "创作省份", "创作所在省"],
    type: "select",
    step: "work_info",
  },
  {
    bitableField: "市创作",
    selector: 'select[name*="city"], select[id*="city"]',
    labelAliases: ["市（创作）", "创作城市", "创作所在市"],
    type: "select",
    step: "work_info",
  },
  {
    bitableField: "发表状态",
    selector: 'input[type="radio"][name*="publish"], input[type="radio"]',
    labelAliases: ["发表状态", "是否发表"],
    type: "radio",
    step: "work_info",
  },
  {
    bitableField: "首次发表日期",
    selector: 'input#publish_time, input[name="publishDate"], input[placeholder*="YYYY-MM-DD"], input[placeholder*="发表"], input[type="date"][name*="publish"]',
    labelAliases: ["首次发表日期", "发表日期", "首次发表", "发表时间", "首次发表时间"],
    type: "date",
    step: "work_info",
  },
  {
    bitableField: "首次发表地点",
    selector: 'input[type="radio"][name*="publish"], input[type="radio"]',
    labelAliases: ["首次发表地点", "发表地点"],
    type: "radio",
    step: "work_info",
  },
  {
    bitableField: "省发表",
    selector: 'select[name*="publishProvince"], select[name*="province"], select[id*="province"]',
    labelAliases: ["省（发表）", "发表省份", "发表所在省"],
    type: "select",
    step: "work_info",
  },
  {
    bitableField: "市发表",
    selector: 'select[name*="publishCity"], select[name*="city"], select[id*="city"]',
    labelAliases: ["市（发表）", "发表城市", "发表所在市"],
    type: "select",
    step: "work_info",
  },
  {
    bitableField: "内容简介",
    selector: 'textarea[name="contentIntro"], textarea[id*="contentIntro"], textarea[placeholder*="内容简介"]',
    labelAliases: ["内容简介", "中心内容及作品特点", "中心内容", "作品特点"],
    type: "textarea",
    step: "work_info",
    required: true,
  },
  {
    bitableField: "创作过程",
    selector: 'textarea[name="creationProcess"], textarea[id*="creationProcess"], textarea[placeholder*="创作过程"], textarea[placeholder*="创作"]',
    labelAliases: ["创作过程", "作品创作过程", "创作说明"],
    type: "textarea",
    step: "work_info",
    required: true,
  },

  // === 步骤5: 权利状况说明 ===
  {
    bitableField: "权利取得方式",
    selector: 'select[name="rightAcquisition"], select[id*="acquisition"]',
    labelAliases: ["权利取得方式"],
    type: "select",
    step: "rights_info",
    required: true,
    valueMap: {
      原始: "原始",
      继承: "继承",
      承受: "承受",
      其他: "其他",
    },
  },
  {
    bitableField: "权利归属方式",
    selector: 'select[name="rightOwnership"], select[id*="ownership"]',
    labelAliases: ["权利归属方式"],
    type: "select",
    step: "rights_info",
    required: true,
    valueMap: {
      法人作品: "法人作品",
      个人作品: "个人作品",
      合作作品: "合作作品",
      职务作品: "职务作品",
      委托作品: "委托作品",
    },
  },
  {
    bitableField: "权利拥有状况",
    selector: 'input[type="radio"][name*="right"], input[type="radio"][name*="status"], input[type="radio"], input[type="checkbox"]',
    labelAliases: ["权利拥有状况", "权利拥有状况及其说明", "权利拥有状况说明"],
    type: "radio",
    step: "rights_info",
    required: true,
    valueMap: {
      全部: "全部",
      部分: "部分",
      其他: "其他",
    },
  },
  {
    bitableField: "作者名称",
    selector: 'input[name="authorName"], input[name*="author"], input[placeholder*="作者"], input[id*="author"], input[name*="Author"]',
    labelAliases: ["作者名称", "作者", "作者姓名"],
    type: "text",
    step: "rights_info",
    required: true,
  },
  {
    bitableField: "署名",
    selector: 'select[name="signature"], select[id*="sign"]',
    labelAliases: ["署名", "署名方式"],
    type: "select",
    step: "rights_info",
  },
  {
    bitableField: "署名名称",
    selector: 'input[name*="signName"], input[name*="sign"], input[placeholder*="署名"], input:not([type])[name*="sign"]',
    labelAliases: ["署名名称", "署名姓名"],
    type: "text",
    step: "rights_info",
  },

  // === 步骤2: 著作权人信息 ===
  // 著作权人信息通常由登录信息自动填充，此处作为备选
];

/**
 * 获取某步骤的所有字段选择器
 */
export function getSelectorsForStep(step: FormStep): FieldSelector[] {
  return FIELD_SELECTORS.filter((s) => s.step === step);
}
