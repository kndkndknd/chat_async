# 映像バッファ録画 / 再生（videoBuffer）

`VIDEORECREQ` / `VIDEOPLAYREQ` コマンドで、15 秒間の映像・音声を録画して backend の Redis に保存し、
後から各端末で再生する機能の仕様。

> 最終更新: 2026-10-25。実装は `packages/frontend/src/videoBuffer/` と
> `packages/backend/src/redis/videoRecRedis.ts` / `packages/backend/src/socket/wsServer.ts`。
> WebSocket プロトコル全体は [WebSocket.md](./WebSocket.md) を参照。

---

## 1. 概要

```
VIDEORECREQ（コマンド入力）
  backend: receiveEnter → 全クライアントへ videoRecReqFromServer
  client : MediaRecorder で 15 秒録画
           → 0.5 秒ごとに WebM チャンクを videoBufferFromClient で送信
  backend: クライアントごとに Redis へ保存

VIDEOPLAYREQ（コマンド入力）
  backend: receiveEnter → 全クライアントへ videoPlayReqFromServer
  client : videoPlayReqFromClient で保存済みチャンクを要求
  backend: 要求元へ videoBufferFromServer を順次送信
           → 最後に videoPlayEndFromServer
  client : 全チャンクを結合して Blob を作成し、音声は video、
           映像は videoCanvas に描画して再生
```

- 録画は**クライアントごと**に独立して行われ、Redis のキーもクライアント ID ごとに分かれる。
- 再生時は各端末が**自分自身の録画**を要求して再生する。
- 保存形式は MediaRecorder が出力する WebM（VP8 + Opus）。MSE は使わず、
  全チャンク受信後に Blob URL で再生する。

---

## 2. 構成ファイル

| ファイル | 役割 |
|---|---|
| `packages/frontend/src/videoBuffer/videoRecReqFromServer.ts` | 15 秒録画とチャンク送信 |
| `packages/frontend/src/videoBuffer/videoPlayReqFromServer.ts` | チャンク要求・受信・Blob 再生・canvas 描画 |
| `packages/frontend/src/socket.ts` | 各イベントのハンドラ登録 |
| `packages/frontend/html/index.html` | `<video id="videoBuffer">` / `<canvas id="videoCanvas">` |
| `packages/frontend/html/snowleopard.html` | 同上（旧 Safari 用エントリ） |
| `packages/frontend/public/client.css` | `videoCanvas` の配置、`videoBuffer` の非表示化 |
| `packages/frontend/src/client.css` | 上記 CSS のソース側コピー |
| `packages/frontend/src/canvasEvent/canvasSizing.ts` | `videoCanvas` の解像度をウィンドウに合わせる |
| `packages/backend/src/cmd/receiveEnter.ts` | `VIDEORECREQ` / `VIDEOPLAYREQ` コマンド処理 |
| `packages/backend/src/socket/wsServer.ts` | 録画開始・チャンク受信・再生要求の受信 |
| `packages/backend/src/redis/videoRecRedis.ts` | Redis へのチャンク保存・取得 |

---

## 3. プロトコル

### client → server

| イベント | ペイロード | 処理 |
|---|---|---|
| `videoRecStartFromClient` | なし | そのクライアントの保存済みチャンクを削除 |
| `videoBufferFromClient` | `ArrayBuffer`（WebM チャンク） | Redis の `video:rec:<clientId>` に Base64 で追加 |
| `videoPlayReqFromClient` | なし | 保存済みチャンクを順次返し、最後に終了イベントを送る |

### server → client

| イベント | ペイロード | 処理 |
|---|---|---|
| `videoRecReqFromServer` | なし | 15 秒録画を開始 |
| `videoPlayReqFromServer` | なし | 保存済み録画の再生を開始 |
| `videoBufferFromServer` | `ArrayBuffer`（WebM チャンク） | 再生用に蓄積 |
| `videoPlayEndFromServer` | なし | 全チャンク受信完了。Blob を生成して再生 |

`ArrayBuffer` は WebSocket 上では `{ "__type": "ArrayBuffer", "data": "<base64>" }` に変換される
（`SocketFacade.serialize` / `IoFacade.serializeMessage`）。

