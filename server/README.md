# 參考伺服器

實作 [`docs/sync-contract.md`](../docs/sync-contract.md) 的零依賴 Node 伺服器。

**這不是正式服務。** 它有兩個用途：

1. 給 `tests/e2e-sync.js` 一個講話的對象
2. **交給日後實作正式伺服器的人，當一份可以執行的規格**

第二點是它刻意寫成純 Node、用 JSON 檔存資料的原因。改用 Cloudflare Workers、
D1、R2 或任何平台原生服務會更短也更省事，但那會把契約綁在某一家廠商的資料層上——
而公司要自己重做一遍。

每次寫入都會把整份資料讀出再寫回。展場幾台平板的量完全夠用，而且檔案打開就看得懂；
真正實作的人請換成資料庫，**把可觀察的行為保留下來**。

---

## 跑起來

**從 repo 根目錄執行。** `server/index.js` 是相對路徑，在別的目錄下會得到
`Cannot find module '…\server\index.js'`。

```bash
git clone https://github.com/art20217/exhibition_form.git
cd exhibition_form
node server/index.js --token dev-token
# 同步伺服器：http://localhost:3000/v1
```

Windows（PowerShell）除了路徑分隔符之外完全相同：

```powershell
git clone https://github.com/art20217/exhibition_form.git
cd exhibition_form
node server\index.js --token dev-token
```

> **`server/` 需要 v3.12 以上。** 若 `master` 上還沒有這個目錄，代表對應的 PR 尚未合併，
> 先合併，或 `git checkout` 到那條功能分支。

不需要 `npm install`——這支伺服器零依賴，只用 Node 內建模組。

| 參數 | 預設 | 說明 |
|---|---|---|
| `--port` | `3000` | 監聽埠 |
| `--data` | `server/data` | 資料目錄（`records.json` 與 `photos/`） |
| `--token` | 無 | 逗號分隔的權杖清單，**必填**。也可用環境變數 `SYNC_TOKENS` |

平板端在「表單管理 → 系統設定」填入同步伺服器網址（含 `/v1`）與其中一組權杖。

---

## 權杖

**多組、可個別撤銷，這是刻意的。** 權杖以明文存在平板的 IndexedDB 裡，只靠後台 PIN 遮蔽，
而那組 PIN 是共用的四位數、只防誤觸。所以平板遺失時**唯一的補救是從伺服器端撤銷**——
一台一組權杖，撤掉那一組，其他平板不受影響。

```bash
node server/index.js --token tablet-a-xxxx,tablet-b-yyyy,tablet-c-zzzz
```

撤銷就是把該組從清單移除再重啟。

---

## 放到有 HTTPS 的地方

**平板一定連得是 HTTPS。** App 由 GitHub Pages 以 HTTPS 提供，瀏覽器會把
`http://` 的請求當成 mixed content 直接擋掉——所以「筆電接在展場 Wi-Fi 上跑
`http://192.168.x.x:3000`」**不會動**。`http://localhost` 是例外，但那是平板自己。

### VPS + Caddy（推薦，最接近公司日後自己跑的形態）

Caddy 會自動申請並續期 Let's Encrypt 憑證。`/etc/caddy/Caddyfile`：

```caddyfile
sync.example.com {
    reverse_proxy localhost:3000
}
```

搭配一個 systemd unit 讓伺服器常駐：

```ini
[Unit]
Description=Exhibition form sync server
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/exhibition_form/server/index.js --port 3000
Environment=SYNC_TOKENS=tablet-a-xxxx,tablet-b-yyyy
WorkingDirectory=/opt/exhibition_form
Restart=always
User=sync

[Install]
WantedBy=multi-user.target
```

平板填入的網址就是 `https://sync.example.com/v1`。

### 臨時隧道（只為了一次現場實測）

先裝 `cloudflared`：

