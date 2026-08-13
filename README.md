# 會談紀錄表 — Offline Prototype

展覽客戶資料蒐集表單，單一 HTML 檔案，完全離線運作，零伺服器依賴。

---

## Demo

GitHub Pages：`https://art20217.github.io/exhibition_form/`

直接在平板或手機瀏覽器開啟即可使用，不需安裝任何應用程式。

---

## 這一版有什麼新東西

**v3.15.0** — 活動與欄位定義也會同步了（契約 v2），**兩台平板終於看得到彼此的紀錄**；
欄位由一台裝置擁有，其他平板唯讀、可一層確認接管。系統設定搬出「表單管理」，
改由活動列表的齒輪進入。

**v3.14.0** — 名片照片也會同步了（獨立端點、以內容摘要避免重傳）。並修掉一個隱私漏洞：
刪除紀錄時，伺服器上的照片先前不會跟著消失。

**v3.13.0** — 紀錄的前景同步真的接起來了：推送／拉取、四個觸發點、三種失敗分流，
外加 [`server/`](server/) 下一支零依賴的參考伺服器。**未設定伺服器時完全沒有動作**。

**v3.12.0** — 同步契約（[`docs/sync-contract.md`](docs/sync-contract.md)）與其所需的資料模型：
`updatedAt`、墓碑式軟刪除、`deviceId`。

**v3.11.0** — 修正填單日期差一天（時區換算錯誤，**已存的紀錄不會自動修正**）；
紀錄編輯頁可改訪談日期；活動管理模式下卡片不再是填單入口，改由「查看紀錄」進入；
國籍選定後仍顯示中文。

**v3.10.0** — 填單入口改為先選「新客戶／舊客戶」再選「從客戶資料開始／從客戶需求開始」；
移除「快速填單」。舊客戶跳過公司背景，新舊客戶會寫進紀錄並可匯出。

**v3.9.0** — 編輯紀錄時，選項類欄位改為只顯示已選中的值，每個欄位附一個「編輯」鈕開啟
彈窗修改；客戶填單流程不受影響。

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
| 同步協定（給實作伺服器的人） | [docs/sync-contract.md](docs/sync-contract.md) |
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
| 資料儲存 | IndexedDB v2（四個 Object Store：`config`、`events`、`records`、`fieldDefinitions`）。`fieldDefinitions` 以 `<活動 id>::<群組>` 為鍵，每場活動各有 customerFields / needsFields / companyFields / staffFields 四組定義；每筆 `records` 帶 `eventId`，並自 v3.12 起帶 `updatedAt` / `deletedAt`（墓碑）/ `deviceId`；`events` 自 v3.15 起同樣帶 `updatedAt` / `deletedAt`，外加 `ownerDeviceId`（誰能改這場活動的欄位定義）；`config` 為全域設定（PIN、裝置名稱、`deviceId`、GDPR 條文、遷移旗標，以及 v3.13 起的 `syncUrl` / `syncToken` / `syncSeq`、v3.15 起的 `syncEventSeq`） |
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
- **同步（v3.13）在未設定伺服器時完全不動作**，這是預設狀態。拉取只在活動列表或活動內頁進行（`pullAllowed()`）——把遠端資料蓋在使用者正在編輯的那筆上，會靜靜毀掉他的輸入。狀態列與更新橫幅同一個位置、同一條規則：**填單畫面上結構性地不存在**。
- **`state.records` 含 v3.12 的墓碑（軟刪除），永遠透過 `liveRecords()` 或 `eventRecords()` 讀取，不要直接讀；`state.events` 自 v3.15 起同理，讀取端一律走 `liveEvents()`。** 墓碑不保留任何欄位值，所以漏掉過濾時它會渲染成**一列空白**——用姓名比對的斷言看不到它。要抓這件事得驗筆數（`tests/e2e-sync-model.js` 對後台筆數與匯出的列數各有一條）。
- 欄位若標記 `source: 'event'`（接待人員、訪談日期、新舊客戶），代表其內容由活動頁供應。v3.5 移除了業務備註頁與該頁籤，這三個欄位在表單管理中不再有編輯介面——但**定義刻意保留**，因為資料紀錄的「接待人員」欄與匯出欄位都靠它們解析。唯一的例外是**訪談日期在紀錄編輯頁可改**（v3.11），因為它先前完全沒有修正途徑；另外兩個維持唯讀。

### 測試

```bash
npm ci
npx playwright-core install chromium   # 首次執行才需要
npm test                               # 27 支套件，約 8 分鐘
npm test -- pin-mobile events          # 只跑名稱含這些字串的套件
```

每次 push 與 PR 由 `.github/workflows/test.yml` 自動執行；失敗時截圖會上傳為 artifact。

套件依序執行，不能平行——每支各自起 HTTP server 並清空同一個 IndexedDB。涵蓋範圍包含完整填單流程、後台各頁籤、版面尺寸、資料紀錄欄位、匯出內容，以及 **v2 → v3.15 的每一段遷移**（各自植入該版本形狀的資料庫再驗證結果）。

`e2e-sync.js`、`e2e-photo-sync.js`、`e2e-event-sync.js` 用兩個 browser context 當兩台平板，跑真的參考伺服器——單台對伺服器證明不了什麼。

`e2e-timezone.js` 是唯一明寫 `timezoneId` 的套件，理由見下面的踩雷筆記。

寫測試前請先讀下面的**踩雷筆記**，其中兩則直接關於測試怎麼寫才抓得到問題。

### 已知限制

