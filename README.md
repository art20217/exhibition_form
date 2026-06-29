# 訪客資料登記表 — Offline Prototype

展覽客戶資料蒐集表單，單一 HTML 檔案，完全離線運作，零伺服器依賴。

---

## Demo

GitHub Pages：https://art20217.github.io/exhibition_form/

直接在平板或手機瀏覽器開啟即可使用，不需安裝任何應用程式。

---

## 功能總覽

### 表單模式（Exhibition Mode）

面向展覽現場的客戶與業務人員，流程如下：

```
語言選擇（EN / 繁中）
  → 客戶填寫表單
  → 送出 → 感謝頁面
  → 名片拍照（業務操作，可跳過）
  → 業務備註（可跳過）
  → 回到語言選擇，等待下一位
```

- **中英雙語切換：** 首頁選擇語言後，所有欄位標籤、按鈕文字、錯誤提示皆切換為對應語言。
- **動態表單欄位：** 依後台配置動態渲染，支援 text / email / tel（含國碼選單）/ select / checkbox-group / textarea。
- **輸入驗證：** 必填欄位檢查、Email 格式檢查，錯誤提示顯示在欄位下方。
- **GDPR 同意聲明：** 底部勾選框 + 聲明文字，未勾選不可送出。聲明文字可在後台自訂。
- **名片拍照存檔：** 客戶送出後由業務拍攝名片，照片經 Canvas API 壓縮（長邊 ≤1600px，JPEG 品質 0.8），存入 IndexedDB。支援預覽、重拍、跳過。
- **業務備註：** 顯示客戶姓名與公司（唯讀），業務填寫潛力評級、感興趣產品、自由備註等，允許跳過。

### 後台管理模式（Admin Panel）

透過畫面右上角齒輪圖示 → 輸入 4 位 PIN 碼進入（預設 `0000`）。

分為四個頁籤：

**Customer Fields** — 管理客戶填寫區的欄位，支援新增、編輯、刪除、排序。每個欄位可設定中英名稱、類型、是否必填、選項列表。預設五個核心欄位（Name / Company / Email / Phone / Inquiry Type）不可刪除但可編輯。

**Staff Fields** — 管理業務備註區的欄位，同樣支援完整的 CRUD 操作。預設三個欄位（Potential / Product of Interest / Notes）。

**Records** — 檢視所有已蒐集的紀錄，以表格呈現。顯示蒐集統計（筆數、含名片照片筆數）。支援逐筆刪除、檢視名片照片（點擊 📷 圖示放大）。

**Settings** — 設定裝置名稱（附加在每筆紀錄上，多台平板時用於辨識來源）、修改 Admin PIN、編輯 GDPR 同意聲明中英文。

### 資料匯出

後台 Records 頁籤點擊「Export Data」，瀏覽器端打包並下載一個 ZIP 檔案：

```
export_YYYYMMDD_HHMMSS.zip
├── records.xlsx
└── cards/
    ├── 001_CompanyName_ContactName.jpg
    ├── 002_CompanyName_ContactName.jpg
    └── ...
```

