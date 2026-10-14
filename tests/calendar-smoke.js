#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * 手机系统日历写入的自检（node tests/calendar-smoke.js）
 *
 * 为什么值得单独立一份：utils/calendar.js 里那套「后端重复规则 → 微信 repeatInterval」的映射
 * 全是边界 case（month 档不能落在 29~31 日、没有「每 N 天」、时间串解析不出必须退化而不是
 * 写一个 1970 年的事件），而这些在开发者工具里点一次只能验到其中一条，真机又要点十几下。
 *
 * 做法与其它自检一致：把 utils/calendar.js 原样 require 进来，只 stub 掉用到的那几个 wx 接口。
 */

// ==================== 假 wx（只装 calendar.js 会碰的那几个）====================
function makeFakeWx() {
  const store = {};
  const fake = {
    __calls: [],
    __authSetting: {},
    __privacyBlocked: false,
    __reset() {
      fake.__calls = [];
      fake.__authSetting = {};
      fake.__privacyBlocked = false;
      Object.keys(store).forEach((k) => delete store[k]);
    },
    getStorageSync: (key) => store[key] || "",
    setStorageSync: (key, val) => {
      store[key] = val;
    },
    getSetting({ success }) {
      success({ authSetting: fake.__authSetting });
    },
    authorize({ scope, success, fail }) {
      if (fake.__privacyBlocked) {
        fail({
          errCode: 112,
          errMsg: `${scope}:fail api scope is not declared in the privacy agreement`,
        });
        return;
      }
      fake.__authSetting[scope] = true;
      success();
    },
    addPhoneCalendar(opts) {
      fake.__calls.push({ api: "addPhoneCalendar", args: opts });
      opts.success && opts.success({});
    },
    addPhoneRepeatCalendar(opts) {
      fake.__calls.push({ api: "addPhoneRepeatCalendar", args: opts });
      opts.success && opts.success({});
    },
  };
  return fake;
}

global.wx = makeFakeWx();
const calendar = require("../utils/calendar");

let passed = 0;
let failed = 0;

function check(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) {
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${name}\n      期望 ${b}\n      实际 ${a}`);
}

const rowOf = (over) =>
  Object.assign({ id: 1, title: "交报告", time: "2026-11-05 09:00", remark: "" }, over);

console.log("\n[1] 重复规则映射（微信只有 day/week/month/year 四档）");
check("每天 → day", calendar.planOf(rowOf({ repeat: "daily" })).repeatInterval, "day");
check("每周 → week", calendar.planOf(rowOf({ repeat: "weekly" })).repeatInterval, "week");
check("每年 → year", calendar.planOf(rowOf({ repeat: "yearly" })).repeatInterval, "year");
check("不重复 → 单次", calendar.planOf(rowOf({ repeat: "none" })).repeatInterval, "");
check(
  "每月 5 日 → month",
  calendar.planOf(rowOf({ repeat: "monthly", time: "2026-11-05 09:00" })).repeatInterval,
  "month",
);
check(
  "每月 30 日 → 退化单次（month 档不能大于 28 日）",
  calendar.planOf(rowOf({ repeat: "monthly", time: "2026-11-30 09:00" })).repeatInterval,
  "",
);
check(
  "「每月 30 日」的退化原因必须带日期",
  /28 日.*30 日/.test(
    calendar.planOf(rowOf({ repeat: "monthly", time: "2026-11-30 09:00" })).degrade,
  ),
  true,
);
check(
  "每 1 天 → day",
  calendar.planOf(
    rowOf({ repeat: "custom", intervalValue: 1, intervalUnit: "day" }),
  ).repeatInterval,
  "day",
);
check(
  "每 1 个月 → month",
  calendar.planOf(
    rowOf({ repeat: "custom", intervalValue: 1, intervalUnit: "month" }),
  ).repeatInterval,
  "month",
);
check(
  "每 3 天 → 退化单次",
  calendar.planOf(
    rowOf({ repeat: "custom", intervalValue: 3, intervalUnit: "day" }),
  ).repeatInterval,
  "",
);
check(
  "每 2 小时的退化提示要说清单位",
  calendar
    .planOf(rowOf({ repeat: "custom", intervalValue: 2, intervalUnit: "hour" }))
    .degrade.includes("每2小时"),
  true,
);

console.log("\n[2] 时间戳（必须按本机时区解释墙钟串，读不出来就不能写）");
const okPlan = calendar.planOf(rowOf({ time: "2026-11-05 09:00" }));
const okDate = new Date(okPlan.startTime * 1000);
check(
  '2026-11-05 09:00 解回本机同一墙钟',
  [
    okDate.getFullYear(),
    okDate.getMonth() + 1,
    okDate.getDate(),
    okDate.getHours(),
    okDate.getMinutes(),
  ],
  [2026, 11, 5, 9, 0],
);
check("事件默认占半小时", okPlan.endTime - okPlan.startTime, 30 * 60);
check("空时间 → startTime=0", calendar.planOf(rowOf({ time: "" })).startTime, 0);
check(
  "iOS 易踩的空格分隔写法与 T 分隔等价",
  calendar.planOf(rowOf({ time: "2026-11-05T09:00:00" })).startTime,
  okPlan.startTime,
);

console.log("\n[3] addRow 的三条出口（成功 / 已写过 / 未授权）");
(async () => {
  wx.__reset();

  const first = await calendar.addRow(rowOf({ id: 7, repeat: "daily" }));
  check("首次写入成功", first.ok, true);
  check("首次不该报 stale", first.stale, false);
  check("调的是重复事件接口", wx.__calls[0].api, "addPhoneRepeatCalendar");
  check("到点即提醒", wx.__calls[0].args.alarmOffset, 0);
  check("说明里带上提醒 ID", /#7/.test(wx.__calls[0].args.description), true);

  const again = await calendar.addRow(rowOf({ id: 7, repeat: "daily" }));
  check("同一行再点是「已写过」而不是第二条", [again.ok, again.repeated], [false, true]);

  const changed = await calendar.addRow(
    rowOf({ id: 7, repeat: "daily", time: "2026-11-05 10:00" }),
  );
  check("时间改了会写新的一条", changed.ok, true);
  check("并告知旧的那条还留在日历里", changed.stale, true);

  wx.__authSetting["scope.addPhoneCalendar"] = false;
  const denied = await calendar.addRow(rowOf({ id: 8, repeat: "none" }));
  check("拒绝过一次时不再空转", [denied.ok, denied.denied], [false, true]);

  // 隐私声明没配：接口层直接不响应，报的错得指向「服务端配置」而不是用户
  wx.__privacyBlocked = true;
  wx.__authSetting = {};
  const blocked = await calendar.addRow(rowOf({ id: 9, repeat: "none" }));
  check(
    "errno 112 要翻成「服务端未声明」而不是「你不授权」",
    /服务端未声明/.test(blocked.reason || ""),
    true,
  );
  check(
    "写失败的那条不该落进已写记录（否则会谎称「已在日历」）",
    calendar.isWritten(rowOf({ id: 9, repeat: "none" })),
    false,
  );

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
