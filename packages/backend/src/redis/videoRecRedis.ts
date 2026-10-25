import { redis } from "./client";

// クライアントごとに直近の録画チャンクを Redis のリストで保持する。
// 再生リクエスト時は、そのクライアントのリストを丸ごと返す。
const KEY_PREFIX = "video:rec:";
const TTL_SECONDS = 60 * 60;
// 0.5 秒 × 120 = 60 秒ぶん。15 秒録画には十分な余裕がある。
const MAX_CHUNKS = 120;

export const videoRecKey = (clientId: string): string =>
  `${KEY_PREFIX}${clientId}`;

export const videoRecRedis = {
  // 新しい録画の開始時に、前回の録画を破棄する。
  async start(clientId: string): Promise<void> {
    await redis.del(videoRecKey(clientId));
  },

  async push(clientId: string, chunk: ArrayBuffer): Promise<void> {
    const key = videoRecKey(clientId);
    await redis.rpush(key, Buffer.from(chunk).toString("base64"));
    await redis.expire(key, TTL_SECONDS);
    // 想定より長い録画でリストが伸び続けないように、新しい側だけ残す。
    await redis.ltrim(key, -MAX_CHUNKS, -1);
  },

  async getAll(clientId: string): Promise<ArrayBuffer[]> {
    const raws = await redis.lrange(videoRecKey(clientId), 0, -1);
    return raws.map((raw) => {
      const buf = Buffer.from(raw, "base64");
      return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer;
    });
  },
};
