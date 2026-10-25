# Timer / タイマー仕様まとめ

本ドキュメントは chat_itsuki におけるすべての時間制御（タイマー・タイムアウト・インターバル・周期スケジュール・経過時間判定）の挙動を網羅的にまとめたもの。各項目について **目的 / 値 / 場所 / 起動契機 / 発火時の動作・解除条件** を記載する。

モノレポ構成:
- フロントエンド: `packages/frontend/src/`（TypeScript / ブラウザ）
- バックエンド: `packages/backend/src/`（TypeScript / Node.js）

> 注: 行番号は調査時点のもの。実装変更で多少ずれる可能性があるため、参照時はシンボル名で確認すること。

---

## 1. バックエンド — スケジューラ系

### 1.1 シナリオ周期実行（scenarioItsuki）
- **ファイル**: `backend/src/scenario/scenarioItsuki.ts`
- **インターバル**: 1,500,000ms（**25分**、`INTERVAL = 25` 分）
- **動作**:
  - 起動時に即 `runOnce()`、以降 25 分ごとに繰り返し。
  - `runOnce()`: `loadYesterdayPlayback()`（前日プレイバック読込・`itsukiState.faceDetect.yesterdayLoaded` 更新）→ `loadScenario("scenario")` → `execScenario()`。
  - エラーが出てもタイマーは止めず継続。
- **多重起動防止**: `itsukiTimer !== null` ならスキップ。
- **状態取得/停止**: `isScenarioItsukiActive()` / `stopScenarioItsuki()`。

---

## 2. バックエンド — シナリオ / 顔検出のタイマー

### 2.1 シナリオステップ実行（execScenario）
- **ファイル**: `backend/src/scenario/execScenario.ts`
- **値**: シナリオ各ステップの時刻（相対 `HH:MM:SS` / `MM:SS` をパースした ms、または絶対時刻との差分）
- **動作**: 各ステップに対し `setTimeout()` を張り、到来時に `receiveEnter(cmd, "scenario")` を実行。複数ステップ分の `setTimeout` がキューされる。

### 2.2 顔検出シナリオのステップ遅延
- **ファイル**: `backend/src/scenario/faceDetectScenario.ts`
- **値**: 各ステップの `step.delayMs`（`faceDetectScenario.json` 定義）
- **動作**: 顔が正面・範囲内で認識されたとき、`delayMs > 0` のステップは `setTimeout(runStep, step.delayMs)`、`delayMs <= 0` は即実行。現在の JSON は 0ms と 15,000ms の2ステップ。

### 2.3 スナップショット表示
- **ファイル**: `frontend/src/faceApi/index.ts`
- **値**: 1,000ms（`SNAPSHOT_DURATION_MS`）
- **動作**: 正面検出時に現フレームを全画面表示し、1秒後に非表示にする。バックエンドは関与しない（`faceDetectScenario.ts` の `SNAPSHOT_DISPLAY_MS` は未使用）。

### 2.4 顔検出ブロック時間の算出・通知
- **ファイル**: `backend/src/scenario/faceDetectScenario.ts`
- **値**: シナリオ最大 `delayMs` + 20,000ms（`FACE_DETECT_BLOCK_AFTER_MS = 20000`）。現在の JSON では 35,000ms。
- **動作**: 全ステップ中の最大 `delayMs` を求め、20秒を加算して `faceDetectBlockFromServer { durationMs }` を emit。クライアント側で同時間だけ顔検出を抑止（フロント 10.x 参照）。通知は `checkRecentBuffer()` の後に送られる。

---

## 3. バックエンド — タイマー / スケジュールコマンド

### 3.1 タイマーコマンド（絶対時刻実行）
- **ファイル**: `backend/src/stream/timerCmd.ts`
- **書式**: `HH:MM:SS CMD` または `HH:MM CMD`
- **値**: `Date.parse(today + "T" + 時刻 + "+09:00") - now`（JST 基準）
- **動作**:
  - 送信時に `CMD SCHEDULED <ms>ms LATER` を `stringsFromServer` で表示。
  - `timerVal > 0` のときのみ `setTimeout`。発火時、現存クライアントの index からランダムに対象を選び:
    - `currentState.cmd` / `currentState.stream` に該当があれば `receiveEnter(cmd, targetId)`
    - `STOP`（引数2個）なら `stopEmit("", "ALL", "all")`
    - それ以外は `stringsFromServer { strings: cmd, timeout: false }`

