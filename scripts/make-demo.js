// 生成虚构内容的演示库，用于截图；截图绝不使用真实知识库
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'data/demo-library');
const files = {
  '项目周报/2026-W43.md': `---\ntitle: 第 43 周项目周报\nstatus: 已发布\nowner: 示例团队\ntags: [周报, 项目]\n---\n# 第 43 周项目周报\n\n本周完成了 [[发布计划|发布计划]] 的评审，并更新了 [[接口约定#错误码]]。还未创建的笔记显示为灰色：[[下季度路线图]]。\n\n> [!note] 本周重点\n> 移动端首屏渲染时间降到 800ms 以内。\n\n## 进展\n\n| 模块 | 负责人 | 状态 |\n|---|---|---|\n| 阅读页 | 小林 | ~~排期中~~ 已完成 |\n| 分享 | 阿周 | 联调中 |\n| 搜索 | 小唐 | 已完成 |\n\n- [x] 完成阅读页\n- [x] 接入全文搜索\n- [ ] 上线分享功能\n\n## 示例代码\n\n\`\`\`js\nexport function greet(name) {\n  // 一段足够长的代码用来验证横向滚动不会撑破手机布局 ———————————————————\n  return \`你好，\${name}\`;\n}\n\`\`\`\n\n![[架构图.svg|420]]\n\n#周报 #团队协作\n`,
  '项目周报/2026-W42.md': `# 第 42 周项目周报\n\n上周讨论了合同模板的版式，详见 [[合同模板说明]]。\n`,
  '项目周报/发布计划.md': `# 发布计划\n\n分三步发布，参考 [[2026-W43]]。\n\n1. 内部试用\n2. 小范围分享\n3. 正式上线\n`,
  '项目周报/架构图.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 120"><rect width="420" height="120" rx="10" fill="#dcefeb"/><text x="210" y="66" text-anchor="middle" font-size="20" fill="#0b6e63">阅读 · 搜索 · 分享</text></svg>`,
  '技术文档/接口约定.md': `# 接口约定\n\n## 分页\n\n所有列表接口使用游标分页。\n\n## 错误码\n\n合同相关接口返回 4xx 时带 \`code\` 字段。\n`,
  '技术文档/合同模板说明.md': `# 合同模板说明\n\n模板分为服务合同、采购合同两类，合同编号按年度递增。\n`,
  '技术文档/配置示例.json': `{\n  "name": "demo",\n  "retries": 3,\n  "enabled": true\n}\n`,
  '技术文档/人员名单.csv': `姓名,部门,城市\n小林,研发,上海\n阿周,产品,杭州\n小唐,设计,成都\n`,
  '生活笔记/读书清单.md': `# 读书清单\n\n- 《设计中的设计》\n- 《写给大家看的设计书》\n\n合同之外的阅读。\n`,
  '生活笔记/旅行计划.md': `# 旅行计划\n\n春天去大理，秋天去喀纳斯。\n`,
};
for (const [rel, content] of Object.entries(files)) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
console.log(`演示库已生成：${Object.keys(files).length} 个文件`);
