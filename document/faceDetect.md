# 顔検出（face-api.js）実装ドキュメント

`face-api.js` を用いたフロント側のリアルタイム顔検出と、検出をトリガーにしたバックエンドの `faceDetectScenario` の実装説明。

> 旧 `personDetectState` と `POST /api/persondetect` による起動方式は廃止済み。
> 現在は「接続時の URL パス」で顔検出の有効・無効が決まる。
>
> 本実装は個人を識別する顔認証ではなく、顔の位置・68点ランドマーク・正面度を検出するだけの仕組み。
> 顔の埋め込み特徴量や `FaceMatcher` は使っていない。

---

## 全体アーキテクチャ

```
【フロントエンド /1, /2 など】                【バックエンド】

face-api.js                                 wsServer.ts
  detectAllFaces()                            │
  500ms + 推論時間ごと                         │
       │                                      │
       │ 正面範囲 + サイズを2フレーム連続       │
       └── faceDetectFromClient {x,width,height} ──>│
                                                 ▼
                                       countersRedis.increment("faceDetect")
                                                 │
                                                 ▼
                                       faceDetectScenario(id)
                                         ├─ stopEmit（全ストリーム停止）
                                         ├─ CHAT ライブ配信の開始
                                         ├─ recordEmit（10秒録画）
                                         ├─ M5 回転
                                         ├─ faceDetectBlockFromServer を全端末へ
                                         ├─ recent PLAYBACK を検出端末で再生
                                         ├─ 15秒後 today / yesterday を再生
                                         └─ 40秒後 stopStream
```

---

## 起動条件

### URL パスによる初期設定

`connectFromClient.ts` が接続時の `urlPathName` を見て `clientState.client[id].facedetection` を決める。

| パス | `facedetection` | 備考 |
|---|---|---|
| `/1` | `true` | 顔検出端末 |
| `/2` | `true` | 顔検出端末 |
| `/3` | `false` | `hanged: true` |
| `face` を含むパス | `true` | 汎用クライアント側の判定 |
| `noStream` | `false` | ストリームなし端末 |
| `/nosound` | クライアント登録なし | 早期 return |

- `/1` `/2` `/3` は完全一致で判定する（`connectFromClient.ts:37-67`）。
- それ以外のパスは `urlPathName.includes("face")` で判定する（`:142`, `:164`）。
- `noStream` は常に `facedetection: false`（`:246`）。

### 接続時の設定送信

`wsServer.ts:74-85` の流れ:

1. `connectFromClient()` がクライアント状態を作る
2. `emitClientSettings()` が `clientSettingsFromServer` を送る

```json
{
  "type": "clientSettingsFromServer",
  "data": {
    "facedetection": true,
    "hanged": false
  }
}
```

フロントは `socket.ts` の `clientSettingsFromServer` ハンドラでこのイベントを受け、`true` なら `initFaceDetection()`、`false` なら `stopFaceDetection()` を呼ぶ。

### 廃止された起動方式

以前の `POST /api/persondetect` は `app.ts` から削除した。現在は以下が存在しない。

- `personDetectState.flag` と 15 分タイマー
- `triggerLeftPersonDetect()`
- `countersRedis.increment("visitor")` / `countersRedis.increment("leave")`
- `personDetectFromServer` の送信

外部センサーが `/api/persondetect` を呼んでも、現在は 404 になる。顔検出を開始・停止したい場合は、接続時のパス設定を使う。

---

## フロントエンド実装

実装本体は `packages/frontend/src/faceApi/index.ts`。

### モデル

`MODEL_URL = "/models"` から以下を初回だけ並列ロードする（`:135-144`）。

| モデル | 用途 |
|---|---|
| `tinyFaceDetector` | 顔検出 |
| `faceLandmark68TinyNet` | 68点ランドマーク |
| `faceExpressionNet` | 表情認識（推論は実行するが、**結果は未使用**） |

モデルファイルは以下に配置されている。

- `packages/frontend/public/models/`
- `packages/backend/static/models/`（本番の Express static 配信用）

### `initFaceDetection()`

1. `active === true` なら早期 return（二重起動ガード）。
2. 未ロードなら 3 モデルを `Promise.all` でロード。
3. `<canvas id="faceCanvas">` を `#wrapper` に追加（`position:absolute; z-index:3; pointer-events:none`）。
4. `active = true` にして `detectLoop()` を開始。

### `detectLoop()`

- `setTimeout` による再帰ループ。間隔は **500ms + 推論時間**（`DETECT_INTERVAL_MS = 500`）。
- 旧実装の 100ms から、WebRTC リレー映像への影響を減らすため 250ms、さらに 500ms に間引かれている。
- `video.readyState >= 2 && video.videoWidth > 0` のときだけ検出する。