### 3.2 スケジュールコマンド（絶対 / 相対）
- **ファイル**: `backend/src/schedule/splitTimerCmd.ts`
- **書式**: `HH:MM:SS cmd` / `MM:SS cmd`
- **値・分岐**:
  - 絶対時刻差 `timerVal` が **0 < timerVal < 10,800,000ms（3時間）** のとき → その差分で `setTimeout` → `execSchedule(cmd)`。
  - それ以外（範囲外/過去）は**相対時刻**として解釈:
    - 2要素: `(MM*60 + SS) * 1000`
    - 3要素: `(HH*3600 + MM*60 + SS) * 1000`
    - その ms で `setTimeout` → `execSchedule(cmd)`。

---

## 4. バックエンド — WebRTC / メディアストリーミング

2026-06 の WebRTC 移行（`1fc258a`）で backend の werift / ffmpeg / `cameraRotator` は撤去され、
本節が扱っていたタイマー（再接続バックオフ、RTP 統計、PLI、`PI_POLL_INTERVAL_MS`、
`REC_REQ_RETRY_INTERVAL_MS`、`ACTIVATE_DELAY_MS`）は**すべて存在しない**。

現行の WebRTC は `/webrtc` ブラウザ (SyncClient) が chat_sync へ直接接続する構成。
再接続バックオフは `frontend/src/webRTC/syncClient.ts` にあり、`document/WebRTC.md` を参照。

---

## 5. バックエンド — ストリーム / 録音 / グリッド量子化

### 5.1 録音タイムアウト（サーバ側）
- **ファイル**: `backend/src/stream/recordEmit.ts`
- **値**: 10,000ms（`RECORD_TIMEOUT_MS`）
- **動作**: `recordEmit()` / `recordAsOtherEmit()` で `currentState.RECORD = true`、`recordReqFromServer { timeout: 10000 }` を emit。10秒後に `RECORD = false`。現在の `faceDetectScenario` はこのフラグをガードに使っていない（該当チェックはコメントアウト済み）。

### 5.2 BPM タップ検出ウィンドウ
- **ファイル**: `backend/src/cmd/metronomeBpmSet.ts`
- **値**: 10,000ms
- **動作**: タップ時刻を `metronomeArr` に蓄積。10秒以内に規定回数のタップが揃わなければ配列リセット。揃えばタップ間隔から BPM 算出。

### 5.3 グリッド遅延値の算出
- **ファイル**: `backend/src/stream/gridTimeoutVal.ts`
- **値**: `(Math.random() * 16 * millisecondsPerBeat(bpm)) / 4`（ビート長の 0〜4倍のランダムジッター）
- **用途**: 後述の stream/chat 遅延に渡す遅延量（タイマー本体ではなく値の計算）。

### 5.4 グリッドベースのストリーム遅延
- **ファイル**: `backend/src/stream/streamEmit.ts`
- **値**: `gridTimeoutVal()` の結果
- **動作**: `gridFlag` 有効時、`setTimeout` で `ioEmitStreamFromServer()` を次グリッドビートまで遅延。発火前に `currentState.stream[source]` の存在を確認。

### 5.5 グリッドベースのチャット遅延
- **ファイル**: `backend/src/stream/chatReceive.ts`
- **値**: `gridTimeoutVal("CHAT", targetId)` の結果
- **動作**: CHAT チャンネルに対し 5.4 と同様のグリッド量子化遅延。

---

## 6. バックエンド — その他

### 6.1 debounce ヘルパ
- **ファイル**: `backend/src/redis/stateRedis.ts`
- **値**: 引数 `ms`（呼び出し側指定）
- **動作**: 呼ぶたびに前回 `clearTimeout` → 新規 `setTimeout`。最後の呼び出しから `ms` 経過後に1回実行。主に Redis への状態保存のデバウンスに使用。

### 6.2 M5Stack 通信タイムアウト
- **ファイル**: `backend/src/rotate/m5Access.ts`
- **値**: 5,000ms（`M5_FETCH_TIMEOUT_MS`）
- **動作**: `m5Fetch()` ごとに `AbortController` + `setTimeout` で5秒応答なしなら `abort()`。`finally` でタイマー解除。

### 6.3 Mongo 挿入バッチ遅延
- **ファイル**: `backend/src/mongoAccess/insertStream.ts`
- **値**: 1,000ms（バッファ1件ごと）
- **動作**: Redis バッファを順に取り出し、各挿入を1秒間隔で実行（DB 過負荷防止）。

