# 华力 AI 桌面吉祥物第一版试点开发文档

> 这份文档用于交给 Codex 实现第一版。  
> 第一版目标：先做一个可安装、可试用、可联调的桌面 AI 吉祥物 MVP。  
> 安装方式：内网下载页，员工手动下载安装。

---

## 1. 第一版目标

第一版不要追求完整 3D、语音和自动更新。

先完成这个闭环：

```text
桌面出现一个小吉祥物
  ↓
点击吉祥物打开小面板
  ↓
输入一句话创建待办
  ↓
调用后端 AI 解析接口
  ↓
拿到 todoDraftId
  ↓
自动打开 Web 工作台
  ↓
Web 工作台弹出待办确认
  ↓
用户确认后创建待办
```

同时完成后台任务推送闭环：

```text
后端产生新任务
  ↓
WebSocket 推送给桌面端
  ↓
桌面吉祥物弹出任务卡片
  ↓
用户点击确认 / 取消 / 稍后
  ↓
调用后端任务操作接口
  ↓
后端更新任务状态
```

---

## 2. 第一版技术栈

```text
Tauri 2
Vue 3
TypeScript
Vite
Pinia
Axios
Tauri WebSocket Plugin
Tauri Notification Plugin
Tauri Shell / Opener 能力
```

UI 可以先不用复杂组件库。  
第一版建议使用普通 Vue 组件 + CSS 实现，避免引入大型后台组件库。

---

## 3. 第一版不做什么

第一版明确不做：

1. 不做 3D 吉祥物；
2. 不做语音输入；
3. 不做唤醒词；
4. 不做自动更新；
5. 不做域控批量安装；
6. 不做 Intune / 终端平台分发；
7. 不做复杂聊天窗口；
8. 不做完整消息中心；
9. 不做 Web 端唤起桌面端 Deep Link。

但是代码结构要预留：

1. 3D 组件位置；
2. 语音服务文件；
3. 更新服务文件；
4. Deep Link 配置位；
5. 多窗口扩展能力。

---

## 4. 第一版功能清单

### 4.1 桌面吉祥物

必须实现：

1. 桌面显示一个小吉祥物；
2. 支持拖拽；
3. 支持置顶；
4. 支持透明背景；
5. 点击吉祥物打开 / 收起操作面板；
6. 右键菜单支持打开工作台、隐藏、退出；
7. 托盘菜单支持显示、隐藏、打开工作台、退出。

第一版吉祥物素材可以用：

```text
src/assets/mascot/mascot.png
```

后续再替换为 3D 模型。

### 4.2 一句话创建待办

必须实现：

1. 面板里有输入框；
2. 输入框 placeholder：`一句话创建待办...`；
3. 点击发送后调用接口；
4. 接口处理中吉祥物状态改为 `thinking`；
5. 成功后打开 Web 工作台；
6. 失败后显示错误提示。

示例输入：

```text
明天下午三点提醒我确认会议纪要
```

### 4.3 后台新任务推送

必须实现：

1. 客户端启动后连接 WebSocket；
2. 收到 `task.created` 事件；
3. 展示任务卡片；
4. 卡片包含标题、内容、截止时间、创建人；
5. 支持确认；
6. 支持取消；
7. 支持稍后提醒；
8. 操作后调用任务接口；
9. 操作成功后卡片消失；
10. 操作失败后显示错误。

### 4.4 打开 Web 平台

必须实现：

1. 点击「打开工作台」打开 Web 首页；
2. 待办解析成功后打开：

```text
{WEB_BASE_URL}/workbench?todoDraftId={draftId}
```

3. 点击任务详情时打开：

```text
{WEB_BASE_URL}/calendar?taskId={taskId}
```

### 4.5 内网下载安装

第一版安装方式：

```text
开发打包
  ↓
生成 Windows 安装包
  ↓
上传到内网服务器
  ↓
员工访问内网下载页
  ↓
手动下载安装
```

---

## 5. 环境变量

在桌面端项目中新增：

```text
.env.development
.env.production
```

示例：

