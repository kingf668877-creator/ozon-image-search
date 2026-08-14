# OZON 批量图搜找爆品

借助浏览器自动化调用 OZON 官网图搜接口，支持批量上传图片，自动定位相似商品，附带价格、评分、销量等多维度信息。

- **三种批量方式**：图片批量上传、链接批量上传、表格批量上传（解析 Excel/CSV 中的图片链接列）
- **浏览器接管**：复用本机已登录 OZON 的 Chrome 会话
- **结果展示**：源图缩略图、商品图、价格、评分、销量
- **结果导出**：JSON / Excel / CSV
- **批量并发**：服务端通过浏览器内 fetch 并发调用 OZON 接口，单 CDP handle 即可支撑 3 路并发搜索

## 快速开始

```bash
# 安装依赖
npm install

# 启动后端（端口 5443，CDP 端口 9225）
node server.js

# 浏览器打开
open http://localhost:5443/
```

### 准备工作

1. 启动本机 Chrome / Edge，开启远程调试端口：`--remote-debugging-port=9225`
2. 在浏览器中打开 https://www.ozon.ru 并完成登录 / captcha
3. 后端会自动接管该 OZON 页面

### 启动 Chrome（手动）

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9225 ^
  --user-data-dir="C:\Users\<you>\AppData\Local\Google\Chrome\User Data"
```

打开 https://www.ozon.ru，完成登录 / CAPTCHA，保持页面常驻。

### 启动 Chrome（脚本化：headless / 守护）

`scripts/` 下提供三个 PowerShell 脚本：

- `start-ozon-headless.ps1` — 启动无窗口 Chrome（`--headless=new`），复用同一 user-data-dir；
- `start-ozon-visible.ps1` — 启动有窗口 Chrome，专用于一次性登录 OZON；
- `watch-ozon-chrome.ps1` — 守护进程：CDP 不可达或缺少 OZON 标签页时自动重启。

典型用法：

```powershell
# 一次性：开有窗口 Chrome 完成 OZON 登录
powershell -ExecutionPolicy Bypass -File scripts/start-ozon-visible.ps1

# 关闭窗口后，转 headless 常驻
powershell -ExecutionPolicy Bypass -File scripts/start-ozon-headless.ps1

# 持续守护（建议加到任务计划程序“登录时启动”）
powershell -ExecutionPolicy Bypass -File scripts/watch-ozon-chrome.ps1
```

环境变量：
- `OZON_CHROME_PATH`（默认 `C:\Program Files\Google\Chrome\Application\chrome.exe`）
- `OZON_CDP_PORT`（默认 `9225`）
- `OZON_PROFILE_DIR`（默认 `%LOCALAPPDATA%\OzonImageSearchChrome`，与 headless 共享 Cookie）

## 健康检查

```bash
curl http://localhost:5443/api/health
curl http://localhost:5443/api/session
```

`/api/session` 返回 `{ ok: true, tabs: [...] }` 表示已接管成功。

## 工作流

1. 用户在网页里上传图片或粘贴图片 URL（支持三种入口：批量上传、URL 批量、表格批量）。
2. 前端 POST 到 `/api/upload/:taskId` 或 `/api/upload_urls`（支持分片，每片 100 条，跨分片使用同一 `task_id` 累积；只有最后一片会真正触发搜索）。
3. 后端在已登录 OZON 的 Chrome 标签页里，通过 CDP 并发执行 `fetch('/api/composer-api.bx/_action/searchByImageUpload', ...)` 上传图片，再用 `fetch('/api/entrypoint-api.bx/page/json/v2?url=...')` 拉取商品 JSON。
4. 后端解析 `tileGridDesktop` widget，提取商品标题、价格、折扣、评分、评价数、图片。
5. 前端轮询 `/api/status/:taskId`，完成后展示结果卡。

## 目录结构

| 路径 | 作用 |
|------|------|
| `server.js` | Express 服务，调度与任务管理 |
| `src/ozonHttp.js` | 浏览器内并发 fetch（HTTP 代理模式） |
| `src/ozonSearch.js` | 接管模式（navigate + DOM） |
| `src/ozonSession.js` | 会话凭证与 OZON 标签页发现 |
| `src/ozonParse.js` | tileGridDesktop 结果解析 |
| `index.html` / `css/style.css` / `js/app.js` | 前端 UI |
| `scripts/` | Chrome 启动与守护脚本 |
| `docs/superpowers/specs/` | 设计 spec |

## 配置

环境变量：
- `OZON_MODE`（默认 `http`）：`http` 走浏览器代理；`attach` 走旧接管模式
- `OZON_HTTP_CONCURRENCY`（默认 3）：服务端 worker 并发搜索数
- `OZON_CDP_PORT`（默认 9225）：Chrome 远程调试端口
- `PORT`（默认 5443）：后端服务端口

启动方式：
- `node server.js` — 接管已开启远程调试的本机 Chrome
- `OZON_MODE=attach node server.js` — 退回旧 navigate+DOM 模式

## 设计要点

- **金额解析容错**：对 `2 016 ₽`、`\u202f2\u202f016\u00a0₽` 等俄语窄空格千分位，`num()` 直接 `replace(/[^\d]/g, '')` 拿到纯数字。
- **评分 / 评价数**：从 `tileGridDesktop` 的 `mainState[].labelListV2.items` 解析（`text.text.text` 嵌套）；无评分时留空。
- **分批下载再搜索**：`/api/upload_urls` 接收 `is_last_batch` 与 `expected_total`，只有最后一批下载完毕才触发搜索，避免 2000 张任务前几张还没下载就开始搜索而失败。
- **会话接管**：通过 `9225/json` 找 `url.includes('ozon.ru')` 的 tab，连接 `webSocketDebuggerUrl`；会话丢失时返回 `{ ok: false, code: 'no_ozon_tab' }`，前端可提示用户重新打开。
- **CDP 错误码**：`no_ozon_tab`、`captcha_required`、`access_restricted`、`upload_failed`、`navigation_timeout`，前端在进度卡片中按错误码显示不同提示。
- **生命周期清理**：页面关闭 / 刷新时通过 `pagehide` 事件 + `fetch keepalive` 通知后端清理该 tab 的上传文件（按 `ownedTaskIds` 批量），避免磁盘堆积且不影响其他 tab。
- **URL 上传安全**：URL 模式下后端先把图片下载到本地（推断后缀），后续 `runSearch` 自动走本地路径，避免 OZON URL 上传的 CORS 问题。

## 安全说明

- 本仓库不包含任何 GitHub Token / Cookie。
- 上传的图片存在 `uploads/<taskId>/` 并已被 `.gitignore` 忽略。

## 已知限制

1. **首屏只渲染少量商品**（OZON 懒加载）——首屏够用，本轮不做"加载更多"。
2. **必须在本机 Windows 上运行**——CDP 接管的是本地 Chrome，云端跑不通。
3. **滑块 / CAPTCHA** — OZON 偶尔弹验证，需在浏览器里手动通过一次后 Cookie 才能继续使用。

## License

Internal project.
