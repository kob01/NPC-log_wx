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
    // 屏蔽名单：列表只带条数，名单本体按需拉（几行的小表，不值得每次都拉）
    blockedCount: 0,
    showBlocks: false,
    blocks: [],
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
          // 把「你屏蔽了几个」带回来：入口藏在二级页里时，这是唯一能找回出口的线索
          blockedCount: Number(data.blockedCount || 0),
        });
        // 不用可选链 ?.：会被增强编译转成 @swc/runtime helper，工具端 runtime 缺失时整页注册失败
        const hit = list.find((p) => p.person === this._deepName);
        // 深链优先，其次保住当前选中的人（屏蔽/恢复后重拉不该把选中项跳到第一个），再退回首位
        const cur = this.data.selected;
        const kept = cur && list.find((p) => p.person === cur) ? cur : "";
        const target =
          (hit && hit.person) || kept || (list[0] && list[0].person) || "";
        if (target) this.selectPersonByName(target);
        else this.setData({ selected: "", timeline: null, yearChips: [] });
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

  // ==================== 屏蔽图谱里的一个人 ====================

  /**
   * 长按人物卡屏蔽掉这个人（只从自己的图谱列表里消失）
   *
   * 为什么要弹窗确认一句：屏蔽后这张卡就从图上没了，用户会以为是「这个人没了」；
   * 弹窗里把「只影响列表、TA 的相关日志与 AI 问答都不变、可在已屏蔽里恢复」说清，
   * 比事后去二级入口找出口便宜得多。
   * 长按而不是给每张卡挂一个 ✕：横滑卡片本来就窄，多一个按钮会挤掉姓名，
   * 而这个动作低频到不该占常驻位置。
   */
  onBlockPerson(e) {
    const name = e.currentTarget.dataset.name;
    if (!name) return;
    wx.showModal({
      title: `屏蔽「${name}」`,
      content:
        "只从你的人物图谱列表里隐藏这个人：日志正文、TA 的相关日志与 AI 问答都不受影响。需要时在「已屏蔽」里恢复。",
      confirmText: "屏蔽",
      confirmColor: "#f5222d",
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const res = await api.memory.blockPerson(name);
          if (Number(res.code) !== 200) {
            wx.showToast({ title: res.message || "屏蔽失败", icon: "none" });
            return;
          }
          // 本地剔掉那一格，不重拉整张图：重拉会把选中项跳走，而屏蔽不该打断用户在看的时间线
          this.setData({
            blockedCount: Number((res.data || {}).blockedCount || 0),
            persons: this.data.persons.filter((p) => p.person !== name),
            filtered: this.data.filtered.filter((p) => p.person !== name),
          });
          // 屏蔽的正是当前看着的那个人：时间线得跟着收起来，否则留下一个图上找不到的选中态
          if (this.data.selected === name) {
            this.setData({ selected: "", timeline: null, yearChips: [] });
          }
          if (this.data.showBlocks) this.loadBlocks();
          wx.showToast({ title: "已从图谱隐藏", icon: "none" });
        } catch (err) {
          wx.showToast({ title: "网络异常，请重试", icon: "none" });
        }
      },
    });
  },

  /** 展开/收起已屏蔽名单（屏蔽了谁必须能找回来，否则与「人没了」无法区分） */
  toggleBlocks() {
    const show = !this.data.showBlocks;
    this.setData({ showBlocks: show });
    if (show) this.loadBlocks();
  },

  async loadBlocks() {
    try {
      const { code, data } = await api.memory.personBlocks();
      if (Number(code) === 200 && data) {
        const blocks = data.blocks || [];
        this.setData({ blocks, blockedCount: blocks.length });
      }
    } catch (err) {
      /* 已提示 */
    }
  },

  /** 恢复一个人：图谱那边是缓存过的，必须重拉一次这个人才会回来（客户端缓存已在 api 层清掉） */
  async onUnblock(e) {
    const name = e.currentTarget.dataset.name;
    if (!name) return;
    try {
      const res = await api.memory.unblockPerson(name);
      if (Number(res.code) !== 200) {
        wx.showToast({ title: res.message || "恢复失败", icon: "none" });
        return;
      }
      this.setData({
        blocks: this.data.blocks.filter((b) => b.person !== name),
        blockedCount: Number((res.data || {}).blockedCount || 0),
      });
      wx.showToast({ title: "已恢复", icon: "success" });
      this.loadPersons();
    } catch (err) {
      wx.showToast({ title: "网络异常，请重试", icon: "none" });
    }
  },
});