```env
VITE_APP_NAME=华力AI桌面助手
VITE_API_BASE_URL=http://127.0.0.1:8080/api
VITE_WEB_BASE_URL=http://127.0.0.1:5173
VITE_WS_URL=ws://127.0.0.1:8080/ws/desktop
VITE_ENABLE_MOCK=true
```

生产环境示例：

```env
VITE_APP_NAME=华力AI桌面助手
VITE_API_BASE_URL=http://内网服务器地址/api
VITE_WEB_BASE_URL=http://内网服务器地址
VITE_WS_URL=ws://内网服务器地址/ws/desktop
VITE_ENABLE_MOCK=false
```

---

## 6. 推荐目录结构

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
│  ├─ stores/
│  │  ├─ mascot.ts
│  │  ├─ task.ts
│  │  └─ user.ts
│  ├─ views/
│  │  ├─ MascotWindow.vue
│  │  └─ PanelWindow.vue
│  ├─ components/
│  │  ├─ MascotAvatar.vue
│  │  ├─ MascotBubble.vue
│  │  ├─ TodoInputBox.vue
│  │  ├─ TaskPushCard.vue
│  │  └─ TrayStatus.vue
│  ├─ services/
│  │  ├─ request.ts
│  │  ├─ auth.service.ts
│  │  ├─ todo.service.ts
│  │  ├─ task.service.ts
│  │  ├─ websocket.service.ts
│  │  ├─ window.service.ts
│  │  └─ mock.service.ts
│  ├─ types/
│  │  ├─ api.ts
│  │  ├─ todo.ts
│  │  ├─ task.ts
│  │  └─ mascot.ts
│  ├─ utils/
│  │  ├─ env.ts
│  │  ├─ storage.ts
│  │  └─ time.ts
│  └─ assets/
│     ├─ mascot/
│     │  └─ mascot.png
│     └─ styles/
│        ├─ base.css
│        └─ app.css
└─ src-tauri/
   ├─ tauri.conf.json
   ├─ capabilities/
   ├─ icons/
   └─ src/
      └─ main.rs
```

---

## 7. 类型定义

### 7.1 吉祥物状态

文件：

```text
src/types/mascot.ts
```

内容：

```ts
export type MascotStatus =
  | 'idle'
  | 'hover'
  | 'thinking'
  | 'remind'
  | 'success'
  | 'error'
```

### 7.2 待办解析结果

文件：

```text
src/types/todo.ts
```

内容：

```ts
export interface TodoParseRequest {
  source: 'desktop-mascot'
  inputType: 'text' | 'voice'
  text: string
  userId?: string
}

export interface TodoParseResult {
  title: string
  startTime?: string
  remindBeforeMinutes?: number
  assignee?: string
  priority?: 'low' | 'normal' | 'high'
  repeatRule?: string
}

export interface TodoParseResponse {
  confidence: number
  draftId: string
  needConfirm: boolean
  result: TodoParseResult
}
```

### 7.3 任务推送事件

文件：

```text
src/types/task.ts
```

内容：

```ts
export type TaskAction = 'confirm' | 'cancel' | 'later' | 'openDetail'

export interface DesktopEvent<T = any> {
  eventId: string
  eventType: string
  timestamp: string
  needAck?: boolean
  payload: T
}

export interface TaskCreatedPayload {
  taskId: string
  title: string
  content?: string
  deadline?: string
  priority?: 'low' | 'normal' | 'high'
  creatorName?: string
  actions?: Array<{
    key: TaskAction
    label: string
  }>
}

export interface TaskActionRequest {
  eventId: string
  taskId: string
  action: TaskAction
}

