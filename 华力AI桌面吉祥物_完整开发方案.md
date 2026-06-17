# 华力 AI 桌面吉祥物完整开发方案

> 项目定位：基于现有「华力企业级 AI 平台」扩展一个桌面常驻 AI 助手客户端。  
> 目标形态：类似桌面宠物 / 桌面助手，支持任务推送、待办创建、Web 平台联动、语音交互、3D 吉祥物展示。

---

## 1. 项目背景

现有 Web 项目已经包含以下核心能力：

1. 企业 AI 工作台首页；
2. 日历 + 今日待办；
3. 智能体入口；
4. Agent 使用统计；
5. Token 统计；
6. 积分排行；
7. 智能体分类展示。

下一步要做的是：  
在员工电脑桌面上增加一个常驻的「AI 吉祥物」，作为 Web 平台的轻量入口。

桌面吉祥物不是独立业务系统。  
它是现有 Web 平台的桌面入口层。

---

## 2. 产品目标

### 2.1 核心目标

桌面吉祥物需要完成以下闭环：

```text
桌面常驻
  ↓
接收文字 / 语音输入
  ↓
调用后端 AI 解析接口
  ↓
生成待办草稿
  ↓
自动打开 Web 工作台
  ↓
Web 页面确认并创建待办
  ↓
日历和任务状态同步
```

同时需要支持：

```text
后台任务产生
  ↓
后端实时推送
  ↓
桌面吉祥物弹出任务卡片
  ↓
用户确认 / 取消 / 稍后处理
  ↓
调用后端接口更新任务状态
  ↓
Web 平台同步刷新
```

---

## 3. 最终功能范围

### 3.1 桌面吉祥物能力

| 功能 | 说明 |
|---|---|
| 桌面常驻 | 小窗口常驻桌面，可拖拽 |
| 透明背景 | 只显示吉祥物和气泡，不显示传统窗口边框 |
| 置顶显示 | 可配置是否始终置顶 |
| 系统托盘 | 可显示、隐藏、退出、打开工作台 |
| 状态动画 | 待机、提醒、聆听、思考、成功、失败 |
| 任务气泡 | 展示后台推送的新任务 |
| 简单操作 | 支持确认、取消、稍后提醒 |
| 文字输入 | 一句话创建待办 |
| 语音输入 | 按住说话 / 唤醒词能力 |
| 打开 Web | 可跳转到 Web 工作台、日历、任务详情页 |
| 开机自启 | 可配置是否开机自动启动 |
| 自动更新 | 后续版本可自动更新 |

---

## 4. 技术选型

### 4.1 桌面端

推荐：

```text
Tauri 2 + Vue 3 + TypeScript + Vite
```

原因：

1. 与现有 Vue 技术栈一致；
2. 适合做轻量桌面客户端；
3. 支持透明窗口、系统托盘、通知、窗口管理；
4. Windows 端安装包体积相对 Electron 更轻；
5. 可用 Rust 扩展系统能力；
6. 适合后续做企业客户端分发。

### 4.2 3D 吉祥物

推荐：

```text
TresJS + Three.js + glTF / GLB 模型
```

说明：

1. Three.js 是 Web 端 3D 渲染基础库；
2. TresJS 是 Vue 生态里对 Three.js 的组件化封装；
3. 适合 Vue3 + TS 项目；
4. 3D 模型统一使用 `.glb` 或 `.gltf`；
5. 动画状态最好直接内置在模型文件中。

### 4.3 动画模型方案

| 阶段 | 推荐方案 | 说明 |
|---|---|---|
| 第一版 | 静态 PNG / SVG / Lottie / Rive | 快速完成桌面端闭环 |
| 第二版 | Rive | 轻量交互动画 |
| 第三版 | GLB 3D 模型 | 实现真正 3D 吉祥物 |
| 后续增强 | Live2D / 复杂骨骼动画 | 如果需要更强人格化 |

### 4.4 任务推送

推荐：

```text
WebSocket 优先
SSE 备选
轮询兜底
```

优先使用 WebSocket。  
原因是任务推送、桌面气泡、状态同步都需要实时性。

### 4.5 语音能力

| 阶段 | 方案 | 说明 |
|---|---|---|
| 第一阶段 | 不做语音，只做文字输入 | 降低风险 |
| 第二阶段 | 后端 ASR | 桌面录音上传后端识别 |
| 第三阶段 | 内网 ASR 服务 | FunASR / SenseVoice |
| 第四阶段 | 本地 ASR + 唤醒词 | sherpa-onnx / whisper.cpp |

