const api = require("../../utils/api");
const { resolveFileUrl } = require("../../utils/format");

// 海报逻辑尺寸（3:4 竖版），导出时按设备像素比放大
const LW = 600;
const LH = 800;
// 版式常量：内边距与配色（统一克制的靛蓝主色 + 高级灰阶）
const PAD = 44;
const PRIMARY = "#4a6cf7";
const INK = "#1f2430";
const BODY = "#5a6072";
const MUTED = "#9aa0b0";

/** 按最大宽度逐字换行（CJK 友好），支持手动 \n */
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let line = "";
  const chars = String(text || "").split("");
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\n") {
      lines.push(line);
      line = "";
      continue;
    }
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** 圆角矩形路径（不自动 fill/stroke） */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 文本超宽则截断并补省略号 */
function ellipsisText(ctx, text, maxW) {
  const s = String(text == null ? "" : text);
  if (ctx.measureText(s).width <= maxW) return s;
  let out = s;
  while (out.length && ctx.measureText(out + "…").width > maxW) {
    out = out.slice(0, -1);
  }
  return out + "…";
}

/**
 * 话题标签胶囊：圆角背景 + 主色文字，横向排列自动换行
 * @returns {number} 绘制结束后的 y（下一段内容的起点）
 */
function drawTagPills(ctx, tags, x, y, maxW, opt) {
  const o = opt || {};
  const fontSize = o.fontSize || 17;
  const padX = o.padX || 16;
  const h = o.h || 34;
  const gapX = o.gapX || 12;
  const gapY = o.gapY || 12;
  const maxRows = o.maxRows || 2;
  const max = o.max || tags.length;
  const limit = o.limit || Infinity; // 底部不可越界线
  const bg = o.bg || "rgba(74,108,247,0.10)";
  const fg = o.fg || PRIMARY;

  ctx.font = fontSize + "px sans-serif";
  const prevBaseline = ctx.textBaseline;
  ctx.textBaseline = "middle";
  let cx = x;
  let cy = y;
  let row = 1;
  let drawn = 0;
  for (let i = 0; i < tags.length && drawn < max; i++) {
    const raw = String(tags[i] || "").trim();
    if (!raw) continue;
    const label = raw.charAt(0) === "#" ? raw : "#" + raw;
    const pillW = ctx.measureText(label).width + padX * 2;
    if (cx + pillW > x + maxW && cx > x) {
      if (row >= maxRows) break;
      if (cy + h + gapY + h > limit) break; // 下一行放不下则停
      cx = x;
      cy += h + gapY;
      row++;
    }
    if (cy + h > limit) break; // 当前行越界则停
    roundRectPath(ctx, cx, cy, pillW, h, h / 2);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.fillText(label, cx + padX, cy + h / 2 + 1);
    cx += pillW + gapX;
    drawn++;
  }
  ctx.textBaseline = prevBaseline;
  return drawn ? cy + h : y;
}

