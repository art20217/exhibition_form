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

```bash
node server/index.js --token dev-token
# 同步伺服器：http://localhost:3000/v1
```

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

```bash
node server/index.js --token dev-token &
cloudflared tunnel --url http://localhost:3000
```

會給一個隨機的 `https://….trycloudflare.com` 網址。免費、不用帳號，但**每次重啟網址就變**，
要重新填到每一台平板的設定裡。適合實測一天，不適合當常態。

---

## 資料保護

**測試階段一律使用假資料。**

平板上給訪客看的同意條文寫的是「本人資料不會提供予第三方」。上傳到該公司自己的伺服器
沒有問題（同一個資料控制者），但開發或測試用的伺服器**就是第三方**——把真實訪客資料
送上去，會直接違反剛剛才給對方看過的那段文字。

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
