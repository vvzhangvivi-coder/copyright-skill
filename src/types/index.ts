// ============================================================
// 著作权登记助手 — 类型定义
// ============================================================

/** 作品来源类型（对应 Bitable 中的"类型"字段） */
export type WorkType =
  | "表情包"
  | "礼物"
  | "语音房背景"
  | "头像框"
  | "语音房主题套装"
  | "戒指"
  | "进场特效"
  | "聊天气泡"
  | "座驾"
  | "梦幻名片"
  | "语音房坐骑"
  | "羁绊卡"
  | "撩一撩"
  | "用户定制称号"
  | "logo及功能玩法icon"
  | "红包皮肤"
  | "皮肤";

/** 作品类别（对应 ccct.net.cn 表单字段） */
export type WorkCategory =
  | "文字"
  | "口述"
  | "音乐"
  | "戏剧"
  | "曲艺"
  | "舞蹈"
  | "杂技"
  | "美术"
  | "建筑"
  | "摄影"
  | "电影"
  | "类似摄制电影方法创作的作品"
  | "工程设计图、产品设计图"
  | "地图、示意图"
  | "模型"
  | "录音制品"
  | "录像制品"
  | "其他";

/** 权利归属方式 */
export type RightOwnership =
  | "法人作品"
  | "个人作品"
  | "合作作品"
  | "职务作品"
  | "委托作品";

/** 权利取得方式 */
export type RightAcquisition = "原始" | "继承" | "承受" | "其他";

/** 权利拥有状况 */
export type RightOwnershipStatus = "全部" | "部分" | "其他";

/** 发表状态 */
export type PublicationStatus = "已发表" | "未发表";

/** 发表地点 */
export type PublicationLocation = "国内" | "海外";

/** 署名方式 */
export type SignatureType = "本名" | "别名" | "匿名";

/** 作品创作性质 */
export type CreationNature =
  | "原创"
  | "改编"
  | "翻译"
  | "汇编"
  | "注释"
  | "整理"
  | "其他";

/** 是否系列作品 */
export type IsSeriesWork = "是" | "否";

/** 一条完整的著作权登记记录（源自 Bitable 导出） */
export interface CopyrightRecord {
  /** 作品名称 — 必填 */
  作品名称: string;
  /** 作品类别 */
  作品类别: WorkCategory;
  /** 作品来源类型（Bitable 的"类型"字段，如礼物/表情包等） */
  类型?: WorkType;
  /** 创作/制作完成日期 — 格式 YYYY/MM/DD */
  创作完成日期: string;
  /** 首次发表日期 — 格式 YYYY/MM/DD */
  首次发表日期: string;
  /** 发表状态 */
  发表状态: PublicationStatus;
  /** 作者名称（公司名） */
  作者名称: string;
  /** 权利归属方式 */
  权利归属方式: RightOwnership;
  /** 权利取得方式 */
  权利取得方式: RightAcquisition;
  /** 权利拥有状况 */
  权利拥有状况: RightOwnershipStatus;
  /** 署名方式 */
  署名?: SignatureType;
  /** 作品创作性质 */
  作品创作性质?: CreationNature;
  /** 创作完成地点 */
  创作完成地点?: PublicationLocation;
  /** 省（创作） */
  省创作?: string;
  /** 市（创作） */
  市创作?: string;
  /** 首次发表地点 */
  首次发表地点?: PublicationLocation;
  /** 省（发表） */
  省发表?: string;
  /** 市（发表） */
  市发表?: string;
  /** 内容简介 — 产品说明 */
  内容简介?: string;
  /** 创作过程 — 公式自动生成的详细说明 */
  创作过程?: string;
  /** 是否登记为系列作品 */
  是否系列作品?: IsSeriesWork;
  /** 系列作品名称 */
  系列作品名称?: string;
  /** 作品月份 */
  作品月份?: string;
  /** 登记证书号（登记完成后才有的） */
  登记证书号?: string;
  /** 作品登记提交日期 */
  作品登记提交日期?: string;
  /** 作品登记通过日期 */
  作品登记通过日期?: string;
}

// ============================================================
// 扩展内部类型
// ============================================================

/** 飞书应用凭据 */
export interface FeishuCredentials {
  /** 飞书应用 App ID */
  appId: string;
  /** 飞书应用 App Secret */
  appSecret: string;
}

/** 飞书多维表格配置 */
export interface BitableConfig {
  /** 多维表格 Base Token */
  baseToken: string;
  /** 数据表 ID */
  tableId: string;
}

/** 飞书 API 租户访问令牌缓存 */
export interface TenantTokenCache {
  token: string;
  expiresAt: number; // 过期时间戳（ms）
}

