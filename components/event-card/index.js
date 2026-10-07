const { resolveFileUrl, shortTime } = require("../../utils/format");

/** 相对路径数组 → 可访问地址数组（顺手丢掉空值，老数据可能没 thumb_url） */
function toFullUrls(list) {
  return (Array.isArray(list) ? list : []).filter(Boolean).map(resolveFileUrl);
}

Component({
  options: {
    // 允许 app.wxss 全局类（.tag/.ellipsis 等）作用于本组件
    addGlobalClass: true,
  },

  properties: {
    // 时间线条目：{id,time,event,type,summary,content,tags,persons,position,address,lng,lat,
    // firstThumb,firstUrl,thumbs,imageUrls,imageCount,score,isMine}
    entry: {
      type: Object,
      value: {},
      observer(entry) {
        if (!entry) return;
        // 卡片上的缩略图：优先用 thumbs[]，否则回退 firstThumb
        const thumbs = toFullUrls(
          entry.thumbs && entry.thumbs.length
            ? entry.thumbs
            : [entry.firstThumb],
        );
        // 卡片上只放 300px 缩略图（省流量），但点开后是全屏，必须换成原图地址，
        // 否则等于把缩略图放大三倍——这就是“大图发糊”的直接原因。
        // 预览源按「整条原图集 imageUrls[] → 首图原图 firstUrl → 缩略图」逐级回退，
        // 拿到几张就能滑几张；角标只看实际能滑的张数，不拿 imageCount 报一个点不开的数
        const preview = toFullUrls(
          entry.imageUrls && entry.imageUrls.length
            ? entry.imageUrls
            : [entry.firstUrl],
        );
        const previewUrls = preview.length ? preview : thumbs;
        this.setData({
          displayThumbs: thumbs,
          previewUrls,
          imageCount: previewUrls.length,
          displayTags: (entry.tags || []).slice(0, 4),
          displayPersons: (entry.persons || []).slice(0, 3),
          bodyText: entry.summary || entry.content || "",
          displayTime: shortTime(entry.time),
          scorePercent:
            entry.score != null ? Math.round(entry.score * 100) : null,
          // 贴卡片左边缘的蓝竖条：只认明确为 true 的归属标记，
          // 未映射 isMine 的页面（report/persons）一律不出
          showMineBar: entry.isMine === true,
        });
      },
    },
    // 是否显示相关度（搜索结果模式）
    showScore: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    displayThumbs: [],
    previewUrls: [],
    imageCount: 0,
    displayTags: [],
    displayPersons: [],
    bodyText: "",
    displayTime: "",
    scorePercent: null,
    showMineBar: false,
  },

  methods: {
    onTap() {
      this.triggerEvent("select", { id: this.properties.entry.id });
    },
    /** 点开缩略图：全屏预览整条图集，wx.previewImage 原生支持左右滑动翻页 */
    onPreview() {
      const urls = this.data.previewUrls;
      if (!urls.length) return;
      wx.previewImage({ current: urls[0], urls });
    },
  },
});