- **records.xlsx** 包含兩個工作表：「Records」（所有紀錄，電話欄位格式化為文字避免 Excel 吃掉開頭符號）與「Field Definitions」（當前欄位定義，供接手人員理解資料結構）。
- **cards/** 資料夾包含所有名片照片，檔名與 XLSX 中的 Card Photo Filename 欄位對應。無照片的紀錄不產生檔案。

### 資料清除

後台 Records 頁籤的「Clear All」按鈕，需輸入 `DELETE` 確認後才會執行，防止誤觸。

---

## 使用指南

### 展前準備

1. 用平板瀏覽器開啟表單網址（或直接開啟 `index.html` 檔案）。
2. 點擊右上角齒輪圖示，輸入 PIN `0000` 進入後台。
3. 進入 **Settings**：修改裝置名稱（如 `Tablet-A`）、修改 PIN、修改 GDPR 聲明文字（替換為公司名稱）。
4. 進入 **Customer Fields** / **Staff Fields**：依公司需求調整欄位和選項。例如在「Product of Interest」中新增產品線名稱。
5. 點擊「← Exit to Form」回到表單模式。
6. 如有多台平板，每台重複上述步驟，確保裝置名稱不同。

### 展覽現場操作

1. 客戶到訪時，讓客戶選擇語言並填寫基本資料，或由業務協助輸入。
2. 客戶按「Submit / 送出」後，業務可拍攝客戶名片（或跳過）。
3. 進入業務備註頁，填寫潛力評級和備註（或跳過）。
4. 系統自動回到語言選擇畫面，等待下一位客戶。

### 展後匯出

1. 進入後台 → Records 頁籤。
2. 點擊「Export Data」，等待 ZIP 檔案下載完成。
3. 解壓後用 Excel 開啟 `records.xlsx`，照片在 `cards/` 資料夾中。
4. 匯出確認無誤後，建議執行「Clear All」清除平板上的資料。

---

## 技術架構

| 項目 | 說明 |
|---|---|
| 檔案結構 | 單一 `index.html`，內含所有 CSS / JS / 函式庫 |
| 前端框架 | React（透過 Babel standalone 編譯）+ 自訂 DC 模板引擎 |
| 資料儲存 | IndexedDB（三個 Object Store：`config`、`records`、`fieldDefinitions`） |
| 照片處理 | Canvas API 壓縮後以 Base64 存入 IndexedDB |
| 匯出 | 內建 XLSX 生成 + ZIP 打包（ExportLib，inline 於 HTML 中） |
| 螢幕適配 | 響應式 CSS，`@media (max-width: 768px)` 斷點，支援 `safe-area-inset` 與 `100dvh` |
| 離線能力 | 完全離線，不依賴任何伺服器或網路連線 |
| 瀏覽器相容 | iPad Safari 16+、Chrome Android 100+、主流手機瀏覽器 |

### 已知限制

- **不具備雲端同步。** 多台平板的資料需各自匯出後手動合併。
- **照片儲存佔用 IndexedDB 空間。** 壓縮後單張約 200～500KB，100 筆含照片約 20～50MB。iPad Safari 的 IndexedDB 配額通常足夠，但建議展後及時匯出並清除。
- **瀏覽器清除資料會遺失所有紀錄。** 確保平板已啟用螢幕鎖定密碼，避免他人誤操作。
- **不含 OCR 名片辨識。** 名片照片僅作為存檔，不自動擷取文字。
- **PIN 碼僅防止誤觸，不構成安全機制。**

---

## 後續升級建議

此原型驗證了核心流程的可行性。以下是正式版建議的升級方向，按優先順序排列：

### Phase 1：PWA 化（Offline-First + Cloud Sync）

- 加入 Service Worker 實現正式的離線快取，使用者首次透過網路開啟後，即使完全離線也能正常使用。
- 實作背景同步（Background Sync API）：資料先寫入本機 IndexedDB，偵測到網路後自動同步至後端伺服器。
- 現場搭配 4G/5G 行動分享器作為主要網路來源。

### Phase 2：後端服務

- 照片上傳至物件儲存服務（如 AWS S3 / Azure Blob），資料庫僅存 URL。
- 多台平板的資料透過雲端自動合併，不需手動匯出。
- 匯出由伺服器端打包，不受瀏覽器記憶體限制。
- 展後自動寄送跟進信件（避免現場即時寄信，改為批次處理並正確設定 SPF/DKIM）。

### Phase 3：安全性與合規

- 實作 Web Crypto API 加密 IndexedDB 中的客戶資料。
- 使用者帳號與權限管理（區分管理員與一般業務）。
- GDPR 同意聲明文字由法務審定。
- 資料保留期限與自動清除策略。

### 技術債與改善項目

- 目前 XLSX 與 ZIP 生成邏輯為自行實作（ExportLib），inline 於 HTML 中。正式版不再受單一檔案體積限制，建議改用 SheetJS（xlsx）與 JSZip 等成熟函式庫，可獲得更完整的 Excel 格式支援（欄寬自動適應、凍結窗格、儲存格樣式等）與更可靠的跨瀏覽器相容性。
- 後台介面未做手機適配（僅表單模式有），如需在手機上管理後台需額外處理。
- 國碼選單目前為硬編碼列表，正式版可改為完整的國際電話國碼資料庫。
- 考慮加入裝置層級的安全提醒（iPad 引導式取用模式設定指引）。

---

## 授權

本專案為內部工具原型，不包含公開授權。內嵌的第三方函式庫授權如下：

- React / ReactDOM — MIT License
- Babel Standalone — MIT License

XLSX 生成與 ZIP 打包邏輯為自行實作（ExportLib），未使用 SheetJS 或 JSZip。