/** 公司主体配置 */
export interface CompanyConfig {
  /** 公司全称 */
  name: string;
  /** 统一社会信用代码 */
  creditCode: string;
  /** 成立日期 */
  establishmentDate: string;
  /** 公司地址 */
  address: string;
  /** 创作工具（默认 Photoshop） */
  creationTool?: string;
}

/** 扩展设置 */
export interface ExtensionSettings {
  /** 公司主体列表 */
  companies: CompanyConfig[];
  /** 默认选中的公司索引 */
  defaultCompanyIndex: number;
  /** 内容简介模板 */
  contentDescriptionTemplate: string;
  /** 创作过程模板 */
  creationProcessTemplate: string;
  /** 内容简介说明模板 */
  contentIntroTemplate: string;
  /** 飞书应用凭据 */
  feishuCredentials: FeishuCredentials;
  /** 飞书多维表格配置 */
  bitableConfig: BitableConfig;
}

// ============================================================
// 飞书 Bitable API 响应类型
// ============================================================

/** 飞书 tenant_access_token 响应 */
export interface FeishuTokenResponse {
  code: number;
  msg: string;
  tenant_access_token: string;
  expire: number; // 秒
}

/** 飞书 Bitable 字段属性 */
export interface BitableFieldMeta {
  field_id: string;
  field_name: string;
  type: number;
  property?: Record<string, unknown>;
}

/** 飞书 Bitable 记录列表请求参数 */
export interface BitableListParams {
  page_size?: number;
  page_token?: string;
  filter?: string;
}

/** 飞书 Bitable 记录值 */
export type BitableFieldValue = string | number | boolean | string[] | null;

/** 飞书 Bitable 单条记录 */
export interface BitableRecord {
  record_id: string;
  fields: Record<string, BitableFieldValue>;
  created_time?: string;
  last_modified_time?: string;
}

/** 飞书 Bitable 记录列表响应 */
export interface BitableListResponse {
  code: number;
  msg: string;
  data: {
    has_more: boolean;
    page_token: string;
    total: number;
    items: BitableRecord[];
  };
}

/** 飞书 Bitable 字段列表响应 */
export interface BitableFieldListResponse {
  code: number;
  msg: string;
  data: {
    items: BitableFieldMeta[];
  };
}

// ============================================================
// Bitable 字段元数据
// ============================================================
// 2026-05-12 通过 lark-cli base +field-list 从实际多维表格读取
// Base: 作品著作权登记信息收集表 测试 (KlFobkbtpaBHcRsWxmTcEG3anwg)
// Table: 数据表 (tblF7zqf0q5FBvTk)

/** Bitable 字段类型常量 */
export const enum BitableFieldType {
  Text = 1,
  Number = 2,
  SingleSelect = 3,
  MultiSelect = 4,
  DateTime = 5,
  Checkbox = 7,
  User = 11,
  Url = 15,
  Attachment = 17,
  SingleLink = 18,
  Formula = 20,
  Location = 22,
  CreatedTime = 1001,
  ModifiedTime = 1002,
  CreatedUser = 1003,
  ModifiedUser = 1004,
  AutoNumber = 1005,
}

/** Bitable 字段元数据 */
export interface BitableFieldMetaMap {
  fieldId: string;
  fieldName: string;
  type: BitableFieldType;
}

/**
 * Bitable 全部 31 个字段元数据（通过 lark-cli 实际读取验证）
 * 包含用于填表的核心字段和辅助/公式/附件字段
 */