export interface TaskActionResponse {
  success: boolean
  taskStatus: string
  message: string
}
```

---

## 8. 接口约定

### 8.1 解析待办

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

### 8.2 任务操作

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

返回：

```json
{
  "success": true,
  "taskStatus": "confirmed",
  "message": "已确认任务"
}
```

### 8.3 WebSocket 新任务事件

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

---

## 9. Mock 模式要求

第一版后端接口可能还没全部完成。  
因此必须支持 mock 模式。

通过环境变量控制：

```env
VITE_ENABLE_MOCK=true
```

当 mock 开启时：

1. `todo.service.ts` 返回固定 draftId；
2. `task.service.ts` 返回操作成功；
3. `websocket.service.ts` 每隔 10 秒模拟一条 `task.created` 消息；
4. 方便前端先完成页面、状态和交互。

Mock 示例任务：

```json
{
  "eventId": "mock_evt_001",
  "eventType": "task.created",
  "timestamp": "2026-05-28 14:30:00",
  "needAck": true,
  "payload": {
    "taskId": "mock_task_001",
    "title": "确认会议纪要",
    "content": "请在今天下班前确认本周会议纪要内容。",
    "deadline": "2026-05-28 18:00:00",
    "priority": "normal",
    "creatorName": "系统管理员"
  }
}
```

---

## 10. 页面交互设计

### 10.1 默认状态

桌面上只显示一个小吉祥物。

视觉要求：

1. 不要像传统后台窗口；
2. 尺寸不要太大；
3. 圆润、轻量、友好；
4. 适合企业办公环境；
5. 鼠标悬停有轻微放大或发光。

### 10.2 点击吉祥物

点击后出现面板。

面板内容：

```text
华力 AI 桌面助手

[一句话创建待办...]

今日入口：
- 打开工作台
- 查看日历
- 查看智能体

最新任务：
任务卡片
```

### 10.3 任务卡片

任务卡片格式：

```text
新任务

确认下月规划会材料
请在今天 16:00 前确认材料内容

截止时间：2026-05-28 16:00
来自：系统管理员

[确认] [取消] [稍后]
```

### 10.4 待办创建成功

用户输入：

```text
明天下午三点提醒我确认会议纪要
```

接口成功后：

1. 吉祥物状态变为 `success`；
2. 显示提示：`已识别待办，即将打开工作台确认`;
3. 打开浏览器：

```text
{WEB_BASE_URL}/workbench?todoDraftId={draftId}
```

### 10.5 待办创建失败

显示：

```text
识别失败，请稍后重试
```

同时状态变为：

```text
error
```

2 秒后回到：

```text
idle
```

---

## 11. Tauri 配置要求

### 11.1 窗口配置

第一版至少需要一个主窗口。

建议配置：

```json
{
  "label": "main",
  "title": "华力AI桌面助手",
  "width": 420,
  "height": 520,
  "decorations": false,
  "transparent": true,
  "alwaysOnTop": true,
  "resizable": false,
  "visible": true
}
```

说明：

1. `decorations: false` 去掉系统标题栏；
2. `transparent: true` 用于透明背景；
3. `alwaysOnTop: true` 让吉祥物浮在桌面；
4. 如果透明窗口在某些电脑不稳定，允许临时改成浅色圆角窗口。

### 11.2 权限能力

需要配置以下能力：

1. 打开外部浏览器；
2. 系统托盘；
3. 通知；
4. WebSocket；
5. 窗口控制。

具体按 Tauri 2 capabilities 规则配置。

---

## 12. 服务文件职责

### 12.1 request.ts

职责：

1. 封装 axios；
2. 自动拼接 `VITE_API_BASE_URL`；
3. 统一处理 token；
4. 统一错误提示；
5. 返回接口 data。

### 12.2 todo.service.ts

职责：

1. `parseTodo(text: string)`；
2. 调用 `/api/ai/todo/parse`；
3. mock 模式返回固定数据。

### 12.3 task.service.ts

职责：

1. `handleTaskAction(params)`；
2. 调用 `/api/desktop/task/action`；
3. mock 模式返回成功。

### 12.4 websocket.service.ts

职责：

1. 连接 `VITE_WS_URL`；
2. 自动携带 token；
3. 监听 `task.created`；
4. 断线重连；
5. mock 模式模拟消息；
6. 将消息写入 task store。

### 12.5 window.service.ts

职责：

1. 打开 Web 工作台；
2. 打开日历任务详情；
3. 控制窗口显示隐藏；
4. 后续预留 deep link。

---

## 13. Store 设计

### 13.1 mascot store

状态：

```ts
status: MascotStatus
panelVisible: boolean
alwaysOnTop: boolean
message: string
```

方法：

```ts
setStatus(status)
togglePanel()
showMessage(message)
resetStatus()
```

### 13.2 task store

状态：

```ts
taskQueue: TaskCreatedPayload[]
currentTask: TaskCreatedPayload | null
```

方法：

```ts
pushTask(event)
removeTask(taskId)
handleAction(taskId, action)
```

### 13.3 user store

状态：

```ts
token: string
userInfo: UserInfo | null
clientId: string
```

第一版如果登录暂时没有接入，可以先用配置里的 mock token。

---

## 14. 内网下载页安装方案

### 14.1 打包命令

Windows 环境执行：

```bash
npm run tauri build
```

打包后产物一般在：

```text
src-tauri/target/release/bundle/msi/
src-tauri/target/release/bundle/nsis/
```

第一版建议优先提供：

```text
setup.exe
```

或者：

```text
.msi
```

如果员工自己双击安装，`setup.exe` 会更友好。  
如果后面要 IT 批量分发，优先用 `.msi`。

### 14.2 内网下载目录

在内网服务器 Nginx 上放置：

```text
/var/www/html/downloads/huali-ai-mascot/
├─ index.html
├─ huali-ai-mascot-setup-1.0.0.exe
├─ huali-ai-mascot-1.0.0.msi
└─ release-note-1.0.0.md
```

访问地址示例：

```text
http://内网服务器/downloads/huali-ai-mascot/
```

### 14.3 下载页内容

下载页至少包含：

```text
华力 AI 桌面助手