---

## 4. 録画（frontend）

`packages/frontend/src/videoBuffer/videoRecReqFromServer.ts`

### 4.1 入力ストリーム

- `initialize.ts` が `getUserMedia` で取得し、`streamState.stream` に保持しているストリームを共有する。
- 録画側で `getUserMedia` を呼び直すことはしない（カメラの二重オープン防止）。
- `streamState.stream` が未取得の場合は警告して録画しない。

### 4.2 MediaRecorder 設定

| 定数 | 値 | 意味 |
|---|---|---|
| `RECORD_DURATION_MS` | 15,000ms | 録画時間 |
| `CHUNK_INTERVAL_MS` | 500ms | `dataavailable` の間隔 |
| `MIME_TYPE` | `video/webm;codecs=vp8,opus` | 映像 VP8 / 音声 Opus |
| `VIDEO_BITRATE` | 800,000bps | 映像ビットレート |
| `AUDIO_BITRATE` | 32,000bps | 音声ビットレート |

`recorder.start(500)` で開始し、15 秒後に `recorder.stop()` する。
停止時の端数チャンクも `ondataavailable` → 送信される。

### 4.3 送信

- `ondataavailable` のたびに `Blob.arrayBuffer()` を実行し、`videoBufferFromClient` で送信する。
- `arrayBuffer()` の完了順でチャンクの順序が入れ替わらないよう、Promise チェーンで直列化している。
- 録画開始成功後に `videoRecStartFromClient` を送り、backend 側の前回バッファを削除させる。

### 4.4 ガード

- 録画中の再要求は無視（二重録画防止）
- `MediaRecorder` 非対応、または VP8 + Opus 非対応なら警告して中止
- `recorder.start()` が例外を投げた場合は状態を戻して中止

---

## 5. 保存（backend / Redis）

`packages/backend/src/redis/videoRecRedis.ts`

| 項目 | 値 |
|---|---|
| キー | `video:rec:<clientId>` |
| 型 | Redis リスト |
| 要素 | WebM チャンクの Base64 文字列 |
| TTL | 3,600 秒（1 時間）。チャンク追加のたびに更新 |
| 最大件数 | 120 チャンク（0.5 秒 × 120 = 60 秒ぶん） |
| 初期化 | `videoRecStartFromClient` 受信時に `DEL` |

- クライアント ID は WebSocket 接続ごとに発行される UUID。
- 再接続すると ID が変わるため、以前の録画は TTL まで残るが再生対象にはならない。
- `LTRIM key -120 -1` で新しいチャンクだけを残す。15 秒録画（約 30 チャンク）では
  WebM の先頭ヘッダが落ちることはない。
- 切断時に明示削除はせず、TTL に任せる。
- `initRedis()` は `streams:*` と `chats` のみ削除するため、`video:rec:*` は backend 再起動後も残る。

---

## 6. 配信（backend）

`packages/backend/src/socket/wsServer.ts`

| 受信イベント | 処理 |
|---|---|
| `videoRecStartFromClient` | `videoRecRedis.start(id)` |
| `videoBufferFromClient` | `videoRecRedis.push(id, ArrayBuffer)` |
| `videoPlayReqFromClient` | `videoRecRedis.getAll(id)` → 要求元へ `videoBufferFromServer` を順次送信 → `videoPlayEndFromServer` |

- チャンクは要求元のクライアントにだけ送る（`facade.to(id).emit`）。
- 保存チャンクが 0 件でも `videoPlayEndFromServer` は送る。
  フロント側は「no chunks received」を警告して何も再生しない。
- 録画完了を示す専用イベントは無い。再生要求時点で Redis に入っているチャンクが再生対象になる。

### コマンド

`packages/backend/src/cmd/receiveEnter.ts`

| 入力 | 動作 |
|---|---|
| `VIDEORECREQ` | 全クライアントへ `videoRecReqFromServer` |
| `VIDEOPLAYREQ` | 全クライアントへ `videoPlayReqFromServer` |

---

## 7. 再生（frontend）

`packages/frontend/src/videoBuffer/videoPlayReqFromServer.ts`

