/**
 * 全局播放台账
 *
 * 为什么要这么一层：InnerAudioContext 是「谁创建谁持有」的，页面之间互相看不见对方的
 * 实例。于是「点录制」这个动作没法把别处正在播的那段停掉 —— 详情页放着录音回到编辑页
 * 点重录，或在录音卡上直接重播上一条，两段声音会叠在一起，录进去的还会把自己放的旧
 * 录音一起录下来（转写出来的文字里就混着上一段的内容）。
 *
 * 所以播放实例统一从这里取，起录前一句 stopAll() 全静音。
 *
 * 台账还额外记一份「此刻真的在播」的集合：stopAll() 只对着在播的发 stop。
 * 盲发有两个代价 —— 每次 stop 都是一个 JSBridge 往返（点录制那一刻正卡在原生从
 * 放音切到录音的缝上，多一发就多一分顿感），而且 stop 会回触发该实例的 onStop，
 * 让那一页白白 setData 刷一次。
 */
const live = [];
const playing = [];

function markPlaying(audio) {
  if (playing.indexOf(audio) === -1) playing.push(audio);
}
function markIdle(audio) {
  const i = playing.indexOf(audio);
  if (i >= 0) playing.splice(i, 1);
}

function wrap(name, before, after) {
  return (audio) => {
    const raw = typeof audio[name] === "function" ? audio[name].bind(audio) : null;
    audio[name] = (...args) => {
      if (before) before(audio);
      let ret;
      try {
        if (raw) ret = raw(...args);
      } finally {
        if (after) after(audio);
      }
      return ret;
    };
  };
}

/**
 * 建一个登记在案的播放器。destroy 被包了一层：调用方照常 destroy，出账自动完成，
 * 不需要它记得再通知台账（漏一次就会留下一辈子停不掉的幽灵实例）。
 * @returns {object} wx InnerAudioContext
 */
function create() {
  const audio = wx.createInnerAudioContext();
  live.push(audio);
  // play() 当场就登记，不等原生回 onPlay：手指快（刚点播放就点重录）时
  // 那一枪 onPlay 还没回来，靠回调记账会漏停这一段
  wrap("play", markPlaying)(audio);
  wrap("pause", markIdle)(audio);
  wrap("stop", markIdle)(audio);
  const rawDestroy =
    typeof audio.destroy === "function" ? audio.destroy.bind(audio) : null;
  audio.destroy = () => {
    const i = live.indexOf(audio);
    if (i >= 0) live.splice(i, 1);
    markIdle(audio);
    if (rawDestroy) rawDestroy();
  };
  // 原生侧自己停下来的（播完、被系统打断、报错）也要出列
  audio.onEnded(() => markIdle(audio));
  audio.onStop(() => markIdle(audio));
  audio.onPause(() => markIdle(audio));
  audio.onError(() => markIdle(audio));
  return audio;
}

/**
 * 停掉所有在播的（含别的页面创建的）。
 * 只 stop 不 destroy：各页自己的 onStop 回调会把播放态按钮改回 ▶，
 * 而销毁时机仍归页面自己管（换音源、卸载），台账不越权。
 */
function stopAll() {
  playing.slice().forEach((audio) => {
    try {
      audio.stop();
    } catch (err) {
      /* 已被原生层回收的实例调 stop 会抛：它本来也就不播了，出列即可 */
      markIdle(audio);
    }
  });
}

/** 当前在账的实例数（自检用） */
function count() {
  return live.length;
}

/** 此刻在播的实例数（自检用） */
function playingCount() {
  return playing.length;
}

module.exports = { create, stopAll, count, playingCount };
