# 會談紀錄表 — Offline Prototype

展覽客戶資料蒐集表單，單一 HTML 檔案，完全離線運作，零伺服器依賴。

---

## Demo

GitHub Pages：`https://art20217.github.io/exhibition_form/`

直接在平板或手機瀏覽器開啟即可使用，不需安裝任何應用程式。

---

## 這一版有什麼新東西

**v3.8.0** — 新增「客戶資料紀錄」瀏覽頁（可查詢與編輯，不能刪除或匯出）、
「快速填單」入口（跳過公司背景）、訪客國籍改為可搜尋的 60 國選單；App 更名為
「會談紀錄表」。

完整版本沿革與**資料遷移說明**見 **[CHANGELOG.md](CHANGELOG.md)**。

---

## 文件放在哪裡

| 你要找的 | 位置 |
|---|---|
| 怎麼操作（展前、現場、展後） | **[Wiki — 使用指南](https://github.com/art20217/exhibition_form/wiki)** |
| 系統有哪些功能 | **[Wiki — 功能總覽](https://github.com/art20217/exhibition_form/wiki)** |
| 版本沿革、資料遷移 | [CHANGELOG.md](CHANGELOG.md) |
| 後續規劃、技術債 | [Issues](https://github.com/art20217/exhibition_form/issues) |
| 技術架構、改程式碼要注意什麼 | 本文件以下的內容 |

操作說明放 Wiki，是因為讀者是展場接待人員，不該為了看步驟而讀一個程式碼倉庫。
技術文件刻意留在 repo：**Wiki 是獨立的 git 倉庫**，不在 clone 裡、不進 PR、CI 也看不到，
放在那裡的技術內容會逐漸與程式碼脫節。

---

## 技術架構

| 項目 | 說明 |
|---|---|
| 檔案結構 | 單一 `index.html`，內含所有 CSS / JS / 函式庫，原始碼直接可讀可改 |
| 前端框架 | React 18.3.1 UMD（內嵌）+ DC 模板引擎（dc-runtime，內嵌） |
| 資料儲存 | IndexedDB v2（四個 Object Store：`config`、`events`、`records`、`fieldDefinitions`）。`fieldDefinitions` 以 `<活動 id>::<群組>` 為鍵，每場活動各有 customerFields / needsFields / companyFields / staffFields 四組定義；每筆 `records` 帶 `eventId`；`config` 為全域設定（PIN、裝置名稱、GDPR 條文、遷移旗標） |
| 照片處理 | Canvas API 壓縮後以 Base64 存入 IndexedDB |
| 匯出 | 內建 XLSX 生成 + ZIP 打包（ExportLib，inline 於 HTML 中） |
| 拖曳排序 | Pointer Events 自製實作（相容 iPad Safari 觸控，不依賴 HTML5 Drag & Drop） |
| 螢幕適配 | 響應式 CSS，`@media (max-width: 768px)` 斷點，支援 `safe-area-inset` 與 `100dvh` |
| 離線能力 | 完全離線，所有依賴皆已內嵌，不需任何網路連線。v3.7.0 起另有 Service Worker 快取應用外殼，可安裝為主畫面 App |
| 瀏覽器相容 | iPad Safari 16+、Chrome Android 100+、主流手機瀏覽器 |

### 修改指南

`index.html` 結構由上而下：App 樣式 → React / ReactDOM UMD → dc-runtime → ExportLib → `x-dc` 模板（畫面標記）→ `text/x-dc` 邏輯腳本（`Component` 類別）。日常修改只需動最後兩段。注意事項：

- 模板內具嚴格 HTML 解析規則的元素以 `sc-raw-` 前綴書寫（`sc-raw-select`、`sc-raw-table`、`sc-raw-tr` 等），瀏覽器解析時才能保留其中的 `sc-for` / `sc-if` 子節點，dc-runtime 會在渲染時還原。
- 真正的 `<x-dc>` 模板元素之前，檔案中不可出現字面上的 x-dc 開頭標籤序列（dc-runtime 以第一個出現位置定位模板）。
- 選項的 `en` 是**紀錄實際儲存的值**，`zh` 只用於顯示。要改 `en` 就必須同步改寫已蒐集紀錄中的值（見 `loadAllData` 中的 `VALUE_RENAMES`），否則舊答案會對不上選項；只改中文標籤則用 `labelFixes`，以「原值」比對，後台已自訂過的標籤不會被覆蓋。
- `state` 的 `customerFields` / `needsFields` / `companyFields` / `staffFields` 永遠是**目前開啟活動**的定義，所以表單、後台、匯出等讀取端不需要知道活動的存在；只有存取 IndexedDB 的那一層（`saveEventDefs` / `loadEventDefs` / `defKey`）需要帶活動前綴。
- 欄位若標記 `source: 'event'`（接待人員、訪談日期），代表其內容由活動頁供應。v3.5 移除了業務備註頁與該頁籤，這兩個欄位不再有任何編輯介面——但**定義刻意保留**，因為資料紀錄的「接待人員」欄與匯出欄位都靠它們解析。

### 測試

```bash
npm ci
npx playwright-core install chromium   # 首次執行才需要
npm test                               # 18 支套件，約 4.5 分鐘
npm test -- pin-mobile events          # 只跑名稱含這些字串的套件
```

每次 push 與 PR 由 `.github/workflows/test.yml` 自動執行；失敗時截圖會上傳為 artifact。

套件依序執行，不能平行——每支各自起 HTTP server 並清空同一個 IndexedDB。涵蓋範圍包含完整填單流程、後台各頁籤、版面尺寸、資料紀錄欄位、匯出內容，以及 **v2 → v3.8 的每一段遷移**（各自植入該版本形狀的資料庫再驗證結果）。

寫測試前請先讀下面的**踩雷筆記**，其中兩則直接關於測試怎麼寫才抓得到問題。

### 已知限制

- **不具備雲端同步。** 多台平板的資料需各自匯出後手動合併。
- **照片儲存佔用 IndexedDB 空間。** 壓縮後單張約 200～500KB，100 筆含照片約 20～50MB。iPad Safari 的 IndexedDB 配額通常足夠，但建議展後及時匯出並清除。
- **瀏覽器清除資料會遺失所有紀錄。** 確保平板已啟用螢幕鎖定密碼，避免他人誤操作。
- **不含 OCR 名片辨識。** 名片照片僅作為存檔，不自動擷取文字。
- **PIN 碼僅防止誤觸，不構成安全機制。** 活動管理、表單管理與客戶資料紀錄**共用同一組 PIN**，因此瀏覽頁「不能刪除、不能匯出」是流程上的區隔而非權限上的——拿到 PIN 的人一樣能自己進表單管理做這兩件事（[#10](https://github.com/art20217/exhibition_form/issues/10)）。
- **填單人員靠業務自行選擇，系統不驗證身分。** 換人接待時若忘了點「重新選擇」，紀錄會掛在上一位業務名下——活動頁上方的常駐橫幅就是為了讓這件事一眼看得出來。
- **活動之間的欄位設定不會同步。** 複製活動是一次性的深拷貝；建立之後修改任一方都不影響另一方。

---

## 踩雷筆記

這幾件事各自造成過一次真實的故障，動到相關程式碼前請先讀。

### dc-runtime 沒有 pointer 事件

模板中寫 `onpointerdown` **不會生效**。`EVENT_MAP` 沒有這個項目，fallback 產生的是 `onPointerdown`（大小寫錯誤），React 直接忽略——處理器不會執行，也不會報錯。國籍選單的選項一度就是這樣靜靜地失效。可用的事件請參考 `EVENT_MAP`。

### 不要用 `-webkit-textfield-decoration-container` 隱藏密碼欄圖示

它**不是圖示**，而是 WebKit 用來包住輸入框 inner editor（真正可輸入的區域）的容器。
隱藏它等於把可輸入區一起拿掉——欄位仍能取得焦點（iOS 會彈出鍵盤），但沒有東西可顯示、
也沒有東西可打字。**Blink 根本沒有實作這個 pseudo-element**，所以 headless Chromium
測不出來。要隱藏圖示請只針對個別的裝飾按鈕（`::-webkit-credentials-auto-fill-button` 等）。

### Service Worker 的兩條規則

寫在 `sw.js` 檔頭，都源自「客戶手上的展場平板」這個環境：

1. **絕不自己接管**——沒有 `skipWaiting()`。新版本裝好後停在 `waiting`，由頁面決定何時套用，
   而且只在活動首頁提供，客戶填到一半的畫面永遠不會在腳下被重整。
2. **絕不變成救不回來**——`?sw=off` 解除註冊並清空快取（`?sw=on` 復原）。停用狀態持久化，
   否則重新載入會立刻註冊回去；若壞的正是 SW 本身，那等於毫無用處。

發布新版時，`index.html` 的版本字串與 `sw.js` 的 `VERSION` **必須一致**。

### 測試相關

- **不要用 `locator.fill()` 驅動輸入框。** 它直接指派 `.value` 再派發一次 `input` 事件，
  完全不經過瀏覽器的 inner editor——上面那個「手機打不了 PIN 碼」的 bug 就是這樣躲過
  整個套件的。一律用 `click()` + `pressSequentially()`。
- **headless Chromium 不等於使用者的瀏覽器。** Blink 沒有實作的 WebKit 專屬
  pseudo-element，誤用在本機完全測不出來。這類情況改為斷言 CSS 規則本身
  （見 `tests/e2e-pin-mobile.js` 末段的靜態防護）。

---

## 檔案清單

```
exhibition_form/
├── index.html              # 完整應用程式（單一自包含檔案，約 440KB，原始碼可讀）
├── sw.js                   # Service Worker（離線快取；版本字串須與 index.html 一致）
├── manifest.webmanifest    # PWA manifest（standalone）
├── icons/                  # 主畫面圖示（由 tools/make-icons.js 產生）
├── tools/make-icons.js     #   圖示產生器，僅在圖案變更時重跑
├── tests/                  # 端到端測試（Playwright 驅動 headless Chromium）
│   ├── helpers.js          #   共用導覽、IndexedDB 讀寫、瀏覽器啟動
│   ├── run-all.js          #   依序執行全部套件的 runner
│   └── e2e-*.js            #   18 支套件
├── .github/workflows/      # CI：每次 push 與 PR 跑完整測試
├── docs/wiki/              # Wiki 頁面的原始檔（正本在 GitHub Wiki，見下方說明）
├── package.json
├── CHANGELOG.md            # 版本沿革與資料遷移
└── README.md               # 本文件
```

仍然**沒有 build step**：`index.html` / `sw.js` / `manifest.webmanifest` / `icons/` 原樣部署到 GitHub Pages。`tests/`、`tools/` 與 `package.json` 只服務開發流程。

`docs/wiki/` 是 Wiki 頁面的**原始檔**，方便在 PR 中一起審閱；**正本是 GitHub Wiki**，改完這裡記得同步過去（Wiki 是獨立的 git 倉庫，不會自動跟著更新）。

> **發布新版時務必同步 `sw.js` 的 `VERSION` 與 `index.html` 的版本字串。** 兩者不一致代表新的 HTML 會沿用舊的快取名稱，所有平板都會停在舊版且無從察覺。`e2e-pwa.js` 有一條斷言擋這件事。
>
> **SW 相關的變更無法用 artifact 預覽驗證**——artifact 跑在沙箱 iframe 且 CSP 嚴格，Service Worker 註冊不會生效。必須在 GitHub Pages 上測。

---

## 授權

本專案為內部工具原型，不包含公開授權。內嵌的第三方函式庫授權如下：

- React / ReactDOM 18.3.1（UMD）— MIT License
- dc-runtime — 專案內部模板引擎

XLSX 生成與 ZIP 打包邏輯為自行實作（ExportLib），未使用 SheetJS 或 JSZip。
