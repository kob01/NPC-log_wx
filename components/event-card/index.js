const { resolveFileUrl, shortTime } = require("../../utils/format");

Component({
  options: {
    // 允许 app.wxss 全局类（.tag/.ellipsis 等）作用于本组件
    addGlobalClass: true,
  },

  properties: {
    // 时间线条目：{id,time,event,type,summary,content,tags,persons,position,address,lng,lat,firstThumb,firstUrl,thumbs,score}
    entry: {
      type: Object,
      value: {},
      observer(entry) {
        if (!entry) return;
        // 缩略图：优先用 thumbs[]，否则回退 firstThumb
        let thumbs = Array.isArray(entry.thumbs)
          ? entry.thumbs.filter(Boolean)
          : [];
        if (!thumbs.length && entry.firstThumb) {
          thumbs = [entry.firstThumb];
        }
        this.setData({
          displayThumbs: thumbs.map(resolveFileUrl),
          // 卡片上只放 300px 缩略图（省流量），但点开后是全屏，必须换成原图地址，
          // 否则等于把缩略图放大三倍——这就是“大图发糊”的直接原因。
          // 列表接口已经一并返回了 firstUrl（只是一个字符串，不传图字节）
          previewUrls: entry.firstUrl
            ? [resolveFileUrl(entry.firstUrl)]
            : thumbs.map(resolveFileUrl),
          displayTags: (entry.tags || []).slice(0, 4),
          displayPersons: (entry.persons || []).slice(0, 3),
          bodyText: entry.summary || entry.content || "",
          displayTime: shortTime(entry.time),
          scorePercent:
            entry.score != null ? Math.round(entry.score * 100) : null,
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
    displayTags: [],
    displayPersons: [],
    bodyText: "",
    displayTime: "",
    scorePercent: null,
  },

  methods: {
    onTap() {
      this.triggerEvent("select", { id: this.properties.entry.id });
    },
    onPreview(e) {
      const index = e.currentTarget.dataset.index;
      const urls = this.data.previewUrls;
      wx.previewImage({
        current: urls[index] || urls[0],
        urls,
      });
    },
  },
});