```ts
const detections = await faceapi
  .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions())
  .withFaceLandmarks(true)
  .withFaceExpressions();

const resized = faceapi.resizeResults(detections, {
  width: window.innerWidth,
  height: window.innerHeight,
});
```

- 検出結果は `window.innerWidth/innerHeight` にリサイズして描画する。
- ランドマークは検出したすべての顔に対して描画する。
- 正面判定とサーバー送信は **最初の顔 `resized[0]` だけ**を対象にする。

### 正面判定

68点ランドマークの以下を使う（`:209-219`）。

- `positions[0]`: 左の顎輪郭
- `positions[16]`: 右の顎輪郭
- `positions[30]`: 鼻先

```ts
const faceCenterX = (leftJaw.x + rightJaw.x) / 2;
const halfFaceWidth = (rightJaw.x - leftJaw.x) / 2;
const frontalOffset = (noseTip.x - faceCenterX) / halfFaceWidth;
```

`Math.abs(frontalOffset) <= FRONTAL_RATIO`（0.3）なら正面とみなす。

- 鼻先が顔の中心から半幅の 30% 以内、という判定。
- 見ているのは左右方向（ヨー）だけ。上下（ピッチ）や傾き（ロール）は判定しない。
- 複数人が映っている場合、2人目以降は正面判定の対象外。
- さらに、同じ正面範囲に **2フレーム連続**で検出されることをトリガ条件にする（`FRONTAL_CONFIRM_FRAMES = 2`）。1フレーム目では送信せず、2フレーム目で送信する。

### サイズ判定

距離を判定するため、検出ボックスの幅を映像の元解像度で正規化する。

```ts
const faceWidthRatio =
  detections[0].detection.box.width / video.videoWidth;

if (faceWidthRatio >= MIN_FACE_WIDTH_RATIO) {
  // 近距離の顔として扱う
}
```

- `MIN_FACE_WIDTH_RATIO = 0.08`（640px 幅で約51px）。
- MacBook 内蔵カメラ（640x360）で **1.0〜1.5m 程度**の距離にいる顔を想定した暫定値。
- カメラの画角や設置環境で変わるため、実機で調整する前提。
- ウィンドウサイズの影響を受けないよう、`resizeResults` 後の座標ではなく元の `detections[0].detection.box` を使う。
- 正面だがサイズが小さい場合はトリガせず、連続フレーム数もリセットする。

### 検出成立時

「正面範囲」かつ「サイズ条件」を2フレーム連続で満たした時だけ、以下を実行する（`:221-240`）。

1. `faceDetectFromClient` を `{ x, width, height }` 付きで送信
2. カメラ映像を1フレームだけ静止画として全画面表示（1秒間）
3. 90秒間、白黒点滅を無効化

```json
{
  "type": "faceDetectFromClient",
  "data": { "x": 120, "width": 80, "height": 80 }
}
```

`x / width / height` は `resizeResults` 後のウィンドウ座標。**サーバー側ではログに出すだけで、シナリオの判断には使っていない。**

### 非正面時の点滅

正面から外れている間は、画面全体を白黒で点滅させる（`:241-246`）。

- `#faceFlash` を `position:fixed; z-index:9999; pointer-events:none` で全画面に重ねる。
- 500ms ごとに白/黒を切り替える（1秒周期）。
- 顔が検出されなくなったら点滅を止める。
- 正面だがサイズが小さい場合は点滅しない（点滅は正面判定のみを条件にする）。

`flashDisabledUntil` は検出成立時に 90 秒後へ設定される。したがって、シナリオ起動後の 90 秒間は非正面でも点滅しない。

### スナップショット

`showCapturedFrame()` が `canvasElement.video` の1フレームを `#faceSnapshot` に描画する（`:47-84`）。

- `position:fixed; inset:0; z-index:9998; background:#000`
- アスペクト比を保って画面中央に contain 配置
- `SNAPSHOT_DURATION_MS = 1000` 後に非表示
- 再度検出成立した場合は前のタイマーを解除して再表示

### ブロック

`faceDetectBlockFromServer` を受けると `blockFaceDetection(durationMs)` が呼ばれ、`faceDetectBlockedUntil` まで検出処理をスキップする（`:100-102`, `:175-181`）。

ブロック中は:

- `detectAllFaces()` を実行しない
- `faceDetectFromClient` を送らない
- オーバーレイをクリアする
- 点滅を止める
- `frontalFrameCount = 0` / `frontalTriggered = false` に戻す

### `stopFaceDetection()`

- `active = false` にしてループを止める
- `frontalFrameCount = 0` / `frontalTriggered = false`
- 点滅を停止
- スナップショットを非表示
- オーバーレイをクリア
- モデルと canvas は再起動高速化のため保持

---

## バックエンド実装

### `wsServer.ts`: `faceDetectFromClient`

