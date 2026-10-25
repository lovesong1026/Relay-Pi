#!/usr/bin/env bun
// 编辑 asciinema v3 `.cast` 文件：丢弃头尾时间窗口、限制空闲间隔，并可选提速。
//
// 用法：
//   bun scripts/edit-cast.ts <in.cast> <out.cast> [--drop-head N] [--drop-tail N] [--max-gap S] [--speed X]

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const [inPath, outPath] = args;
if (!inPath || !outPath) {
  console.error(
    "usage: edit-cast.ts <in> <out> [--drop-head N] [--drop-tail N] [--max-gap S] [--speed X]",
  );
  process.exit(1);
}
const flag = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const dropHead = flag("drop-head", 0); // 从开头跳过的秒数
const dropTail = flag("drop-tail", 0); // 从末尾裁掉的秒数
const maxGap = flag("max-gap", 0.5); // 将单次间隔限制为这么多秒
const speed = flag("speed", 1.0); // 播放速度倍数

const lines = readFileSync(inPath, "utf8").split("\n").filter(Boolean);
const header = JSON.parse(lines[0]);
const out: string[] = [JSON.stringify(header)];

// 计算总时长，以便丢弃末尾时间窗口。
let totalDuration = 0;
for (let i = 1; i < lines.length; i++) totalDuration += JSON.parse(lines[i])[0];
const tailCutoff = totalDuration - dropTail;

let absIn = 0; // 源文件中的绝对时间
let droppedHead = false;
for (let i = 1; i < lines.length; i++) {
  const ev = JSON.parse(lines[i]) as [number, string, string];
  let [delta, kind, data] = ev;
  absIn += delta;

  if (!droppedHead && absIn < dropHead) continue;
  if (dropTail > 0 && absIn > tailCutoff) break;
  if (!droppedHead) {
    droppedHead = true;
    delta = 0; // 第一个保留事件从 t=0 开始
  } else {
    if (delta > maxGap) delta = maxGap;
    delta = delta / speed;
  }
  out.push(JSON.stringify([Number(delta.toFixed(3)), kind, data]));
}

writeFileSync(outPath, out.join("\n") + "\n");
const newTotal = out.slice(1).reduce((s, l) => s + JSON.parse(l)[0], 0);
console.log(`wrote ${outPath} — ${out.length - 1} events, ${newTotal.toFixed(2)}s`);