---

## 7. フロントエンド — 接続 / 再接続

### 7.1 WebSocket 再接続バックオフ（SocketFacade）
- **ファイル**: `frontend/src/socket/SocketFacade.ts`
- **値**: 基準 1,000ms × 2^attempt、上限 30,000ms
- **契機**: WebSocket クローズ
- **動作**: `delay = min(1000 * 2^attempt, 30000)` 後に再接続。接続成功で `reconnectAttempt = 0`。`close()` 内で `clearTimeout` 可能。

### 7.2 旧 WebSocket 再接続フォールバック
- **ファイル**: `frontend/src/webSocket/connectWebSocket.ts`
- **値**: 3,000ms
- **動作**: クローズ時に3秒後 `connectWebSocket()` を再帰呼び出し。

---

## 8. フロントエンド — センサーポーリング

### 8.1 加速度センサ / GPS ポーリング
- **ファイル**: `frontend/src/initialize.ts`（Snowleopard 版: `initializeSnowleopard.ts`）
- **値**: 500ms インターバル
- **契機**: `sensorState.isMobile || flagState.counterbalanceFlag`
- **動作**: 加速度(x,y,z)と GPS を500msごとに取得。RMS 計算（カウンターバランス）、GPS ベースの周波数オシレータ（20〜440Hz）を算出し `sensorState` に格納。`sensorState.sensorTimeIntervalId` で `clearInterval` 可能。

### 8.2 加速度センサ初期化タイムアウト
- **ファイル**: `frontend/src/sensor/index.ts`
- **値**: 5,000ms
- **動作**: `getAcceleration()` 呼び出しから5秒以内に `devicemotion` が来なければ Promise を reject。

---

## 9. フロントエンド — メトロノーム / 量子化

### 9.1 メトロノーム・クリック
- **ファイル**: `frontend/src/webaudio/sound/metronome.ts`
- **値**: 可変 `latency`（ビートあたり ms）
- **動作**: `setInterval` で `latency` ごとにクリック音。flag 変化で旧 interval を `clearInterval` し再生成、`flag=false` で停止。

### 9.2 量子化グリッド tick
- **ファイル**: `frontend/src/quantize/setQuantize.ts`
- **値**: `bar`（BPM から算出した1小節 ms）
- **動作**: `bar` ごとに `streamFlagState`/`streamChunk` を確認し `quantizePlay()`。BPM 変化時は旧 interval を解除して再生成。`quantizeState.interval` で管理。

### 9.3 量子化ビート遅延
- **ファイル**: `frontend/src/quantize/quantizePlay.ts`
- **値**: ビート i ごとに `(quantizeState.bar / beat) * i`
- **動作**: 各ビート（1〜64）を小節内オフセットで `setTimeout` 再生。未指定ならビート数をランダム化。全ビート予約後にストリーム要求を emit。

---

## 10. フロントエンド — 顔検出

### 10.1 顔検出ループ
- **ファイル**: `frontend/src/faceApi/index.ts`
- **値**: 500ms + 推論時間（再帰 `setTimeout`）
- **動作**: `detectAllFaces()` を500msごとに実行。正面範囲かつ顔幅が `MIN_FACE_WIDTH_RATIO` 以上の状態を2フレーム連続で満たしたら `faceDetectFromClient` emit。`blockFaceDetection(durationMs)` のブロック期間中は抑止。

### 10.2 非正面フラッシュ（1Hz 点滅）
- **ファイル**: `frontend/src/faceApi/index.ts`
- **値**: 500ms インターバル（1秒周期）
- **契機**: `Math.abs(frontalOffset) > FRONTAL_RATIO`（0.3）
- **動作**: 500msごとに `flashWhite` トグルで背景白/黒。`stopFlashing()` で `clearInterval`。検出成立後の90秒間は `flashDisabledUntil` により無効。

### 10.3 スナップショット表示
- **ファイル**: `frontend/src/faceApi/index.ts`
- **値**: 1,000ms（`SNAPSHOT_DURATION_MS`）
- **動作**: 正面顔初検出時に現フレームを全画面表示、1秒後に非表示。前タイマーは解除してから再スケジュール。バックエンドは関与しない。

