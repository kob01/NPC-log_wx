/**
 * 通用格式化与工具函数
 */
const { BASE_URL } = require("../config");

/**
 * 解析后端返回的相对图片路径为可访问地址
 * @param {string} path - /uploads/... 或完整 URL
 * @returns {string}
 */
function resolveFileUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return BASE_URL + normalized;
}

/**
 * 取 YYYY-MM-DD 作为日期分组键
 * @param {string} time - YYYY-MM-DD HH:mm
 */
function dayKey(time) {
  return time ? String(time).slice(0, 10) : "未知日期";
}

/**
 * 卡片展示时间去掉年份：YYYY-MM-DD HH:mm → MM-DD HH:mm
 * 非标准格式（如缺年份或无日期）原样返回
 * @param {string} time
 */
function shortTime(time) {
  if (!time) return "";
  const s = String(time);
  return /^\d{4}-/.test(s) ? s.slice(5) : s;
}

/** 空值占位 */
const EMPTY = "-";
function orDash(v) {
  return v === null || v === undefined || v === "" ? EMPTY : v;
}

/** 逗号串 → 去重数组 */
function csvToArray(csv) {
  if (csv === null || csv === undefined || csv === "") return [];
  const list = Array.isArray(csv) ? csv : String(csv).split(",");
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
}

/** 数组 → 逗号串 */
function arrayToCsv(arr) {
  if (arr === null || arr === undefined) return null;
  const list = Array.isArray(arr) ? arr : String(arr).split(",");
  const s = list
    .map((x) => String(x).trim())
    .filter(Boolean)
    .join(",");
  return s || null;
}

/** 补零 */
function pad(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Date → YYYY-MM-DD HH:mm */
function formatDateTime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** 当前时间字符串 YYYY-MM-DD HH:mm */
function nowDateTime() {
  return formatDateTime(new Date());
}

/** 当前日期 YYYY-MM-DD */
function nowDate() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 当前月份 YYYY-MM */
function nowMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

module.exports = {
  resolveFileUrl,
  dayKey,
  shortTime,
  EMPTY,
  orDash,
  csvToArray,
  arrayToCsv,
  formatDateTime,
  nowDateTime,
  nowDate,
  nowMonth,
};
