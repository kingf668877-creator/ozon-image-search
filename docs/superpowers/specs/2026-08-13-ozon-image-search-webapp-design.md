# OZON 图搜 Web 应用化设计（方案 A）

日期：2026-08-13
作者：TRAE 会话
范围：把现有 `ozon-image-search` 实验脚本集收敛为一个本地 Web 应用，沿用 1688 图搜前端交互，部署到 GitHub 代码托管。

## 目标

1. 复用现有 `index.html` / `js/app.js` / `css/style.css` 三件套（已经实现的批量上传 / URL 输入 / 表格上传 / 进度轮询 / 结果分页 / 详情弹窗）。
2. 后端只替换图搜执行路径：放弃 headless Puppeteer + WARP 的“纯 API”模式（已被 WAF 标记），改走**接管已人工验证的本地 Chrome**（CDP）。
3. 图搜结果直接取 `.tile-root`（不再去逐个详情页），同时修复金额解析（窄空格千分位）。
4. 清理上一轮遗留的 GitHub 令牌泄漏：删除 `create-github-repo.js`、将 remote URL 改为不带凭据的标准地址、推送凭据交给 Windows Credential Manager / `gh auth setup-git`。

## 架构

```
┌────────────────────┐  同一台 Windows 主机
│  用户人工 Chrome    │  ← 已登录 OZON、已通过 captcha
│  --remote-debug    │
│  port=9225         │
└─────────┬──────────┘
          │ 9225/json -> webSocketDebuggerUrl
          ▼
┌────────────────────┐    fetch(.../searchByImageUpload)
│  src/ozonSearch.js │ ─► Page.navigate(/search-by-image?image_id=…)
│  (CDP via ws)      │ ─► Page.evaluate(.tile-root) -> JSON
└─────────┬──────────┘
          │  { ok, products:[{url,title,image,price,oldPrice,discount,rating,reviews}], imageId, redirectUri }
          ▼
┌────────────────────┐    /api/upload /api/upload_urls /api/search /api/status /api/results
│  server.js (Express)│
│  --attach (默认)    │
└─────────┬──────────┘
          │ JSON
          ▼
┌────────────────────┐
│  index.html + app.js│  ← 1688 风格 UI（保留）
└────────────────────┘
```

## 模块设计

### `src/ozonSearch.js`（新）

- `attachChrome({ port = 9225 })`
  - GET `http://127.0.0.1:9225/json`，找到 `url.includes('ozon.ru')` 的 tab；
  - 用 `ws` 连接其 `webSocketDebuggerUrl`，封装 `send(method, params)`；
  - 启用 `Page.enable` / `Runtime.enable`，返回会话句柄。
- `searchByImage(handle, { fileBuffer, fileName, url })`
  - 若 `fileBuffer` 存在：在浏览器内用 `FormData + Blob` 调 `https://www.ozon.ru/api/composer-api.bx/_action/searchByImageUpload`，拿 `imageId`；
  - 若 `url` 存在：把图片 URL 作为 `url` 字段上传，拿到 `imageId`；
  - 然后 `Page.navigate` 到 `https://www.ozon.ru/search-by-image?image_id=<imageId>`，等待 `document.body.innerHTML.length > 100000` 且不包含 captcha 文案（最多轮询 30 秒）；
  - 调用 `extractFromTiles` 返回 `{ ok, imageId, redirectUri, products }`。
- `extractFromTiles(handle)`
  - `Page.evaluate` 内联脚本，逐个 `.tile-root`：
    - 链接：`a[href*="/product/"]`；
    - 图片：`img` 的 `src` 或 `srcset` 第一项；
    - 标题：`.tsBody500Medium` 中 `textContent.trim().length > 5`；
    - 现价：`.c35_5_1-b2` / `[class*="tsHeadline500Medium"]`，**解析金额用 `text.replace(/[^\d]/g, '')`**，避免 `2 016 ₽` 被误读为 `2`；
    - 原价：`.c35_5_1-b` 中金额不等于现价的；
    - 折扣：`[class*="c35_5_1-b5"]` 文本匹配 `[−-]\d+%`；
    - 评分：匹配 `\d\.\d` 的小段文本；
    - 评论：tile 文本中匹配 `(\d+)\s*(?:отзыв|оцен)`。
  - 返回 `{ tilesFound, uniqueProducts, products }`。

### `server.js`（重写默认模式）