- **雲端同步需要自備伺服器。** v3.13 起客戶端可同步紀錄、v3.15 起連活動與欄位定義一起同步，但**正式伺服器尚不存在**——`server/` 下的是參考實作，用於測試與交付規格。未設定伺服器時 app 完全離線運作（[#8](https://github.com/art20217/exhibition_form/issues/8)、[#9](https://github.com/art20217/exhibition_form/issues/9)）。
- **欄位定義由一台裝置擁有。** 每場活動記一個 `ownerDeviceId`，只有它能改欄位；其他平板的欄位頁籤唯讀（收單與匯出不受影響），要改須先「接管欄位設定」。這與 PIN 一樣**只防誤觸，不是權限控制**——共用權杖之下，伺服器分不出刻意接管與冒名頂替（[#10](https://github.com/art20217/exhibition_form/issues/10)）。
- **同步伺服器必須是 https。** App 由 GitHub Pages 以 https 提供，瀏覽器會擋掉對 `http://` 位址的請求，所以「筆電接在展場 Wi-Fi 上」這個做法不通。部署方式見 [`server/README.md`](server/README.md)。
- **名片照片是單向的。** 平板會把照片上傳到伺服器，但拉取不帶照片，所以另一台平板拉到的紀錄不會有圖。
- **照片儲存佔用 IndexedDB 空間。** 壓縮後單張約 200～500KB，100 筆含照片約 20～50MB。iPad Safari 的 IndexedDB 配額通常足夠，但建議展後及時匯出並清除。
- **瀏覽器清除資料會遺失所有紀錄。** 確保平板已啟用螢幕鎖定密碼，避免他人誤操作。
- **不含 OCR 名片辨識。** 名片照片僅作為存檔，不自動擷取文字。
- **PIN 碼僅防止誤觸，不構成安全機制。** 活動管理、表單管理與客戶資料紀錄**共用同一組 PIN**，因此瀏覽頁「不能刪除、不能匯出」是流程上的區隔而非權限上的——拿到 PIN 的人一樣能自己進表單管理做這兩件事（[#10](https://github.com/art20217/exhibition_form/issues/10)）。
- **填單人員靠業務自行選擇，系統不驗證身分。** 換人接待時若忘了點「重新選擇」，紀錄會掛在上一位業務名下——活動頁上方的常駐橫幅就是為了讓這件事一眼看得出來。
- **活動之間的欄位設定不會互通。** 複製活動是一次性的深拷貝；建立之後修改任一方都不影響另一方。（跨**裝置**的同一場活動則會同步——v3.15 起。）
- **v3.11 之前用日期籤填的紀錄，訪談日期可能早一天**（僅限 UTC 以東的時區，例如台灣）。程式已修正，但既有紀錄**不會自動更正**——偏移後的值落在活動期間內時，與手動輸入的正確值無從分辨。請在客戶資料紀錄中逐筆核對，在編輯頁修改。

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

### 日期字串不要經過 `toISOString()`

`new Date('2026-09-23T00:00:00')` 解析成**本地**午夜，`toISOString()` 會轉成 UTC——
UTC+8 往回退 8 小時就跨過日界，得到 `2026-09-22`。活動日期籤曾經整組往前一天，
而且那個值會直接存進紀錄的訪談日期並帶進匯出。

**要日曆日就用本地欄位**（`getFullYear()` / `getMonth()` / `getDate()`，見 `ymd()`）；
`toISOString()` 只留給真正的時間戳記（`timestamp`、`createdAt`），那些記的是瞬間，UTC 才對。

**CI 跑在 UTC，這類 bug 在那裡完全不會發作。** 任何與日曆日有關的測試都必須明寫
`browser.newContext({ timezoneId: ... })`，而且值得同時測 UTC 的東、西兩側——只測一側
分不出「不該轉 UTC」和「偏移方向反了」。`tests/e2e-timezone.js` 就是這樣寫的。

### 本機修改的時間戳要蓋過它所修改的值

同步的衝突是比 `updatedAt` 決定的，而**平板的時鐘會走偏**。從一台快幾秒的平板拉來的
紀錄，`updatedAt` 可能還在未來；這時在本機刪除它，若墓碑只標記「現在」，它就比被刪的
紀錄還舊——同步判定墓碑落敗並丟棄，**刪除靜靜地沒有生效，而且哪裡都不會報錯**。

本機的每一次修改都要走 `nextUpdatedAt(prev)`：動了這筆紀錄，就有權取代它。
`tests/e2e-sync.js` 有一條刻意製造時鐘偏差的斷言守著。

**同一件事的極端版本：測試裡不要拿未來的 `updatedAt` 去戳共用的資料。** LWW 之下，
一個 2099 年的時間戳會贏過此後每一次合法修改，而且不報錯——`e2e-event-sync.js` 早期
版本用它去試探伺服器的擁有者規則，結果那場活動再也接受不了任何真實的變更，後面四條
斷言全紅，而失敗的畫面看起來像是接管功能壞了。**探測性的寫入要用自己的一份資料。**
（正式伺服器應該直接拒收時間遠在未來的資料，已寫進契約的檢查清單。）

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
│   └── e2e-*.js            #   27 支套件
├── .github/workflows/      # CI：每次 push 與 PR 跑完整測試
├── docs/
│   ├── sync-contract.md    #   同步協定規格（寫給日後實作伺服器的人）
│   └── wiki/               #   Wiki 頁面的原始檔（正本在 GitHub Wiki，見下方說明）
├── server/                 # 同步伺服器的參考實作（零依賴 Node，非正式服務）
├── package.json
├── CHANGELOG.md            # 版本沿革與資料遷移
└── README.md               # 本文件
```

仍然**沒有 build step**：`index.html` / `sw.js` / `manifest.webmanifest` / `icons/` 原樣部署到 GitHub Pages。`tests/`、`tools/` 與 `package.json` 只服務開發流程。

`server/` **不會部署到 Pages**，它是另外跑在自己主機上的東西——而且是參考實作，不是正式服務。

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
