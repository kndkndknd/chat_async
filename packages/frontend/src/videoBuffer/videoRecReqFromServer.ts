import { socketState, streamState } from "../state";

// サーバからの VIDEOBUFFERREQ で 15 秒間だけ録画し、WebM (VP8 + Opus) を
// 0.5 秒ごとのチャンクに分けて送信する。映像・音声は initialize.ts が
// getUserMedia で取得済みの stream を共有し、ここで getUserMedia を
// 呼び直すことはしない。
const RECORD_DURATION_MS = 15_000;
const CHUNK_INTERVAL_MS = 500;
const MIME_TYPE = "video/webm;codecs=vp8,opus";
const VIDEO_BITRATE = 800_000;
const AUDIO_BITRATE = 32_000;

let mediaRecorder: MediaRecorder | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;
// チャンクの読み出し順と送信順が入れ替わらないよう直列化する。
let sendQueue: Promise<void> = Promise.resolve();

const clearStopTimer = (): void => {
  if (stopTimer !== null) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
};

export const videoRecReqFromServer = (): void => {
  const stream = streamState.stream;
  if (!stream) {
    console.warn("videoRecReqFromServer: stream is not ready");
    return;
  }
  if (mediaRecorder !== null) {
    console.warn("videoRecReqFromServer: already recording");
    return;
  }
  if (typeof MediaRecorder === "undefined") {
    console.warn("videoRecReqFromServer: MediaRecorder is not supported");
    return;
  }
  if (!MediaRecorder.isTypeSupported(MIME_TYPE)) {
    console.warn(`videoRecReqFromServer: ${MIME_TYPE} is not supported`);
    return;
  }

  const recorder = new MediaRecorder(stream, {
    mimeType: MIME_TYPE,
    videoBitsPerSecond: VIDEO_BITRATE,
    audioBitsPerSecond: AUDIO_BITRATE,
  });
  mediaRecorder = recorder;

  recorder.ondataavailable = (event) => {
    if (event.data.size === 0) return;
    const chunk = event.data;
    sendQueue = sendQueue
      .then(() => chunk.arrayBuffer())
      .then((buffer) => {
        socketState.socket?.emit("videoBufferFromClient", buffer);
        console.log(`videoBufferFromClient: chunk ${buffer.byteLength} bytes`);
      })
      .catch((err) => {
        console.error("videoRecReqFromServer: failed to send chunk", err);
      });
  };

  recorder.onstop = () => {
    clearStopTimer();
    mediaRecorder = null;
    console.log("videoRecReqFromServer: stop recording");
  };

  recorder.onerror = (event) => {
    console.error("videoRecReqFromServer: recorder error", event);
    clearStopTimer();
  };

  try {
    recorder.start(CHUNK_INTERVAL_MS);
  } catch (err) {
    clearStopTimer();
    mediaRecorder = null;
    console.error("videoRecReqFromServer: failed to start recording", err);
    return;
  }

  // backend に新しい録画セッションの開始を通知し、前回の保存チャンクを破棄させる。
  socketState.socket?.emit("videoRecStartFromClient");
  console.log(
    `videoRecReqFromServer: start recording (${RECORD_DURATION_MS}ms)`,
  );
  stopTimer = setTimeout(() => {
    stopTimer = null;
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
  }, RECORD_DURATION_MS);
};
