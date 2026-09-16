'use strict';
// 开机自启条目的判断,纯字符串处理,和注册表/文件系统解耦以便测试。

// reg query 的输出里挖出条目当前指向的 exe。路径几乎一定带空格,值通常还带引号。
function runValuePath(output) {
  const match = String(output || '').match(/\bREG_SZ\s{2,}(.*\S)/);
  return match ? match[1].replace(/^"([\s\S]*)"$/, '$1') : '';
}

// 便携版被双击一次,不等于用户想换掉开机启动的那一份:条目指向别的 exe、而且那个 exe
// 还在,就别动它。装安装版是明确动作,所以安装版照常接管(README 承诺的迁移)。
// 条目指向的 exe 已经不在了(便携版被挪走、安装版被卸载)照常自愈。
function portableShouldYield({ current, own, isPortable, currentExists }) {
  return Boolean(isPortable && current && current !== own && currentExists);
}

module.exports = { runValuePath, portableShouldYield };
