# 桌面吉祥物与 Web 登录联动对接说明

## 目标

桌面吉祥物打包成 exe/app 后，需要根据当前 Web 登录用户接收站内消息。站内消息 WebSocket 地址是：

```txt
/websocket/{userId}
```

所以桌面端必须拿到真实登录用户的 `token` 和 `userId`，否则只能连接固定用户或 mock 用户，无法给多人正常推送消息。

## 桌面端当前状态

桌面端已经完成以下能力：

1. 启动时检查本地是否已有 `token + userId`。
2. 没有登录态时，在吉祥物上方显示登录提示。
3. 点击“去登录”后打开 Web 登录页：

```txt
{VITE_WEB_BASE_URL}/login?from=desktop&desktopCallback=huali-ai-mascot://auth-callback&state={state}
```

4. 桌面端已注册 Deep Link：

```txt
huali-ai-mascot://auth-callback
```

5. Web 回调成功后，桌面端会校验 `state`，保存身份信息，并提示：

```txt
登录成功，消息提醒已开启
```

6. 保存成功后，桌面端使用 `userId` 连接站内消息 WebSocket：

```txt
{VITE_SYS_MESSAGE_WS_BASE_URL}/websocket/{encodeURIComponent(userId)}
```

## 桌面端涉及文件

| 文件 | 作用 |
|---|---|
| `src/App.vue` | 控制登录态检查、登录按钮、回调成功后连接 WebSocket |
| `src/services/desktop-auth.service.ts` | 生成 `state`、监听 Deep Link、解析 Web 回调 |
| `src/services/window.service.ts` | 打开 Web 登录页、打开消息详情页 |
| `src/stores/user.ts` | 保存桌面端用户会话 |
| `src/utils/storage.ts` | 本地持久化 `token/userInfo/state` |
| `src/services/sys-message.service.ts` | 连接 `/websocket/{userId}` 并处理 `sys_message` |
| `src/components/AuthLoginTip.vue` | 未登录时的吉祥物提示卡 |
| `src/components/SysMessageTip.vue` | 收到站内消息后的提示卡 |
| `src-tauri/tauri.conf.json` | 注册 `huali-ai-mascot` Deep Link scheme |
| `src-tauri/src/main.rs` | 初始化 `deep-link` 和 `single-instance` 插件 |

## 环境变量

桌面端生产环境需要配置：

```env
VITE_WEB_BASE_URL=https://你的Web域名
VITE_SYS_MESSAGE_WS_BASE_URL=https://你的Web或后端域名
VITE_ENABLE_MOCK=false
VITE_USE_MOCK_API=false
```

说明：

- `VITE_WEB_BASE_URL`：点击“去登录”时打开的 Web 地址。
- `VITE_SYS_MESSAGE_WS_BASE_URL`：桌面端会自动转成 `ws://` 或 `wss://`，并拼接 `/websocket/{userId}`。
- `VITE_DESKTOP_USER_ID` 只适合临时内测固定用户，正式多人使用不要配置固定值。

## Web 端需要配合的内容

Web 端需要识别桌面端登录请求，并在登录成功或已登录时回调桌面端。

### 1. 识别桌面端登录参数

桌面端打开 Web 登录页时会带这些 query：

```txt
from=desktop
desktopCallback=huali-ai-mascot://auth-callback
state=随机字符串
```

Web 端判断方式：

```ts
const isDesktopAuth = route.query.from === 'desktop'
const desktopCallback = String(route.query.desktopCallback || '')
const desktopState = String(route.query.state || '')
```

只有同时满足以下条件才执行桌面端回调：

- `from === 'desktop'`
- `desktopCallback === 'huali-ai-mascot://auth-callback'`
- `state` 非空
- Web 已拿到当前用户 `token` 和 `profile.id`

### 2. Web 已登录时不要直接跳首页

当前 Web 路由守卫如果访问 `/login` 且已登录，会直接跳默认首页。这里需要先判断是否是桌面端登录请求。

伪代码：

```ts
function isDesktopAuthRoute(to) {
  return (
    to.path === '/login' &&
    to.query.from === 'desktop' &&
    to.query.desktopCallback === 'huali-ai-mascot://auth-callback' &&
    typeof to.query.state === 'string' &&
    to.query.state.length > 0
  )
}

router.beforeEach((to) => {
  const userStore = useUserStore()

  if (isDesktopAuthRoute(to) && userStore.isLoggedIn && userStore.profile?.id) {
    redirectDesktopAuthCallback({
      callback: String(to.query.desktopCallback),
      state: String(to.query.state),
      token: userStore.token,
      userId: userStore.profile.id,
      userName: userStore.profile.name,
      department: userStore.profile.department,
    })
    return false
  }

  // 原有登录守卫逻辑继续保留
})
```

### 3. Web 登录成功后回调桌面端

