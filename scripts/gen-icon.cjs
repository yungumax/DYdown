/*
 * 生成应用图标：build/icon.png (512)、build/icon.ico (256, PNG-in-ICO)
 * 依赖 @resvg/resvg-js（纯 wasm，无原生编译）
 * 设计：黑色圆角方底 + 白色下载箭头（与界面标题栏同款 download 图标）
 */
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

/* 下载图标（iconfont 1024 视野，箭头 + 底线），与 src/icons.js 的 download 同路径 */
const DOWNLOAD_ICON = [
  'M132.288 832v-106.688a38.4 38.4 0 1 1 76.8 0V832c0 14.08 11.456 25.6 25.6 25.6h554.688a25.6 25.6 0 0 0 25.6-25.6v-106.688a38.4 38.4 0 0 1 76.8 0V832a102.4 102.4 0 0 1-102.4 102.4H234.688a102.4 102.4 0 0 1-102.4-102.4z',
  'M473.6 682.688v-512a38.4 38.4 0 1 1 76.8 0v512a38.4 38.4 0 1 1-76.8 0z',
  'M698.24 442.176a38.4 38.4 0 0 1 54.272 54.272L539.2 709.76a38.4 38.4 0 0 1-54.336 0L271.552 496.448a38.336 38.336 0 1 1 54.272-54.272L512 628.288l186.24-186.112z',
];

const ICON_PATHS = DOWNLOAD_ICON.map((d) => `<path d="${d}" fill="#ffffff"/>`).join('\n    ');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="110" fill="#0b0b0e"/>
  <rect x="1" y="1" width="510" height="510" rx="109" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="2"/>
  <g transform="translate(256,262) scale(0.46) translate(-512,-512)">
    ${ICON_PATHS}
  </g>
</svg>`;

function renderPng(size) {
  const resvg = new Resvg(SVG, { fitTo: { mode: 'width', value: size } });
  return resvg.render().asPng();
}

/* PNG 直接嵌入单条目 ICO（Windows Vista+ 支持 PNG 压缩 ICO） */
function pngToIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // 保留
  header.writeUInt16LE(1, 2); // 类型：图标
  header.writeUInt16LE(1, 4); // 条目数
  const entry = Buffer.alloc(16);
  entry[0] = 0;  // 宽 256（0 表示 256）
  entry[1] = 0;  // 高 256
  entry[2] = 0;  // 调色板
  entry[3] = 0;  // 保留
  entry.writeUInt16LE(1, 4);   // 颜色平面
  entry.writeUInt16LE(32, 6);  // 位深
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // 数据偏移 6+16
  return Buffer.concat([header, entry, png]);
}

const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, 'icon.png'), renderPng(512));
fs.writeFileSync(path.join(buildDir, 'icon.ico'), pngToIco(renderPng(256)));
console.log('icon.png / icon.ico 已生成到 build/');