---

## 5. 总体架构

```text
┌──────────────────────────────┐
│       huali-ai-mascot         │
│       Tauri 桌面吉祥物         │
│                              │
│  - MascotWindow              │
│  - PanelWindow               │
│  - WebSocket Client          │
│  - Tray                      │
│  - Task Push UI              │
│  - Todo Input UI             │
│  - 3D Mascot Renderer        │
└───────────────┬──────────────┘
                │
                │ HTTPS / WebSocket
                │
┌───────────────▼──────────────┐
│        huali-ai-server        │
│                              │
│  - 登录认证                   │
│  - 桌面设备注册               │
│  - 任务推送                   │
│  - 任务确认 / 取消            │
│  - AI 待办解析                │
│  - 待办草稿                   │
│  - 日历待办落库               │
└───────────────┬──────────────┘
                │
                │ HTTP API
                │
┌───────────────▼──────────────┐
│       huali-ai-platform       │
│       现有 Web 平台            │
│                              │
│  - 首页工作台                 │
│  - 日历待办                   │
│  - 智能体中心                 │
│  - Token 统计                 │
│  - 任务确认弹窗               │
└──────────────────────────────┘
```

---

## 6. 项目仓库规划

建议拆成三个项目，不要把桌面端直接塞进现有 Web 项目。

```text
huali-ai-platform/       # 现有 Web 平台
huali-ai-mascot/         # Tauri 桌面吉祥物
huali-ai-server/         # 后端任务、AI、推送服务
```

如果公司当前只有一个后端工程，也可以先在现有后端中新增 `desktop`、`todo`、`ai` 模块。

---

## 7. 桌面端目录结构

```text
huali-ai-mascot/
├─ package.json
├─ vite.config.ts
├─ index.html
├─ .env.development
├─ .env.production
├─ src/
│  ├─ main.ts
│  ├─ App.vue
│  ├─ router/
│  │  └─ index.ts
│  ├─ stores/
│  │  ├─ user.ts
│  │  ├─ mascot.ts
│  │  ├─ task.ts
│  │  └─ socket.ts
│  ├─ views/
│  │  ├─ MascotWindow.vue
│  │  ├─ PanelWindow.vue
│  │  └─ SettingsWindow.vue
│  ├─ components/
│  │  ├─ mascot/
│  │  │  ├─ MascotAvatar.vue
│  │  │  ├─ Mascot3D.vue
│  │  │  ├─ MascotBubble.vue
│  │  │  └─ MascotStatusBar.vue
│  │  ├─ task/
│  │  │  ├─ TaskPushCard.vue
│  │  │  ├─ TaskActionButtons.vue
│  │  │  └─ UpcomingTaskList.vue
│  │  ├─ input/
│  │  │  ├─ TodoTextInput.vue
│  │  │  └─ VoiceInputButton.vue
│  │  └─ common/
│  │     ├─ EmptyState.vue
│  │     └─ LoadingIcon.vue
│  ├─ services/
│  │  ├─ request.ts
│  │  ├─ auth.service.ts
│  │  ├─ desktop.service.ts
│  │  ├─ task.service.ts
│  │  ├─ todo.service.ts
│  │  ├─ ai.service.ts
│  │  ├─ speech.service.ts
│  │  ├─ websocket.service.ts
│  │  └─ window.service.ts
│  ├─ types/
│  │  ├─ task.ts
│  │  ├─ todo.ts
│  │  ├─ desktop.ts
│  │  ├─ socket.ts
│  │  └─ api.ts
│  ├─ utils/
│  │  ├─ storage.ts
│  │  ├─ env.ts
│  │  ├─ logger.ts
│  │  └─ time.ts
│  └─ assets/
│     ├─ images/
│     ├─ mascot/
│     │  ├─ mascot.png
│     │  ├─ mascot.glb
│     │  └─ animations/
│     └─ styles/
│        ├─ base.css
│        └─ theme.css
│
└─ src-tauri/
   ├─ tauri.conf.json
   ├─ capabilities/
   ├─ icons/
   └─ src/
      ├─ main.rs
      ├─ tray.rs
      ├─ window.rs
      └─ commands.rs
```

---

## 8. 桌面端窗口规划

### 8.1 MascotWindow

负责显示吉祥物本体。

特点：

```text
透明背景
无边框
可拖拽
默认置顶
尺寸小
不展示任务栏
可吸附屏幕边缘
```