| 系統 | 指令 |
|---|---|
| Windows | `winget install --id Cloudflare.cloudflared`，裝完**關掉終端機重開**（PATH 不會傳進已開啟的視窗） |
| macOS | `brew install cloudflared` |
| Linux | 見 [Cloudflare 的安裝說明](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) |

Windows 上若沒有 winget，或裝完仍找不到指令，直接抓單一執行檔就好：

```powershell
curl.exe -L -o cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
.\cloudflared.exe --version
```

PowerShell 不會執行當前目錄下的檔案，所以要寫 `.\cloudflared.exe` 而不是 `cloudflared.exe`。

**開兩個終端機視窗**，一個跑伺服器、一個跑隧道。不要用 `&` 之類的背景執行寫法——
那是 Unix shell 專屬的，在 Windows 上不會照預期運作，而且伺服器的輸出你會想看得到。

```
# 終端機 1（repo 根目錄）
node server/index.js --token dev-token

# 終端機 2
cloudflared tunnel --url http://localhost:3000
```

> **`--url` 後面不要加 `/v1`。** 它指的是隧道要把流量送到哪個**本機伺服器**，
> 不是某一條路徑；加了會讓路徑被疊兩次，怎麼填都到不了正確的端點。
>
> `/v1` 只出現在**平板的設定欄位**裡：`https://<隨機>.trycloudflare.com/v1`。

### 網址在哪裡

**在終端機 2 自己的輸出裡。** `cloudflared` 會刷一堆 log，其中有一段用框線圍起來的區塊：

```
+--------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at ...          |
|  https://某些-隨機-英文字.trycloudflare.com                     |
+--------------------------------------------------------------+
```

那個 `.trycloudflare.com` 網址就是。平板要填的是**它加上 `/v1`**。

若只看到錯誤與重試、沒有這個框，代表電腦的對外網路不通，網址還沒產生。
輸出裡出現 `Registered tunnel connection` 才是連上了。

**別用手打。** 那串是隨機英文單字，打錯一個字母的症狀和同步壞掉一模一樣。
用任何平板也開得到的方式傳過去（通訊軟體傳給自己、寄信給自己都行），
貼進 App 之前先在平板瀏覽器開一次 `<網址>/v1/records?since=0` 驗證——
見下面的排查順序第 3 步。

免費、不用帳號，但**每次重啟網址就變**，要重新填到每一台平板的設定裡。
所以實測期間那個視窗別關。適合實測一天，不適合當常態。

### 連不上時的排查順序

一次只排除一層，不要靠猜：

```powershell
# 1. 伺服器本身（另開一個終端機）
curl.exe -H "Authorization: Bearer dev-token" "http://localhost:3000/v1/records?since=0"
#    預期 {"records":[],"seq":0,"hasMore":false}；不通就是伺服器沒跑起來

# 2. 隧道（同一台電腦，換成隧道網址）
curl.exe -H "Authorization: Bearer dev-token" "https://<隨機>.trycloudflare.com/v1/records?since=0"
#    回一樣的 JSON 才算隧道通；這步失敗就與平板無關
```

**3. 平板碰得到**：用平板的瀏覽器直接開
`https://<隨機>.trycloudflare.com/v1/records?since=0`

看到 `{"error":"invalid token"}` **是好消息**——代表平板連得到伺服器，只是瀏覽器不會帶權杖。
看到 Cloudflare 的錯誤頁或一直轉圈才是真的不通。

**4. 最後才回 App 按「測試連線」。** 權杖要和 `--token` 後面那串一字不差。

---

## 現場實測（一次性）

### 前置：確認平板上真的是新版

**GitHub Pages 服務的是 `master`。** 同步的程式碼要先合併進去，平板上才會有設定欄位可填。
確認方式：平板開啟後，**活動列表最底部的版本字串要是 v3.13.0 以上**。
已安裝主畫面 App 的平板要先點更新橫幅——Service Worker 不會自己接管。

