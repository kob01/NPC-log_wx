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
  "/api/event/share-copy",
  "/api/event/transcribe",
  "/api/event/parse-voice-text",
];

// 需要走「长超时」的非 AI 接口：后端本身很快（不超 8s），但会同步出一趟网。
// 与 AI_URL_PREFIXES 分开是有意：那边与后端 metrics.groupOf() 的 AI 分流一一对应，
// 把非 AI 接口塞进去会让「改一边记得改另一边」这条约定不再成立。
const SLOW_URL_PREFIXES = ["/api/reminder/test"];

module.exports = {
  BASE_URL,
  // 与 Web 端保持一致的本地缓存 key
  TOKEN_KEY: "NPC_token",
  USER_KEY: "NPC_user",
  ONLY_MINE_KEY: "npc_only_mine", // 日志列表查看范围（'all'|'mine'|'others'|'private'，旧版可能为布尔）
  // 「用户主动退出登录」的一次性标记：微信一键登录的账号一点退出就会被
  // 静默登录立刻送回首页，看起来像退出没生效（见 pages/login/login.js 的 onLoad）
  MANUAL_LOGOUT_KEY: "npc_manual_logout",
  // ==================== 访问打点（见 utils/appVisit.js）====================
  // 总开关：置 false 就彻底不上报（只改端上，不动后端也能关）
  VISIT_TRACK: true,
  // 当前这次打开的 {visitKey, closeKey}：onHide 收尾后用掉即清。
  // 必须落存储而不是只放内存：小程序被系统回收时 JS 模块会重启，
  // 而「上次根本没机会上报关闭」正是最需要补记的那种情况
  VISIT_PENDING_KEY: "npc_visit_pending",
  // open 上报失败（断网/后端重启）时攒下的待发报文，下次进前台先补发
  VISIT_RETRY_KEY: "npc_visit_retry",
  VISIT_RETRY_MAX: 20,
  // 两次 onShow 间隔小于这个值就合并成一次：部分安卓机型一次前后台切换会连发两次 onShow，
  // 不合并的话「打开次数」会被虚高一倍
  VISIT_MERGE_MS: 5000,
  // 结果缓存落盘的 key 前缀（冷启动秒开用）
  CACHE_KEY_PREFIX: "npc_cache_",
  // 普通接口超时：后端读接口分级超时是 8s，客户端不需要同步等 60s。
  // 原来统一 60s 会让突发时用户长时间白屏，也不触发重试。
  TIMEOUT: 8000,
  // AI 接口超时（要盖住后端 45s 闸门 + 网络往返）
  AI_TIMEOUT: 50000,
  AI_URL_PREFIXES,
  // 不走 AI、但后端会同步出一趟网的接口（后端给它们的超时是 15s 写接口档）：
  // /api/reminder/test 要现取一次微信 access_token 再下发，默认 8s 会误判成失败
  SLOW_TIMEOUT: 20000,
  SLOW_URL_PREFIXES,
  // 幂等 GET 在 429/503/超时后的退避重试（服务端过载时让客户端自己错峰）
  RETRY_MAX: 2,
  RETRY_BASE_DELAY: 300,
};
