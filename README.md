# OZON 图搜 · 本地 Web 应用

OZON 俄罗斯电商平台的“以图搜款”自动化。**保留现有 1688 图搜风格的前端**，后端改为**接管本机已通过 captcha 的 Chrome 浏览器**（Chrome DevTools Protocol），不再依赖 headless Puppeteer 或代理池。

## 启动流程

### 1. 启动 Chrome（手动）

用调试端口打开 Chrome，**保证至少一个 `ozon.ru` 标签页是已登录并通过 captcha 的**：

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9225 ^
  --user-data-dir="C:\Users\Administrator\AppData\Local\Google\Chrome\User Data"
```

打开 https://www.ozon.ru，完成登录 / CAPTCHA，保持页面常驻。

### 2. 启动后端

```
cd F:\traehuihua\6a7c43465a320f293c88f40c\ozon-image-search
node server.js
```

启动后访问 http://localhost:5443/ ，浏览器应显示 1688 风格的上传界面。

### 3. 健康检查

```
curl http://localhost:5443/api/health
curl http://localhost:5443/api/session
```

`/api/session` 返回 `{ ok: true, tabs: [...] }` 表示已接管成功。

## 工作流

1. 用户在网页里上传图片或粘贴图片 URL（支持三种入口：批量上传、URL 批量、表格批量）。
2. 前端 POST 到 `/api/upload/:taskId` 或 `/api/upload_urls`。
3. 后端通过 `9225/json` 找到已打开的 OZON 标签页，连上 CDP WebSocket。
4. 在该浏览器上下文里调用 `searchByImageUpload` 拿到 `imageId`。
5. 用 `Page.navigate` 打开 `/search-by-image?image_id=...`。
6. 等待 DOM 就绪后用 `Page.evaluate` 抓 `.tile-root`（不再进入详情页），返回商品列表。
7. 前端轮询 `/api/status/:taskId`，完成后展示结果卡。

## 目录结构（产品化）

| 路径 | 作用 |
|------|------|
| `server.js` | Express 服务，默认 `--attach` 模式 |
| `src/ozonSearch.js` | CDP 接管 + 图搜 + `.tile-root` 提取 |
| `scripts/test-price-parse.js` | 金额解析单元测试 |
| `index.html` / `css/style.css` / `js/app.js` | 1688 风格前端（保留） |
| `docs/superpowers/specs/2026-08-13-ozon-image-search-webapp-design.md` | 本轮设计 spec |

> 旧的实验脚本（`cdp-*.js`、`extract-*.js`、`enrich-*.js`、`manual-*.js`、`ozon-image-api.js` 等）保留为历史记录，正式产品只依赖 `src/ozonSearch.js` + `server.js`。

## 设计要点

- **金额解析容错**：对 `2 016 ₽`、`\u202f2\u202f016\u00a0₽` 等俄语窄空格千分位，`num()` 直接 `replace(/[^\d]/g, '')` 拿到纯数字。
- **会话接管**：通过 `9225/json` 找 `url.includes('ozon.ru')` 的 tab，连接 `webSocketDebuggerUrl`；会话丢失时返回 `{ ok: false, code: 'no_ozon_tab' }`，前端可提示用户重新打开。
- **CDP 错误码**：`no_ozon_tab`、`captcha_required`、`access_restricted`、`upload_failed`、`navigation_timeout`，前端在进度卡片中按错误码显示不同提示。

## 安全说明

- 本仓库不再包含任何 GitHub Token。`origin` 已改为无凭据的 HTTPS URL；
- 推送凭据交给 Windows Credential Manager 或 `gh auth setup-git`；
- 上传的图片存在 `uploads/<taskId>/` 并已被 `.gitignore` 忽略。

## 已知限制

1. **首屏只渲染 8 张商品**（OZON 懒加载）——首屏够用，本轮不做“加载更多”。
2. **评分 / 评论数不总是可见**——只有 OZON 在 tile 里渲染了才抓得到；否则留空。
3. **必须在本机 Windows 上运行**——CDP 接管的是本地 Chrome，云端跑不通。

## License

Internal project.