### 7.1 チャンク要求と結合

1. `videoPlayReqFromServer` で前回の再生状態をリセットし、`videoPlayReqFromClient` を送信
2. `videoBufferFromServer` で `ArrayBuffer` を配列に蓄積
3. `videoPlayEndFromServer` で `Blob`（`video/webm;codecs=vp8,opus`）を生成
4. `URL.createObjectURL(blob)` を `<video id="videoBuffer">.src` に設定して再生

- 要求前の古いチャンクは破棄する。
- 要求中フラグ（`collecting`）が false のときに届いたチャンクは無視する。
- 前回の Blob URL は新しい再生開始時に `revokeObjectURL` する。

### 7.2 映像表示

映像は `<video>` では表示せず、`<canvas id="videoCanvas">` に描画する。

- `<video id="videoBuffer">` は音声再生とフレーム供給用。
  CSS で 1×1、`opacity: 0`、`pointer-events: none` にして不可視化している
  （`display: none` にするとフレームが供給されない環境があるため使わない）。
- 再生中は `requestAnimationFrame` で `drawImage(video, ...)` を実行する。
- アスペクト比を保ち、canvas 中央に contain 描画（レターボックス）する。
- リセット時、`ended`、`error` 時に canvas をクリアする。
- 自動再生がブロックされた場合は `video.play()` の reject を警告ログに出すだけで、
  現状はユーザー操作用のフォールバック UI を持たない。

### 7.3 canvas の配置

| 要素 | z-index | 位置・サイズ |
|---|---|---|
| `#cnvs` | 2 | absolute / ウィンドウ全体 |
| `#bckcnvs` | 0 | absolute / ウィンドウ全体 |
| `#videoCanvas` | -1 | absolute / ウィンドウ全体。上記 2 つより背面 |

- `canvasSizing.ts` が `cnvs` / `bckcnvs` と同じタイミングで `videoCanvas` の
  `width` / `height` をウィンドウサイズに合わせる。
- `videoCanvas` は `body` / `#wrapper` の背景が透明であることを前提に `z-index: -1` で背面配置している。
  今後これらの要素に背景色を付けると映像が隠れる。

---

## 8. 既知の注意点・制約

- **クライアント単位の保存**: 全端末で同じ映像を共有する仕様ではない。
  共有再生が必要なら、保存キーを共通化するか録画元を 1 台に限定する設計変更が必要。
- **再接続**: WebSocket 再接続で client ID が変わるため、再接続前の録画は再生できない（TTL まで残る）。
- **録画中の再生要求**: 15 秒経過前に `VIDEOPLAYREQ` すると、途中までのチャンクで Blob を作る。
  不完全な WebM となり、再生できないか途中で止まる可能性がある。
- **チャンク上限**: 120 チャンクを超えると古いチャンクから捨てられ、WebM の先頭ヘッダが失われて
  再生できなくなる。録画時間・間隔を変更する場合は `MAX_CHUNKS` も見直すこと。
- **コーデック**: VP8 + Opus の WebM を扱えるブラウザが必須。
  `MediaRecorder.isTypeSupported()` が false の環境では録画しない。
- **自動再生**: WebSocket イベント起点の再生はユーザー操作とみなされず、
  ブラウザの自動再生ポリシーで `play()` が拒否される場合がある。
- **メモリ / 通信量**: 15 秒あたり映像 800kbps + 音声 32kbps ≈ 1.5MB。
  Base64 化により Redis 上では約 2MB、WebSocket 上でも約 2MB になる。
- **MSE 不使用**: 全チャンク受信後に一括再生するため、受信完了までは再生開始しない。
  逐次再生が必要になった場合は MediaSource / SourceBuffer の実装が必要。

---

## 9. 未確認事項

- 実機ブラウザでの「録画 → Redis 保存 → 再生 → canvas 描画」の一連動作
- `opacity: 0` の `<video>` から `requestAnimationFrame` で安定してフレームが取得できるか
- 自動再生ポリシー下で音声付き再生が許可されるか
- 旧 Safari（snowleopard エントリ）での WebM / MediaRecorder 動作