export const BITABLE_FIELDS: readonly BitableFieldMetaMap[] = [
  { fieldId: "fldT9KGTRt", fieldName: "作品名称", type: BitableFieldType.Text },
  { fieldId: "fldVleVZTA", fieldName: "作品类别", type: BitableFieldType.SingleSelect },
  { fieldId: "fldw9L9aSH", fieldName: "类型", type: BitableFieldType.SingleSelect },
  { fieldId: "fldRA8h0yH", fieldName: "创作/制作完成日期", type: BitableFieldType.DateTime },
  { fieldId: "fldYtLHrIW", fieldName: "首次发表日期", type: BitableFieldType.DateTime },
  { fieldId: "fld3OkWDor", fieldName: "发表状态", type: BitableFieldType.SingleSelect },
  { fieldId: "fldgFPiGrO", fieldName: "作者名称", type: BitableFieldType.MultiSelect },
  { fieldId: "fldesAB8eC", fieldName: "权利归属方式", type: BitableFieldType.SingleSelect },
  { fieldId: "fld8bvH5BV", fieldName: "权利取得方式", type: BitableFieldType.SingleSelect },
  { fieldId: "fldltwKrQM", fieldName: "权利拥有状况及其说明", type: BitableFieldType.SingleSelect },
  { fieldId: "fldP1YspS9", fieldName: "署名", type: BitableFieldType.SingleSelect },
  { fieldId: "fldukFgFwz", fieldName: "作品创作性质", type: BitableFieldType.SingleSelect },
  { fieldId: "fld3bA676e", fieldName: "创作完成地点", type: BitableFieldType.SingleSelect },
  { fieldId: "fldatxVGQ1", fieldName: "省（创作）", type: BitableFieldType.Text },
  { fieldId: "fldeNqWQsh", fieldName: "市（创作）", type: BitableFieldType.Text },
  { fieldId: "fldk6nyxnf", fieldName: "首次发表地点", type: BitableFieldType.SingleSelect },
  { fieldId: "fldgmKoTZS", fieldName: "省（发表）", type: BitableFieldType.Text },
  { fieldId: "fld1EhOXgH", fieldName: "市（发表）", type: BitableFieldType.Text },
  { fieldId: "fldNyxpCRY", fieldName: "内容简介", type: BitableFieldType.Text },
  { fieldId: "fld9KR18Z1", fieldName: "创作过程", type: BitableFieldType.Formula },
  { fieldId: "fldDKSj66k", fieldName: "是否登记为系列作品", type: BitableFieldType.SingleSelect },
  { fieldId: "fld8dljblq", fieldName: "系列作品名称", type: BitableFieldType.Text },
  { fieldId: "fldqI1wKO2", fieldName: "作品电子文件", type: BitableFieldType.Attachment },
  { fieldId: "fldetu7KGJ", fieldName: "权利归属证明材料", type: BitableFieldType.Attachment },
  { fieldId: "fldCHAf0Vz", fieldName: "其他证明材料", type: BitableFieldType.Attachment },
  { fieldId: "fldnqXQdoo", fieldName: "日期复核", type: BitableFieldType.Formula },
  { fieldId: "fld9dZh9Jb", fieldName: "标记重复作品名", type: BitableFieldType.Formula },
  { fieldId: "fldPHVeUtn", fieldName: "作品登记提交日期", type: BitableFieldType.DateTime },
  { fieldId: "fldNL1yccN", fieldName: "作品月份", type: BitableFieldType.Formula },
  { fieldId: "fld7S7p1Ge", fieldName: "登记证书号", type: BitableFieldType.Text },
  { fieldId: "fldO6LAfUb", fieldName: "作品登记通过日期", type: BitableFieldType.DateTime },
] as const;

const LEGACY_BITABLE_FIELDS: readonly BitableFieldMetaMap[] = [
  { fieldId: "fldtfshh9T", fieldName: "作品名称", type: BitableFieldType.Text },
  { fieldId: "fldg3eSoVO", fieldName: "作品类别", type: BitableFieldType.SingleSelect },
  { fieldId: "fldJoFzx1I", fieldName: "类型", type: BitableFieldType.SingleSelect },
  { fieldId: "fld3cOFepZ", fieldName: "创作/制作完成日期", type: BitableFieldType.DateTime },
  { fieldId: "fldj6ET41U", fieldName: "首次发表日期", type: BitableFieldType.DateTime },
  { fieldId: "fld4lW0z5D", fieldName: "发表状态", type: BitableFieldType.SingleSelect },
  { fieldId: "fldYhvs1KS", fieldName: "发表所在国家/城市", type: BitableFieldType.Text },
  { fieldId: "fld3sSOaKo", fieldName: "作者名称", type: BitableFieldType.MultiSelect },
  { fieldId: "fldbHYIb0B", fieldName: "权利归属方式", type: BitableFieldType.SingleSelect },
  { fieldId: "fldBh1RhGB", fieldName: "权利取得方式", type: BitableFieldType.SingleSelect },
  { fieldId: "fldfrSQas7", fieldName: "权利拥有状况及其说明", type: BitableFieldType.SingleSelect },
  { fieldId: "fldtVowunv", fieldName: "署名", type: BitableFieldType.SingleSelect },
  { fieldId: "fldyBQBPaa", fieldName: "作品创作性质", type: BitableFieldType.SingleSelect },
  { fieldId: "fldvWsX62p", fieldName: "创作完成地点", type: BitableFieldType.SingleSelect },
  { fieldId: "fldWsvvlgL", fieldName: "省（创作）", type: BitableFieldType.Text },
  { fieldId: "fldMnCI0a3", fieldName: "市（创作）", type: BitableFieldType.Text },
  { fieldId: "fldMTn8F8g", fieldName: "首次发表地点", type: BitableFieldType.SingleSelect },
  { fieldId: "fldlOoK8z1", fieldName: "省（发表）", type: BitableFieldType.Text },
  { fieldId: "fldyyj6CV6", fieldName: "市（发表）", type: BitableFieldType.Text },
  { fieldId: "fldbhkJE0N", fieldName: "内容简介", type: BitableFieldType.Text },
  { fieldId: "fld94507az", fieldName: "创作过程", type: BitableFieldType.Formula },
  { fieldId: "fldVy1I06t", fieldName: "是否登记为系列作品", type: BitableFieldType.SingleSelect },
  { fieldId: "fldF1RhN3G", fieldName: "系列作品名称", type: BitableFieldType.Text },
  { fieldId: "fldLurqc4A", fieldName: "作品电子文件", type: BitableFieldType.Attachment },
  { fieldId: "fldmYirDxc", fieldName: "权利归属证明材料", type: BitableFieldType.Attachment },
  { fieldId: "fldYWsu8Ez", fieldName: "日期复核", type: BitableFieldType.Formula },
  { fieldId: "fldjUqacUn", fieldName: "标记重复作品名", type: BitableFieldType.Formula },
  { fieldId: "fldbWkUt3u", fieldName: "作品登记提交日期", type: BitableFieldType.DateTime },
  { fieldId: "fldg0qPGjq", fieldName: "作品月份", type: BitableFieldType.Formula },
  { fieldId: "fldtnMsGL1", fieldName: "登记证书号", type: BitableFieldType.Text },
  { fieldId: "fldhBZ7uUC", fieldName: "作品登记通过日期", type: BitableFieldType.DateTime },
] as const;

