import { socketState } from "../state";

// backend に保存済みの録画チャンクを要求し、全チャンク受信後に WebM Blob として再生する。
// <video id="videoBuffer"> は音声再生とフレーム供給のために非表示で使い、
// 映像そのものは <canvas id="videoCanvas"> に描画する。
const VIDEO_ELEMENT_ID = "videoBuffer";
const CANVAS_ELEMENT_ID = "videoCanvas";
const MIME_TYPE = "video/webm;codecs=vp8,opus";

let chunks: ArrayBuffer[] = [];
let objectUrl: string | null = null;
let collecting = false;
let listenersAttached = false;
let rafId: number | null = null;

const getVideoElement = (): HTMLVideoElement | null => {
  const el = document.getElementById(VIDEO_ELEMENT_ID);
  return el instanceof HTMLVideoElement ? el : null;
};

const getCanvasElement = (): HTMLCanvasElement | null => {
  const el = document.getElementById(CANVAS_ELEMENT_ID);
  return el instanceof HTMLCanvasElement ? el : null;
};

const clearCanvas = (): void => {
  const canvas = getCanvasElement();
  const ctx = canvas?.getContext("2d");
  if (canvas && ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
};

const stopDrawLoop = (): void => {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
};

const drawFrame = (video: HTMLVideoElement): void => {
  const canvas = getCanvasElement();
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;

  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  if (videoWidth === 0 || videoHeight === 0) return;

  // 画面全体に収まるよう、アスペクト比を保って中央に contain 描画する。
  const scale = Math.min(
    canvas.width / videoWidth,
    canvas.height / videoHeight,
  );
  const drawWidth = videoWidth * scale;
  const drawHeight = videoHeight * scale;
  const drawX = (canvas.width - drawWidth) / 2;
  const drawY = (canvas.height - drawHeight) / 2;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(video, drawX, drawY, drawWidth, drawHeight);
};

const startDrawLoop = (video: HTMLVideoElement): void => {
  stopDrawLoop();
  const step = (): void => {
    if (video.paused || video.ended) {
      rafId = null;
      return;
    }
    drawFrame(video);
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
};

const attachListeners = (video: HTMLVideoElement): void => {
  if (listenersAttached) return;
  video.addEventListener("play", () => {
    startDrawLoop(video);
  });
  video.addEventListener("ended", () => {
    stopDrawLoop();
    clearCanvas();
  });
  video.addEventListener("error", () => {
    stopDrawLoop();
    clearCanvas();
  });
  listenersAttached = true;
};

const resetPlayback = (video: HTMLVideoElement): void => {
  stopDrawLoop();
  clearCanvas();
  video.pause();
  video.removeAttribute("src");
  video.load();
  if (objectUrl !== null) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
};

export const videoPlayReqFromServer = (): void => {
  const video = getVideoElement();
  if (!video) {
    console.warn(`videoPlayReqFromServer: #${VIDEO_ELEMENT_ID} not found`);
    return;
  }
  chunks = [];
  resetPlayback(video);
  collecting = true;
  socketState.socket?.emit("videoPlayReqFromClient");
};

export const videoBufferFromServer = (chunk: ArrayBuffer): void => {
  if (!collecting) return;
  chunks.push(chunk);
};

export const videoPlayEndFromServer = (): void => {
  collecting = false;
  const video = getVideoElement();
  if (!video) {
    chunks = [];
    console.warn(`videoPlayEndFromServer: #${VIDEO_ELEMENT_ID} not found`);
    return;
  }
  if (!getCanvasElement()) {
    chunks = [];
    console.warn(`videoPlayEndFromServer: #${CANVAS_ELEMENT_ID} not found`);
    return;
  }
  if (chunks.length === 0) {
    console.warn("videoPlayEndFromServer: no chunks received");
    return;
  }

  const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const blob = new Blob(chunks, { type: MIME_TYPE });
  chunks = [];
  if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(blob);

  attachListeners(video);
  video.src = objectUrl;
  console.log(
    `videoPlayEndFromServer: play ${blob.size} bytes (${totalBytes} bytes received)`,
  );
  video.play().catch((err) => {
    // WebSocket 起点の再生はユーザー操作扱いにならず、自動再生がブロックされる場合がある。
    console.warn("videoPlayEndFromServer: autoplay blocked", err);
  });
};
