/**
 * 图片格式识别：上传前判清「这个文件到底是什么」
 *
 * 为什么要判：后端 multer 只按上传文件名的扩展名放行，真正的失败发生在下游 ——
 * HEIC 会被 sharp（预编译包不含 HEVC 解码器）解码失败，原始字节被原样塞进
 * .webp 文件名里返回 URL；而小程序 <image> 只认 JPG/PNG/SVG/WEBP/GIF，
 * 也不报错，用户看到的是一张永久空白的裂图。与其传上去换一趟注定无效的上传，
 * 不如在选择环节就当场挡下并说清原因。
 *
 * 判定顺序：文件头魔数 > 文件名后缀。后缀能被伪造、也常常压根没有
 * （微信临时路径多是 wxfile://tmp_xxx 这种无后缀形态），魔数才是真相。
 */

/** 允许上传的后缀（与后端白名单交集，且小程序 <image> 渲染得出来；heic 故意不放进来） */
const SUPPORTED_EXT_RE = /\.(jpe?g|png|webp)$/i;

/**
 * 格式表：label 用于给用户一句指名的提示，ext 是补后缀时该用的规范后缀
 * supported:false 的一律当场挡下，不进上传队列
 */
const FORMATS = {
  jpg: { label: "JPG", supported: true, ext: "jpg" },
  jpeg: { label: "JPG", supported: true, ext: "jpg" },
  png: { label: "PNG", supported: true, ext: "png" },
  webp: { label: "WEBP", supported: true, ext: "webp" },
  heic: { label: "HEIC", supported: false, ext: "" },
  heif: { label: "HEIF", supported: false, ext: "" },
  avif: { label: "AVIF", supported: false, ext: "" },
  gif: { label: "GIF", supported: false, ext: "" },
  bmp: { label: "BMP", supported: false, ext: "" },
  tiff: { label: "TIFF", supported: false, ext: "" },
  svg: { label: "SVG", supported: false, ext: "" },
  video: { label: "视频", supported: false, ext: "" },
};

/** 只读文件头这么多字节就够判格式了 */
const HEAD_BYTES = 16;

/** HEIF/HEVC 家族的 ftyp brand（含 mif1/msf1 这类纯容器品牌） */
const HEIF_BRANDS = [
  "heic",
  "heix",
  "heim",
  "hevc",
  "hevm",
  "hevs",
  "heis",
  "hsnc",
  "mif1",
  "msf1",
];

/**
 * 读文件头
 * @param {string} filePath 本地（临时）文件路径
 * @returns {Promise<Uint8Array|null>} 读不到返回 null，由调用方退回后缀判定
 */
function readHead(filePath) {
  if (typeof wx.getFileSystemManager !== "function") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    wx.getFileSystemManager().readFile({
      filePath,
      // position/length 只要开头；万一被老基础库忽略退化成整读，
      // 单张最多 MAX_UPLOAD_MB 也还撑得住，不改变判定结果
      position: 0,
      length: HEAD_BYTES,
      success: (res) => {
        // 不传 encoding 时拿到的是 ArrayBuffer
        const data = res && res.data;
        resolve(data instanceof ArrayBuffer ? new Uint8Array(data) : null);
      },
      // 临时路径不可读（异常/低版本）时不能误杀正常图片，交回调用方按后缀判
      fail: () => resolve(null),
    });
  });
}

/** 取一段 ASCII 文本（越界返回已读到的部分） */
function ascii(bytes, from, to) {
  let s = "";
  for (let i = from; i < to && i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

/**
 * 按魔数认格式
 * @param {Uint8Array} head 文件头字节
 * @returns {string} FORMATS 的键；认不出来返回 ""
 */
function sniff(head) {
  if (!head || head.length < 4) return "";
  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpg";
  // PNG: 89 50 4E 47
  if (
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47
  ) {
    return "png";
  }
  // GIF: "GIF8"
  if (ascii(head, 0, 4) === "GIF8") return "gif";
  // BMP: "BM"
  if (head[0] === 0x42 && head[1] === 0x4d) return "bmp";
  // TIFF: II\x2A\x00 / MM\x00\x2A（little/big endian）
  if (
    (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a) ||
    (head[0] === 0x4d && head[1] === 0x4d && head[3] === 0x2a)
  ) {
    return "tiff";
  }
  // WEBP: "RIFF" .... "WEBP"
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") {
    return "webp";
  }
  // ISO-BMFF 容器："....ftyp" + 4 字节 brand。HEIF/HEIC 与 mp4 视频都是这个头，
  // 品牌决定它到底是照片还是视频，也决定 sharp 能不能解
  if (ascii(head, 4, 8) === "ftyp") {
    const brand = ascii(head, 8, 12).toLowerCase();
    if (HEIF_BRANDS.indexOf(brand) >= 0) return "heic";
    if (brand === "avif" || brand === "avis") return "avif";
    if (/^(isom|mp4|avc|m4a|dash|qt)/.test(brand)) return "video";
    // 未知品牌的 HEIF 类容器：小程序一样渲染不出来，按不支持处理
    return "heif";
  }
  return "";
}

/** 从文件名/路径尾取小写后缀，没有返回 "" */
function extOf(name) {
  const m = String(name || "").match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : "";
}

/**
 * 判定单个文件能否作为图片上传
 * @param {{path:string, name?:string}} file 微信返回的临时文件
 * @returns {Promise<{ok:boolean, label:string, ext:string}>}
 *   ok:false 时 label 为不支持的格式名，可直接拼进提示文案；
 *   ok:true 时 ext 为补后缀该用的规范后缀（认不出来源时为空，由调用方兜底）
 */
async function inspectImage(file) {
  const path = (file && file.path) || "";
  const head = await readHead(path);
  const sniffed = sniff(head);
  if (sniffed && FORMATS[sniffed]) {
    const fmt = FORMATS[sniffed];
    return {
      ok: fmt.supported,
      label: fmt.label,
      ext: fmt.supported ? fmt.ext : "",
    };
  }
  // 魔数认不出来（或压根读不到）才退回归后缀：后缀明确却不在名单里的
  // （.gif/.bmp/.cr2/文档）当场挡下；完全没有后缀的才放行让后端试一次，
  // 免得把一张正常图悄悄丢掉
  const ext = extOf((file && file.name) || path);
  if (!ext) return { ok: true, label: "", ext: "" };
  const fmt = FORMATS[ext];
  if (fmt) {
    return {
      ok: fmt.supported,
      label: fmt.label,
      ext: fmt.supported ? fmt.ext : "",
    };
  }
  return { ok: false, label: ext.toUpperCase(), ext: "" };
}

module.exports = {
  SUPPORTED_EXT_RE,
  inspectImage,
};