```ts
case "faceDetectFromClient": {
  const faceData = data as { x: number; width: number; height: number };
  console.log("faceDetectFromClient", faceData);
  countersRedis.increment("faceDetect").then((count) => {
    console.log("faceDetect count:", count);
  });
  await faceDetectScenario(id);
  break;
}
```

- `counters:faceDetect` をインクリメントする。
- `faceDetectScenario(id)` を実行する。
- `faceData` はログのみで、座標は使わない。

### `faceDetectScenario()`

実装は `packages/backend/src/scenario/faceDetectScenario.ts`。

| タイミング | 処理 |
|---|---|
| t=0 | `stopEmit()` で全ストリーム停止 |
| t=0 | 検出端末を CHAT の配信元にしてライブ配信を開始 |
| t=0 | 検出端末へ 10 秒間の PLAYBACK 録画を指示（`recordEmit`） |
| t=0 | M5 の回転を開始 |
| t=0（recent 検索後） | `faceDetectBlockFromServer` を全端末へ送信 |
| t=0（recent 検索後） | `recent` バッファを検出端末で再生 |
| t=15s | `today` / `yesterday` バッファをランダムな端末で再生 |
| t=40s | `stopStream()` で全ストリーム停止 |
| t=60s | M5 の回転を停止 |

#### CHAT ライブ配信

```ts
streamState.target.CHAT = detectedClientId
  ? [detectedClientId]
  : streamState.target.CHAT;
currentState.stream.CHAT = true;

if (detectedClientId) {
  ioState.io?.to(detectedClientId).emit("chatReqFromServer");
} else {
  ioState.io?.emit("chatReqFromServer");
}

setTimeout(() => {
  streamState.target.CHAT = Object.keys(clientState.client);
}, 5000);
```

- 検出端末を CHAT の配信元にする。
- 5 秒後に CHAT の target を接続中の全クライアントへ切り替える。
- 40 秒後の `stopStream()` で停止する。

#### PLAYBACK 録画

`recordEmit(detectedClientId, false)` により、検出端末へ `recordReqFromServer` を送る。

- `source: "PLAYBACK"`
- `timeout: 10000`
- `index`: 現在の `recordIndex`
- `textPrint: false`（画面に RECORD を出さない）

#### 再生バッファの選び方

| 種別 | 条件 | 再生先 |
|---|---|---|
| `recent` | `PLAYBACK` の最大 `recordIndex` | 検出端末 |
| `today` | 今日0時以降・`recent` を除く・1時間前に最も近い | ランダムな端末 |
| `yesterday` | `scenarioItsuki` が Mongo から Redis にロードした `YESTERDAY` | ランダムな端末 |

- `recent` は `checkRecentBuffer()` が `getRecordIndexEntries("PLAYBACK")` から最大 `recordIndex` を求める。
- `today` は `checkTodayYesterdayBuffers()` が同じ一覧から選ぶ。
- `yesterday` は `itsukiState.faceDetect.yesterdayLoaded` が `true` の場合だけ候補になる。
- `yesterday` を有効にするには `scenarioItsuki` の `loadYesterdayPlayback()` が動いている必要がある。

#### 顔検出ブロック

`faceDetectScenario.json` の最大 `delayMs` に `FACE_DETECT_BLOCK_AFTER_MS`（20秒）を加えた時間を、全端末へ通知する。

```
blockDurationMs = max(step.delayMs) + 20,000ms
```

現在の JSON は `0ms` と `15,000ms` の2ステップなので、ブロックは **35秒**。

```json
{
  "type": "faceDetectBlockFromServer",
  "data": { "durationMs": 35000 }
}
```

通知は `checkRecentBuffer()` の後に送られる。`recent` の検索が終わるまで他端末はブロックされない点に注意。

#### M5 回転

```ts
void m5Test("rotation").then((rotationState) => {
  void blinkM5Switch("rotation", rotationState, 50, 16);
});
setTimeout(async () => {
  const rotationState = await m5Test("rotation");
  if (rotationState) m5Switch("rotation", false);
}, 60 * 1000);
```

- シナリオ開始時に回転を開始する。
- 60 秒後に回転状態を確認し、ON なら停止する。

#### `faceDetectScenario.json`

```json
{
  "steps": [
    {
      "delayMs": 0,
      "actions": [{ "type": "playFirstBuffer" }]
    },
    {
      "delayMs": 15000,
      "actions": [{ "type": "playRestBuffers" }]
    }
  ]
}
```

`execStream` / `stopEmit` / `rotateItsuki` / `bpmChange` / `gridChange` のアクション種別は実装されているが、現在の JSON では未使用。

---

## メッセージプロトコル

### サーバー → クライアント: `clientSettingsFromServer`