当前版本：1.0.0
更新时间：2026-05-28

下载 Windows 安装包

安装说明：
1. 点击下载安装包
2. 双击安装
3. 安装完成后桌面会出现「华力AI桌面助手」
4. 如被安全软件拦截，请联系信息技术部
```

### 14.4 版本命名

安装包命名规则：

```text
huali-ai-mascot-setup-1.0.0.exe
huali-ai-mascot-1.0.0.msi
```

版本号规则：

```text
主版本.次版本.修复版本
```

例如：

```text
1.0.0
1.0.1
1.1.0
```

---

## 15. Web 平台需要配合的改造

现有 Web 平台需要支持：

```text
/workbench?todoDraftId=xxx
```

逻辑：

1. 页面加载时读取 `todoDraftId`；
2. 调用草稿详情接口；
3. 展示待办确认弹窗；
4. 用户确认后创建待办；
5. 刷新日历；
6. 清理 URL 参数。

还需要支持：

```text
/calendar?taskId=xxx
```

逻辑：

1. 页面读取 taskId；
2. 定位任务；
3. 打开任务详情。

---

## 16. 第一版验收标准

### 16.1 桌面端验收

1. Windows 上可以正常安装；
2. 桌面能看到吉祥物；
3. 点击吉祥物能打开面板；
4. 可以输入一句话；
5. 可以调用解析接口；
6. 成功后能打开 Web 工作台；
7. 可以收到模拟任务或真实任务；
8. 任务卡片能显示；
9. 点击确认能调用接口；
10. 点击取消能调用接口；
11. 点击稍后能调用接口；
12. 托盘可以显示 / 隐藏 / 退出；
13. 关闭窗口后程序不异常；
14. 断开 WebSocket 后能重连。

### 16.2 Web 联动验收

1. Web 能识别 `todoDraftId`；
2. 能弹出待办确认；
3. 能创建待办；
4. 创建后日历刷新；
5. `taskId` 能打开任务详情。

### 16.3 安装验收

1. 安装包能在普通员工电脑上安装；
2. 安装完成能正常启动；
3. 内网下载页能访问；
4. 下载页能下载最新版安装包；
5. 安装说明清晰。

---

## 17. Codex 实现任务清单

请按以下顺序实现。

### 任务 1：初始化项目

1. 创建 Tauri 2 + Vue3 + TypeScript + Vite 项目；
2. 引入 Pinia；
3. 配置基础 CSS；
4. 配置环境变量；
5. 确保 `npm run dev` 和 `npm run tauri dev` 可运行。

### 任务 2：实现桌面窗口

1. 配置 Tauri 主窗口；
2. 无边框；
3. 透明背景；
4. 置顶；
5. 禁止缩放；
6. 页面中显示吉祥物图片；
7. 支持点击打开面板。

### 任务 3：实现基础 UI

实现以下组件：

1. `MascotAvatar.vue`
2. `MascotBubble.vue`
3. `PanelWindow.vue`
4. `TodoInputBox.vue`
5. `TaskPushCard.vue`

要求：

1. 视觉风格与现有 Web 平台保持一致；
2. 浅色背景；
3. 圆角卡片；
4. 蓝紫科技感点缀；
5. 不要传统后台风。

### 任务 4：实现服务层

实现：

1. `request.ts`
2. `todo.service.ts`
3. `task.service.ts`
4. `websocket.service.ts`
5. `window.service.ts`
6. `mock.service.ts`

要求：

1. 支持 mock 模式；
2. 支持真实接口模式；
3. 接口错误要有提示；
4. WebSocket 自动重连。

### 任务 5：实现一句话创建待办

流程：

1. 输入内容；
2. 校验不能为空；
3. 设置状态为 `thinking`；
4. 调用 `parseTodo`；
5. 成功后拿到 `draftId`；
6. 打开 `{WEB_BASE_URL}/workbench?todoDraftId={draftId}`；
7. 设置状态为 `success`；
8. 失败设置状态为 `error`。

### 任务 6：实现任务推送

流程：

1. 启动时连接 WebSocket；
2. 收到 `task.created`；
3. 写入 task store；
4. 展示 `TaskPushCard`；
5. 点击确认 / 取消 / 稍后；
6. 调用 `handleTaskAction`；
7. 成功后移除卡片；
8. 失败提示错误。

### 任务 7：实现托盘菜单

托盘菜单：

```text
打开工作台
显示助手
隐藏助手
退出
```

点击「打开工作台」：

```text
打开 VITE_WEB_BASE_URL
```

### 任务 8：打包安装包

1. 配置应用名称：`华力AI桌面助手`；
2. 配置图标；
3. 执行 `npm run tauri build`；
4. 输出 `.exe` 或 `.msi`；
5. 编写内网下载页 `index.html`；
6. 写清楚安装说明。

---

## 18. 第一版 UI 文案

### 18.1 面板标题

```text
华力 AI 桌面助手
```

### 18.2 输入框

```text
一句话创建待办...
```

### 18.3 按钮

```text
发送
打开工作台
查看日历
```

### 18.4 状态提示

```text
正在识别待办...
已识别待办，即将打开工作台确认
识别失败，请稍后重试
收到一个新任务
操作成功
操作失败，请重试
```

### 18.5 任务按钮

```text
确认
取消
稍后
查看详情
```

---

## 19. 注意事项

1. 第一版先不要写复杂 Rust 逻辑；
2. 能用前端完成的先用前端完成；
3. 系统能力只通过 Tauri 插件调用；
4. 所有接口地址从环境变量读取；
5. 不要把后端地址写死；
6. URL 中只传 `draftId` 和 `taskId`；
7. 不要把完整待办内容拼到 URL；
8. WebSocket 断线必须重连；
9. 任务操作要防止重复点击；
10. mock 模式必须保留，方便没有后端时演示。

---

## 20. 第一版交付物

第一版完成后，需要交付：

1. 桌面端源码；
2. Windows 安装包；
3. 内网下载页；
4. 安装说明；
5. 接口对接说明；
6. mock 演示说明；
7. 版本号 `1.0.0`；
8. 简单更新日志。

---

## 21. 第一版最终效果

员工电脑上会出现一个小吉祥物。

员工可以：

1. 点击它；
2. 输入一句话；
3. 自动打开 Web 工作台；
4. 确认创建待办；
5. 收到后台任务提醒；
6. 在桌面上点确认、取消或稍后处理。

这就是第一版最重要的产品价值：

```text
桌面入口
  +
AI 待办解析
  +
后台任务推送
  +
Web 平台联动
```

第一版只要这个闭环跑通，就可以给领导和同事试用了。
