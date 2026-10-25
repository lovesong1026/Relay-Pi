// @ts-ignore @types 的类型已过时，因此无需理会
import { default as xmlImpl, type XmlElement, type XmlOptions } from "jstoxml";

// 包装 toXML 方法，加入一些默认选项
export function toXML(obj?: XmlElement | XmlElement[], options?: XmlOptions): string {
  // 注意：这是针对 `jstoxml` 属于当前打包器不支持的另一种模块类型的变通方法
  // 添加 trim，因为 `toXML` 往往会在前面添加换行
  return xmlImpl.toXML(obj, { ...options, depth: 100, indent: "" }).trim();
}
