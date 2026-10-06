const api = require("../../utils/api");
const auth = require("../../utils/auth");

// 姓名 → 色相（0~359）：不同的人落到不同颜色
function hueOf(name) {
  const s = name || "?";
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) % 360;
  }
  return h;
}

// HSL → [r,g,b]（0~1），仅用于估算感知亮度以决定头像文字用深色还是白色
function hslToRgb(h, s, l) {
  const sat = s / 100;
  const lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

Page({
  behaviors: [require("../../utils/themeBehavior")],
  data: {
    persons: [],
    filtered: [],
    keyword: "",
    selected: "",
    year: "",
    yearChips: [],
    timeline: null,
    listLoading: true,
    timelineLoading: false,
    // 后端扫描行数触顶时为 true（人物统计只覆盖了最近 N 条）
    partial: false,
  },

  _deepName: "",

  onLoad(options) {
    this._deepName = options.name ? decodeURIComponent(options.name) : "";
  },

  onShow() {
    if (!auth.checkLogin()) return;
    this.loadPersons();
  },

  /** 下拉强制重拉（api.memory.persons 带 5 分钟缓存，缓存过期后这里才会真正发请求） */
  onPullDownRefresh() {
    this.loadPersons().then(() => wx.stopPullDownRefresh());
  },

  withInitial(persons) {
    return persons.map((p) =>
      Object.assign({}, p, { initial: (p.person || "?").charAt(0) }),
    );
  },

  /** 配色：色相随姓名变化（人人不同）；条数越多明度越低（颜色越深），采用绝对对数刻度，与列表其他人无关 */
  withColor(persons) {
    const cap = 30; // 达到该条数即为最深色
    const denom = Math.log(1 + cap);
    return persons.map((p) => {
      const ratio = Math.min(1, Math.log(1 + (p.count || 0)) / denom); // 0~1，对数刻度拉开低频差距
      const light = Math.round(70 - ratio * 38); // 70% 最浅 → 32% 最深
      const sat = Math.round(48 + ratio * 24); // 越多越饱和
      const hue = hueOf(p.person);
      const rgb = hslToRgb(hue, sat, light);
      const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
      return Object.assign({}, p, {
        avatarColor: `hsl(${hue}, ${sat}%, ${light}%)`,
        avatarFg: lum > 0.62 ? "#3a3a3a" : "#ffffff",
      });
    });
  },

  async loadPersons() {
    try {
      this.setData({ listLoading: true });
      const { code, data } = await api.memory.persons();
      if (Number(code) === 200 && data) {
        const list = this.withColor(this.withInitial(data.persons || []));
        // partial：后端只统计了最近 N 条，提示用户统计范围有限
        this.setData({
          persons: list,
          filtered: list,
          partial: !!data.partial,
        });
        // 不用可选链 ?.：会被增强编译转成 @swc/runtime helper，工具端 runtime 缺失时整页注册失败
        const hit = list.find((p) => p.person === this._deepName);
        const target = (hit && hit.person) || (list[0] && list[0].person) || "";
        if (target) this.selectPersonByName(target);
      }
      this._deepName = "";
    } catch (err) {
      /* 已提示 */
    } finally {
      this.setData({ listLoading: false });
    }
  },

  onKeywordInput(e) {
    const v = (e.detail.value || "").trim();
    this.setData({
      keyword: v,
      filtered: v
        ? this.withInitial(
            this.data.persons.filter((p) => p.person.indexOf(v) !== -1),
          )
        : this.data.persons,
    });
  },

  selectPerson(e) {
    this.selectPersonByName(e.currentTarget.dataset.name);
  },

  selectPersonByName(name) {
    this.setData({ selected: name, year: "" });
    this.loadTimeline(name, "");
  },

  async loadTimeline(person, year) {
    if (!person) return;
    try {
      this.setData({ timelineLoading: true });
      const { code, data } = await api.memory.person(person, year);
      if (Number(code) === 200 && data) {
        const yearChips = [{ label: "全部", value: "" }].concat(
          (data.years || []).map((y) => ({
            label: `${y.year}(${y.count})`,
            value: String(y.year),
          })),
        );
        this.setData({ timeline: data, yearChips });
      } else {
        this.setData({ timeline: null, yearChips: [] });
      }
    } catch (err) {
      this.setData({ timeline: null });
    } finally {
      this.setData({ timelineLoading: false });
    }
  },

  onYearChip(e) {
    const year = e.currentTarget.dataset.year || "";
    this.setData({ year });
    this.loadTimeline(this.data.selected, year);
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${e.detail.id}` });
  },
});