/** 字段 ID → 字段名 快速查询（用于填表数据映射） */
export const BITABLE_FIELD_MAP: Record<string, string> = Object.fromEntries(
  [...BITABLE_FIELDS, ...LEGACY_BITABLE_FIELDS].map((f) => [f.fieldId, f.fieldName])
);

/** 字段 ID → 字段类型 快速查询 */
export const BITABLE_FIELD_TYPE_MAP: Record<string, BitableFieldType> = Object.fromEntries(
  [...BITABLE_FIELDS, ...LEGACY_BITABLE_FIELDS].map((f) => [f.fieldId, f.type])
);

/** 默认 Base Token（作品著作权登记信息收集表 测试） */
export const DEFAULT_BASE_TOKEN = "KlFobkbtpaBHcRsWxmTcEG3anwg";

/** 默认 Table ID */
export const DEFAULT_TABLE_ID = "tblF7zqf0q5FBvTk";

/** 填充状态 */
export type FillStatus = "pending" | "filling" | "filled" | "submitted" | "error" | "skipped";

/** 一条记录的处理状态 */
export interface RecordState {
  record: CopyrightRecord;
  status: FillStatus;
  error?: string;
  index: number;
}

/** 跨页面填表会话（存储在 chrome.storage.session 中跨页面恢复） */
export interface FillSession {
  /** 所有记录列表 */
  records: CopyrightRecord[];
  /** 当前记录索引 */
  currentIndex: number;
  /** 当前所处步骤 */
  currentStep: FormStep;
  /** 公司配置 */
  company: CompanyConfig;
  /** 会话是否活跃 */
  active: boolean;
}

/** 填表进度 */
export interface FillProgress {
  total: number;
  current: number;
  currentStep: string;
  records: RecordState[];
}

/** 填表步骤 */
export type FormStep =
  | "agreement"      // 申请须知
  | "copyright_owner" // 著作权人信息
  | "work_info"       // 作品基本信息
  | "upload"          // 上传作品
  | "rights_info"     // 权利状况说明
  | "rights_proof"    // 权利归属证明材料上传
  | "preview"         // 预览
  | "done";           // 完成

/** ccct.net.cn 表单字段选择器映射 */
export interface FieldSelector {
  /** 字段在 Bitable 中的名称 */
  bitableField: string;
  /** ccct.net.cn 页面上的 DOM 选择器 */
  selector: string;
  /** 页面 label/提示文本的别名 */
  labelAliases?: string[];
  /** 字段类型 */
  type: "text" | "select" | "date" | "textarea" | "radio" | "checkbox";
  /** 所属步骤 */
  step: FormStep;
  /** 当前步骤进入下一步前必须填上的字段 */
  required?: boolean;
  /** 值映射（select/radio 选项值转换） */
  valueMap?: Record<string, string>;
}

/** 内容简介模板变量 */
export interface TemplateVars {
  companyName: string;
  creditCode: string;
  establishmentDate: string;
  address: string;
  creationMonth: string;      // YYYY年MM月
  creationDate: string;       // YYYY年MM月DD日
  publicationDate: string;    // YYYY年MM月DD日
  creationTool?: string;
  revisionCount?: number;
  revisionDetail?: string;
  workName: string;
  productIntro: string;
}