```json
{
  "type": "clientSettingsFromServer",
  "data": {
    "facedetection": true,
    "hanged": false
  }
}
```

送信タイミング:

- クライアント接続時（`connectFromClient` 成功直後）

`facedetection` は `clientState.client[id].facedetection` をそのまま返す。旧実装のような `personDetectState.flag` との AND はない。

### クライアント → サーバー: `faceDetectFromClient`

```json
{
  "type": "faceDetectFromClient",
  "data": { "x": 120, "width": 80, "height": 80 }
}
```

- 同じ正面範囲に2フレーム連続で検出された時だけ送信する。
- `y` は送らない。
- サーバーは `counters:faceDetect` の加算と `faceDetectScenario` の起動だけを行う。

### サーバー → クライアント: `faceDetectBlockFromServer`

```json
{
  "type": "faceDetectBlockFromServer",
  "data": { "durationMs": 35000 }
}
```

- シナリオ開始時に全端末へブロードキャストする。
- フロントは `durationMs` の間、顔検出を停止する。

### 廃止されたイベント

- `personDetectFromServer`: 旧 `/api/persondetect` のフリッカー演出用。送信元の削除に伴い、フロントのハンドラも削除済み。

---

## 既知の挙動・制約

- **個人識別はしない**: 顔認証・顔照合は行わない。検出するのは bbox とランドマークのみ。
- **送信 bbox は未使用**: `faceDetectFromClient` の `x / width / height` はサーバーでログに出すだけ。サイズ判定はフロント側で `detections[0].detection.box` を使って行う。
- **検出は最初の顔だけ**: 複数人の場合、2人目以降は正面判定に使わない。
- **正面判定はヨーのみ**: ピッチ・ロールは考慮しない。
- **サイズ閾値は暫定**: `MIN_FACE_WIDTH_RATIO = 0.08` は 640x360 の MacBook 内蔵カメラを想定した値。画角・設置位置・顔の大きさで変わるため、実機で調整する。
- **約35秒で再発火し得る**: ブロック中に `frontalFrameCount` / `frontalTriggered` をリセットするため、同じ人が正面に立ったままだと、ブロック解除後に2フレーム連続の条件を満たして再度 `faceDetectFromClient` が送られる。
- **トリガまで2フレームかかる**: 検出間隔は500ms + 推論時間なので、条件を満たしてから送信まで約1秒以上かかる。
- **サーバー側の同時実行ガードはない**: `faceDetectScenario` に実行中フラグはなく、`recordEmit` の `currentState.RECORD` ガードもコメントアウトされている。複数端末が同時に検出するとシナリオが重複し得る。
- **ブロック通知は recent 検索後**: `checkRecentBuffer()` の完了を待ってから `faceDetectBlockFromServer` を送る。
- **検出ループは例外を捕捉していない**: `detectAllFaces()` が reject するとループが止まり、`active` が `true` のまま残る。
- **表情推論の結果は未使用**: `withFaceExpressions()` は毎回推論を実行するが、結果はどこからも参照していない。`faceExpressionNet` のロードと推論は負荷対効果が悪い。
- **座標系**: ランドマークはウィンドウ座標にリサイズされる。映像表示は `object-fit: contain` / `showImage` の contain なので、アスペクト比が違うと表示位置とずれる。
- **`/1` `/2` は自動初期化しない**: `/webrtc` と違い、クリックか Enter で `initialize()` する必要がある。
- **`availableBuffersState` は未使用**: `faceDetectScenario.ts` で更新されるが、参照されていない。
- **`SNAPSHOT_DISPLAY_MS` は未使用**: バックエンド定数は残っているが、スナップショットはフロント単独で 1 秒表示する。

---

## 関連ファイル

### フロントエンド

- `packages/frontend/src/faceApi/index.ts` — 顔検出・正面判定・点滅・スナップショット
- `packages/frontend/src/socket.ts` — `clientSettingsFromServer` / `faceDetectBlockFromServer` ハンドラ
- `packages/frontend/src/main.ts` — WebSocket 接続と初期化
- `packages/frontend/public/models/` — face-api.js モデル

### バックエンド

- `packages/backend/src/socket/wsServer.ts` — `faceDetectFromClient` 受信
- `packages/backend/src/scenario/faceDetectScenario.ts` — シナリオ本体
- `packages/backend/src/scenario/faceDetectScenario.json` — シナリオ定義
- `packages/backend/src/clientSetting/connectFromClient.ts` — パスによる `facedetection` 決定
- `packages/backend/src/clientSetting/clientSettingsEmit.ts` — 設定送信
- `packages/backend/src/redis/streamsRedis.ts` — カウンタ・バッファ検索
- `packages/backend/src/stream/recordEmit.ts` — PLAYBACK 録画要求
- `packages/backend/static/models/` — 本番配信用モデル