- 参数：`--attach`（默认）/ `--browser`（headless Puppeteer，备用）/ `--api`（纯 API，备用）。
- `--attach` 路径：
  - 启动时打印提示：“请先在本机 Chrome 打开 https://www.ozon.ru 并完成 captcha，启动时不要带 `--user-data-dir` 之外的参数”；
  - 上传/URL 接口照旧：`POST /api/upload/:taskId`、`POST /api/upload_urls`、`POST /api/search/:taskId`；
  - 搜索流程：`searchFn = (opts) => ozonSession.searchByImage({...})`，图片读取走 `fs.readFileSync(diskPath)` 或直接 `url`；
  - 新增 `GET /api/session`：返回 `{ ok: boolean, tabs: [{url, title}] }` 供前端检测 CDP 会话是否存在；
  - 新增 `GET /api/health`：返回 `{ mode: 'attach' | 'browser' | 'api', sessionOk }`。
- `--browser` 路径：保留现有 `browserSearchImage`，但**改用已经验证的浏览器会话**（`9225` 接管 + `Page.setLifecycleEnabled`），而不是 headless；
- `--api` 路径：保留现有 `apiSearchImage`（用 `ozon-image-api.js`），只作最后兜底，不做 WAF 对抗。

### 前端（无改动）

- `js/app.js` 已经实现了 `GET /api/tasks` 检测，新增 `/api/health` 调用即可；
- 进度轮询、结果渲染、JSON 导出、详情弹窗全部保留；
- 价格渲染 `₽ ${item.price}` 不变；如有 `oldPrice` / `discount` 直接显示在 mini-card / product-card。

### 安全 / Git

- 删除 `create-github-repo.js`；
- `origin` 改为 `https://github.com/kingf668877-creator/ozon-image-search.git`；
- `gh auth setup-git` 或 Windows Credential Manager 管理凭据；
- `.gitignore` 继续忽略 `uploads/`、`*.log`、`.env`、`ozon-*.json`、`ozon-products*.json`、`dump.html`、`*.warp-enabled`、`create-github-repo.js`（虽然已经删，仍保留兜底）；
- 不再写任何含明文 token 的脚本或注释。

## 数据流

1. 用户在前端 `index.html` 选择上传方式（文件 / URL / 表格）。
2. 前端把图片 POST 给 `server.js`：
   - 文件：`multipart/form-data` 到 `/api/upload/:taskId`；
   - URL：`application/json` 到 `/api/upload_urls`，`auto_search: true` 时立即异步执行。
3. `server.js` 启动后台 `startSearch(taskId)`：
   - 调 `ozonSession.attachChrome()` 拿到 CDP handle；
   - 调 `ozonSession.searchByImage({ fileBuffer | url })`；
   - 返回 `products` 写入 `task.results[name]`。
4. 前端每 2 秒 `GET /api/status/:taskId`，根据 `image_statuses` 渲染进度。
5. 完成后 `GET /api/results/:taskId`，前端 `renderResults` 按图片分组，每组展示 5 个 mini-card + “查看更多”弹窗。

## 错误处理

- `attachChrome()` 找不到 OZON tab → 抛 `no_ozon_tab`，前端在进度卡片中显示“未检测到 OZON 浏览器会话，请保持 Chrome 打开并完成验证”；
- `searchByImage` 收到 captcha 文案 → 抛 `captcha_required`，前端提示用户刷新 Chrome 重新验证；
- `extractFromTiles` 返回 0 条 → 返回 `{ ok: true, products: [] }`，前端显示“未找到匹配商品”；
- 上传/URL 解析失败 → `task.results[name].error` 写入，前端 `image_statuses` 显示 `failed`。

## 测试

1. **本地端**：人工启动 Chrome、登录、刷新；`node server.js`；浏览器打开 `http://localhost:5443/`；上传示例图 → 检查 `.tile-root` 提取数量 ≥ 8、商品卡显示价格/评分/链接。
2. **CDP 会话**：用 `GET /api/health` 验证 `sessionOk: true`。
3. **金额容错**：单元脚本 `node scripts/test-price-parse.js`，覆盖 `2 016 ₽`、`1 250 ₽`、纯数字、含 `₽` 空格等样本。
4. **Git 推送**：`git push origin main`，凭据走 `gh auth setup-git`。

## 不做（YAGNI）

- 不做 OZON 全量懒加载/翻页：首屏 8 条够用；
- 不做 headless Puppeteer 的生产模式：保留 `--browser` 作为本地备用；
- 不把服务部署到云：CDP 必须接本地 Chrome；
- 不重写前端：1688 风格已经验证。

## 风险

- **CDP 会话稳定性**：浏览器崩溃或关闭 → 后端下次请求时找不到 tab，必须返回明确错误；
- **价格字段不稳定**：OZON className 可能改版；遇到抓不到价格时退化为 JSON-LD（仅对 `oldPrice === ''` 的产品尝试一次详情页）；
- **Git 凭据残留**：先 `git remote -v` 确认 URL 中无 token 才允许 push。