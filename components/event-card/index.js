const { resolveFileUrl, shortTime } = require("../../utils/format");

Component({
  options: {
    // 允许 app.wxss 全局类（.tag/.ellipsis 等）作用于本组件
    addGlobalClass: true,
  },

  properties: {
    // 时间线条目：{id,time,event,type,summary,content,tags,persons,position,address,lng,lat,firstThumb,thumbs,score}
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
      wx.previewImage({
        current: this.data.displayThumbs[index],
        urls: this.data.displayThumbs,
      });
    },
  },
});