這是最容易漏掉的一步。沒合併就等於什麼都測不到——而且**同一個合併也決定了電腦這端**：
`server/` 也是隨那次合併才進 `master` 的，沒合併就得先 `git checkout` 到功能分支。

### 電腦上：兩個終端機視窗

**兩個都要在 repo 根目錄下**（`cd` 進 clone 出來的資料夾），伺服器那行是相對路徑。

```
# 終端機 1
node server/index.js --token tabletA-xxxx,tabletB-yyyy

# 終端機 2（--url 後面不要加 /v1，那是平板設定裡才有的）
cloudflared tunnel --url http://localhost:3000
# → https://<隨機>.trycloudflare.com
```

兩個視窗都要保持開著。**每台平板一組權杖**，不要共用——遺失時才能只撤銷那一台。

隧道網址印在終端機 2 的輸出裡（見上面「網址在哪裡」），**別用手抄到平板上**。

### 每台平板上

表單管理（PIN）→ 系統設定 → 同步伺服器填 `https://<隨機>.trycloudflare.com/v1`
→ 填該台的權杖 → **測試連線** → 儲存設定。

**`/v1` 結尾不能漏。** 客戶端是直接把 `/records` 接在你填的網址後面，漏了會一路 404。

### 逐格對

| 動作 | 預期 |
|---|---|
| 填完一筆，回活動列表 | 2 秒內由「待同步 1 筆」變成「已同步 · hh:mm」 |
| 電腦上看 `server/data/records.json` | 筆數增加 |
| **關掉平板 Wi-Fi，再填一筆** | 「同步失敗：無法連線（待同步 1 筆）」 |
| 開回 Wi-Fi，按「立即同步」 | 恢復「已同步」，筆數補上 |
| 故意把權杖打錯一個字元 | 「存取權杖錯誤」——與離線的訊息不同 |

**離線那一格是整場最重要的**，因為那就是展場 Wi-Fi 的常態；其他幾格順利的機率高得多。

### 會絆到人的幾點

- **拉取只在活動列表與活動內頁進行。** 要收資料得先回列表再按「立即同步」，
  填單畫面上按不到——那是刻意的，避免遠端資料蓋掉正在輸入的內容。
- **tunnel 網址每次重啟都會變**，變了就得重填每一台平板。實測期間別關掉那個視窗。
- tunnel 靠電腦的對外網路，**展場網路斷了它也一起斷**。
- **另一台平板不會顯示這些紀錄**（活動不同步，見 [`docs/sync-contract.md`](../docs/sync-contract.md)）。
  驗收看的是伺服器收到什麼，不是別台平板的畫面。

## 資料保護

**測試階段一律使用假資料。**

平板上給訪客看的同意條文寫的是「本人資料不會提供予第三方」。上傳到該公司自己的伺服器
沒有問題（同一個資料控制者），但開發或測試用的伺服器**就是第三方**——把真實訪客資料
送上去，會直接違反剛剛才給對方看過的那段文字。

臨時隧道還多一層：**`trycloudflare.com` 的網址是公開的**，網路層沒有任何限制，
只有 bearer token 擋著。實測請用假資料。

---

## 給重新實作的人

行為上必須保留的幾點，詳見[契約](../docs/sync-contract.md)：

- `POST /v1/records` **冪等**，依 `id` upsert。同一批送兩次的結果要和送一次相同。
- `seq` 單調遞增，**重啟不得倒退**，而且不是時間戳。
- 墓碑（`deletedAt` 非 null）**必須保留並回傳**，否則已刪的紀錄會從沒同步的平板上長回來。
- 逐筆回報結果，**一筆壞資料不得讓整批失敗**。
- 認證失敗回 **401**，不要回 200 夾錯誤訊息——客戶端必須能區分「網路壞了」和「權杖錯了」。
- 跨來源標頭要開（app 與伺服器一定不同源）。

`GET /debug/all` 不屬於契約，只是給測試看資料用的，正式實作不需要。
