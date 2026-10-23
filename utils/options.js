/**
 * 分类 / 评价候选：小程序内的单一来源（编辑页 picker 与存档页筛选抽屉共用）
 *
 * 为什么必须统一：这两列在后端存的就是中文原文（note_events.event_type /
 * event_rating），写入按原样保存、筛选走 IN 精确匹配，所以数组里的值不是 UI 文案
 * 而是数据契约的一部分 —— 两处各写一份，改了一边就会出现「编辑页能选、筛选页选不到」
 * 或筛选条件永远匹配不上存量数据的静默失效。
 *
 * 顺序沿用编辑页 picker（用户天天滑的那一版），筛选抽屉与之一致；
 * 集合与 Web 端 NPC-log/src/pages/content/log/model.ts 的同名数组保持一致，
 * 增删分类/评价档位时要三处同步（Web 表单、Web 筛选、本文件）。
 */
const TYPE_OPTIONS = [
  "吃喝",
  "生活",
  "运动",
  "爱好",
  "学习",
  "Her",
  "旅游",
  "家庭",
  "社交",
  "大事件",
  "待办",
  "衣",
  "工作",
  "其他",
];

const RATING_OPTIONS = ["夯", "好", "NPC", "拉", "拉完了"];

module.exports = { TYPE_OPTIONS, RATING_OPTIONS };