建议尺寸：

```text
宽度：160 - 260px
高度：180 - 320px
```

### 8.2 PanelWindow

负责展示操作面板。

内容包括：

1. 一句话创建待办输入框；
2. 新任务推送卡片；
3. 今日待办摘要；
4. 打开 Web 工作台按钮；
5. 语音按钮；
6. 设置入口。

建议尺寸：

```text
宽度：360 - 460px
高度：420 - 600px
```

### 8.3 SettingsWindow

负责设置项。

包括：

1. 是否开机自启；
2. 是否始终置顶；
3. 是否显示任务通知；
4. 是否播放提示音；
5. API 地址；
6. 当前登录用户；
7. 当前版本；
8. 检查更新。

---

## 9. 吉祥物状态机

建议统一定义状态，不要散落在各组件里。

```ts
export type MascotStatus =
  | 'idle'
  | 'hover'
  | 'listening'
  | 'typing'
  | 'thinking'
  | 'remind'
  | 'success'
  | 'error'
  | 'sleep'
```

状态含义：

| 状态 | 使用场景 |
|---|---|
| idle | 默认待机 |
| hover | 鼠标悬停 |
| listening | 正在听语音 |
| typing | 用户正在输入 |
| thinking | 接口处理中 |
| remind | 有新任务 |
| success | 操作成功 |
| error | 操作失败 |
| sleep | 长时间未操作 |

状态流转示例：

```text
idle
  → hover
  → typing
  → thinking
  → success
  → idle
```

任务推送示例：

```text
idle
  → remind
  → thinking
  → success / error
  → idle
```

---

## 10. 后端模块设计

### 10.1 desktop 模块

负责桌面客户端相关能力。

功能：

1. 设备注册；
2. 客户端登录；
3. Token 刷新；
4. 当前版本检查；
5. 桌面配置下发；
6. 桌面通知开关；
7. 设备在线状态。

### 10.2 task 模块

负责任务推送和任务操作。

功能：

1. 新任务创建；
2. 任务推送；
3. 任务确认；
4. 任务取消；
5. 稍后提醒；
6. 任务状态同步；
7. 任务操作日志。

### 10.3 todo 模块

负责待办事项。

功能：

1. 待办草稿；
2. 创建待办；
3. 查询待办；
4. 更新待办；
5. 完成待办；
6. 删除待办。

### 10.4 ai 模块

负责 AI 解析。

功能：

1. 一句话解析待办；
2. 识别时间；
3. 识别负责人；
4. 识别提醒规则；
5. 识别任务类型；
6. 输出结构化 JSON。

### 10.5 push 模块

负责 WebSocket 推送。

功能：

1. 用户连接管理；
2. 设备连接管理；
3. 心跳；
4. 断线重连；
5. 事件重发；
6. 消息确认 ACK。

---

## 11. WebSocket 事件协议

### 11.1 基础格式

所有服务端推送给桌面端的消息统一使用以下格式：

```json
{
  "eventId": "evt_20260528_0001",
  "eventType": "task.created",
  "timestamp": "2026-05-28 14:30:00",
  "needAck": true,
  "payload": {}
}
```

### 11.2 事件类型

| eventType | 说明 |
|---|---|
| task.created | 新任务 |
| task.updated | 任务更新 |
| task.cancelled | 任务取消 |
| task.deadlineSoon | 任务即将到期 |
| todo.remind | 待办提醒 |
| system.notice | 系统通知 |
| client.forceUpdate | 强制更新 |
| client.configChanged | 配置变更 |

### 11.3 新任务事件示例

```json
{
  "eventId": "evt_20260528_0001",
  "eventType": "task.created",
  "timestamp": "2026-05-28 14:30:00",
  "needAck": true,
  "payload": {
    "taskId": "task_10001",
    "title": "确认下月规划会材料",
    "content": "请在今天 16:00 前确认材料内容",
    "deadline": "2026-05-28 16:00:00",
    "priority": "normal",
    "creatorName": "系统管理员",
    "actions": [
      {
        "key": "confirm",
        "label": "确认"
      },
      {
        "key": "cancel",
        "label": "取消"
      },
      {
        "key": "later",
        "label": "稍后提醒"
      }
    ]
  }
}
```

### 11.4 客户端 ACK

桌面端收到需要 ACK 的消息后，需要回传：

