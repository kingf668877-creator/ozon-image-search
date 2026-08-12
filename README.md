# OZON 图搜 (Search by Image)

OZON 俄罗斯电商平台的"以图搜商品"自动化实现。返回与查询图片相似的 OZON 商品列表。

## ⚠️ 重要警告

OZON 部署了非常严格的 anti-bot (Cloudflare-style WAF)：
- 自动 Node.js HTTP client / 自动化 Puppeteer / WARP SOCKS5 出口 IP 都会被 ban
- 单一 IP 频繁请求会触发 `abt_data` challenge JS（CAPTCHA-like challenge）
- OZON 服务端 `abt/result` 会返回 `{"ok":false}` 拒绝自动提交的 challenge token

**结论**：纯自动化方案行不通，**必须配合真人浏览器手动操作过 captcha**。

## 架构

```
┌─────────────────────────────────────────────┐
│ Browser (Chrome / Edge) with debug port      │
│ - 真人手动操作完成 captcha                    │
│ - 保留 cookies / 登录态                      │
└──────────────────┬──────────────────────────┘
                   │ CDP (WebSocket)
                   ▼
┌─────────────────────────────────────────────┐
│ Node.js script (extract-from-main.js)        │
│ - 导航 search-by-image URL                   │
│ - 从 .tile-root DOM 抓商品数据               │
│ - 保存到 ozon-products.json                   │
└─────────────────────────────────────────────┘
```

## 关键 API 路径

### 1. 图搜 URL (直接 GET)
```
https://www.ozon.ru/search-by-image?image_id={32-char-hex}x{32-char-hex}
```

返回 HTML 页面，主页 DOM tile-root 元素包含商品：
- url, title, image
- price (现价)
- oldPrice (原价/划线价)
- discount (-xx%)

**注意**：
- 第 1 次 GET 返回 307 redirect
- 第 2 次 GET 返回 200 OK + 真页面（或 403 captcha）
- 主页面没有 JSON-LD structured data
- 主页面没有 `__NUXT__.state.webSearchResults`

### 2. 上传图片 API (不需要，可选)
```
POST https://www.ozon.ru/api/composer-api.bx/_action/searchByImageUpload
Content-Type: multipart/form-data; boundary=xxx
```

请求字段：
- `sourceMetadata` (JSON 字符串)
- `url` (图片 URL) 或 `file` (二进制)

返回：`{ imageId, imageSrc }`

### 3. crop + search API
```
POST https://www.ozon.ru/api/composer-api.bx/_action/searchByImage
Content-Type: application/json
```

请求：
```json
{
  "imageId": "...",
  "cropRectangle": { "left": 0, "top": 0, "width": 1, "height": 1 }
}
```

返回：`{ redirectUri, resultId }`

`redirectUri` 类似 `/search?text=...&result=...`，浏览器访问得到图搜结果。

### 4. 必要 Headers

所有 API 请求必须带：
```
x-o3-app-name: dweb_client
x-o3-app-version: release_csma_20260807-1
x-o3-manifest-version: frontend-ozon-ru:906c0454d19508bf52bb83732870e6b8f3099bd1
x-page-view-id: <UUID>
x-page-previous: home | search
x-o3-parent-requestid: <from NUXT requestID>
```

## 关键 Cookies

| Cookie | 来源 | 用途 |
|--------|------|------|
| `__Secure-ETC` | 首次 GET / 时 OZON 设置 | session id |
| `abt_data` | 第 2 次 GET 时 OZON 设置 (captcha page) | anti-bot 状态 |

## 使用方法

### 准备
1. 安装 Node.js (≥18) + Chrome / Edge
2. `npm install puppeteer-core ws express multer`
3. 安装 Cloudflare WARP (可选，用于换 IP)

### 启动

```bash
node manual-launch.js
```

启动后：
1. 脚本打开 Chrome (debug port 9225) + 加载 OZON 主页
2. 你**手动操作**浏览器，必要时完成 captcha / 登录
3. 脚本检测到 OZON 主页加载后，自动访问 `search-by-image?image_id=...`
4. 自动滚动 + 提取商品数据 → 保存到 `ozon-products.json`

## 关键代码

### `extract-from-main.js` (主提取器)
- 导航 search-by-image 页面
- 从 `.tile-root` DOM 元素提取
- 一次性获取 url, title, image, price, oldPrice, discount

### `enrich-with-price.js` (价格补充)
- 访问每个商品详情页
- 从 JSON-LD structured data 提取精确价格
- （备用方案，主页价格已经足够时不需要）

## 输出格式

```json
{
  "imageId": "56f69f01ce8342799bf8931a630dac51x56f69f0117756d7ea6d53d033c8ce586",
  "timestamp": 1786548263430,
  "requestID": "185dfada21311cddc56547df13280dfe",
  "products": [
    {
      "url": "https://www.ozon.ru/product/sumka-kruglaya-na-plecho-4922346167/",
      "title": "Сумка круглая, на плечо",
      "price": "513 ₽",
      "oldPrice": "2 ₽",
      "discount": "−74%",
      "image": "https://ir-20.ozonstatic.cn/s3/multimedia-1-a/wc500/12075745114.jpg"
    }
  ]
}
```

## 已知限制

1. **首屏只渲染 8 个 tile** ——OZON 用 lazy load 加载更多商品
   - 解决：需要真实滚动 (CDP Input.dispatchMouseEvent 没生效)
2. **评分和评论数** 不在 tile-root 里（被截断）
   - 解决：需要去详情页从 JSON-LD 抓取
3. **JSON-LD 只在详情页** ——主页面没有 structured data
4. **价格 "1 ₽" / "2 ₽"** ——OZON 促销展示价，实际价格不正确
   - 解决：从详情页 JSON-LD 拿真实价格

## 文件说明

| 文件 | 用途 |
|------|------|
| `manual-launch.js` | 启动 Chrome + debug port + 引导流程 |
| `attach-ozon-tab.js` | CDP attach 到 OZON tab + 提取商品 |
| `extract-from-main.js` | 从主页 DOM 提取（推荐） |
| `extract-with-scroll.js` | 滚动加载 + 提取（待完善） |
| `enrich-with-price.js` | 详情页补充价格 |
| `ozon-image-api.js` | 底层 API 客户端（实验性） |
| `server.js` | HTTP server（与 React 前端对接） |
| `index.html` | 简易上传界面 |

## License

Internal project.