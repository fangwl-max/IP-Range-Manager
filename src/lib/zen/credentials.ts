/**
 * 从 zen-config.json 读取 Zenlayer API 凭据（供 vite.config.ts 后端调用）。
 * 此文件仅在 Node 环境（vite.config.ts 中间件）下运行，不被前端 bundle。
 */
import fs from 'fs';
import path from 'path';

export interface ZenConfig {
  accessKeyId: string;
  accessKeyPassword: string;
  apiVersion?: string;
  bandwidthClusterId?: string;
  eipBandwidthMbps?: number;
  createEipsMaxAmount?: number;
}

const CONFIG_FILE = path.resolve(process.cwd(), 'zen-config.json');

export function loadZenConfig(): ZenConfig | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as ZenConfig;
  } catch {
    return null;
  }
}

export function saveZenConfig(cfg: ZenConfig): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

export function getZenCredentials(): { ak: string; sk: string } {
  const cfg = loadZenConfig();
  if (!cfg?.accessKeyId || !cfg?.accessKeyPassword) {
    throw new Error('ZEN API 凭据未配置，请在「ZEN 宣告」页面设置 Access Key');
  }
  return { ak: cfg.accessKeyId, sk: cfg.accessKeyPassword };
}

export function apiVersion(): string {
  return loadZenConfig()?.apiVersion || '2022-11-20';
}