```json
{
  "eventId": "evt_20260528_0001",
  "ackTime": "2026-05-28 14:30:02",
  "clientId": "client_xxx",
  "status": "received"
}
```

---

## 12. API 设计

### 12.1 桌面登录

```http
POST /api/desktop/login
```

请求：

```json
{
  "username": "liumeihua",
  "password": "******",
  "deviceName": "DESKTOP-001",
  "clientVersion": "1.0.0"
}
```

返回：

```json
{
  "token": "access_token",
  "refreshToken": "refresh_token",
  "user": {
    "userId": "u001",
    "userName": "刘美华",
    "department": "信息技术部"
  },
  "client": {
    "clientId": "desktop_client_001"
  }
}
```

### 12.2 设备注册

```http
POST /api/desktop/device/register
```

请求：

```json
{
  "deviceName": "DESKTOP-001",
  "os": "Windows 11",
  "appVersion": "1.0.0",
  "clientId": "desktop_client_001"
}
```

### 12.3 一句话解析待办

```http
POST /api/ai/todo/parse
```

请求：

```json
{
  "source": "desktop-mascot",
  "inputType": "text",
  "text": "明天下午三点提醒我确认会议纪要",
  "userId": "u001"
}
```

返回：

```json
{
  "confidence": 0.92,
  "draftId": "todo_draft_20260528_001",
  "needConfirm": true,
  "result": {
    "title": "确认会议纪要",
    "startTime": "2026-05-29 15:00:00",
    "remindBeforeMinutes": 10,
    "assignee": "刘美华",
    "priority": "normal",
    "repeatRule": "none"
  }
}
```

### 12.4 获取待办草稿

```http
GET /api/todo/draft/detail?draftId=todo_draft_20260528_001
```

### 12.5 从草稿创建待办

```http
POST /api/todo/createFromDraft
```

请求：

```json
{
  "draftId": "todo_draft_20260528_001",
  "confirm": true
}
```

### 12.6 任务操作

```http
POST /api/desktop/task/action
```

请求：

```json
{
  "eventId": "evt_20260528_0001",
  "taskId": "task_10001",
  "action": "confirm"
}
```

action 可选值：

```text
confirm
cancel
later
openDetail
```

返回：

```json
{
  "success": true,
  "taskStatus": "confirmed",
  "message": "已确认任务"
}
```

### 12.7 获取即将开始的待办

```http
GET /api/desktop/todo/upcoming?minutes=30
```

---

## 13. Web 平台改造点

现有 Web 平台需要新增能力。

### 13.1 工作台支持 todoDraftId 参数

访问：

```text
/workbench?todoDraftId=todo_draft_20260528_001
```

页面逻辑：

1. 读取 URL 参数；
2. 调用草稿详情接口；
3. 弹出待办确认弹窗；
4. 用户确认后调用创建接口；
5. 日历刷新；
6. 清理 URL 参数。

### 13.2 日历页支持 taskId 参数

访问：

```text
/calendar?taskId=task_10001
```

页面逻辑：

1. 自动定位任务所在日期；
2. 高亮任务；
3. 打开任务详情弹窗。

### 13.3 预留 Deep Link

后期 Web 可通过以下协议唤起桌面助手：

```text
huali-ai://open-task?taskId=task_10001
huali-ai://create-todo?draftId=todo_draft_001
huali-ai://show
```

第一版可以不做。

---

## 14. 数据库表建议

### 14.1 桌面设备表：desktop_device

| 字段 | 说明 |
|---|---|
| id | 主键 |
| user_id | 用户 ID |
| client_id | 客户端 ID |
| device_name | 设备名称 |
| os | 操作系统 |
| app_version | 客户端版本 |
| last_online_time | 最后在线时间 |
| status | 状态 |
| create_time | 创建时间 |

### 14.2 桌面事件表：desktop_event

| 字段 | 说明 |
|---|---|
| id | 主键 |
| event_id | 事件 ID |
| event_type | 事件类型 |
| user_id | 用户 ID |
| task_id | 任务 ID |
| payload | 事件内容 JSON |
| need_ack | 是否需要 ACK |
| ack_status | ACK 状态 |
| create_time | 创建时间 |
| ack_time | ACK 时间 |

### 14.3 待办草稿表：todo_draft

| 字段 | 说明 |
|---|---|
| id | 主键 |
| draft_id | 草稿 ID |
| user_id | 用户 ID |
| source | 来源 |
| raw_text | 原始输入 |
| parsed_json | AI 解析结果 |
| confidence | 置信度 |
| status | 状态 |
| create_time | 创建时间 |
| expire_time | 过期时间 |

