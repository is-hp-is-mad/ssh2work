#!/usr/bin/env node
import { ClaudeVpsApp } from '../src/app.js';
import { checkForAppUpdate, getCurrentVersion, performAppUpgrade } from '../src/updater.js';

const args = process.argv.slice(2);
const version = getCurrentVersion();

if (args.includes('-v') || args.includes('--version')) {
  console.log(`ssh4work v${version}`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`ssh4work v${version} - 纯 SSH 多服务器并发工作台 & 远程开发 TUI

用法:
  ssh4work [--config <path>]
  ssh4work check-update       检查 GitHub 最新 Release 版本
  ssh4work upgrade            升级本地 ssh4work 到最新版本

选项:
  --config <path>             指定配置文件路径 (默认: ~/.ssh4work/profiles.json)
  -v, --version               显示当前版本号
  -h, --help                  显示帮助信息
`);
  process.exit(0);
}

if (args[0] === 'check-update') {
  const res = await checkForAppUpdate({ currentVersion: version });
  if (!res.ok) {
    console.error(`检查更新失败: ${res.error}`);
    process.exitCode = 1;
  } else if (res.hasUpdate) {
    console.log(`发现新版本: v${res.latestVersion} (当前: v${res.currentVersion})`);
    console.log(`Release 地址: ${res.releaseUrl}`);
    console.log('运行 "ssh4work upgrade" 即可升级到最新版本。');
  } else {
    console.log(`当前已是最新版本: v${res.currentVersion}`);
  }
} else if (args[0] === 'upgrade' || args[0] === 'update') {
  console.log(`当前版本: v${version}，正在检查更新...`);
  const check = await checkForAppUpdate({ currentVersion: version });
  if (check.ok && !check.hasUpdate) {
    console.log(`当前已是最新版本 (v${version})，无需升级。`);
  } else {
    if (check.ok && check.hasUpdate) {
      console.log(`发现新版本 v${check.latestVersion}，正在执行升级...`);
    } else {
      console.log('未能获取 Release 信息，尝试直接从主分支拉取更新...');
    }
    const up = performAppUpgrade({ inheritStdio: true });
    if (!up.ok) {
      console.error(`升级失败: ${up.error}`);
      process.exitCode = 1;
    } else {
      console.log(`升级完成: v${up.previousVersion} -> v${up.newVersion} (${up.method})`);
    }
  }
} else {
  let configPath;
  const cfgIdx = args.indexOf('--config');
  if (cfgIdx >= 0 && args[cfgIdx + 1]) {
    configPath = args[cfgIdx + 1];
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('请在交互式终端 (TTY) 中运行 ssh4work');
    process.exit(1);
  }

  const app = new ClaudeVpsApp({ configPath });
  app.start();
}
