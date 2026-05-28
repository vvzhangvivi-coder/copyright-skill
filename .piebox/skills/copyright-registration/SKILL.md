---
name: copyright-registration
description: |
  著作权登记自动填表工具。从飞书多维表格读取作品数据，通过 Playwright 自动登录中国版权保护中心（ccct.net.cn）并批量填写登记申请表。
  触发词：著作权登记、版权登记、登记著作权、copyright registration、登记公司、批量登记。
---

<skill-instruction>

# 著作权登记自动填表

## Overview

本工具通过 Playwright 控制本地 Chrome 浏览器，自动完成中国版权保护中心（ccct.net.cn）的著作权登记申请表填写。数据来源是飞书多维表格，填写完成后自动回写提交日期。

**核心流程**：用户提供公司名 + 飞书多维表格链接 → 本地启动服务 → 拉取数据并按公司筛选 → 用户打开控制台 → 启动浏览器自动填表 → 逐条暂存 → 回写日期

## 前置要求

使用本 skill 前，用户本地必须满足以下条件：

| 依赖                 | 说明                                                    |
| -------------------- | ------------------------------------------------------- |
| Node.js ≥ 18         | 运行 TypeScript 服务                                    |
| lark-cli             | 飞书命令行工具，需已登录（`lark-cli auth status` 确认） |
| Playwright           | 自动安装 Chromium，或使用系统已安装的 Chrome            |
| copyright-skill 仓库 | 从 GitHub clone 到本地                                  |

### 首次使用准备

```bash
# 1. clone 仓库
git clone https://github.com/vvzhangvivi-coder/copyright-skill.git
cd copyright-skill

# 2. 安装依赖
npm install

# 3. 确认 lark-cli 已登录（需要用户身份，不是 bot 身份）
lark-cli auth status
# 如果未登录：
lark-cli auth login --as user
```

## 触发与输入

用户发送格式：

```
登记 <公司名> <飞书多维表格链接>
```

示例：

- "登记荟友公司 https://wepie.feishu.cn/base/U3WcbZgNYaJhi8sxv4nccm6knoe"
- "著作权登记 微派 https://wepie.feishu.cn/base/KlFobkbtpaBHcRsWxmTcEG3anwg"

**公司名支持模糊匹配**：用户说"荟友"即可匹配"武汉荟友网络科技有限公司"。

### 解析规则

从用户消息中提取：

1. **公司名**：排除 URL 后的中文关键词（可能是简称）
2. **飞书链接**：匹配 `https://...feishu.cn/base/<baseToken>` 格式
   - `baseToken`：URL 路径的最后一段（`?` 前的部分）
   - `tableId`：如果 URL 含 `table=<tableId>` query param 则提取，否则需要用户补充或使用表格中的第一个数据表

## 执行流程

### Step 1：解析参数并启动服务

```bash
cd /path/to/copyright-skill
npx tsx server.ts
```

服务启动后监听 `http://localhost:3456`。

### Step 2：设置运行时配置

向本地服务发送配置：

```bash
curl -X POST http://localhost:3456/api/config \
  -H "Content-Type: application/json" \
  -d '{"baseToken": "<解析出的baseToken>", "tableId": "<tableId>", "company": "<公司名>"}'
```

### Step 3：拉取并验证数据

```bash
curl http://localhost:3456/api/records
```

确认返回的记录数量正确（已按公司名筛选，且排除已提交的记录）。

### Step 4：引导用户打开控制台

告诉用户：

> 请在浏览器中打开控制台页面：http://localhost:3456/console
>
> 点击「拉取数据」确认记录数量，然后点击「开始填表」。
> 浏览器会自动打开，请在登录页面手动完成登录（支持短信/密码登录），登录成功后系统会自动开始逐条填写。

### Step 5：监控进度

填表过程中，控制台页面通过 SSE 实时显示进度。每条记录处理完成后：

- 成功：自动暂存并回写「作品登记提交日期」到飞书表格
- 失败：记录错误信息，继续下一条

## 多维表格字段要求

表格必须包含以下核心字段（字段名支持别名模糊匹配）：

| 字段名            | 类型      | 说明                 |
| ----------------- | --------- | -------------------- |
| 作品名称          | 文本      | 必填                 |
| 作品类别          | 单选      | 美术/文字/音乐等     |
| 创作/制作完成日期 | 日期      |                      |
| 首次发表日期      | 日期      |                      |
| 作者名称          | 多选/文本 | 公司全称，用于筛选   |
| 作品电子文件      | 附件      | 上传到登记系统的文件 |
| 权利归属证明材料  | 附件      | 营业执照等           |
| 作品登记提交日期  | 日期      | 填表完成后自动回写   |

## 重要说明

1. **浏览器是本地可见的**：Playwright 以 headed 模式运行，用户可以看到整个填写过程
2. **登录需要手动完成**：ccct.net.cn 的登录（验证码/短信）无法自动化，需要用户手动操作
3. **权限使用用户自己的**：通过 lark-cli 以用户身份访问飞书表格，不需要额外的应用凭据
4. **暂存而非提交**：系统只做到"暂存"步骤，最终提交需要用户人工确认
5. **公司信息**：如果需要填写统一社会信用代码、成立日期、地址等，需在启动前通过 `/api/config` 补充，或确保多维表格中有对应字段

## 错误处理

| 错误              | 原因                      | 解决                                                             |
| ----------------- | ------------------------- | ---------------------------------------------------------------- |
| lark-cli 执行失败 | 未登录或 token 过期       | `lark-cli auth login --as user`                                  |
| 端口 3456 被占用  | 上次进程未关闭            | `lsof -ti:3456 \| xargs kill` 或设置 `BOT_PORT` 环境变量         |
| 记录数为 0        | 公司名不匹配或全部已提交  | 确认表格中「作者名称」包含目标公司名，且「作品登记提交日期」为空 |
| 附件下载失败      | lark-cli 权限不足         | 确认用户对该多维表格有编辑权限                                   |
| 登录超时          | 用户未在 5 分钟内完成登录 | 重新点击「开始填表」                                             |

## 红线规则

| #   | 禁止             | 说明                           |
| --- | ---------------- | ------------------------------ |
| 1   | 禁止自动提交     | 只暂存，不点最终提交按钮       |
| 2   | 禁止存储用户密码 | 登录由用户手动完成             |
| 3   | 禁止修改原始数据 | 只回写「作品登记提交日期」字段 |

</skill-instruction>