### 14.4 任务操作日志表：task_action_log

| 字段 | 说明 |
|---|---|
| id | 主键 |
| task_id | 任务 ID |
| user_id | 用户 ID |
| action | 操作 |
| source | 操作来源 |
| client_id | 客户端 ID |
| create_time | 操作时间 |

---

## 15. 安全设计

### 15.1 登录安全

1. 桌面端必须登录；
2. token 存储在系统安全存储中，避免明文存 localStorage；
3. token 过期自动刷新；
4. 刷新失败回到登录状态。

### 15.2 接口安全

1. 所有接口走 HTTPS；
2. WebSocket 走 WSS；
3. 请求携带 Bearer Token；
4. 服务端校验用户权限；
5. 任务操作需要做幂等处理；
6. 重要操作记录日志。

### 15.3 数据安全

1. URL 中只传 `draftId`、`taskId`，不传完整任务内容；
2. 桌面日志不要记录敏感正文；
3. AI 解析原文需按公司数据安全规范保存；
4. 桌面端缓存需可清理。

### 15.4 企业内网环境

1. 支持内网 API 地址；
2. 支持内网更新服务器；
3. 支持离线安装包；
4. 不依赖公网服务。

---

## 16. 安装和分发完整方案

完整阶段建议分三种方式。

### 16.1 第一阶段：内网下载页

适合试点。

```text
员工访问内网下载页面
  ↓
下载 .msi 或 setup.exe
  ↓
双击安装
  ↓
登录账号
  ↓
开始使用
```

### 16.2 第二阶段：域控 / 组策略安装

适合 Windows 域环境。

```text
IT 将 MSI 放入共享目录
  ↓
域控 GPO 配置软件分发
  ↓
员工电脑开机或登录时自动安装
```

### 16.3 第三阶段：终端管理平台

适合大规模企业分发。

可使用：

1. Microsoft Intune；
2. SCCM；
3. 360 企业安全管理；
4. 火绒企业版；
5. 公司已有终端管控平台。

### 16.4 自动更新

后续建议接入 Tauri Updater。

```text
客户端启动
  ↓
检查版本
  ↓
发现更新
  ↓
下载更新包
  ↓
校验签名
  ↓
安装更新
  ↓
重启客户端
```

---

## 17. 版本规划

### 17.1 V1.0 试点版

目标：跑通桌面端到 Web 平台的业务闭环。

功能：

1. 桌面吉祥物窗口；
2. 文字输入创建待办；
3. 打开 Web 工作台确认待办；
4. WebSocket 接收新任务；
5. 任务确认 / 取消 / 稍后提醒；
6. 系统托盘；
7. 内网下载页安装。

不做：

1. 3D 吉祥物；
2. 语音；
3. 自动更新；
4. Deep Link；
5. 批量分发。

### 17.2 V1.5 增强版

功能：

1. Rive / Lottie 动画；
2. 待办提醒；
3. 消息中心；
4. 开机自启；
5. 位置记忆；
6. 基础设置页。

### 17.3 V2.0 3D 版

功能：

1. 3D GLB 吉祥物；
2. 多状态动画；
3. 任务提醒动作；
4. 点击互动；
5. 模型皮肤切换。

### 17.4 V2.5 语音版

功能：

1. 按住说话；
2. 语音转文字；
3. 一句话创建待办；
4. 一句话查询日程；
5. 语音播报。

### 17.5 V3.0 企业分发版

功能：

1. 自动更新；
2. 代码签名；
3. 域控批量安装；
4. 终端管理平台分发；
5. 灰度发布；
6. 强制升级；
7. 远程配置下发。

---

## 18. 开发里程碑

### 阶段一：桌面壳

交付：

1. Tauri 2 项目初始化；
2. Vue3 + TS 工程结构；
3. 透明窗口；
4. 系统托盘；
5. 基础设置；
6. 打开 Web 平台。

### 阶段二：待办创建闭环

交付：

1. 桌面输入框；
2. AI 解析接口调用；
3. 生成草稿；
4. 打开 Web 工作台；
5. Web 弹窗确认；
6. 创建待办并刷新日历。

### 阶段三：任务推送闭环

交付：

1. WebSocket 长连接；
2. 新任务推送；
3. 桌面任务卡片；
4. 确认 / 取消 / 稍后；
5. 后端状态同步；
6. Web 平台状态刷新。

