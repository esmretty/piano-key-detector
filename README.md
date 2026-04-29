# Piano Key Detector

把琴譜餵進來，網頁上半部會跑五線譜（**目前演奏到的音符會放大 + 變紅**），下半部是 88 鍵鋼琴 highlight 對應的琴鍵。Mobile-first，主要使用情境是把手機放在鋼琴旁邊照著彈。

支援三種輸入：

| 格式 | 副檔名 | 處理方式 | 需要後端? |
| --- | --- | --- | --- |
| MIDI | `.mid` `.midi` | 前端用 `@tonejs/midi` 解析 → 即時轉成 MusicXML 餵給 OSMD | 否 |
| MusicXML | `.xml` `.musicxml` `.mxl` | 直接給 OSMD（`.mxl` 會在前端解壓） | 否 |
| 圖片琴譜 | `.png` `.jpg` `.jpeg` | 上傳到後端，用 [Oemer](https://github.com/BreezeWhite/oemer) 做 OMR → MusicXML | **是** |
| PDF 琴譜 | `.pdf` | 後端先用 `pdf-to-img` 把每頁 raster 成 PNG（scale=3），對每一頁跑 Oemer，再把所有 `<measure>` 串起來成單一 MusicXML | **是** |

---

## 一鍵啟動（開發模式）

```bash
# 第一次：安裝所有相依套件
npm run install:all

# 平常啟動（同時起前端 5173 與後端 3001）
npm run dev
```

打開 <http://localhost:5173> 就可以使用。MIDI / MusicXML 直接拖入即可；圖片琴譜需要後端 + Oemer。

---

## 後端 OMR 設定（圖片琴譜）

後端會去找 `oemer.exe`。Windows 預設路徑是
`%APPDATA%\Python\Python314\Scripts\oemer.exe`，如果你的 Python 版本不同，
請設環境變數：

```bash
# Windows (PowerShell)
$env:OEMER_BIN = "C:\path\to\oemer.exe"

# 或 macOS / Linux：oemer 通常已在 PATH 上
```

安裝 Oemer：

```bash
pip install oemer
```

> 第一次跑圖片辨識時，Oemer 會下載深度學習模型權重（~100MB），會等比較久。後續就快多了。

健康檢查：<http://localhost:3001/api/health>

---

## 生產建置

```bash
npm run build         # 產生 frontend/dist
npm start             # 後端會自動 serve frontend/dist + /api/omr
```

打開 <http://localhost:3001>。手機跟電腦在同一個 LAN 時，把 localhost 換成電腦 IP 即可在手機開。

---

## 使用方式

1. 點「選擇琴譜」上傳檔案
2. 等到狀態列顯示「載入完成」
3. 按 ▶ 播放
4. BPM 可以即時調整；勾掉「音訊」可以靜音練習（仍會 highlight）
5. 按 ■ 停止

範例檔在 `samples/` 資料夾：
- `twinkle.musicxml` — 小星星，最快可驗證的測試檔
- `chord_test.musicxml` — 測試和弦同時 highlight 多顆鍵

---

## 架構

```
piano-key-detector/
├── frontend/                 Vite + TypeScript
│   ├── src/
│   │   ├── main.ts           主入口、UI wiring、播放排程
│   │   ├── sheet.ts          OSMD wrapper（cursor、note enlarge）
│   │   ├── piano.ts          88 鍵 SVG keyboard
│   │   ├── player.ts         Tone.js Sampler（Salamander Grand Piano）
│   │   ├── parsers/
│   │   │   ├── midi.ts       MIDI → MusicXML（前端內建）
│   │   │   └── omr.ts        圖片 → 後端 /api/omr → MusicXML
│   │   ├── types.ts
│   │   └── style.css         mobile-first CSS
│   └── index.html
├── backend/                  Express + Multer
│   └── server.js             /api/omr 包 oemer subprocess + 靜態 serve dist
├── samples/                  測試用 MusicXML
└── package.json              root：concurrently 起 FE + BE
```

---

## 已知限制 (v1)

- MIDI → MusicXML 是前端輕量轉換，會把所有時值 quantize 到 16 分音符；複雜節奏（連結線、3 連音、附點切分）會被四捨五入。要更精確的話，之後可以改成走後端 `music21` 轉換。
- OMR 準確度看 Oemer：印刷譜表現尚可，**手寫譜目前不行**。
- 目前只用單譜表（高音譜或低音譜其中之一），沒有實作 grand-staff 雙譜表自動分上下手。
- 沒做 transport 倒退、跳到任意小節等控制（先求能用）。

下一步可以：分上下手雙譜表 / 跑 metronome / 紀錄練習進度 / 把 OMR 加入快取避免重複跑。
