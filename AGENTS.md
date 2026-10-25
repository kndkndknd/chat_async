# chat_async エージェントガイド

node/TypeScript の音声・映像チャット／インスタレーション。pnpm workspace。ドキュメント・コメント・コミットメッセージは日本語。

## まず知るべきこと
- 通信は native WebSocket (`ws`, path `/ws`)。**socket.io ではない**。README と `vite.config.ts` の `/socket.io` proxy は移行前の記述で古い。
- workspace は `packages/*` のみ（`backend` / `frontend`）。`types/` は workspace 非所属の共有 `.d.ts`。backend は `../../../../types` と相対 import し、集約は `types/index.d.ts`。
- backend は HTTPS 固定。起動時に**リポジトリ外**の TLS 証明書（`keys/chat/private.key`, `keys/chat/selfsigned.crt`, passphrase `chat`）を `src/app.ts:83` で読む。無いと起動しない。
- 起動時に Redis / Mongo に接続。ルート `.env` を `src/app.ts` が読む。`docker/` は redis + nginx（Mongo はコメントアウト）。
- パッケージマネージャは pnpm のみ（`engines` で npm/yarn を拒否）。ツール判定は `mise.toml`。

## 構成
- `packages/backend` … Express + `https` + `ws`。エントリは `src/app.ts` のみ。HTTP API も同ファイル。
- `packages/frontend` … Vite + TS。`html/index.html`→`src/main.ts`、`html/snowleopard.html`→`src/snowleopardMain.ts`（旧 Safari 用の ScriptProcessor 経路）。`vite build` は `../backend/static` に直接出力する（`packages/frontend/dist` ではない）。
- `/webrtc` `/relay` は外部サービス `chat_sync` の WebRTC シグナリングへ接続。`VITE_CHAT_SYNC_URL` は**ビルド時変数**なので変更後は再ビルドが必要（既定は `src/webRTC/syncConfig.ts`）。
- `crate/`（`tuner`）と `packages/frontend/crate/`（`simulate`）は wasm-bindgen の cdylib。生成 glue `packages/frontend/src/wasm/simulate.js` は `.gitignore` の `*.js` 例外で追跡している。**削除・再生成に注意**。

## コマンド（root から）
- 依存導入: `pnpm install`
- backend dev: `pnpm -F backend dev`（`tsx src/app.ts`）/ `pnpm -F backend watch`
- backend build: `pnpm -F backend build`（`tsc` + `lib/*.json` を `dist` へ copy）
- backend test（単発）: `pnpm -F backend exec vitest run`。1 ファイルに絞る: 末尾に `test/path/foo.test.ts`
- frontend dev: `pnpm -F frontend dev`（vite）
- frontend build: `pnpm -F frontend build` → `packages/backend/static` に出力
- frontend test（単発）: `pnpm -F frontend exec vitest run`
- lint / typecheck スクリプトは無い。型は backend=`pnpm -F backend build`、frontend=`pnpm -F frontend exec tsc --noEmit` で確認。
- 動かない script: root の `pnpm arduino` / `pnpm snowleopard`（対象 package 不在）、frontend の `snow` / `snowleopard`（webpack config 不在）。

## テスト
- vitest は root の devDependency。`include: ["test/**/*.test.ts"]`, `globals: true`, `environment: "node"`。
- `packages/backend/test/setup.ts` が `ioredis` をグローバル mock する。state は import 時に `createPersistedState` 経由で実 Redis に繋ぐため必須。frontend の setup は `window = globalThis` と `WebSocket` スタブのみ。
- 方針: 純粋関数・state 依存の計算ロジックのみ単体テスト。I/O 結合関数は意図的に対象外。ローカル関数を `export` 化してテストする運用。詳細と対象一覧は `document/backend_test.md`・`document/frontend_test.md`。

## 参照ドキュメント
subsystem に触る前に `document/` の該当 md を読む: `WebSocket.md`（プロトコル）, `WebRTC.md` / `WebRTC-E2E.md`, `redis.md`, `Timer.md`, `faceDetect.md`, `snowleopard.md`。