### 阶段四：动画和体验

交付：

1. 吉祥物状态机；
2. idle / remind / thinking / success / error；
3. 气泡动画；
4. 位置记忆；
5. 提示音；
6. 开机自启。

### 阶段五：3D 和语音

交付：

1. GLB 模型加载；
2. 3D 动画控制；
3. 语音录制；
4. ASR 接口；
5. 语音输入待办；
6. 语音播报。

---

## 19. 测试要求

### 19.1 桌面端测试

1. Windows 10；
2. Windows 11；
3. 不同分辨率；
4. 多显示器；
5. 高 DPI 缩放；
6. 开机自启；
7. 断网重连；
8. 后端服务重启；
9. WebSocket 重连；
10. 安装 / 卸载。

### 19.2 业务测试

1. 输入一句话生成待办；
2. 日期识别正确；
3. 时间识别正确；
4. 负责人识别正确；
5. Web 页面能拿到草稿；
6. 确认后日历刷新；
7. 后台任务能推到桌面；
8. 桌面确认后后端状态更新；
9. 取消任务后 Web 同步；
10. 重复点击不会重复提交。

### 19.3 安全测试

1. token 过期；
2. 未登录访问接口；
3. 越权操作任务；
4. 重复事件 ACK；
5. 恶意 taskId；
6. URL 参数篡改；
7. 日志敏感信息泄露。

---

## 20. 验收标准

### 20.1 产品验收

1. 员工可以看到桌面吉祥物；
2. 可以输入一句话创建待办；
3. 可以自动跳转 Web 工作台；
4. 可以确认创建待办；
5. 可以收到后台新任务；
6. 可以在桌面端确认或取消任务；
7. 操作结果和 Web 平台一致；
8. 程序关闭后可从托盘重新打开；
9. 安装流程可被普通员工完成。

### 20.2 技术验收

1. 项目可独立构建；
2. 可生成 Windows 安装包；
3. API 地址可配置；
4. WebSocket 断线可重连；
5. 操作接口有幂等保护；
6. 无明显内存泄漏；
7. 日志可定位问题；
8. 代码结构清晰；
9. 后续可接入 3D 和语音。

---

## 21. 风险和规避

| 风险 | 说明 | 规避 |
|---|---|---|
| 透明窗口兼容问题 | 不同系统表现可能不一致 | 第一版允许非透明兜底窗口 |
| WebSocket 不稳定 | 网络断开导致无法接收任务 | 心跳 + 重连 + 轮询兜底 |
| 后端接口未完成 | 桌面端无法联调 | 提供 mock 模式 |
| AI 解析不准 | 待办内容错误 | Web 页面必须二次确认 |
| 安装被拦截 | 未签名安装包被安全软件拦截 | 试点白名单，正式版代码签名 |
| 3D 性能问题 | 低配电脑卡顿 | 第一版不做 3D，后续提供关闭开关 |
| 语音识别不稳定 | 噪音和方言影响识别 | 先做文字，语音后置 |

---

## 22. 官方参考资料

> 以下链接用于技术选型和实现参考，实际开发时以公司内网环境和当前依赖版本为准。

1. Tauri 2 官方文档：https://v2.tauri.app/
2. Tauri Windows Installer：https://v2.tauri.app/distribute/windows-installer/
3. Tauri Updater：https://v2.tauri.app/plugin/updater/
4. Tauri WebSocket Plugin：https://v2.tauri.app/plugin/websocket/
5. Tauri Notification Plugin：https://v2.tauri.app/plugin/notification/
6. Tauri Deep Linking Plugin：https://v2.tauri.app/plugin/deep-linking/
7. Tauri System Tray：https://v2.tauri.app/learn/system-tray/
8. TresJS 文档：https://docs.tresjs.org/
9. Three.js 官网：https://threejs.org/

---

## 23. 最终结论

本项目建议按「桌面常驻 AI 助手客户端」规划。

第一阶段先跑通业务闭环：

```text
桌面吉祥物
  ↓
文字输入创建待办
  ↓
后台任务推送
  ↓
桌面确认 / 取消
  ↓
Web 平台同步
```

后续再逐步升级：

```text
Rive 动画
  ↓
3D GLB 吉祥物
  ↓
语音交互
  ↓
自动更新和企业批量分发
```

不要一开始就追求完整 3D 和语音。  
先把桌面端、Web 端、后端的任务闭环跑通，才是这个项目最关键的价值点。
