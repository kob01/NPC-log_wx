/**
 * 全局配置
 * BASE_URL：后端服务地址，需与你的实际部署一致，只改这一处即可：
 *   - 经 Nginx 反代（/api、/uploads 同域）：http://47.116.208.170
 *   - 本机联调：http://localhost:3000
 * 注意：正式发布需在小程序后台配置 HTTPS 备案域名，开发阶段在开发者工具
 * 勾选「不校验合法域名」即可使用下面的 HTTP 地址。
 */
// 【临时】指向本地 node 服务（NPC-log_node 默认 3000 端口，若 .env 改了 PORT 需同步）；
// ⚠️ 真机预览必须用手机能访问的局域网 IP，localhost 会被解析到手机自身
// const BASE_URL = "http://192.168.3.24:3000";
const BASE_URL = "http://47.116.208.170";

// 需要走「长超时」的 AI 接口前缀：后端这些接口要等外部 LLM/ASR，普通 8s 会误判失败。
// 与后端 src/utils/metrics.js 的 groupOf() 分流保持一致，改一边记得改另一边。
const AI_URL_PREFIXES = [
  "/api/memory/ask",
  "/api/memory/search",
  "/api/memory/summary",
  "/api/memory/report",
  "/api/memory/share-copy",
  "/api/event/share-copy",
  "/api/event/transcribe",
  "/api/event/parse-voice-text",
];

module.exports = {
  BASE_URL,
  // 与 Web 端保持一致的本地缓存 key
  TOKEN_KEY: "NPC_token",
  USER_KEY: "NPC_user",
  ONLY_MINE_KEY: "npc_only_mine",
  // 结果缓存落盘的 key 前缀（冷启动秒开用）
  CACHE_KEY_PREFIX: "npc_cache_",
  // 普通接口超时：后端读接口分级超时是 8s，客户端不需要同步等 60s。
  // 原来统一 60s 会让突发时用户长时间白屏，也不触发重试。
  TIMEOUT: 8000,
  // AI 接口超时（要盖住后端 45s 闸门 + 网络往返）
  AI_TIMEOUT: 50000,
  AI_URL_PREFIXES,
  // 幂等 GET 在 429/503/超时后的退避重试（服务端过载时让客户端自己错峰）
  RETRY_MAX: 2,
  RETRY_BASE_DELAY: 300,
};