### 10.4 顔検出ブロックウィンドウ
- **ファイル**: `frontend/src/faceApi/index.ts`
- **値**: サーバ通知の `durationMs`（シナリオ最大 `delayMs` + 20秒、現在35秒）
- **動作**: `faceDetectBlockedUntil = Date.now() + durationMs` を設定し、その間は検出・emit・点滅を抑止。`setTimeout` ではなく `Date.now()` タイムスタンプ比較。（バックエンド 2.4 から `faceDetectBlockFromServer` で受信）

---

## 11. フロントエンド — タイムラプス / 録音 / ストリーム

### 11.1 タイムラプス・フラグ周期トグル
- **ファイル**: `frontend/src/initialize.ts`（Snowleopard 版: `initializeSnowleopard.ts`）
- **値**: 60,000ms（1分）
- **契機**: `flagState.start = true` の間
- **動作**: 60秒ごとに `audioWorkletState.chat.flag.TIMELAPSE = true` にして1チャンク録音させる。`timelapseState.setIntervalId` で管理。

### 11.2 タイムラプス GET モード一時フラグ
- **ファイル**: `frontend/src/socket.ts`
- **値**: 5,000ms
- **契機**: サーバから `timelapseFromServer { cmd: "GET" }`
- **動作**: `TIMELAPSE = true` で1チャンク取得、5秒後に false へ戻す。

### 11.3 録音タイムアウト（クライアント側）
- **ファイル**: `frontend/src/stream/socketFromServer/recordReqFromServer.ts`
- **値**: サーバ指定 `recordReq.timeout`（通常 10,000ms）
- **動作**: `flag[source] = true`（録音開始）、`timeout` ms 後に false（停止）。

### 11.4 ストリーム再生レイテンシ遅延
- **ファイル**: `frontend/src/stream/play/streamPlay.ts`
- **値**: `(stream.bufferSize / stream.sampleRate) * 1000` ms
- **契機**: `recLatency` フラグ有効時
- **動作**: 即再生後、バッファ長分待って次チャンクの `streamReqFromClient` を emit。

### 11.5 ストリーム準備待ち（SyncClient 起動）
- **ファイル**: `frontend/src/webRTC/syncClient.ts`
- **値**: 250ms × 最大40回（計10秒、`STREAM_WAIT_INTERVAL_MS` / `STREAM_WAIT_MAX`）
- **契機**: `SyncClient.start()` 時に `streamState.stream` が未取得
- **動作**: 250ms 間隔で `streamState.stream` を確認し、取得でき次第 WebRTC 接続を開始。40回（10秒）で諦めて警告。

---

## 12. フロントエンド — テキスト表示 / 時計 / フリッカー / コマンド

### 12.1 テキスト自動消去
- **ファイル**: `frontend/src/canvasEvent/textEvent.ts`
- **値**: 500ms（既定）または指定 `timeoutDuration`
- **動作**: `textPrint(..., timeout: true)` で描画後、遅延後に `eraseText()`。

### 12.2 黒白フリッカー
- **ファイル**: `frontend/src/canvasEvent/flickering.ts`
- **値**: 500ms/回、合計 3,000ms
- **動作**: 500msごとに `isBlack` トグルで再描画。3秒経過で停止（再帰 `setTimeout`）。

### 12.3 時計モード
- **ファイル**: `frontend/src/clientMode/clockMode.ts`
- **値**: 引数 `latency`
- **動作**: `setInterval` で現在時刻を `textPrint`。`clockModeId` で解除。

### 12.4 wholeCmd 継続時間タイムアウト
- **ファイル**: `frontend/src/cmd/wholeCmd.ts`
- **値**: `option.duration`
- **動作**: sinewave/stream/other を `duration` ms 実行後に停止し、stream は `wholeReqFromClient` を emit。

### 12.5 sinewave 自動停止（カウンター）
- **ファイル**: `frontend/src/textInput.ts`
- **値**: 30,000ms（`SINEWAVE_DURATION_MS`）
- **契機**: カウンター入力が20文字超かつ 100〜20000 の数字を含む
- **動作**: 一致周波数で sinewave 開始、30秒後に停止。

### 12.6 カウンター・クールダウン（1段階）
- **ファイル**: `frontend/src/textInput.ts`
- **値**: 30,000ms（`COUNTER_COOLDOWN_MS`）
- **動作**: `/counter` の `rotateReqFromClient` を30秒に1回へ制限。送信後 `counterCooldown = true`、30秒後に false 信号送出＋再有効化。5回到達で2段階目へ。