登录页 `submitLogin()` 成功拿到 token 和 profile 后，如果是桌面端登录请求，不要正常跳首页，直接回调桌面端。

示例：

```ts
function redirectDesktopAuthCallback(params: {
  callback: string
  state: string
  token: string
  userId: string
  userName?: string
  department?: string
}) {
  const url = new URL(params.callback)
  url.searchParams.set('token', params.token)
  url.searchParams.set('userId', params.userId)
  url.searchParams.set('state', params.state)

  if (params.userName) {
    url.searchParams.set('userName', params.userName)
  }

  if (params.department) {
    url.searchParams.set('department', params.department)
  }

  window.location.href = url.toString()
}
```

登录页成功逻辑中增加：

```ts
if (isDesktopAuth.value && desktopCallback.value && desktopState.value) {
  redirectDesktopAuthCallback({
    callback: desktopCallback.value,
    state: desktopState.value,
    token,
    userId: profile.id,
    userName: profile.name,
    department: profile.department,
  })
  return
}
```

### 4. 回调 URL 格式

Web 端最终需要打开：

```txt
huali-ai-mascot://auth-callback?token={token}&userId={userId}&userName={userName}&department={department}&state={state}
```

必填字段：

| 字段 | 必填 | 说明 |
|---|---:|---|
| `token` | 是 | Web 登录 token |
| `userId` | 是 | 当前登录用户 ID，用于连接 `/websocket/{userId}` |
| `state` | 是 | 桌面端发起登录时生成，桌面端会校验 |
| `userName` | 否 | 用户名，用于桌面端展示 |
| `department` | 否 | 部门，用于桌面端展示 |

## 站内消息格式

桌面端只处理 `type === "sys_message"` 的 WebSocket 消息。

示例：

```json
{
  "type": "sys_message",
  "id": 9,
  "msgSubject": "会议提醒",
  "msgContent": "标题：周会",
  "msgStatus": 0,
  "msgType": 1,
  "bizType": 2,
  "bizId": 88,
  "createTime": "2026-06-17T10:00:00"
}
```

收到后桌面端会在吉祥物上方展示：

- 标题：`msgSubject`
- 内容：`msgContent`
- 按钮：`查看详情`
- 按钮：`已读`

`已读` 只会本地隐藏，不调用已读接口。

## 查看详情跳转

点击“查看详情”时，桌面端会打开：

```txt
{VITE_WEB_BASE_URL}/calendar?desktopTodoId={bizId或消息id}&desktopMessageId={消息id}&desktopBizType={bizType}
```

Web 端如果要自动打开详情卡片，还需要在首页/日历页消费这些 query：

```txt
desktopTodoId
desktopMessageId
desktopBizType
```

建议逻辑：

1. 页面初始化后读取 `desktopTodoId`。
2. 如果存在，调用现有详情打开方法，加载对应待办/消息详情。
3. 打开成功或失败后清理 URL query，避免刷新重复打开。

## 测试流程

### 场景 1：首次启动，无登录态

1. 安装并启动桌面端。
2. 吉祥物上方出现登录提示。
3. 点击“去登录”。
4. 浏览器打开 Web 登录页。
5. Web 登录成功后跳回 `huali-ai-mascot://auth-callback?...`。
6. 桌面端提示“登录成功，消息提醒已开启”。
7. 后端向 `/websocket/{userId}` 推 `sys_message`。
8. 吉祥物上方展示消息提示卡。

### 场景 2：浏览器已登录

1. 桌面端点击“去登录”。
2. Web 端识别已登录，不展示登录表单。
3. Web 端直接回调桌面端。
4. 桌面端保存身份并连接 WebSocket。

### 场景 3：点击查看详情

1. 后端推送带 `bizId` 的 `sys_message`。
2. 桌面端显示提示卡。
3. 点击“查看详情”。
4. 浏览器打开 `/calendar?desktopTodoId=...`。
5. Web 端自动打开对应详情卡片。

## 安全说明

当前方案为了快速跑通，Web 回调会直接把 `token` 放在 Deep Link URL 中。这个方案可以用于内测，但正式生产更推荐后端提供短期授权码：

```txt
huali-ai-mascot://auth-callback?code={一次性code}&state={state}
```

然后桌面端调用后端接口：

```txt
POST /desktop/auth/exchange
```

用 `code` 换取真正的 `token/userId`。这样 token 不会暴露在浏览器地址栏或系统 URL 记录里，安全性更好。

## 当前限制

1. macOS Deep Link 需要安装后的 app 才能完整测试，直接 dev 模式不一定能触发系统协议。
2. Windows exe 场景已接入 `single-instance`，避免回调时打开第二个进程。
3. 如果 Web 不做 `from=desktop` 的识别和回调，桌面端无法自动获得真实用户身份。
4. 如果 Web 不消费 `desktopTodoId`，桌面端只能打开页面，不能自动展开详情卡片。