Component({
  options: { addGlobalClass: true },

  properties: {
    visible: {
      type: Boolean,
      value: false,
      observer(v) {
        if (v) this.render();
      },
    },
    // 日志详情对象（含 id / event / summary / content / tags / images / position / author 等）
    entry: {
      type: Object,
      value: {},
      observer() {
        if (this.data.visible) this.render();
      },
    },
    // 卡片类型：single（单篇）/ summary（回顾）/ footprint（足迹）
    type: { type: String, value: "single" },
    // 预置文案（无 entry.id 时直接用它绘制，供总结/足迹卡片复用）
    presetCopy: {
      type: Object,
      value: null,
      observer() {
        if (this.data.visible && !this.data.entry.id) this.render();
      },
    },
    // 预置封面图（本地临时路径，如地图截屏）；优先于 entry 内图片
    presetImage: {
      type: String,
      value: "",
      observer() {
        if (this.data.visible) this.render();
      },
    },
  },

  data: {
    platform: "xiaohongshu",
    platforms: [
      { key: "xiaohongshu", label: "小红书" },
      { key: "douyin", label: "抖音" },
    ],
    copy: null,
    tip: "",
    canvasH: 789,
  },

  methods: {
    onPickPlatform(e) {
      this.setData({ platform: e.currentTarget.dataset.key });
      this.render();
    },

    onRegenerate() {
      this.render();
    },

    onClose() {
      this.triggerEvent("close");
    },

    /**
     * 取文案 + 绘制（防抖）
     * 页面一次 setData 会同时触发 visible/presetCopy/presetImage 多个 observer，
     * 不去抖会让 draw() 并发执行、canvas.width 重置互相清屏，导出得到黑图
     */
    render() {
      if (this._renderTimer) clearTimeout(this._renderTimer);
      this._renderTimer = setTimeout(() => {
        this._renderTimer = null;
        this.doRender();
      }, 50);
    },

    doRender() {
      // 无 event id（回顾/足迹）→ 直接用预置文案绘制
      if (!this.data.entry.id && this.data.presetCopy) {
        this.setData({ copy: this.data.presetCopy, tip: "" });
        this.draw();
        return;
      }
      this.fetchCopy().then(() => this.draw());
    },

    /** 调后端 AI 改写；失败/未配置降级为原文 */
    fetchCopy() {
      const entry = this.data.entry || {};
      if (!entry.id) return Promise.resolve();
      this.setData({ tip: "AI 改写中…" });
      return api.event
        .shareCopy({ id: entry.id, platform: this.data.platform })
        .then((res) => {
          if (Number(res.code) === 200 && res.data) {
            const d = res.data;
            this.setData({
              copy: {
                title: d.title || "",
                body: d.body || "",
                hashtags: d.hashtags || [],
              },
              tip: d.degraded ? "AI 暂不可用，已用原文预览" : "",
            });
          } else {
            this.setData({
              copy: this.fallbackCopy(),
              tip: res.message || "文案生成失败，已用原文",
            });
          }
        })
        .catch(() => {
          this.setData({
            copy: this.fallbackCopy(),
            tip: "网络异常，已用原文预览",
          });
        });
    },

    /** 降级文案：标题=原名，正文=摘要/正文截断，标签=原 tags */
    fallbackCopy() {
      const entry = this.data.entry || {};
      return {
        title: entry.event || "",
        body: String(entry.summary || entry.content || "").slice(0, 200),
        hashtags: (entry.tags || []).map((t) =>
          t.indexOf("#") === 0 ? t : "#" + t,
        ),
      };
    },

    /**
     * 加载封面图（网络图需 downloadFile 域名白名单）
     * 部分真机对本地临时路径（如地图截屏）onload/onerror 都不回调，
     * 加 2.5s 超时兜底 + 单次结算，避免整张海报被挂起画不出文字
     */
    loadImage(canvas, src) {
      const IMG_TIMEOUT_MS = 2500;
      return new Promise((resolve) => {
        if (!src) {
          resolve(null);
          return;
        }
        let settled = false;
        const finish = (v) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(v);
        };
        const timer = setTimeout(() => finish(null), IMG_TIMEOUT_MS);
        wx.getImageInfo({
          src,
          success: (info) => {
            const img = canvas.createImage();
            img.onload = () => finish(img);
            img.onerror = () => finish(null);
            img.src = info.path;
          },
          fail: () => finish(null),
        });
      });
    },

    /** 核心绘制 */
    draw() {
      // 绘制作废令牌：只有最后一次 draw 允许落笔，旧绘制异步回来后直接丢弃
      const seq = (this._drawSeq || 0) + 1;
      this._drawSeq = seq;
      const entry = this.data.entry || {};
      const copy = this.data.copy || this.fallbackCopy();
      const coverSrc = this.data.presetImage || this.resolveCover(entry);

      return new Promise((resolve) => {
        wx.createSelectorQuery()
          .in(this)
          .select("#poster")
          .fields({ node: true, size: true })
          .exec((res) => {
            if (this._drawSeq !== seq) {
              resolve();
              return;
            }
            const item = res && res[0];
            if (!item || !item.node) {
              // 弹窗刚打开的第一帧 canvas 可能尚未挂载，延迟重绘一次
              if (!this._nodeRetried) {
                this._nodeRetried = true;
                setTimeout(() => {
                  this._nodeRetried = false;
                  this.draw();
                }, 150);
                return;
              }
              resolve();
              return;
            }
            this._nodeRetried = false;
            const canvas = item.node;
            const dpr = wx.getSystemInfoSync().pixelRatio || 2;
            const ctx = canvas.getContext("2d");

            // 版式常量：图片永远占满宽、原比例、不裁剪、贴顶；卡片高度随内容自适应
            const GAP = 36; // 图片/头图与文案的间距
            const BPAD = 44; // 卡片底部留白
            const HEADER_H = 260; // 无图头图高
            const MIN_H = LH; // 卡片最小高（短内容仍保持约 3:4）
            const MAX_H = 2000; // 卡片最大高（防极端超长）
            const MAX_BODY = 12; // 正文最多行

            // 先测量文案高度（measureText 不依赖画布尺寸），据此算出总高
            const layout = this.computeLayout(ctx, entry, copy, MAX_BODY);

            const paint = (img) => {
              if (this._drawSeq !== seq) {
                resolve();
                return;
              }
              const mediaH = img ? LW / (img.width / img.height) : HEADER_H;
              const topY = mediaH + GAP;
              let H = Math.round(topY + layout.h + BPAD);
              H = Math.max(MIN_H, Math.min(MAX_H, H));

              // 重设画布尺寸（会重置 ctx 状态），再按 dpr 缩放
              canvas.width = LW * dpr;
              canvas.height = H * dpr;
              ctx.scale(dpr, dpr);

              // 背景：干净白底 + 底部极浅渐变
              const grd = ctx.createLinearGradient(0, 0, 0, H);
              grd.addColorStop(0, "#ffffff");
              grd.addColorStop(1, "#f5f6fa");
              ctx.fillStyle = grd;
              ctx.fillRect(0, 0, LW, H);

              // 媒体区：占满宽等比图（不裁剪），加载失败降级为头图
              if (img) {
                try {
                  ctx.drawImage(img, 0, 0, LW, mediaH);
                } catch (e) {
                  this.drawHeaderBand(ctx, HEADER_H);
                }
              } else {
                this.drawHeaderBand(ctx, HEADER_H);
              }

              // 文案区：按预计算布局全量绘制
              this.drawContentLayout(ctx, layout, topY, H);

              // 同步预览显示高度（592rpx 宽对应的等比高）
              this.setData({ canvasH: Math.round((592 * H) / LW) });
              resolve();
            };

            if (coverSrc) {
              this.loadImage(canvas, coverSrc).then((img) => {
                paint(img && img.width ? img : null);
              });
            } else {
              paint(null);
            }
          });
      });
    },

    /**
     * 测量文案布局（不绘制）：返回各段行数据与总高度 h
     * 供自适应卡片高度计算，并与 drawContentLayout 严格一致
     */
    computeLayout(ctx, entry, copy, maxBody) {
      const maxW = LW - PAD * 2;
      const L = {
        meta: "",
        titleLines: [],
        bodyLines: [],
        tags: [],
        tagRows: 0,
        h: 0,
      };
      let h = 0;

      const meta = [entry.time || "", entry.type || ""]
        .filter(Boolean)
        .join("   ·   ");
      if (meta) {
        L.meta = meta;
        h += 32;
      }

      ctx.font = "bold 33px sans-serif";
      L.titleLines = wrapText(
        ctx,
        copy.title || entry.event || "",
        maxW - 18,
      ).slice(0, 2);
      h += L.titleLines.length * 44;

      const bodyText = copy.body || "";
      if (bodyText) {
        ctx.font = "19px sans-serif";
        L.bodyLines = wrapText(ctx, bodyText, maxW).slice(0, maxBody);
        if (L.bodyLines.length) h += 12 + L.bodyLines.length * 32;
      }

      const tags = (copy.hashtags || []).filter(Boolean);
      if (tags.length) {
        ctx.font = "17px sans-serif";
        const padX = 16;
        const gapX = 12;
        const max = 6;
        let rows = 1;
        let cx = 0;
        let drawn = 0;
        for (let i = 0; i < tags.length && drawn < max; i++) {
          const raw = String(tags[i] || "").trim();
          if (!raw) continue;
          const label = raw.charAt(0) === "#" ? raw : "#" + raw;
          const w = ctx.measureText(label).width + padX * 2;
          if (cx + w > maxW && cx > 0) {
            if (rows >= 2) break;
            rows++;
            cx = 0;
          }
          cx += w + gapX;
          drawn++;
        }
        if (drawn) {
          L.tags = tags.slice(0, max);
          L.tagRows = rows;
          h += 16 + (rows * 34 + (rows - 1) * 12);
        }
      }

      L.h = h;
      return L;
    },

    /** 按预计算布局全量绘制文案区（与 computeLayout 严格一致，不截断） */
    drawContentLayout(ctx, L, topY, H) {
      const x = PAD;
      const maxW = LW - PAD * 2;
      let y = topY;
      ctx.textBaseline = "top";

      if (L.meta) {
        ctx.fillStyle = PRIMARY;
        ctx.beginPath();
        ctx.arc(x + 4, y + 7, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = "13px sans-serif";
        ctx.fillStyle = MUTED;
        ctx.fillText(ellipsisText(ctx, L.meta, maxW - 20), x + 16, y);
        y += 32;
      }

      if (L.titleLines.length) {
        const tx = x + 18;
        const barH = (L.titleLines.length - 1) * 44 + 34;
        roundRectPath(ctx, x, y + 1, 5, barH, 2.5);
        ctx.fillStyle = PRIMARY;
        ctx.fill();
        ctx.font = "bold 33px sans-serif";
        ctx.fillStyle = INK;
        L.titleLines.forEach((ln) => {
          ctx.fillText(ln, tx, y);
          y += 44;
        });
      }

      if (L.bodyLines.length) {
        y += 12;
        ctx.font = "19px sans-serif";
        ctx.fillStyle = BODY;
        L.bodyLines.forEach((ln) => {
          ctx.fillText(ln, x, y);
          y += 32;
        });
      }

      if (L.tags.length) {
        y += 16;
        drawTagPills(ctx, L.tags, x, y, maxW, {
          maxRows: L.tagRows,
          max: 6,
          limit: H,
        });
      }
    },

    /** 无封面时的品牌头图：柔和渐变 + 装饰圆 + 居中标题（按类型定制） */
    drawHeaderBand(ctx, bandH) {
      const H = bandH || 260;
      const type = this.data.type || "single";
      const grd = ctx.createLinearGradient(0, 0, LW, H);
      grd.addColorStop(0, "#4a6cf7");
      grd.addColorStop(0.55, "#6d7dff");
      grd.addColorStop(1, "#9078f2");
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, LW, H);

      // 装饰：半透明圆，营造层次
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      ctx.beginPath();
      ctx.arc(LW - 30, H - 20, 120, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(50, 24, 66, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      ctx.beginPath();
      ctx.arc(LW * 0.5, H * 0.42, 150, 0, Math.PI * 2);
      ctx.fill();

      // 居中标题（英文小字 + 中文大字）
      const map = {
        summary: { zh: "月度回顾", en: "MONTHLY REVIEW" },
        footprint: { zh: "我的足迹", en: "FOOTPRINT MAP" },
        single: { zh: "生活存档", en: "LIFE ARCHIVE" },
      };
      const t = map[type] || map.single;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(255,255,255,0.82)";
      ctx.font = "bold 15px sans-serif";
      ctx.fillText(t.en, LW / 2, H / 2 - 26);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 42px sans-serif";
      ctx.fillText(t.zh, LW / 2, H / 2 + 16);
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
    },

    resolveCover(entry) {
      const imgs = Array.isArray(entry.images) ? entry.images : [];
      const first = imgs.length
        ? imgs[0].url || imgs[0].thumbUrl
        : entry.firstThumb;
      return first ? resolveFileUrl(first) : "";
    },

    /** 导出当前画布为临时图片路径（各分享动作公用） */
    ensurePoster() {
      return new Promise((resolve, reject) => {
        wx.createSelectorQuery()
          .in(this)
          .select("#poster")
          .fields({ node: true })
          .exec((res) => {
            const canvas = res && res[0] && res[0].node;
            if (!canvas) {
              reject(new Error("canvas not ready"));
              return;
            }
            wx.canvasToTempFilePath({
              canvas,
              success: (r) => resolve(r.tempFilePath),
              fail: (err) => reject(err || new Error("export fail")),
            });
          });
      });
    },

    /** 保存到相册 */
    onSave() {
      wx.showLoading({ title: "生成中", mask: true });
      this.ensurePoster()
        .then((path) => {
          wx.hideLoading();
          this.saveToAlbum(path);
        })
        .catch(() => {
          wx.hideLoading();
          wx.showToast({ title: "导出失败", icon: "none" });
        });
    },

    /** 组合纯文本分享文案 */
    buildShareText() {
      const c = this.data.copy || {};
      return [c.title, c.body, (c.hashtags || []).join(" ")]
        .filter(Boolean)
        .join("\n\n");
    },

    /** 复制文案到剪贴板 */
    onCopyText() {
      const text = this.buildShareText();
      if (!text) {
        wx.showToast({ title: "暂无文案", icon: "none" });
        return;
      }
      wx.setClipboardData({
        data: text,
        success: () => wx.showToast({ title: "文案已复制", icon: "none" }),
      });
    },

    /**
     * 发给微信好友 / 朋友圈：拉起系统图片分享面板（发送给朋友，
     * 部分基础库版本面板内含朋友圈入口）；不支持/失败时降级为存相册+引导
     */
    onShareWx() {
      wx.showLoading({ title: "生成中", mask: true });
      this.ensurePoster()
        .then((path) => {
          wx.hideLoading();
          wx.showShareImageMenu({
            path,
            fail: (err) => {
              const msg = String((err && err.errMsg) || "");
              if (msg.indexOf("cancel") > -1) return;
              this.shareWxFallback(path);
            },
          });
        })
        .catch(() => {
          wx.hideLoading();
          wx.showToast({ title: "导出失败", icon: "none" });
        });
    },

    /** 微信分享面板不可用：存相册 + 引导手动发好友/朋友圈 */
    shareWxFallback(path) {
      this.saveToAlbum(path);
      wx.showModal({
        title: "已保存到相册",
        content:
          "发朋友圈：微信「发现 → 朋友圈 → 长按相机图标 → 从相册选择」；发好友：聊天框「+ → 相册」选择该海报",
        showCancel: false,
      });
    },

    /**
     * 去抖音/小红书发布：小程序无第三方平台分享 API，
     * 采用「存海报 + 复制文案 + 引导打开 App」的标准做法
     */
    onShareToApp(e) {
      const key = e.currentTarget.dataset.platform;
      const label = key === "douyin" ? "抖音" : "小红书";
      wx.showLoading({ title: "生成中", mask: true });
      this.ensurePoster()
        .then((path) => {
          wx.hideLoading();
          this.saveToAlbum(path);
          const text = this.buildShareText();
          const after = () =>
            wx.showModal({
              title: `去${label}发布`,
              content: `海报已存到相册${
                text ? "，分享文案已复制到剪贴板" : ""
              }。打开${label}，发布图文时选择该海报${text ? "并粘贴文案" : ""}即可`,
              showCancel: false,
            });
          if (text) {
            wx.setClipboardData({ data: text, success: after, fail: after });
          } else {
            after();
          }
        })
        .catch(() => {
          wx.hideLoading();
          wx.showToast({ title: "导出失败", icon: "none" });
        });
    },

    saveToAlbum(path) {
      wx.saveImageToPhotosAlbum({
        filePath: path,
        success: () => wx.showToast({ title: "已保存到相册", icon: "success" }),
        fail: (err) => {
          const msg = String((err && err.errMsg) || "");
          if (
            msg.indexOf("auth") > -1 ||
            msg.indexOf("deny") > -1 ||
            msg.indexOf("权限") > -1
          ) {
            wx.showModal({
              title: "需要相册权限",
              content: "请在设置中允许保存图片到相册",
              confirmText: "去设置",
              success: (m) => {
                if (m.confirm) wx.openSetting();
              },
            });
          } else {
            wx.showToast({ title: "保存失败", icon: "none" });
          }
        },
      });
    },
  },
});