### 12.7 カウンター・クールダウン（2段階）
- **ファイル**: `frontend/src/textInput.ts`
- **値**: 180,000ms（3分、`COUNTER_LONG_COOLDOWN_MS`）
- **動作**: 5回（`COUNTER_MAX_SENDS`）送信後、3分間全送信をブロック。満了で `counterSendCount` リセット。

---

## 13. 定数一覧（抜粋）

| 定数 / 値 | 値 | ファイル | 用途 |
|---|---|---|---|
| `INTERVAL_MS` | 1,500,000ms(25分) | scenarioItsuki.ts | シナリオ周期 |
| `FRONTAL_RATIO` | 0.3 | faceApi/index.ts | 正面判定の許容範囲（±30%） |
| `FRONTAL_CONFIRM_FRAMES` | 2 | faceApi/index.ts | 顔検出トリガに必要な連続フレーム数 |
| `MIN_FACE_WIDTH_RATIO` | 0.185 | faceApi/index.ts | 顔幅の下限（640pxで約118px、1.5m実測ベース） |
| `FACE_DETECT_BLOCK_AFTER_MS` | 20,000ms | faceDetectScenario.ts | 顔検出後ブロック加算 |
| `SNAPSHOT_DISPLAY_MS` | 1,000ms | faceDetectScenario.ts | 未使用（スナップショットはフロント側で1秒） |
| 絶対時刻上限 | 10,800,000ms(3時間) | splitTimerCmd.ts | スケジュール絶対/相対分岐 |
| 再接続基準/上限 | 1,000 / 30,000ms | SocketFacade.ts, syncClient.ts | 指数バックオフ |
| 旧WS再接続 | 3,000ms | connectWebSocket.ts | 単純リトライ |
| `RECORD_TIMEOUT_MS` | 10,000ms | recordEmit.ts | 録音時間 |
| BPMタップ窓 | 10,000ms | metronomeBpmSet.ts | タップ検出 |
| `M5_FETCH_TIMEOUT_MS` | 5,000ms | m5Access.ts | M5 HTTP |
| Mongo挿入間隔 | 1,000ms | insertStream.ts | DB レート制限 |
| センサポーリング | 500ms | initialize.ts | 加速度/GPS |
| センサ初期化TO | 5,000ms | sensor/index.ts | devicemotion 待ち |
| タイムラプス周期 | 60,000ms | initialize.ts | チャンク録音 |
| タイムラプスGET | 5,000ms | socket.ts | 手動取得 |
| ストリーム準備待ち | 250ms ×40 | syncClient.ts | SyncClient 起動待ち |
| 顔検出ループ | 500ms | faceApi/index.ts | フレーム間隔（+推論時間） |
| フラッシュ点滅 | 500ms | faceApi/index.ts | 非正面1Hz |
| `SNAPSHOT_DURATION_MS` | 1,000ms | faceApi/index.ts | スナップ表示 |
| テキスト消去 | 500ms | textEvent.ts | 自動消去 |
| フリッカー | 500ms×6(計3秒) | flickering.ts | 黒白点滅 |
| `SINEWAVE_DURATION_MS` | 30,000ms | textInput.ts | sinewave 自動停止 |
| `COUNTER_COOLDOWN_MS` | 30,000ms | textInput.ts | 巡回1段クールダウン |
| `COUNTER_LONG_COOLDOWN_MS` | 180,000ms(3分) | textInput.ts | 巡回2段クールダウン |

---

## 14. 設計パターンの要点

1. **指数バックオフ**: WebSocket（フロント）と WebRTC（バックエンド）はいずれも基準1秒×2^attempt・上限30秒。
2. **周期実行**: シナリオ25分、センサ500ms、顔検出500ms など階層的な周期。
3. **グリッド/量子化**: 音楽系遅延はすべて BPM 由来またはグリッド整列（ヒューマナイズのためのランダムジッター含む）。
4. **フロント/バック協調**: 顔検出ブロック(シナリオ長+20秒)などを socket イベントで同期。スナップショット(1秒)はフロント単独で処理する。
5. **レート制限**: カウンター・クールダウン、録画要求リトライ、Mongo挿入間隔。
6. **リトライと上限**: 録画要求(1.5秒×20)・バッファ録画(250ms×40)・/pi探索(2秒)+10分フォールバックなど、上限・諦め条件を必ず持つ。
7. **録音タイムアウト**: サーバ側録音タイムアウト(10秒)で `currentState.RECORD` を戻す。現在の `faceDetectScenario` はこのフラグをガードに使っていない。
