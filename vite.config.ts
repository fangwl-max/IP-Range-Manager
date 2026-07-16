import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import nodemailer from 'nodemailer'

const _require = createRequire(import.meta.url)

const execFileAsync = promisify(execFile)

// 获取当前文件的目录路径（ES模块中替代__dirname）
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 数据文件路径：项目根目录下的 ip-data.json
const dataFilePath = path.resolve(__dirname, 'ip-data.json');
// 用户文件路径
const usersFilePath = path.resolve(__dirname, 'users.json');
// ASN 备用组数据文件路径
const asnStandbyFilePath = path.resolve(__dirname, 'asn-standby-groups.json');
// ZEN 宣告配置文件路径
const zenConfigFilePath = path.resolve(__dirname, 'zen-config.json');
// 内存中的 token 存储 (token -> { userId, username })
const tokenStore = new Map<string, { userId: string; username: string; role: string }>();

function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function loadUsers(): any[] {
  try {
    if (fs.existsSync(usersFilePath)) {
      const data = JSON.parse(fs.readFileSync(usersFilePath, 'utf-8'));
      return Array.isArray(data.users) ? data.users : [];
    }
  } catch (e) {
    console.error('Load users error:', e);
  }
  return [];
}

function saveUsers(users: any[]): void {
  fs.writeFileSync(usersFilePath, JSON.stringify({ users, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
}

function initDefaultUserIfNeeded(): void {
  const users = loadUsers();
  if (users.length === 0) {
    const defaultUser = {
      id: 'admin-' + Date.now(),
      username: 'admin',
      passwordHash: hashPassword('admin123'),
      displayName: '管理员',
      role: 'admin',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveUsers([defaultUser]);
    console.log('[Auth] 已创建默认管理员账户: admin / admin123');
  }
}

// IRR 数据库配置
const IRR_SERVERS: Record<string, string> = {
  ripe: 'whois.ripe.net',
  radb: 'whois.radb.net',
  arin: 'whois.arin.net',
  apnic: 'whois.apnic.net',
  lacnic: 'whois.lacnic.net',
  afrinic: 'whois.afrinic.net',
  nttcom: 'whois.gin.ntt.net',
  level3: 'rr.level3.net',
  altdb: 'whois.altdb.net',
};

// IRR 数据库覆盖范围
const IRR_SCOPES: Record<string, string> = {
  ripe: '欧洲、中东、中亚',
  radb: '全球通用',
  arin: '北美',
  apnic: '亚太',
  lacnic: '拉丁美洲',
  afrinic: '非洲',
  nttcom: 'NTT 客户',
  level3: 'Level3 客户',
  altdb: '其他',
};

// RPKI API URL
const RPKI_API_URL = 'https://stat.ripe.net/data/rpki-validation/data.json';

// Whois 查询函数
function whoisQuery(query: string, server: string = 'whois.radb.net', timeout: number = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const host = IRR_SERVERS[server] || server;
    const socket = new net.Socket();
    let response = '';
    let timer: NodeJS.Timeout;

    socket.setTimeout(timeout);
    socket.on('timeout', () => {
      socket.destroy();
      resolve(`错误: 连接超时 (${host})`);
    });

    socket.on('error', (err) => {
      resolve(`错误: 连接失败 - ${err.message}`);
    });

    socket.on('data', (data) => {
      response += data.toString('utf-8');
    });

    socket.on('close', () => {
      if (timer) clearTimeout(timer);
      resolve(response || '无响应');
    });

    socket.connect(43, host, () => {
      socket.write(query + '\r\n', 'utf-8');
    });
  });
}

// 标准化 AS 号
function normalizeAS(input: string): string {
  const s = input.trim().toUpperCase();
  if (s.match(/^\d+$/)) {
    return `AS${s}`;
  }
  if (s.startsWith('AS')) {
    return s;
  }
  return input.trim();
}

// 解析路由对象
function parseRouteObjects(raw: string): Array<{ route: string; origin: string | null }> {
  const objects: Array<{ route: string; origin: string | null }> = [];
  let current: { route: string; origin: string | null } | null = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('%') || trimmed.startsWith('#')) {
      if (current) {
        objects.push(current);
        current = null;
      }
      continue;
    }

    const match = trimmed.match(/^(\w[\w-]*):\s*(.+)$/);
    if (match) {
      const key = match[1].toLowerCase();
      const val = match[2].trim();
      if (key === 'route' || key === 'route6') {
        if (current) objects.push(current);
        current = { route: val, origin: null };
      } else if (key === 'origin' && current) {
        current.origin = val.toUpperCase().replace(/\s+/g, '');
      }
    }
  }
  if (current) objects.push(current);
  return objects;
}

// RPKI 验证
async function verifyRPKI(prefix: string, asn: string, timeout: number = 8000): Promise<any> {
  const asNum = asn.replace(/\D/g, '');
  const prefixClean = prefix.trim();
  if (!asNum || !prefixClean) {
    return { ok: false, status: 'error', error: '缺少 AS 或 prefix' };
  }

  try {
    const params = new URLSearchParams({ resource: `AS${asNum}`, prefix: prefixClean });
    const url = `${RPKI_API_URL}?${params}`;
    const urlObj = new URL(url);
    
    // 根据协议选择使用 http 或 https
    const httpModule = urlObj.protocol === 'https:' ? https : http;
    
    return new Promise((resolve) => {
      const req = httpModule.get(url, { timeout }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.status !== 'ok') {
              resolve({ ok: false, status: 'error', error: json.message || 'API 错误' });
              return;
            }
            const inner = json.data || {};
            const status = inner.status || 'unknown';
            resolve({
              ok: status === 'valid',
              status,
              prefix: prefixClean,
              asn: `AS${asNum}`,
              validating_roas: inner.validating_roas || [],
              description: inner.description || '',
            });
          } catch (e) {
            resolve({ ok: false, status: 'error', error: String(e) });
          }
        });
      });
      req.on('error', (err) => {
        resolve({ ok: false, status: 'error', error: err.message });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, status: 'error', error: '请求超时' });
      });
    });
  } catch (e) {
    return { ok: false, status: 'error', error: String(e) };
  }
}

// ===================== IPXO API 配置存储 =====================
const ipxoConfigPath = path.resolve(__dirname, 'ipxo-config.json');
/** IPXO 账单数据缓存文件路径 */
const ipxoCachePath = path.resolve(__dirname, 'ipxo-cache.json');
/** 邮件通知配置文件路径 */
const notifyConfigPath = path.resolve(__dirname, 'notify-config.json');
/** 近期续费页独立状态文件（续费状态+备注，不同步到IP段管理） */
const upcomingStatusPath = path.resolve(__dirname, 'ipxo-upcoming-status.json');

/** 近期续费页独立状态：每个 IP 段的本地续费标记和备注 */
interface UpcomingItemStatus {
  renewalStatus?: string; // 'not_renewed' | 'renewed' | 'cancelled' | 'refunded'
  remark?: string;
  updatedAt?: string;
}
interface UpcomingStatusStore {
  /** key: IP段字符串，如 "1.2.3.0/24" */
  [segment: string]: UpcomingItemStatus;
}

function loadUpcomingStatus(): UpcomingStatusStore {
  try {
    if (fs.existsSync(upcomingStatusPath)) {
      return JSON.parse(fs.readFileSync(upcomingStatusPath, 'utf-8'));
    }
  } catch (e) {
    console.error('[UpcomingStatus] Load error:', e);
  }
  return {};
}

function saveUpcomingStatus(store: UpcomingStatusStore): void {
  fs.writeFileSync(upcomingStatusPath, JSON.stringify(store, null, 2), 'utf-8');
}

interface NotifyConfig {
  /** Gmail 发件账户（完整邮箱地址） */
  gmailUser: string;
  /** Gmail App Password（不是账户密码，需要在 Google 账号安全设置中生成） */
  gmailAppPassword: string;
  /** 收件人列表（逗号分隔或数组） */
  recipients: string[];
  /** 提前几天发送通知（默认 7 天） */
  notifyDaysAhead: number;
  /** 是否启用通知 */
  enabled: boolean;
  /** 是否启用定时自动发送 */
  scheduledEnabled: boolean;
  /** 每天自动发送的时间，格式 HH:mm（如 "09:00"），默认 "09:00"；当 notifyIntervalHours > 0 时忽略此字段 */
  notifyTime: string;
  /** 按间隔发送：每隔 N 小时发送一次（0 表示不启用间隔，使用每日固定时间模式）默认 0 */
  notifyIntervalHours: number;
  /** 最近一次自动发送的时间戳（毫秒，用于间隔模式防重复）*/
  lastSentAt?: number;
  /** 最近一次自动发送的时间（ISO 字符串，用于防止同一天重复发送，兼容旧版） */
  lastSentDate?: string;
  /** Google Chat Webhook URL（可选，配置后同步发送消息到群） */
  googleChatWebhook?: string;
  /** 是否启用每日定时备份（默认 true） */
  backupEnabled?: boolean;
  /** 最近一次备份时间（ISO 字符串） */
  lastBackupAt?: string;
  /** 最近一次备份日期（YYYY-MM-DD，防当日重复备份） */
  lastBackupDate?: string;
  /** 是否启用每周汇总通知（默认 true，每周一发送上周购买/续费汇总） */
  weeklyReportEnabled?: boolean;
  /** 最近一次周报发送日期（YYYY-MM-DD，防重复） */
  lastWeeklyReportDate?: string;
  /** 服务器外网访问地址（用于 Chat 消息中生成文件下载链接，如 http://192.168.1.100:8081） */
  serverBaseUrl?: string;
}

function loadNotifyConfig(): NotifyConfig | null {
  try {
    if (fs.existsSync(notifyConfigPath)) {
      return JSON.parse(fs.readFileSync(notifyConfigPath, 'utf-8'));
    }
  } catch (e) {
    console.error('[Notify] Load config error:', e);
  }
  return null;
}

function saveNotifyConfig(config: NotifyConfig): void {
  fs.writeFileSync(notifyConfigPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * 判断一条 IPXO 服务记录是否「有效续费」（需要续费提醒）。
 * 排除条件：billing_service.status 为 cancelled / terminated / cancel_requested
 */
function isRenewableService(item: any): boolean {
  const status = (item.billing_service?.status || '').toLowerCase();
  if (['cancelled', 'terminated', 'cancel_requested'].includes(status)) return false;
  return true;
}

/** 构建并发送续费提醒邮件的核心逻辑（供定时任务和手动触发共用）
 *  @param cfg            通知配置
 *  @param customItems    由前端传入的 upcoming 条目（含 _localRenewalStatus、_localRemark）
 *  @param renewedItems   已续费的 IP 段条目（可选，用于在通知中展示）
 */
async function sendRenewalNotifyEmail(
  cfg: NotifyConfig,
  customItems?: any[],
  renewedItems?: any[]
): Promise<{ success: boolean; message: string; sentCount?: number }> {
  const hasGmail = !!(cfg.gmailUser && cfg.gmailAppPassword && cfg.recipients?.length);
  const hasChat = !!cfg.googleChatWebhook;

  if (!hasGmail && !hasChat) {
    return { success: false, message: '邮件和 Google Chat 均未配置，请先在通知配置中填写至少一种发送方式' };
  }

  // ─── 获取待提醒的近期续费 IP 段 ──────────────────────────────────────────
  let itemsToNotify: any[] = customItems ?? [];

  if (itemsToNotify.length === 0) {
    // 无前端传入数据时，从缓存中自动过滤近期到期条目，并附加近期续费独立状态
    const ipxoCfg = loadIpxoConfig();
    if (ipxoCfg) {
      const cache = loadIpxoCache();
      const upcomingStore = loadUpcomingStatus();
      const daysAhead = cfg.notifyDaysAhead || 7;
      const nowSec = Math.floor(Date.now() / 1000);
      const endSec = nowSec + daysAhead * 86400;
      if (cache?.services?.data?.length) {
        // 从 ip-data.json 建立本地 cancelled 集合
        const localDataForCancel = fs.existsSync(dataFilePath)
          ? JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'))
          : { ipSegments: [] };
        const localCancelledSetForUpcoming = new Set<string>(
          (localDataForCancel.ipSegments || [])
            .filter((s: any) => s.renewalStatus === 'cancelled' && s.segment)
            .map((s: any) => s.segment)
        );
        itemsToNotify = cache.services.data
          .filter((item: any) => {
            const due = item.billing_service?.next_due_date;
            if (due == null || due < nowSec || due > endSec) return false;
            if (!isRenewableService(item)) return false;
            const bs = item.billing_service;
            const segKey = bs?.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
            // 近期续费独立状态中标记为 cancelled 的排除
            if (segKey && upcomingStore[segKey]?.renewalStatus === 'cancelled') return false;
            // ip-data.json 本地标记为 cancelled 的也排除
            if (segKey && localCancelledSetForUpcoming.has(segKey)) return false;
            return true;
          })
          .map((item: any) => {
            const bs = item.billing_service;
            const segKey = bs?.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
            const localStatus = segKey ? upcomingStore[segKey] : null;
            return {
              ...item,
              _localRenewalStatus: localStatus?.renewalStatus || 'not_renewed',
              _localRemark: localStatus?.remark || '',
            };
          });
      }
    }
  }

  // ─── 获取已续费条目（renewedItems 未传入时自动从缓存+本地数据获取） ──────────
  let renewedToShow: any[] = renewedItems ?? [];
  if (renewedToShow.length === 0) {
    const cache = loadIpxoCache();
    const upcomingStore = loadUpcomingStatus();
    const renewedDays = 3; // 默认展示近3天已续费
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - renewedDays * 86400;
    const todayStr = new Date().toISOString().slice(0, 10);

    // 提前加载本地数据，供两个来源共用
    const localData = fs.existsSync(dataFilePath)
      ? JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'))
      : { ipSegments: [] };

    // 来源1：IPXO 缓存中标记为 renewed 的条目
    const cacheRenewed = (cache?.services?.data ?? [])
      .filter((item: any) => {
        const bs = item.billing_service;
        const segKey = bs?.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
        if (!segKey) return false;
        if (!isRenewableService(item)) return false;
        // 排除本地已标记取消续费的 IP 段
        const localSeg = (localData.ipSegments || []).find((s: any) => s.segment === segKey);
        if (localSeg?.renewalStatus === 'cancelled') return false;

        // 条件 A：upcomingStore 手动标记 renewed
        // 用 updatedAt（标记时间）判断是否在查询的天数范围内
        if (upcomingStore[segKey]?.renewalStatus === 'renewed') {
          const updatedAt = upcomingStore[segKey]?.updatedAt;
          if (!updatedAt) return false;
          const updatedTs = Math.floor(new Date(updatedAt).getTime() / 1000);
          return updatedTs >= startSec && updatedTs <= nowSec;
        }

        // 条件 B：从 next_due_date 推算上次续费日在范围内，且晚于购买日
        // 要求 IP 段必须在 ip-data.json 中有记录（有 purchaseDate）
        const purchaseDate = localSeg?.purchaseDate || '';
        if (!purchaseDate) return false; // 未录入 IP 段管理的，不自动计入已续费
        const due = bs?.next_due_date;
        // next_due_date 允许在过去 7 天内（缓存未及时刷新的宽限）
        if (!due || due < nowSec - 7 * 86400) return false;
        const nextDueDate = new Date(due * 1000);
        const lastRenewalDate = new Date(nextDueDate);
        lastRenewalDate.setMonth(lastRenewalDate.getMonth() - 1);
        const lastRenewalStr = lastRenewalDate.toISOString().slice(0, 10);
        const lastRenewalTs = Math.floor(lastRenewalDate.getTime() / 1000);
        if (!(lastRenewalTs >= startSec && lastRenewalTs <= nowSec)) return false;
        if (lastRenewalStr <= purchaseDate) return false;
        return true;
      })
      .map((item: any) => {
        const bs = item.billing_service;
        const segKey = `${bs.address}/${bs.cidr}`;
        const nextDueDate = new Date(bs.next_due_date * 1000);
        const lastRenewalDate = new Date(nextDueDate);
        lastRenewalDate.setMonth(lastRenewalDate.getMonth() - 1);
        const lastRenewalTs = Math.floor(lastRenewalDate.getTime() / 1000);
        return {
          ...item,
          billing_service: { ...bs, next_due_date: lastRenewalTs },
          _localRenewalStatus: 'renewed',
          _localRemark: upcomingStore[segKey]?.remark || '',
        };
      });

    // 来源2：ip-data.json 中 renewalDate 已过期且未取消的条目
    const cacheSegSet = new Set<string>(
      (cache?.services?.data ?? []).map((item: any) => {
        const bs = item.billing_service;
        return bs?.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
      }).filter(Boolean)
    );
    const localRenewed = (localData.ipSegments || [])
      .filter((seg: any) => {
        if (!seg.segment || !seg.renewalDate || !seg.purchaseDate) return false;
        if (seg.renewalStatus === 'cancelled') return false;
        const nextDueDate = new Date(seg.renewalDate);
        const lastRenewalDate = new Date(nextDueDate);
        lastRenewalDate.setMonth(lastRenewalDate.getMonth() - 1);
        const lastRenewalStr = lastRenewalDate.toISOString().slice(0, 10);
        if (lastRenewalStr <= seg.purchaseDate) return false;
        if (lastRenewalStr > todayStr) return false;
        const lastRenewalTs = Math.floor(lastRenewalDate.getTime() / 1000);
        return lastRenewalTs >= startSec;
      })
      .map((seg: any) => {
        if (cacheSegSet.has(seg.segment)) return null;
        const [address, cidrStr] = seg.segment.split('/');
        const cidr = cidrStr ? parseInt(cidrStr) : null;
        const nextDueDate = new Date(seg.renewalDate);
        const lastRenewalDate = new Date(nextDueDate);
        lastRenewalDate.setMonth(lastRenewalDate.getMonth() - 1);
        const lastRenewalTs = Math.floor(lastRenewalDate.getTime() / 1000);
        return {
          billing_service: { address, cidr, next_due_date: lastRenewalTs, recurring_amount: seg.monthlyPrice ?? 0, status: 'active', uuid: seg.id },
          market_service: { registry: '', uuid: '' },
          loa: [],
          _localRenewalStatus: 'renewed',
          _localRemark: seg.remark || '',
        };
      })
      .filter(Boolean);

    renewedToShow = [...cacheRenewed, ...localRenewed]
      .sort((a: any, b: any) => (a.billing_service?.next_due_date ?? 0) - (b.billing_service?.next_due_date ?? 0));
  }

  if (itemsToNotify.length === 0 && renewedToShow.length === 0) {
    return { success: true, message: '当前没有需要提醒的 IP 段，无需发送', sentCount: 0 };
  }

  const nowSec2 = Math.floor(Date.now() / 1000);

  // 续费状态显示文本
  const renewalStatusText: Record<string, string> = {
    not_renewed: '待续费',
    renewed: '已续费',
    cancelled: '取消续费',
    refunded: '已退款',
  };

  const sorted = [...itemsToNotify].sort((a: any, b: any) =>
    (a.billing_service?.next_due_date ?? 0) - (b.billing_service?.next_due_date ?? 0)
  );

  const rows = sorted.map((item: any) => {
    const bs = item.billing_service || {};
    const seg = bs.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '-';
    const dueTs = bs.next_due_date;
    const daysLeft = dueTs ? Math.ceil((dueTs - nowSec2) / 86400) : null;
    const dueStr = dueTs ? new Date(dueTs * 1000).toISOString().slice(0, 10) : '-';
    const supplier = (item._localSupplier || 'IPXO').trim();
    const isIpxo = !supplier || supplier.toLowerCase() === 'ipxo';
    const amount = Number(bs.recurring_amount);
    const price = bs.recurring_amount != null ? `$${(isIpxo ? amount * 1.04 : amount).toFixed(2)}` : '-';
    const remark = item._localRemark || '';
    const renewalStatus = item._localRenewalStatus || 'not_renewed';
    const renewalStatusLabel = renewalStatusText[renewalStatus] || renewalStatus;
    const urgencyColor = daysLeft != null && daysLeft <= 1 ? '#ff4d4f' : daysLeft != null && daysLeft <= 3 ? '#fa8c16' : '#1677ff';
    const daysLabel = daysLeft == null ? '-' : daysLeft <= 0 ? '今日到期' : `${daysLeft} 天后`;
    const statusColor = renewalStatus === 'renewed' ? '#52c41a' : renewalStatus === 'cancelled' ? '#fa8c16' : '#666';
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-family:monospace;font-weight:600">${seg}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">${dueStr}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;color:${urgencyColor};font-weight:${daysLeft != null && daysLeft <= 3 ? 700 : 400}">${daysLabel}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">${supplier}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right">${price}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;color:${statusColor};font-weight:500">${renewalStatusLabel}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;color:#666">${remark}</td>
    </tr>`;
  }).join('');

  // 已续费条目表格行
  const renewedRows = renewedToShow.map((item: any) => {
    const bs = item.billing_service || {};
    const seg = bs.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '-';
    const dueTs = bs.next_due_date;
    const dueStr = dueTs ? new Date(dueTs * 1000).toISOString().slice(0, 10) : '-';
    const supplier = (item._localSupplier || 'IPXO').trim();
    const isIpxo = !supplier || supplier.toLowerCase() === 'ipxo';
    const amount = Number(bs.recurring_amount);
    const price = bs.recurring_amount != null ? `$${(isIpxo ? amount * 1.04 : amount).toFixed(2)}` : '-';
    const remark = item._localRemark || '';
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-family:monospace;font-weight:600">${seg}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">${dueStr}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">${supplier}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right">${price}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;color:#52c41a;font-weight:500">✅ 已续费</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;color:#666">${remark}</td>
    </tr>`;
  }).join('');

  const totalFee = sorted.reduce((acc: number, item: any) => acc + (item.billing_service?.recurring_amount ?? 0), 0) * 1.04;
  const urgentCount = sorted.filter((item: any) => {
    const ts = item.billing_service?.next_due_date;
    return ts && (ts - nowSec2) <= 3 * 86400;
  }).length;

  const subject = urgentCount > 0
    ? `⚠️ 紧急提醒：${urgentCount} 个 IP 段 3 天内到期（共 ${sorted.length} 个待续费）`
    : `📋 IP 段续费提醒：${sorted.length} 个 IP 段即将到期`;

  const renewedSection = renewedToShow.length > 0 ? `
  <h3 style="margin-top:28px;margin-bottom:8px;color:#52c41a">✅ 近期已续费（${renewedToShow.length} 个）</h3>
  <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08)">
    <thead>
      <tr style="background:#f6ffed">
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#666;border-bottom:2px solid #b7eb8f">IP 段</th>
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#666;border-bottom:2px solid #b7eb8f">续费日</th>
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#666;border-bottom:2px solid #b7eb8f">供应商</th>
        <th style="padding:10px 12px;text-align:right;font-size:13px;color:#666;border-bottom:2px solid #b7eb8f">月费+手续费</th>
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#666;border-bottom:2px solid #b7eb8f">状态</th>
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#666;border-bottom:2px solid #b7eb8f">备注</th>
      </tr>
    </thead>
    <tbody>${renewedRows}</tbody>
  </table>` : '';

  const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;max-width:860px;margin:0 auto;padding:24px">
  <h2 style="margin-bottom:4px">IP 段续费提醒</h2>
  <p style="color:#666;margin-top:0">以下 IP 段将在 ${cfg.notifyDaysAhead || 7} 天内到期，请及时处理。</p>
  ${urgentCount > 0 ? `<div style="background:#fff2f0;border:1px solid #ffccc7;border-radius:6px;padding:12px 16px;margin-bottom:16px">
    <strong style="color:#ff4d4f">⚠️ 紧急提醒：${urgentCount} 个 IP 段将在 3 天内到期，请立即处理！</strong>
  </div>` : ''}
  <div style="background:#f0f5ff;border-radius:6px;padding:10px 16px;margin-bottom:16px">
    <span><strong>合计：</strong>${sorted.length} 个 IP 段</span>&nbsp;&nbsp;&nbsp;
    <span><strong>月费合计（含4%手续费）：</strong><span style="color:#1677ff;font-weight:700">$${totalFee.toFixed(2)}</span></span>
  </div>
  <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08)">
    <thead>
      <tr style="background:#fafafa">
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#666;border-bottom:2px solid #f0f0f0">IP 段</th>
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#666;border-bottom:2px solid #f0f0f0">到期日</th>
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#666;border-bottom:2px solid #f0f0f0">剩余时间</th>
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#666;border-bottom:2px solid #f0f0f0">供应商</th>
        <th style="padding:10px 12px;text-align:right;font-size:13px;color:#666;border-bottom:2px solid #f0f0f0">月费+手续费</th>
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#666;border-bottom:2px solid #f0f0f0">是否续费</th>
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#666;border-bottom:2px solid #f0f0f0">备注</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  ${renewedSection}
  <p style="color:#999;font-size:12px;margin-top:24px">此邮件由 IP Range Manager 自动发送，发送时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>
</body>
</html>`;

  // ─── 发送邮件（仅在 Gmail 已配置时）────────────────────────────────────
  const results: string[] = [];

  if (hasGmail) {
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: cfg.gmailUser, pass: cfg.gmailAppPassword },
      });
      await transporter.sendMail({
        from: `"IP Range Manager" <${cfg.gmailUser}>`,
        to: cfg.recipients.join(', '),
        subject,
        html: htmlBody,
      });
      console.log(`[Notify] 邮件已发送至 ${cfg.recipients.join(', ')}，共 ${sorted.length} 条 IP 段`);
      results.push(`邮件已发送至 ${cfg.recipients.join(', ')}`);
    } catch (mailErr: any) {
      console.error('[Notify] 邮件发送失败:', mailErr.message);
      results.push(`邮件发送失败：${mailErr.message}`);
    }
  }

  // ─── 发送 Google Chat 消息（仅在 Webhook 已配置时）──────────────────────
  if (hasChat) {
    try {
      const renewalStatusEmoji: Record<string, string> = {
        not_renewed: '',
        renewed: ' ✅',
        cancelled: ' ❌',
        refunded: ' 💰',
      };
      // 构建 Google Chat 消息
      const formatLine = (item: any, urgent: boolean) => {
        const bs = item.billing_service || {};
        const ms = item.market_service || {};
        const seg = `${bs.address}/${bs.cidr}`;
        const segDisplay = bs.address;
        const daysLeft = Math.ceil((bs.next_due_date - nowSec2) / 86400);
        const dueStr = new Date(bs.next_due_date * 1000).toISOString().slice(0, 10);
        const supplier = (item._localSupplier || 'IPXO').trim();
        const isIpxo = !supplier || supplier.toLowerCase() === 'ipxo';
        const amount = Number(bs.recurring_amount);
        const price = `$${(isIpxo ? amount * 1.04 : amount).toFixed(2)}`;
        const remark = item._localRemark || '';
        const renewalStatus = item._localRenewalStatus || 'not_renewed';
        const statusEmoji = renewalStatusEmoji[renewalStatus] || '';
        const statusLabel = renewalStatusText[renewalStatus] || '';
        let timeLabel: string;
        if (daysLeft <= 0) timeLabel = '【今日到期】';
        else timeLabel = `【${daysLeft}天后到期】`;
        const urgency = urgent ? (daysLeft <= 0 ? '🔴' : '🟠') : '🔵';
        const remarkStr = remark ? `  备注: ${remark}` : '';
        const statusStr = statusLabel ? `  [${statusLabel}${statusEmoji}]` : '';
        return `${urgency} ${segDisplay} ${timeLabel} 【${supplier}】 ${price}/月  到期: ${dueStr}${statusStr}${remarkStr}`;
      };

      const urgentLines = sorted
        .filter((item: any) => {
          const ts = item.billing_service?.next_due_date;
          return ts && (ts - nowSec2) <= 3 * 86400;
        })
        .map((item: any) => formatLine(item, true))
        .join('\n');

      const normalLines = sorted
        .filter((item: any) => {
          const ts = item.billing_service?.next_due_date;
          return ts && (ts - nowSec2) > 3 * 86400;
        })
        .map((item: any) => formatLine(item, false))
        .join('\n');

      const separator = '─'.repeat(52);
      const header = `📋 IP 段续费提醒  共 ${sorted.length} 个  月费合计 $${totalFee.toFixed(2)}`;
      const urgentHeader = urgentCount > 0 ? `⚠️ 紧急提醒：${urgentCount} 个 IP 段 3 天内到期！\n${separator}` : null;
      const normalHeader = normalLines ? `续费列表\n${separator}` : null;

      // 已续费部分
      const renewedChatLines = renewedToShow.map((item: any) => {
        const bs = item.billing_service || {};
        const dueStr = bs.next_due_date ? new Date(bs.next_due_date * 1000).toISOString().slice(0, 10) : '-';
        const supplier = (item._localSupplier || 'IPXO').trim();
        const isIpxo = !supplier || supplier.toLowerCase() === 'ipxo';
        const amount = Number(bs.recurring_amount);
        const price = `$${(isIpxo ? amount * 1.04 : amount).toFixed(2)}`;
        const remark = item._localRemark || '';
        const remarkStr = remark ? `  备注: ${remark}` : '';
        return `✅ ${bs.address}/${bs.cidr}  续费日: ${dueStr}  【${supplier}】  ${price}/月${remarkStr}`;
      }).join('\n');
      const renewedChatHeader = renewedToShow.length > 0 ? `\n${separator}\n✅ 近期已续费（${renewedToShow.length} 个）\n${separator}` : null;

      const chatText = [
        urgentHeader,
        urgentLines || null,
        header,
        normalHeader,
        normalLines || null,
        renewedChatHeader,
        renewedChatLines || null,
        `${separator}\n发送时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      ].filter(Boolean).join('\n');

      const chatPayload = JSON.stringify({ text: chatText });

      await new Promise<void>((resolve, reject) => {
        const webhookUrl = new URL(cfg.googleChatWebhook!);
        const options = {
          hostname: webhookUrl.hostname,
          path: webhookUrl.pathname + webhookUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Content-Length': Buffer.byteLength(chatPayload),
          },
        };
        const req = https.request(options, (res) => {
          res.resume();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[Notify] Google Chat 消息已发送`);
            resolve();
          } else {
            reject(new Error(`Google Chat 响应 HTTP ${res.statusCode}`));
          }
        });
        req.on('error', reject);
        req.write(chatPayload);
        req.end();
      });
      results.push('Google Chat 消息已发送');
    } catch (chatErr: any) {
      console.error('[Notify] Google Chat 发送失败:', chatErr.message);
      results.push(`Google Chat 发送失败：${chatErr.message}`);
    }
  }

  const allFailed = results.every(r => r.includes('失败'));
  return {
    success: !allFailed,
    message: results.join('；') + `（共 ${sorted.length} 个待续费 IP 段，${renewedToShow.length} 个已续费）`,
    sentCount: sorted.length,
  };
}

/** 定时任务：每分钟检查一次，支持「按间隔发送」和「每日固定时间」两种模式 */
function startNotifyScheduler(): void {
  console.log('[Notify] 定时通知任务已启动，每分钟检查一次...');

  setInterval(async () => {
    try {
      const cfg = loadNotifyConfig();
      if (!cfg || !cfg.enabled || !cfg.scheduledEnabled) return;
      // 邮件或 Chat 至少配置一种才继续
      const hasGmailCfg = !!(cfg.gmailUser && cfg.gmailAppPassword && cfg.recipients?.length);
      const hasChatCfg = !!cfg.googleChatWebhook;
      if (!hasGmailCfg && !hasChatCfg) return;

      const now = Date.now();
      const intervalHours = cfg.notifyIntervalHours || 0;

      if (intervalHours > 0) {
        // ─── 间隔模式：每隔 N 小时发送一次 ──────────────────────────────
        const intervalMs = intervalHours * 3600 * 1000;
        const lastSentAt = cfg.lastSentAt || 0;
        if (now - lastSentAt < intervalMs) return; // 间隔未到

        console.log(`[Notify] 间隔触发（每 ${intervalHours} 小时）`);
        const result = await sendRenewalNotifyEmail(cfg);
        console.log(`[Notify] 发送结果：${result.message}`);

        const updated = loadNotifyConfig();
        if (updated) {
          updated.lastSentAt = now;
          saveNotifyConfig(updated);
        }
      } else {
        // ─── 每日固定时间模式：按 notifyTime 每天发一次 ──────────────────
        const bjTime = new Intl.DateTimeFormat('zh-CN', {
          timeZone: 'Asia/Shanghai',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date(now));
        const bjDate = new Intl.DateTimeFormat('zh-CN', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date(now)).replace(/\//g, '-');

        const targetTime = cfg.notifyTime || '09:00';
        if (bjTime !== targetTime) return;
        if (cfg.lastSentDate === bjDate) {
          return; // 今天已发过
        }

        console.log(`[Notify] 固定时间触发：${bjDate} ${bjTime}`);
        const result = await sendRenewalNotifyEmail(cfg);
        console.log(`[Notify] 发送结果：${result.message}`);

        const updated = loadNotifyConfig();
        if (updated) {
          updated.lastSentDate = bjDate;
          updated.lastSentAt = now;
          saveNotifyConfig(updated);
        }
      }
    } catch (e: any) {
      console.error('[Notify] 定时任务异常:', e.message);
    }
  }, 60_000); // 每 60 秒检查一次
}

/**
 * 启动时一次性同步备注：将 ipxo-upcoming-status.json 中的备注
 * 同步到 ip-data.json，以 upcoming-status 中的备注为准（优先级更高）。
 * 仅在 ip-data.json 中对应段的 remark 为空时才写入，避免覆盖用户已填的本地备注。
 */
function initSyncRemarks(): void {
  try {
    if (!fs.existsSync(dataFilePath) || !fs.existsSync(upcomingStatusPath)) return;
    const localData = JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'));
    const segments: any[] = localData?.ipSegments || [];
    const upcomingStore = loadUpcomingStatus();
    let changed = false;
    for (const seg of segments) {
      if (!seg.segment) continue;
      const upcomingRemark = (upcomingStore[seg.segment]?.remark || '').trim();
      const localRemark = (seg.remark || '').trim();
      if (upcomingRemark && !localRemark) {
        // upcoming 有备注、ip-data 无备注 → 以 upcoming 备注填入
        seg.remark = upcomingRemark;
        changed = true;
      } else if (localRemark && !upcomingRemark) {
        // ip-data 有备注、upcoming 无备注 → 反向写入 upcoming
        upcomingStore[seg.segment] = {
          ...(upcomingStore[seg.segment] || {}),
          remark: localRemark,
          updatedAt: new Date().toISOString(),
        };
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(dataFilePath, JSON.stringify(localData, null, 2), 'utf-8');
      saveUpcomingStatus(upcomingStore);
      console.log('[Sync] 启动备注同步完成');
    }
  } catch (e) {
    console.error('[Sync] 启动备注同步失败:', e);
  }
}

/**
 * 刷新 IPXO 缓存的核心逻辑（全量拉取 active 服务 + 发票，写入 ipxo-cache.json）
 * 由 HTTP 接口和定时任务共用
 */
async function refreshIpxoCache(): Promise<{ servicesCount: number; invoicesCount: number }> {
  const config = loadIpxoConfig();
  if (!config) throw new Error('IPXO 配置未设置');

  // 1. 全量拉取 active 服务
  const allServices: any[] = [];
  let page = 1;
  let lastPage = 1;
  do {
    const result = await callIpxoApi(
      `/billing/v1/{tenant_uuid}/market/ipv4/services?page=${page}&per_page=100&status=active`
    );
    if (result.status !== 200) break;
    const body = result.body;
    const items: any[] = body?.data ?? [];
    lastPage = body?.meta?.last_page ?? 1;
    allServices.push(...items);
    page++;
  } while (page <= lastPage);

  // 2. 全量拉取发票
  const allInvoices: any[] = [];
  let invPage = 1;
  let invLastPage = 1;
  do {
    const result = await callIpxoApi(
      `/billing/v1/{tenant_uuid}/invoices?page=${invPage}&per_page=100`
    );
    if (result.status !== 200) break;
    const body = result.body;
    const items: any[] = body?.data ?? [];
    invLastPage = body?.meta?.last_page ?? 1;
    allInvoices.push(...items);
    invPage++;
  } while (invPage <= invLastPage);

  // 3. 计算近期续费（7天内）
  const nowSec = Math.floor(Date.now() / 1000);
  const endSec = nowSec + 7 * 86400;
  const upcoming = allServices
    .filter((item: any) => {
      const due = item.billing_service?.next_due_date;
      return due != null && due >= nowSec && due <= endSec && isRenewableService(item);
    })
    .sort((a: any, b: any) =>
      (a.billing_service?.next_due_date ?? 0) - (b.billing_service?.next_due_date ?? 0)
    );

  // 4. 写入缓存
  const nowIso = new Date().toISOString();
  const cache: IpxoCache = {
    cachedAt: nowIso,
    services: {
      data: allServices,
      meta: { total: allServices.length, last_page: 1, per_page: allServices.length, current_page: 1 },
    },
    invoices: {
      data: allInvoices,
      meta: { total: allInvoices.length, last_page: 1, per_page: allInvoices.length, current_page: 1 },
    },
    upcoming,
  };
  saveIpxoCache(cache);
  return { servicesCount: allServices.length, invoicesCount: allInvoices.length };
}

/**
 * 每周一 09:00 北京时间发送上周/上月购买和续费 IP 段汇总
 */

/** 发送 Google Chat 消息的辅助函数（供周报复用） */
async function sendChatMessage(webhookUrl: string, text: string): Promise<void> {
  const payload = JSON.stringify({ text });
  await new Promise<void>((resolve, reject) => {
    const url = new URL(webhookUrl);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      res.resume();
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error(`Google Chat HTTP ${res.statusCode}`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function sendWeeklyReport(): Promise<void> {
  const cfg = loadNotifyConfig();
  if (!cfg?.googleChatWebhook && !cfg?.gmailUser) return;
  if (cfg.weeklyReportEnabled === false) return;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const XLSX = _require('xlsx');

  const nowBj = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间
  const todayStr = nowBj.toISOString().slice(0, 10);

  // ── 计算上周范围（周一~周日，北京时间） ─────────────────────────────
  const todayDow = nowBj.getUTCDay();
  const daysToLastMon = todayDow === 0 ? 6 : todayDow - 1;
  const lastMonday = new Date(nowBj);
  lastMonday.setUTCDate(nowBj.getUTCDate() - daysToLastMon - 7);
  lastMonday.setUTCHours(0, 0, 0, 0);
  const lastSunday = new Date(lastMonday);
  lastSunday.setUTCDate(lastMonday.getUTCDate() + 6);

  const weekStart = lastMonday.toISOString().slice(0, 10);
  const weekEnd = lastSunday.toISOString().slice(0, 10);

  // ── 计算上月范围 ─────────────────────────────────────────────────────
  const thisYear = nowBj.getUTCFullYear();
  const thisMonth = nowBj.getUTCMonth();
  const lastMonthYear = thisMonth === 0 ? thisYear - 1 : thisYear;
  const lastMonth = thisMonth === 0 ? 11 : thisMonth - 1;
  const monthStart = `${lastMonthYear}-${String(lastMonth + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(thisYear, lastMonth + 1, 0).getDate();
  const monthEnd = `${lastMonthYear}-${String(lastMonth + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  // ── 读取数据 ──────────────────────────────────────────────────────────
  const localData = fs.existsSync(dataFilePath)
    ? JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'))
    : { ipSegments: [] };
  const segments: any[] = localData.ipSegments || [];

  const inRange = (dateStr: string, start: string, end: string) =>
    !!dateStr && dateStr >= start && dateStr <= end;

  const weekPurchased = segments.filter(s => inRange(s.purchaseDate, weekStart, weekEnd));
  const monthPurchased = segments.filter(s => inRange(s.purchaseDate, monthStart, monthEnd));

  const cache = loadIpxoCache();
  const purchaseDateMap = new Map<string, string>();
  const supplierMap = new Map<string, string>();
  const projectGroupMap = new Map<string, string>();
  // 本地已取消续费的段集合（不应统计到续费中）
  const localCancelledSet = new Set<string>();
  segments.forEach(s => {
    if (!s.segment) return;
    purchaseDateMap.set(s.segment, s.purchaseDate || '');
    supplierMap.set(s.segment, (Array.isArray(s.supplier) ? s.supplier[0] : s.supplier) || 'IPXO');
    projectGroupMap.set(s.segment, (s.projectGroups || []).join(', ') || '');
    if (s.renewalStatus === 'cancelled') localCancelledSet.add(s.segment);
  });
  const remarkMap = new Map<string, string>();
  try {
    const upStore = loadUpcomingStatus();
    segments.forEach(s => {
      if (s.segment) remarkMap.set(s.segment, upStore[s.segment]?.remark || s.remark || '');
    });
  } catch (_) {}

  const weekRenewed: any[] = [];
  const monthRenewed: any[] = [];

  // 已加入续费统计的段集合（防止重复）
  const renewedSegSet = new Set<string>();

  // ── 来源 1：IPXO 缓存（从 next_due_date 推算上次续费日） ──────────────
  if (cache?.services?.data) {
    for (const item of cache.services.data) {
      const bs = item.billing_service;
      const segKey = bs?.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
      if (!segKey || !isRenewableService(item)) continue;
      // 排除本地已标记取消续费的段（即使 IPXO 缓存中还显示 active）
      if (localCancelledSet.has(segKey)) continue;
      const purchaseDate = purchaseDateMap.get(segKey) || '';
      if (!purchaseDate) continue;
      const due = bs.next_due_date;
      if (!due) continue;
      const nextDueDt = new Date(due * 1000);
      const lastRenDt = new Date(nextDueDt);
      lastRenDt.setMonth(lastRenDt.getMonth() - 1);
      const lastRenStr = lastRenDt.toISOString().slice(0, 10);
      if (lastRenStr <= purchaseDate) continue;
      const supplier = supplierMap.get(segKey) || 'IPXO';
      const isIpxo = !supplier || supplier.trim().toLowerCase() === 'ipxo';
      const amount = Number(bs.recurring_amount);
      const priceNum = isIpxo ? amount * 1.04 : amount;
      const remark = remarkMap.get(segKey) || '';
      const projectGroups = projectGroupMap.get(segKey) || '';
      const entry = { segment: segKey, renewalDate: lastRenStr, supplier, price: priceNum, remark, projectGroups };
      if (inRange(lastRenStr, weekStart, weekEnd)) { weekRenewed.push(entry); renewedSegSet.add(segKey + '|' + lastRenStr); }
      if (inRange(lastRenStr, monthStart, monthEnd)) monthRenewed.push(entry);
    }
  }

  // ── 来源 2：ip-data.json 中非 IPXO 供应商（或不在 IPXO 缓存中）的段 ──
  // 判断依据：renewalDate（下次到期日）-1月 = 上次续费日，落在统计范围内
  // 排除：cancelled、新购第一个月（lastRenDate <= purchaseDate）
  const cacheSegSet = new Set<string>(
    (cache?.services?.data ?? []).map((item: any) => {
      const bs = item.billing_service;
      return bs?.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
    }).filter(Boolean)
  );
  const todayStr2 = new Date().toISOString().slice(0, 10);

  for (const seg of segments) {
    if (!seg.segment || !seg.renewalDate || !seg.purchaseDate) continue;
    if (seg.renewalStatus === 'cancelled') continue;
    const supplier = (Array.isArray(seg.supplier) ? seg.supplier[0] : seg.supplier) || '';
    const isIpxo = !supplier || supplier.trim().toLowerCase() === 'ipxo';
    // IPXO 的段：在缓存中的由来源 1 处理（跳过避免重复）；
    // 不在缓存中的说明已从 IPXO 官网下线，不再续费，也跳过
    if (isIpxo) continue;

    const nextDueDt = new Date(seg.renewalDate);
    const lastRenDt = new Date(nextDueDt);
    lastRenDt.setMonth(lastRenDt.getMonth() - 1);
    const lastRenStr = lastRenDt.toISOString().slice(0, 10);
    if (lastRenStr <= seg.purchaseDate) continue; // 排除新购第一个月
    if (lastRenStr > todayStr2) continue; // 还没发生的续费不统计

    const priceNum = Number(seg.monthlyPrice) || 0;
    const remark = remarkMap.get(seg.segment) || seg.remark || '';
    const projectGroups = (seg.projectGroups || []).join(', ') || '';
    const entry = { segment: seg.segment, renewalDate: lastRenStr, supplier: supplier || '-', price: priceNum, remark, projectGroups };

    const weekKey = seg.segment + '|' + lastRenStr;
    if (inRange(lastRenStr, weekStart, weekEnd) && !renewedSegSet.has(weekKey)) {
      weekRenewed.push(entry);
      renewedSegSet.add(weekKey);
    }
    if (inRange(lastRenStr, monthStart, monthEnd)) monthRenewed.push(entry);
  }

  // ── 计算费用汇总（含分供应商统计） ─────────────────────────────────────
  const fmt2 = (n: number) => '$' + n.toFixed(2);

  // 通用：按供应商分组统计费用
  const feeBySupplier = (list: any[]): Map<string, { count: number; fee: number }> => {
    const map = new Map<string, { count: number; fee: number }>();
    for (const e of list) {
      const sup = e.supplier || '-';
      const cur = map.get(sup) || { count: 0, fee: 0 };
      cur.count++;
      cur.fee += e.price || 0;
      map.set(sup, cur);
    }
    return map;
  };
  const feeBySupplierPurchase = (list: any[]): Map<string, { count: number; fee: number }> => {
    const map = new Map<string, { count: number; fee: number }>();
    for (const s of list) {
      const sup = (Array.isArray(s.supplier) ? s.supplier[0] : s.supplier) || '-';
      const cur = map.get(sup) || { count: 0, fee: 0 };
      cur.count++;
      cur.fee += Number(s.monthlyPrice) || 0;
      map.set(sup, cur);
    }
    return map;
  };

  const weekPurchasedFee = weekPurchased.reduce((s: number, seg: any) => s + (Number(seg.monthlyPrice) || 0), 0);
  const weekRenewedFee   = weekRenewed.reduce((s: number, e: any) => s + (e.price || 0), 0);
  const monthPurchasedFee = monthPurchased.reduce((s: number, seg: any) => s + (Number(seg.monthlyPrice) || 0), 0);
  const monthRenewedFee   = monthRenewed.reduce((s: number, e: any) => s + (e.price || 0), 0);

  const weekRenewedBySupplier   = feeBySupplier(weekRenewed);
  const weekPurchasedBySupplier = feeBySupplierPurchase(weekPurchased);
  const monthRenewedBySupplier  = feeBySupplier(monthRenewed);
  const monthPurchasedBySupplier = feeBySupplierPurchase(monthPurchased);

  // 供应商费用明细行（排序：费用降序）
  const supplierFeeLines = (map: Map<string, { count: number; fee: number }>, label: string): string[] => {
    if (map.size <= 1) return []; // 只有一个供应商不需要拆分
    return [...map.entries()]
      .sort((a, b) => b[1].fee - a[1].fee)
      .map(([sup, v]) => `    ${label}【${sup}】：${v.count} 个  ${fmt2(v.fee)}`);
  };

  // ── 生成 Excel 文件（按日期排序） ────────────────────────────────────
  const wb = XLSX.utils.book_new();

  // 排序辅助
  const sortByDate = (arr: any[], key: string) =>
    [...arr].sort((a, b) => (a[key] || '').localeCompare(b[key] || ''));

  // Sheet1：上周新购（按购买日升序）
  const sortedWeekPurchased = sortByDate(weekPurchased, 'purchaseDate');
  const sheetWeekPurchased = [
    ['IP 段', '购买日', '供应商', '月费 (USD)', '项目组', '使用地区', '续费状态', '备注'],
    ...sortedWeekPurchased.map((s: any) => [
      s.segment || '',
      s.purchaseDate || '',
      (Array.isArray(s.supplier) ? s.supplier[0] : s.supplier) || '',
      s.monthlyPrice != null ? Number(s.monthlyPrice) : '',
      (s.projectGroups || []).join(', '),
      s.usageArea || '',
      s.renewalStatus || '',
      remarkMap.get(s.segment) || s.remark || '',
    ]),
    [],
    [`合计 ${sortedWeekPurchased.length} 个`, '', '', weekPurchasedFee, '', '', '', ''],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(sheetWeekPurchased);
  ws1['!cols'] = [22, 12, 12, 12, 16, 16, 12, 30].map((w: number) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws1, `上周新购(${weekStart}~${weekEnd})`);

  // Sheet2：上周续费（按续费日升序）
  const sortedWeekRenewed = sortByDate(weekRenewed, 'renewalDate');
  const sheetWeekRenewed = [
    ['IP 段', '续费日', '供应商', '月费+手续费 (USD)', '项目组', '备注'],
    ...sortedWeekRenewed.map((e: any) => [e.segment, e.renewalDate, e.supplier, e.price, e.projectGroups, e.remark]),
    [],
    [`合计 ${sortedWeekRenewed.length} 个`, '', '', weekRenewedFee, '', ''],
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(sheetWeekRenewed);
  ws2['!cols'] = [22, 12, 12, 18, 16, 30].map((w: number) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws2, `上周续费(${weekStart}~${weekEnd})`);

  // Sheet3：上月新购（按购买日升序）
  const sortedMonthPurchased = sortByDate(monthPurchased, 'purchaseDate');
  const sheetMonthPurchased = [
    ['IP 段', '购买日', '供应商', '月费 (USD)', '项目组', '使用地区', '续费状态', '备注'],
    ...sortedMonthPurchased.map((s: any) => [
      s.segment || '',
      s.purchaseDate || '',
      (Array.isArray(s.supplier) ? s.supplier[0] : s.supplier) || '',
      s.monthlyPrice != null ? Number(s.monthlyPrice) : '',
      (s.projectGroups || []).join(', '),
      s.usageArea || '',
      s.renewalStatus || '',
      remarkMap.get(s.segment) || s.remark || '',
    ]),
    [],
    [`合计 ${sortedMonthPurchased.length} 个`, '', '', monthPurchasedFee, '', '', '', ''],
  ];
  const ws3 = XLSX.utils.aoa_to_sheet(sheetMonthPurchased);
  ws3['!cols'] = [22, 12, 12, 12, 16, 16, 12, 30].map((w: number) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws3, `上月新购(${monthStart}~${monthEnd})`);

  // Sheet4：上月续费（按续费日升序）
  const sortedMonthRenewed = sortByDate(monthRenewed, 'renewalDate');
  const sheetMonthRenewed = [
    ['IP 段', '续费日', '供应商', '月费+手续费 (USD)', '项目组', '备注'],
    ...sortedMonthRenewed.map((e: any) => [e.segment, e.renewalDate, e.supplier, e.price, e.projectGroups, e.remark]),
    [],
    [`合计 ${sortedMonthRenewed.length} 个`, '', '', monthRenewedFee, '', ''],
  ];
  const ws4 = XLSX.utils.aoa_to_sheet(sheetMonthRenewed);
  ws4['!cols'] = [22, 12, 12, 18, 16, 30].map((w: number) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws4, `上月续费(${monthStart}~${monthEnd})`);

  // 保存文件
  const exportsDir = path.resolve(__dirname, 'exports');
  if (!fs.existsSync(exportsDir)) fs.mkdirSync(exportsDir, { recursive: true });
  const fileName = `weekly-report-${todayStr}.xlsx`;
  // 用于 Content-Disposition 的中文显示名
  const fileDisplayName = `IP段周报-${todayStr}.xlsx`;
  const filePath = path.join(exportsDir, fileName);
  XLSX.writeFile(wb, filePath);
  console.log(`[WeeklyReport] Excel 已生成：${filePath}`);

  // ── 通过邮件发送附件 ──────────────────────────────────────────────────
  const hasGmail = !!(cfg.gmailUser && cfg.gmailAppPassword && cfg.recipients?.length);
  if (hasGmail) {
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: cfg.gmailUser, pass: cfg.gmailAppPassword },
      });
      await transporter.sendMail({
        from: `"IP Range Manager" <${cfg.gmailUser}>`,
        to: cfg.recipients.join(', '),
        subject: `📊 IP 段周报 ${todayStr}（上周购买 ${weekPurchased.length} 个，续费 ${weekRenewed.length} 个）`,
        html: `
          <p>请查收本周 IP 段汇总报告（Excel 附件）。</p>
          <ul>
            <li>上周新购（${weekStart} ~ ${weekEnd}）：<strong>${weekPurchased.length}</strong> 个</li>
            <li>上周续费（${weekStart} ~ ${weekEnd}）：<strong>${weekRenewed.length}</strong> 个</li>
            <li>上月新购（${monthStart} ~ ${monthEnd}）：<strong>${monthPurchased.length}</strong> 个</li>
            <li>上月续费（${monthStart} ~ ${monthEnd}）：<strong>${monthRenewed.length}</strong> 个</li>
          </ul>
          <p style="color:#999;font-size:12px">发送时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>
        `,
        attachments: [{ filename: fileDisplayName, path: filePath }],
      });
      console.log(`[WeeklyReport] 邮件附件已发送至 ${cfg.recipients.join(', ')}`);
    } catch (mailErr: any) {
      console.error('[WeeklyReport] 邮件发送失败:', mailErr.message);
    }
  }

  // ── Google Chat 发送摘要 ──────────────────────────────────────────────
  if (cfg.googleChatWebhook) {
    const sep = '─'.repeat(40);
    const baseUrl = (cfg.serverBaseUrl || '').replace(/\/$/, '');
    const downloadLine = baseUrl
      ? `📥 下载 Excel：${baseUrl}/exports/${fileName}`
      : `📎 Excel 已保存到服务器 exports/${fileName}`;

    // 辅助：按日期分组生成每日明细
    const buildDailyDetail = (
      purchased: any[],
      renewed: any[],
      rangeStart: string,
      rangeEnd: string
    ): string[] => {
      // 收集范围内所有出现过的日期
      const dateSet = new Set<string>();
      purchased.forEach(s => { if (inRange(s.purchaseDate, rangeStart, rangeEnd)) dateSet.add(s.purchaseDate); });
      renewed.forEach(e => { if (inRange(e.renewalDate, rangeStart, rangeEnd)) dateSet.add(e.renewalDate); });
      const dates = [...dateSet].sort();
      if (dates.length === 0) return [];

      const lines: string[] = [];
      for (const date of dates) {
        const dayPurchased = purchased.filter(s => s.purchaseDate === date);
        const dayRenewed = renewed.filter(e => e.renewalDate === date);
        if (dayPurchased.length === 0 && dayRenewed.length === 0) continue;

        lines.push(`  📆 ${date}`);

        // 购买：只显示数量和费用
        if (dayPurchased.length > 0) {
          const dayPurchasedFee = dayPurchased.reduce((s: number, seg: any) => s + (Number(seg.monthlyPrice) || 0), 0);
          lines.push(`    🆕 新购 ${dayPurchased.length} 个  费用：${fmt2(dayPurchasedFee)}`);
        }

        // 续费：显示 IP 段、费用、供应商、项目组、备注，购买在上续费在下
        if (dayRenewed.length > 0) {
          const dayRenewedFee = dayRenewed.reduce((s: number, e: any) => s + (e.price || 0), 0);
          lines.push(`    🔄 续费 ${dayRenewed.length} 个  费用：${fmt2(dayRenewedFee)}`);
          dayRenewed.forEach((e: any) => {
            const parts = [e.segment, fmt2(e.price)];
            if (e.supplier) parts.push(`【${e.supplier}】`);
            if (e.projectGroups) parts.push(e.projectGroups);
            if (e.remark) parts.push(e.remark);
            lines.push(`       • ${parts.join('  ')}`);
          });
        }
      }
      return lines;
    };

    // ── 上周明细 ────────────────────────────────────────────────────────
    const weekDetailLines = buildDailyDetail(weekPurchased, weekRenewed, weekStart, weekEnd);
    const weekBlock = [
      `📅 上周（${weekStart} ~ ${weekEnd}）`,
      `  🆕 新购：${weekPurchased.length} 个  合计：${fmt2(weekPurchasedFee)}`,
      ...supplierFeeLines(weekPurchasedBySupplier, '└ 新购'),
      `  🔄 续费：${weekRenewed.length} 个  合计：${fmt2(weekRenewedFee)}`,
      ...supplierFeeLines(weekRenewedBySupplier, '└ 续费'),
      ...(weekDetailLines.length > 0 ? ['  每日明细：', ...weekDetailLines] : []),
    ];

    // ── 上月：只显示汇总 + 供应商费用，不含每日明细 ─────────────────────
    const monthBlock = [
      `📅 上月（${monthStart} ~ ${monthEnd}）`,
      `  🆕 新购：${monthPurchased.length} 个  合计：${fmt2(monthPurchasedFee)}`,
      ...supplierFeeLines(monthPurchasedBySupplier, '└ 新购'),
      `  🔄 续费：${monthRenewed.length} 个  合计：${fmt2(monthRenewedFee)}`,
      ...supplierFeeLines(monthRenewedBySupplier, '└ 续费'),
    ];

    const allLines = [
      `📊 IP 段周报（${todayStr}）`,
      sep,
      ...weekBlock,
      '',
      sep,
      ...monthBlock,
      '',
      sep,
      downloadLine,
      ...(hasGmail ? [`✉️ 已通过邮件发送附件`] : []),
    ];

    // 分段发送（Google Chat 单条消息上限约 4096 字符）
    const MAX_CHARS = 3800;
    const chunks: string[] = [];
    let cur = '';
    for (const line of allLines) {
      const next = cur ? cur + '\n' + line : line;
      if (next.length > MAX_CHARS && cur) {
        chunks.push(cur);
        cur = line;
      } else {
        cur = next;
      }
    }
    if (cur) chunks.push(cur);

    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 1500));
      await sendChatMessage(cfg.googleChatWebhook, chunks[i]);
    }
  }

  // 记录发送日期防重复
  const updated = loadNotifyConfig();
  if (updated) {
    updated.lastWeeklyReportDate = todayStr;
    saveNotifyConfig(updated);
  }

  console.log(`[WeeklyReport] 完成（上周购买 ${weekPurchased.length} 个，续费 ${weekRenewed.length} 个；上月购买 ${monthPurchased.length} 个，续费 ${monthRenewed.length} 个）`);
}

function startWeeklyReportScheduler(): void {
  console.log('[WeeklyReport] 每周汇总任务已启动，将在每周一 09:00 北京时间执行...');

  setInterval(async () => {
    try {
      const cfg = loadNotifyConfig();
      if (!cfg?.googleChatWebhook) return;
      if (cfg.weeklyReportEnabled === false) return;

      const now = Date.now();
      const bjNow = new Date(now + 8 * 3600 * 1000);
      const bjDate = bjNow.toISOString().slice(0, 10);
      const bjHour = bjNow.getUTCHours();
      const bjMinute = bjNow.getUTCMinutes();
      const bjDow = bjNow.getUTCDay(); // 0=周日, 1=周一

      // 每周一 09:00~09:04 触发
      if (bjDow !== 1 || bjHour !== 9 || bjMinute > 4) return;
      if (cfg.lastWeeklyReportDate === bjDate) return; // 今天已发过

      console.log(`[WeeklyReport] 触发每周汇总（${bjDate} 周一 09:00 北京时间）`);
      await sendWeeklyReport();
    } catch (e: any) {
      console.error('[WeeklyReport] 周报发送失败:', e.message);
    }
  }, 60_000);
}

/**
 * 每天 00:00 北京时间自动刷新 IPXO 缓存
 * 确保当天续费后 next_due_date 更新为新周期，近期已续费能正确显示
 */
function startIpxoCacheRefreshScheduler(): void {
  console.log('[IpxoCache] 每日自动刷新任务已启动，将在每天 00:00 北京时间执行...');

  let lastRefreshDate = '';

  setInterval(async () => {
    try {
      const config = loadIpxoConfig();
      if (!config) return; // IPXO 未配置，跳过

      // 北京时间（UTC+8）
      const now = new Date();
      const bjOffset = 8 * 60 * 60 * 1000;
      const bjNow = new Date(now.getTime() + bjOffset);
      const bjDate = bjNow.toISOString().slice(0, 10);   // YYYY-MM-DD
      const bjHour = bjNow.getUTCHours();
      const bjMinute = bjNow.getUTCMinutes();

      // 每天 00:00 ~ 00:05 之间执行一次（5 分钟窗口，避免秒级误差）
      if (bjHour !== 0 || bjMinute > 4) return;
      if (lastRefreshDate === bjDate) return; // 今天已刷新过

      console.log(`[IpxoCache] 开始每日自动刷新缓存（${bjDate} 00:00 北京时间）...`);
      const { servicesCount, invoicesCount } = await refreshIpxoCache();
      lastRefreshDate = bjDate;
      console.log(`[IpxoCache] 缓存刷新完成：${servicesCount} 条服务，${invoicesCount} 条发票`);
    } catch (e: any) {
      console.error('[IpxoCache] 每日缓存刷新失败:', e.message);
    }
  }, 60_000); // 每 60 秒检查一次
}

/** 定时备份任务：每天 03:00 北京时间备份所有数据文件，文件名含前一天日期 */
function startBackupScheduler(): void {
  console.log('[Backup] 定时备份任务已启动，每分钟检查一次...');

  setInterval(async () => {
    try {
      const cfg = loadNotifyConfig();
      // backupEnabled 默认为 true（未设置时也执行备份）
      if (cfg?.backupEnabled === false) return;

      const now = Date.now();
      const bjTime = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(now));
      const bjDate = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(now)).replace(/\//g, '-');

      // 只在 03:00 触发，且当天未备份过
      if (bjTime !== '03:00') return;
      if (cfg?.lastBackupDate === bjDate) return;

      // 前一天日期作为文件名后缀
      const prevDay = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(now - 86400_000)).replace(/\//g, '-');

      // 备份目录
      const backupDir = path.resolve(__dirname, 'backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

      const filesToBackup: Record<string, string> = {
        'ip-data': dataFilePath,
        'users': path.resolve(__dirname, 'users.json'),
        'notify-config': notifyConfigPath,
        'ipxo-config': path.resolve(__dirname, 'ipxo-config.json'),
        'asn-standby-groups': path.resolve(__dirname, 'asn-standby-groups.json'),
        'ipxo-upcoming-status': upcomingStatusPath,
      };

      const backed: string[] = [];
      for (const [name, filePath] of Object.entries(filesToBackup)) {
        if (fs.existsSync(filePath)) {
          const dest = path.join(backupDir, `${name}-${prevDay}.json`);
          fs.copyFileSync(filePath, dest);
          backed.push(name);
        }
      }

      console.log(`[Backup] 备份完成：${prevDay}，已备份 ${backed.length} 个文件`);

      // 更新备份时间记录
      const updated = loadNotifyConfig();
      if (updated) {
        updated.lastBackupAt = new Date().toISOString();
        updated.lastBackupDate = bjDate;
        saveNotifyConfig(updated);
      }

      // 发送 Google Chat 通知（如果已配置）
      if (cfg?.googleChatWebhook) {
        const chatText = `✅ 数据备份完成\n时间：${bjDate} 03:00（北京时间）\n备份日期：${prevDay}\n文件：${backed.join('、')}\n共 ${backed.length} 个文件已备份到 backups/ 目录`;
        const chatPayload = JSON.stringify({ text: chatText });
        try {
          await new Promise<void>((resolve, reject) => {
            const webhookUrl = new URL(cfg.googleChatWebhook!);
            const req = https.request({
              hostname: webhookUrl.hostname,
              path: webhookUrl.pathname + webhookUrl.search,
              method: 'POST',
              headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': Buffer.byteLength(chatPayload) },
            }, (res) => { res.resume(); resolve(); });
            req.on('error', reject);
            req.write(chatPayload);
            req.end();
          });
        } catch (e: any) {
          console.error('[Backup] 备份通知发送失败:', e.message);
        }
      }
    } catch (e: any) {
      console.error('[Backup] 定时备份异常:', e.message);
    }
  }, 60_000);
}

interface IpxoConfig {
  clientId: string;
  clientSecret: string;
  companyUuid: string;
}

/** IPXO 缓存数据结构 */
interface IpxoCache {
  cachedAt: string;
  services: { data: any[]; meta: any };
  invoices: { data: any[]; meta: any };
  upcoming: any[];
}

function loadIpxoConfig(): IpxoConfig | null {
  try {
    if (fs.existsSync(ipxoConfigPath)) {
      return JSON.parse(fs.readFileSync(ipxoConfigPath, 'utf-8'));
    }
  } catch (e) {
    console.error('[IPXO] Load config error:', e);
  }
  return null;
}

function saveIpxoConfig(config: IpxoConfig): void {
  fs.writeFileSync(ipxoConfigPath, JSON.stringify(config, null, 2), 'utf-8');
}

function loadIpxoCache(): IpxoCache | null {
  try {
    if (fs.existsSync(ipxoCachePath)) {
      return JSON.parse(fs.readFileSync(ipxoCachePath, 'utf-8'));
    }
  } catch (e) {
    console.error('[IPXO] Load cache error:', e);
  }
  return null;
}

function saveIpxoCache(cache: IpxoCache): void {
  fs.writeFileSync(ipxoCachePath, JSON.stringify(cache, null, 2), 'utf-8');
  console.log(`[IPXO] 缓存已更新: ${cache.cachedAt}`);
}

/** 缓存 IPXO OAuth2 access_token */
let ipxoTokenCache: { token: string; expiresAt: number } | null = null;

async function getIpxoAccessToken(): Promise<string> {
  if (ipxoTokenCache && Date.now() < ipxoTokenCache.expiresAt - 60000) {
    return ipxoTokenCache.token;
  }
  const config = loadIpxoConfig();
  if (!config) throw new Error('IPXO API 配置尚未设置');

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: 'billing',
  }).toString();

  const result: any = await new Promise((resolve, reject) => {
    const req = https.request('https://hydra.ipxo.com/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (apiRes) => {
      let data = '';
      apiRes.on('data', (c) => { data += c.toString(); });
      apiRes.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Token response parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Token request timeout')); });
    req.write(body);
    req.end();
  });

  if (!result.access_token) throw new Error('获取 token 失败: ' + JSON.stringify(result));
  ipxoTokenCache = { token: result.access_token, expiresAt: Date.now() + (result.expires_in ?? 86399) * 1000 };
  return result.access_token;
}

/** 代理调用 IPXO API */
async function callIpxoApi(urlPath: string): Promise<any> {
  const token = await getIpxoAccessToken();
  const config = loadIpxoConfig()!;
  const fullUrl = `https://apigw.ipxo.com${urlPath.replace('{tenant_uuid}', config.companyUuid)}`;

  return new Promise((resolve, reject) => {
    const urlObj = new URL(fullUrl);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
      timeout: 30000,
    }, (apiRes) => {
      let data = '';
      apiRes.on('data', (c) => { data += c.toString(); });
      apiRes.on('end', () => {
        try { resolve({ status: apiRes.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: apiRes.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('IPXO API timeout')); });
    req.end();
  });
}

/** POST 请求版本，用于购物车添加等写操作 */
async function callIpxoApiPost(urlPath: string, bodyJson: string): Promise<any> {
  const token = await getIpxoAccessToken();
  const config = loadIpxoConfig()!;
  const fullUrl = `https://apigw.ipxo.com${urlPath.replace('{tenant_uuid}', config.companyUuid)}`;

  return new Promise((resolve, reject) => {
    const urlObj = new URL(fullUrl);
    const bodyBuf = Buffer.from(bodyJson, 'utf-8');
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': bodyBuf.length,
      },
      timeout: 30000,
    }, (apiRes) => {
      let data = '';
      apiRes.on('data', (c) => { data += c.toString(); });
      apiRes.on('end', () => {
        try { resolve({ status: apiRes.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: apiRes.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('IPXO API timeout')); });
    req.write(bodyBuf);
    req.end();
  });
}

// 开发服务器与 vite preview 共用（否则 preview / 仅静态托管时 /api 会回退为 index.html，登录报 Unexpected token '<'）
let dataPersistenceGuardsRegistered = false;

function installDataPersistenceMiddlewares(server: { middlewares: any }) {
  if (!dataPersistenceGuardsRegistered) {
    dataPersistenceGuardsRegistered = true;
    process.on('unhandledRejection', (reason, promise) => {
      console.error('[unhandledRejection]', reason);
    });
    process.on('uncaughtException', (err) => {
      console.error('[uncaughtException]', err);
    });
  }
  // 保存数据接口
  server.middlewares.use('/api/save-data', (req, res, next) => {
      // 设置CORS头
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }
      
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            fs.writeFileSync(dataFilePath, body, 'utf-8');

            // ── 同步备注到 ipxo-upcoming-status.json ──────────────────────────
            // ip-data.json 中有备注的 IPXO 段，同步写入 upcomingStatus（以 ip-data 为准）
            try {
              const savedData = JSON.parse(body);
              const segments: any[] = savedData?.ipSegments || [];
              const upcomingStore = loadUpcomingStatus();
              let changed = false;
              for (const seg of segments) {
                if (!seg.segment) continue;
                const remark = (seg.remark || '').trim();
                const existing = upcomingStore[seg.segment];
                // 只在备注不同时才更新（避免无意义写入）
                if ((existing?.remark || '') !== remark) {
                  if (remark) {
                    upcomingStore[seg.segment] = {
                      ...(existing || {}),
                      remark,
                      updatedAt: new Date().toISOString(),
                    };
                  } else if (existing?.remark) {
                    // ip-data 中清空了备注，也清空 upcomingStatus 中的备注
                    upcomingStore[seg.segment] = {
                      ...existing,
                      remark: '',
                      updatedAt: new Date().toISOString(),
                    };
                  }
                  changed = true;
                }
              }
              if (changed) saveUpcomingStatus(upcomingStore);
            } catch (syncErr) {
              console.error('[Sync] 同步备注到 upcoming-status 失败:', syncErr);
            }
            // ────────────────────────────────────────────────────────────────────

            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true }));
          } catch (err) {
            console.error('Save error:', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Failed to save data' }));
          }
        });
      } else {
        res.statusCode = 405;
        res.end('Method Not Allowed');
      }
    });

    // 读取数据接口
    server.middlewares.use('/api/get-data', (req, res, next) => {
      // 设置CORS头
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }
      
      if (req.method === 'GET') {
        try {
          if (fs.existsSync(dataFilePath)) {
            const data = fs.readFileSync(dataFilePath, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 200;
            res.end(data);
          } else {
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 200;
            res.end(JSON.stringify(null)); // 文件不存在
          }
        } catch (err) {
          console.error('Read error:', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Failed to read data' }));
        }
      } else {
        res.statusCode = 405;
        res.end('Method Not Allowed');
      }
    });

    // 初始化默认用户（首次启动）
    initDefaultUserIfNeeded();

    // 认证 API - 登录
    server.middlewares.use('/api/auth/login', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end('Method Not Allowed');
        return;
      }
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { username, password } = JSON.parse(body);
          const users = loadUsers();
          const user = users.find((u: any) => u.username === (username || '').trim());
          if (!user || user.passwordHash !== hashPassword(password || '')) {
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 200;
            res.end(JSON.stringify({ success: false, message: '用户名或密码错误' }));
            return;
          }
          const token = crypto.randomBytes(32).toString('hex');
          tokenStore.set(token, { userId: user.id, username: user.username, role: user.role });
          const userInfo = { id: user.id, username: user.username, displayName: user.displayName, role: user.role, createdAt: user.createdAt, updatedAt: user.updatedAt };
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, user: userInfo, token }));
        } catch (e: any) {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, message: e.message || '登录失败' }));
        }
      });
    });

    // 认证 API - 获取当前用户
    server.middlewares.use('/api/auth/me', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.end('Method Not Allowed');
        return;
      }
      const authHeader = (req as any).headers?.authorization || '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const session = token ? tokenStore.get(token) : null;
      if (!session) {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify({ success: false, user: null }));
        return;
      }
      const users = loadUsers();
      const user = users.find((u: any) => u.id === session.userId);
      if (!user) {
        tokenStore.delete(token);
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify({ success: false, user: null }));
        return;
      }
      const userInfo = { id: user.id, username: user.username, displayName: user.displayName, role: user.role, createdAt: user.createdAt, updatedAt: user.updatedAt };
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, user: userInfo, token }));
    });

    // 认证 API - 登出
    server.middlewares.use('/api/auth/logout', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }
      if (req.method === 'POST') {
        const authHeader = (req as any).headers?.authorization || '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        if (token) tokenStore.delete(token);
      }
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true }));
    });

    // 用户管理 API - 列出用户（需 admin）
    server.middlewares.use('/api/users', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }
      const authHeader = (req as any).headers?.authorization || '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const session = token ? tokenStore.get(token) : null;
      if (!session || session.role !== 'admin') {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 403;
        res.end(JSON.stringify({ success: false, message: '需要管理员权限' }));
        return;
      }
      if (req.method === 'GET') {
        const users = loadUsers().map((u: any) => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, createdAt: u.createdAt, updatedAt: u.updatedAt }));
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, users }));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const { action, id, username, password, displayName, role } = data;
            let users = loadUsers();
            if (action === 'add') {
              if (!username || !password) {
                res.setHeader('Content-Type', 'application/json');
                res.statusCode = 400;
                res.end(JSON.stringify({ success: false, message: '用户名和密码必填' }));
                return;
              }
              if (users.some((u: any) => u.username === username.trim())) {
                res.setHeader('Content-Type', 'application/json');
                res.statusCode = 400;
                res.end(JSON.stringify({ success: false, message: '用户名已存在' }));
                return;
              }
              const newUser = { id: 'user-' + Date.now(), username: username.trim(), passwordHash: hashPassword(password), displayName: displayName || username.trim(), role: role || 'viewer', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
              users.push(newUser);
              saveUsers(users);
              res.setHeader('Content-Type', 'application/json');
              res.statusCode = 200;
              res.end(JSON.stringify({ success: true, user: { id: newUser.id, username: newUser.username, displayName: newUser.displayName, role: newUser.role, createdAt: newUser.createdAt, updatedAt: newUser.updatedAt } }));
            } else if (action === 'update') {
              const idx = users.findIndex((u: any) => u.id === id);
              if (idx < 0) {
                res.setHeader('Content-Type', 'application/json');
                res.statusCode = 404;
                res.end(JSON.stringify({ success: false, message: '用户不存在' }));
                return;
              }
              if (password) users[idx].passwordHash = hashPassword(password);
              if (displayName !== undefined) users[idx].displayName = displayName;
              if (role) users[idx].role = role;
              users[idx].updatedAt = new Date().toISOString();
              saveUsers(users);
              res.setHeader('Content-Type', 'application/json');
              res.statusCode = 200;
              res.end(JSON.stringify({ success: true, user: { id: users[idx].id, username: users[idx].username, displayName: users[idx].displayName, role: users[idx].role, createdAt: users[idx].createdAt, updatedAt: users[idx].updatedAt } }));
            } else if (action === 'delete') {
              if (id === users.find((u: any) => u.username === 'admin')?.id) {
                res.setHeader('Content-Type', 'application/json');
                res.statusCode = 400;
                res.end(JSON.stringify({ success: false, message: '不能删除管理员账户' }));
                return;
              }
              users = users.filter((u: any) => u.id !== id);
              saveUsers(users);
              res.setHeader('Content-Type', 'application/json');
              res.statusCode = 200;
              res.end(JSON.stringify({ success: true }));
            } else {
              res.setHeader('Content-Type', 'application/json');
              res.statusCode = 400;
              res.end(JSON.stringify({ success: false, message: '无效的 action' }));
            }
          } catch (e: any) {
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, message: e.message || '操作失败' }));
          }
        });
      } else {
        res.statusCode = 405;
        res.end('Method Not Allowed');
      }
    });

    /** HTTPS GET JSON（用于 BGP 查询代理；超时与重试缓解 api.bgpview.io 慢速或被限速） */
    function fetchHttpsJson(urlStr: string, timeoutMs = 60000): Promise<any> {
      return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const req = https.request(
          {
            hostname: u.hostname,
            path: u.pathname + u.search,
            port: u.port || 443,
            method: 'GET',
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
              Accept: 'application/json, text/plain, */*',
              'Accept-Encoding': 'identity',
              Connection: 'close',
            },
          },
          (r) => {
            let body = '';
            r.on('data', (c) => {
              body += c;
            });
            r.on('end', () => {
              if (r.statusCode && r.statusCode >= 400) {
                reject(
                  new Error(
                    `Upstream HTTP ${r.statusCode}: ${body.slice(0, 120).replace(/\s+/g, ' ')}`
                  )
                );
                return;
              }
              try {
                resolve(JSON.parse(body || '{}'));
              } catch {
                reject(new Error('Invalid JSON from upstream'));
              }
            });
          }
        );
        req.setTimeout(timeoutMs, () => {
          req.destroy();
          reject(new Error('Upstream timeout'));
        });
        req.on('error', reject);
        req.end();
      });
    }

    async function fetchHttpsJsonWithRetry(urlStr: string, attempts = 3): Promise<any> {
      let last: Error | null = null;
      for (let i = 0; i < attempts; i++) {
        try {
          return await fetchHttpsJson(urlStr, 45000);
        } catch (e: any) {
          last = e instanceof Error ? e : new Error(String(e));
          if (i < attempts - 1) {
            await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
          }
        }
      }
      throw last || new Error('BGP upstream failed');
    }

    /** HTTPS GET 原始 HTML（用于 Cheburcheck 等只提供页面的上游） */
    function fetchHttpsText(urlStr: string, timeoutMs = 45000): Promise<string> {
      return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const req = https.request(
          {
            hostname: u.hostname,
            path: u.pathname + u.search,
            port: u.port || 443,
            method: 'GET',
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
              Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'ru,en-US;q=0.8,en;q=0.7',
              'Accept-Encoding': 'identity',
              Connection: 'close',
            },
          },
          (r) => {
            let body = '';
            r.setEncoding('utf8');
            r.on('data', (c) => {
              body += c;
            });
            r.on('end', () => {
              if (r.statusCode && r.statusCode >= 400) {
                reject(
                  new Error(
                    `Upstream HTTP ${r.statusCode}: ${body.slice(0, 200).replace(/\s+/g, ' ')}`
                  )
                );
                return;
              }
              resolve(body);
            });
          }
        );
        req.setTimeout(timeoutMs, () => {
          req.destroy();
          reject(new Error('Upstream timeout'));
        });
        req.on('error', reject);
        req.end();
      });
    }

    function parseCheburcheckHtml(html: string) {
      const h2M = html.match(/<div class="result-header"[\s\S]*?<h2>([^<]+)<\/h2>/);
      const statusTitle = h2M ? h2M[1].replace(/\s+/g, ' ').trim() : ''
      const subM = html.match(/<p class="subheading[^"]*">([^<]+)<\/p>/)
      const subheading = subM ? subM[1].replace(/\s+/g, ' ').trim() : ''
      const cdnM = html.match(/row-label">CDN<\/span>[\s\S]*?<span class="row-value">([^<]+)/)
      const cdn = cdnM ? cdnM[1].replace(/\s+/g, ' ').trim() : ''
      const rknM = html.match(/row-label">Реестр РКН<\/span>[\s\S]*?<span class="row-value">([^<]+)/)
      const rkn = rknM ? rknM[1].replace(/\s+/g, ' ').trim() : ''
      const hasPanel = html.includes('result-panel') && statusTitle.length > 0
      const available =
        /Доступен/i.test(statusTitle) && !/Недоступен/i.test(statusTitle)
      return { statusTitle, subheading, cdn, rkn, available, parsed: hasPanel }
    }

    function stripBgpHeTags(s: string) {
      return s
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#x2F;/g, '/')
        .replace(/\s+/g, ' ')
        .trim()
    }

    function parseBgpHeNetinfoHtml(html: string) {
      const announced: Array<{
        origin: string
        originRegistrant: string
        prefix: string
        prefixRegistrant: string
      }> = []
      const delegations: Array<{
        registry: string
        status: string
        parentPrefix: string
        cc: string
      }> = []
      const netM = html.match(/<div id='netinfo'[^>]*>([\s\S]*?)<\/div>\s*<div id='whois'/)
      const block = netM ? netM[1] : ''
      if (block) {
        const tbodys = Array.from(block.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)).map((m) => m[1])
        if (tbodys[0]) {
          for (const tr of Array.from(tbodys[0].matchAll(/<tr>([\s\S]*?)<\/tr>/g))) {
            const tds = Array.from(tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)).map((m) => m[1])
            if (tds.length >= 4) {
              announced.push({
                origin: stripBgpHeTags(tds[0] || '') || '—',
                originRegistrant: stripBgpHeTags(tds[1] || '') || '—',
                prefix: stripBgpHeTags(tds[2] || '') || '—',
                prefixRegistrant: stripBgpHeTags(tds[3] || '') || '—',
              })
            }
          }
        }
        if (tbodys[1]) {
          for (const tr of Array.from(tbodys[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g))) {
            const tds = Array.from(tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)).map((m) => m[1])
            if (tds.length >= 4) {
              delegations.push({
                registry: stripBgpHeTags(tds[0] || '') || '—',
                status: stripBgpHeTags(tds[1] || '') || '—',
                parentPrefix: stripBgpHeTags(tds[2] || '') || '—',
                cc: stripBgpHeTags(tds[3] || '') || '—',
              })
            }
          }
        }
      }
      let bogonLine: string | null = null
      if (/is a bogon/i.test(html)) {
        const alt = html.match(/([\d.:/a-fA-F\[\]]+[^<]{0,120}is a bogon[^<]*)/i)
        if (alt) bogonLine = stripBgpHeTags(alt[1])
      }
      return { announced, delegations, bogonLine: bogonLine && bogonLine.length < 200 ? bogonLine : null }
    }

    function countBgpHeVisibilityDataRows(html: string): number {
      const visM = html.match(
        /<div id='visibility'[^>]*>([\s\S]*?)(?=<div id='routes'|<div id="SearchTab"|<div id="traceroute")/
      )
      if (!visM) return 0
      const sub = visM[1]
      const idx = sub.indexOf("<table")
      if (idx < 0) return 0
      const rest = sub.slice(idx)
      const tbM = rest.match(/<tbody>([\s\S]*?)<\/tbody>/)
      if (!tbM) return 0
      const rows = tbM[1].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []
      return rows.filter((r) => {
        if (/Loading/i.test(r) || /colspan/i.test(r)) return false
        const tds = r.match(/<td/g)
        return (tds ? tds.length : 0) >= 2
      }).length
    }

    /** BGPView data.asns 按 ASN 去重，多条不同源常与「多一层路由表层」对齐（MOAS） */
    function dedupeBgpViewAsns(asns: any[]): Array<{ asn?: number; name?: string }> {
      const seen = new Set<number>()
      const out: Array<{ asn?: number; name?: string }> = []
      for (const a of asns || []) {
        const n = a?.asn
        if (n == null || typeof n !== 'number' || Number.isNaN(n)) continue
        if (seen.has(n)) continue
        seen.add(n)
        out.push({ asn: n, name: typeof a?.name === 'string' ? a.name : undefined })
      }
      return out
    }

    /** IPv4 /plen 前缀掩码（/0 为全网，/32 为单主机） */
    function ipv4MaskBits(plen: number): number {
      const p = Math.max(0, Math.min(32, Math.floor(plen)))
      if (p === 0) return 0xffffffff >>> 0
      return ((0xffffffff << (32 - p)) >>> 0) >>> 0
    }

    function parseIpv4Cidr(raw: string): { addr: number; plen: number } | null {
      const t = raw.trim().replace(/^\//, '')
      const m = t.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/)
      if (!m) return null
      const oc = m[1].split('.').map((x) => Number(x))
      if (oc.some((x) => !Number.isInteger(x) || x > 255)) return null
      const plen = Number(m[2])
      if (!Number.isInteger(plen) || plen < 0 || plen > 32) return null
      const addr = oc[0]! * 16777216 + oc[1]! * 65536 + oc[2]! * 256 + oc[3]!
      return { addr: addr >>> 0, plen }
    }

    /** 父前缀：掩码比查询前缀更短，且覆盖了查询网段（非相等） */
    function ipv4IsStrictSupernetOf(
      parent: { addr: number; plen: number },
      query: { addr: number; plen: number }
    ): boolean {
      if (parent.plen >= query.plen) return false
      const m = ipv4MaskBits(parent.plen)
      const pBase = (parent.addr & m) >>> 0
      const qBase = (query.addr & m) >>> 0
      return pBase === qBase
    }

    /**
     * 从 HE Matching delegations 的「父级前缀」列判断 IPv4 是否有注册分配上的父块。
     * 能解析出至少一个 CIDR 且均非严格父级 → no_parent；完全无法从列中解析出有效 CIDR → unknown（走回退）。
     */
    function bgpHeDelegationLayerHint(
      queryPrefix: string,
      delegations: Array<{ parentPrefix: string }>
    ): 'parent' | 'no_parent' | 'unknown' {
      const q = parseIpv4Cidr(queryPrefix)
      if (!q) return 'unknown'
      const qNorm: { addr: number; plen: number } = {
        addr: (q.addr & ipv4MaskBits(q.plen)) >>> 0,
        plen: q.plen,
      }
      let sawParsable = false
      for (const d of delegations) {
        const cell = d.parentPrefix || ''
        if (!cell || cell === '—') continue
        const parts = cell.match(/\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/g)
        if (!parts) continue
        for (const part of parts) {
          const p = parseIpv4Cidr(part)
          if (!p) continue
          sawParsable = true
          const pNorm: { addr: number; plen: number } = {
            addr: (p.addr & ipv4MaskBits(p.plen)) >>> 0,
            plen: p.plen,
          }
          if (ipv4IsStrictSupernetOf(pNorm, qNorm)) return 'parent'
        }
      }
      if (sawParsable) return 'no_parent'
      return 'unknown'
    }

    /** Team Cymru DNS（仅需 DNS，不访问 api.bgpview.io） */
    async function cymruIpToAsn(ip: string): Promise<null | {
      asn: number;
      prefix: string;
      country: string;
      registry: string;
      allocated: string;
    }> {
      const parts = ip.split('.');
      if (parts.length !== 4) return null;
      const nums = parts.map((p) => parseInt(p, 10));
      if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
      const [a, b, c, d] = nums;
      const host = `${d}.${c}.${b}.${a}.origin.asn.cymru.com`;
      try {
        const rows = await dns.resolveTxt(host);
        const line = (rows[0] && rows[0].join('')) || '';
        const seg = line.split('|').map((s) => s.trim());
        if (seg.length < 2) return null;
        const asn = parseInt(seg[0], 10);
        if (!Number.isFinite(asn)) return null;
        return {
          asn,
          prefix: seg[1] || '',
          country: seg[2] || '',
          registry: seg[3] || '',
          allocated: seg[4] || '',
        };
      } catch {
        return null;
      }
    }

    async function cymruAsnTxt(asnDigits: string): Promise<null | { raw: string; descr: string }> {
      const clean = asnDigits.replace(/\D/g, '');
      if (!clean) return null;
      try {
        const rows = await dns.resolveTxt(`${clean}.asn.cymru.com`);
        const raw = (rows[0] && rows[0].join('')) || '';
        const seg = raw.split('|').map((s) => s.trim());
        const descr = seg[4] || seg[3] || raw;
        return { raw, descr };
      } catch {
        return null;
      }
    }

    function parsePingStdout(text: string): {
      sent: number;
      received: number;
      lost: number;
      lossPercent: number;
      avgMs: number | null;
    } {
      const t = (text || '').replace(/\r/g, '');
      let sent: number | null = null;
      let received: number | null = null;
      let lost: number | null = null;

      const mZh = t.match(/已发送\s*=\s*(\d+)/i);
      const rZh = t.match(/已接收\s*=\s*(\d+)/i);
      const lZh = t.match(/丢失\s*=\s*(\d+)/i);
      if (mZh) sent = parseInt(mZh[1], 10);
      if (rZh) received = parseInt(rZh[1], 10);
      if (lZh) lost = parseInt(lZh[1], 10);

      if (sent === null) {
        const mEn = t.match(/Sent\s*=\s*(\d+)/i);
        const rEn = t.match(/Received\s*=\s*(\d+)/i);
        const lEn = t.match(/Lost\s*=\s*(\d+)/i);
        if (mEn) sent = parseInt(mEn[1], 10);
        if (rEn) received = parseInt(rEn[1], 10);
        if (lEn) lost = parseInt(lEn[1], 10);
      }

      if (sent === null) {
        const m = t.match(/(\d+)\s+packets?\s+transmitted,?\s+(\d+)\s+received/i);
        if (m) {
          sent = parseInt(m[1], 10);
          received = parseInt(m[2], 10);
          lost = sent - received;
        }
      }

      if (sent === null) sent = 5;
      if (received === null) received = 0;
      if (lost === null) lost = Math.max(0, sent - received);

      let lossPercent = 0;
      const pLoss =
        t.match(/\((\d+)%\s*(?:丢失|loss)\s*\)/i) || t.match(/(\d+)%\s*packet\s*loss/i);
      if (pLoss) lossPercent = parseInt(pLoss[1], 10);
      else if (sent > 0) lossPercent = Math.round((lost / sent) * 100);

      let avgMs: number | null = null;
      const zhAvg = t.match(/平均\s*=\s*([\d.]+)\s*ms/i);
      const enAvg = t.match(/Average\s*=\s*([\d.]+)\s*ms/i);
      const linuxAvg = t.match(/min\/avg\/max[^=\n]+=\s*[\d.]+\/([\d.]+)\//i);
      const am = zhAvg || enAvg || linuxAvg;
      if (am) avgMs = Math.round(parseFloat(am[1]));

      return { sent, received, lost, lossPercent, avgMs };
    }

    async function icmpPing5(ip: string): Promise<{
      ok: boolean;
      reachable: boolean;
      sent: number;
      received: number;
      lost: number;
      lossPercent: number;
      avgMs: number | null;
      error?: string;
    }> {
      const isWin = process.platform === 'win32';
      const args = isWin ? ['-n', '5', '-w', '2000', ip] : ['-c', '5', '-W', '2', ip];
      try {
        const { stdout } = await execFileAsync(isWin ? 'ping' : 'ping', args, {
          timeout: 22000,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 512 * 1024,
        });
        const stats = parsePingStdout(stdout || '');
        return { ok: true, reachable: stats.received > 0, ...stats };
      } catch (e: any) {
        const stdout = typeof e?.stdout === 'string' ? e.stdout : '';
        if (stdout.length > 30) {
          const stats = parsePingStdout(stdout);
          return { ok: true, reachable: stats.received > 0, ...stats };
        }
        return {
          ok: false,
          reachable: false,
          sent: 5,
          received: 0,
          lost: 5,
          lossPercent: 100,
          avgMs: null,
          error: e?.message || '无法执行 ping（请检查系统 PATH 或权限）',
        };
      }
    }

    // 本机 ICMP：固定 5 个包，统计整体丢包与延迟（不依赖外网 HTTP API）
    server.middlewares.use('/api/ping/host', async (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.end();
        return;
      }
      const urlObj = new URL(req.url || '', 'http://localhost');
      const ip = (urlObj.searchParams.get('ip') || '').trim();
      if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, message: '请提供合法 IPv4 地址' }));
        return;
      }
      try {
        const result = await icmpPing5(ip);
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (e: any) {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, message: e?.message || 'ping 失败' }));
      }
    });

    // IP → ASN：优先 Team Cymru DNS，可选合并 BGPView（在 api.bgpview.io 不可解析时仍可用 Cymru）
    server.middlewares.use('/api/bgp/lookup-ip', async (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.end();
        return;
      }
      const urlObj = new URL(req.url || '', 'http://localhost');
      const ip = (urlObj.searchParams.get('ip') || '').trim();
      if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, message: '请提供合法 IPv4 地址' }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      try {
        const cymru = await cymruIpToAsn(ip);
        const merged: any[] = [];
        if (cymru) {
          merged.push({
            asn: cymru.asn,
            name: `AS${cymru.asn} · ${cymru.prefix || '?'}`,
            description: `Team Cymru DNS · ${cymru.country} · ${cymru.registry}`,
            country_code: cymru.country,
          });
        }

        try {
          const data = await fetchHttpsJsonWithRetry(
            `https://api.bgpview.io/ip/${encodeURIComponent(ip)}`,
            2
          );
          const bgpAsns = data?.data?.asns;
          if (Array.isArray(bgpAsns)) {
            for (const x of bgpAsns) {
              if (x?.asn == null) continue;
              if (merged.some((m) => m.asn === x.asn)) continue;
              merged.push(x);
            }
          }
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              success: true,
              data: {
                data: { asns: merged },
                source: cymru ? 'cymru+bgpview' : 'bgpview',
                bgpviewRaw: data,
              },
            })
          );
          return;
        } catch {
          /* ENOTFOUND / timeout — 仅用 Cymru */
        }

        if (merged.length === 0) {
          res.statusCode = 502;
          res.end(
            JSON.stringify({
              success: false,
              message:
                '无法解析 ASN（Team Cymru DNS 无记录或本机 DNS 不可用；且 BGPView 不可达）',
            })
          );
          return;
        }
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            success: true,
            data: { data: { asns: merged }, source: 'cymru' },
          })
        );
      } catch (e: any) {
        res.statusCode = 502;
        res.end(JSON.stringify({ success: false, message: e?.message || 'BGP 查询失败' }));
      }
    });

    server.middlewares.use('/api/bgp/lookup-asn', async (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.end();
        return;
      }
      const urlObj = new URL(req.url || '', 'http://localhost');
      const asnRaw = (urlObj.searchParams.get('asn') || '').replace(/^AS/i, '').trim();
      const asn = asnRaw.replace(/\D/g, '');
      if (!asn) {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, message: '请提供 ASN' }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      try {
        const data = await fetchHttpsJsonWithRetry(`https://api.bgpview.io/asn/${asn}`, 2);
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, data }));
      } catch (e: any) {
        const cymru = await cymruAsnTxt(asn);
        if (cymru) {
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              success: true,
              data: {
                source: 'cymru',
                data: {
                  asn: {
                    asn: parseInt(asn, 10),
                    name: cymru.descr,
                    description: cymru.raw,
                  },
                },
              },
            })
          );
          return;
        }
        res.statusCode = 502;
        res.end(JSON.stringify({ success: false, message: e?.message || 'ASN 查询失败' }));
      }
    });

    // IRR 检测 API - 验证 AS
    server.middlewares.use('/api/irr/verify/as', async (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const asn = normalizeAS(data.asn || '');
            const server = data.server || 'radb';
            const host = IRR_SERVERS[server] || IRR_SERVERS.radb;

            if (!asn) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '请输入 AS 号' }));
              return;
            }

            const result = await whoisQuery(asn, server);
            const hasASet = result.includes('AS-SET') || result.includes('as-set');
            const success = !result.startsWith('错误') && (hasASet || result.includes('aut-num') || result.includes('as-block'));

            // 尝试查询 AS-SET
            const asNum = asn.replace('AS', '');
            const asetResults: any[] = [];
            for (const asetFormat of [`AS${asNum}:AS-CUSTOMERS`, `AS-AS${asNum}`]) {
              const asetResult = await whoisQuery(asetFormat, server);
              if (asetResult && !asetResult.startsWith('错误') && !asetResult.toLowerCase().includes('no entries')) {
                if (!asetResult.toLowerCase().substring(0, 200).includes('error')) {
                  asetResults.push({ name: asetFormat, data: asetResult });
                }
              }
            }

            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 200;
            res.end(JSON.stringify({
              type: 'as',
              query: asn,
              server: host,
              success: success || asetResults.length > 0,
              has_aset: hasASet || asetResults.length > 0,
              raw: result,
              aset_results: asetResults,
              error: result.startsWith('错误') ? result : null,
            }));
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message || '服务器错误' }));
          }
        });
      } else {
        res.statusCode = 405;
        res.end('Method Not Allowed');
      }
    });

    // IRR 检测 API - 验证路由
    server.middlewares.use('/api/irr/verify/route', async (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const prefix = (data.prefix || '').trim();
            const server = data.server || 'radb';
            const host = IRR_SERVERS[server] || IRR_SERVERS.radb;

            if (!prefix) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '请输入 IP 前缀' }));
              return;
            }

            const result = await whoisQuery(prefix, server);
            const hasRoute = result.includes('route:') || result.includes('route6:');
            const success = !result.startsWith('错误') && hasRoute;

            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 200;
            res.end(JSON.stringify({
              type: 'route',
              query: prefix,
              server: host,
              success,
              has_route: hasRoute,
              raw: result,
              error: result.startsWith('错误') ? result : null,
            }));
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message || '服务器错误' }));
          }
        });
      } else {
        res.statusCode = 405;
        res.end('Method Not Allowed');
      }
    });

    // IRR 检测 API - 一键检测
    server.middlewares.use('/api/irr/verify/all', async (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const asn = normalizeAS(data.asn || '');
            const prefixesRaw = data.prefixes || '';
            const server = data.server || 'radb';
            const multiIrr = data.multi_irr === true || data.multi_irr === 'true' || data.multi_irr === '1';
            const fullMatrix = data.full_matrix === true || data.full_matrix === 'true' || data.full_matrix === '1';

            if (!asn) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '请输入 AS 号' }));
              return;
            }

            // 解析前缀列表
            let prefixes: string[] = [];
            if (Array.isArray(prefixesRaw)) {
              prefixes = prefixesRaw.map(p => String(p).trim()).filter(Boolean);
            } else {
              prefixes = String(prefixesRaw).split(/[\n\s,]+/).map(p => p.trim()).filter(Boolean);
            }

            if (prefixes.length === 0) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '请输入至少一个 IP 段' }));
              return;
            }

            const asNum = asn.replace('AS', '');
            const dbNames = Object.keys(IRR_SERVERS);
            const host = IRR_SERVERS[server] || IRR_SERVERS.radb;

            // 1. 检测 AS/AS-set
            let asResult: any;
            let asOk = false;

            if (fullMatrix) {
              // 并行查询所有数据库
              const asQueries = dbNames.map(srv => 
                whoisQuery(asn, srv).then(r => ({ srv, result: r }))
              );
              const asResults = await Promise.all(asQueries);
              
              const asMatrix: Record<string, string> = {};
              const asRaw: Record<string, string> = {};
              for (const { srv, result: r } of asResults) {
                const hasASet = r.includes('AS-SET') || r.includes('as-set') || r.includes('aut-num') || r.includes('as-block');
                asMatrix[srv] = hasASet ? 'ok' : 'none';
                asRaw[srv] = (r || '').substring(0, 400);
              }
              asOk = Object.values(asMatrix).some(v => v === 'ok');
              asResult = {
                ok: asOk,
                has_aset: asOk,
                matrix: asMatrix,
                raw: asRaw,
                found_in: dbNames.find(s => asMatrix[s] === 'ok') || null,
              };
            } else if (multiIrr) {
              // 并行查询所有数据库
              const asQueries = Object.entries(IRR_SERVERS).map(([name, host]) =>
                whoisQuery(asn, name).then(r => ({ name, result: r }))
              );
              const asResults = await Promise.all(asQueries);
              
              let foundIn: string | null = null;
              const allRaw: Record<string, string> = {};
              for (const { name, result: r } of asResults) {
                allRaw[name] = (r || '').substring(0, 500);
                const hasASet = r.includes('AS-SET') || r.includes('as-set') || r.includes('aut-num') || r.includes('as-block');
                if (hasASet && !foundIn) {
                  foundIn = name;
                  asOk = true;
                }
              }
              asResult = {
                ok: asOk,
                has_aset: asOk,
                raw: allRaw[foundIn || 'radb'] || '',
                found_in: foundIn,
                all_raw: allRaw,
              };
            } else {
              const r = await whoisQuery(asn, server);
              const hasASet = r.includes('AS-SET') || r.includes('as-set') || r.includes('aut-num') || r.includes('as-block');
              asOk = hasASet;
              asResult = {
                ok: asOk,
                has_aset: asOk,
                raw: r,
                error: r.startsWith('错误') ? r : null,
              };
            }

            // 2. 检测每个前缀 - 并行处理RPKI验证
            const originMatches = (originVal: string | null) => {
              if (!originVal) return false;
              const digits = originVal.replace(/\D/g, '');
              return digits === asNum;
            };

            // 并行执行所有前缀的RPKI验证
            const rpkiPromises = prefixes.map(prefix => {
              const prefixClean = prefix.trim();
              if (!prefixClean) return Promise.resolve({ prefix: prefixClean, rpki: null });
              return verifyRPKI(prefixClean, asNum).then(rpki => ({ prefix: prefixClean, rpki }));
            });
            const rpkiResults = await Promise.all(rpkiPromises);
            const rpkiMap = new Map(rpkiResults.map(r => [r.prefix, r.rpki]));

            // 并行处理所有前缀的IRR查询
            const prefixChecks: any[] = [];
            const prefixPromises = prefixes.map(async (prefix) => {
              const prefixClean = prefix.trim();
              if (!prefixClean) return null;

              const rpkiResult = rpkiMap.get(prefixClean) || null;

              if (fullMatrix) {
                // 并行查询所有数据库
                const routeQueries = dbNames.map(srv =>
                  whoisQuery(prefixClean, srv).then(r => ({ srv, result: r }))
                );
                const routeResults = await Promise.all(routeQueries);
                
                const routeMatrix: Record<string, string> = {};
                const rawByDb: Record<string, string> = {};
                for (const { srv, result: r } of routeResults) {
                  const objs = parseRouteObjects(r || '');
                  rawByDb[srv] = (r || '').substring(0, 350);
                  const matched = objs.filter(o => originMatches(o.origin));
                  const hasRoute = objs.length > 0;
                  if (matched.length > 0) {
                    routeMatrix[srv] = 'ok';
                  } else if (hasRoute) {
                    routeMatrix[srv] = 'wrong_origin';
                  } else {
                    routeMatrix[srv] = 'none';
                  }
                }
                const hasOurRoute = Object.values(routeMatrix).some(v => v === 'ok');
                return {
                  prefix: prefixClean,
                  has_route: Object.values(routeMatrix).some(v => v === 'ok' || v === 'wrong_origin'),
                  origin_match: hasOurRoute,
                  ok: hasOurRoute,
                  found_in: dbNames.find(s => routeMatrix[s] === 'ok') || null,
                  matrix: routeMatrix,
                  rpki: rpkiResult,
                  raw: dbNames.map(s => `[${s}]\n${rawByDb[s] || ''}`).join('\n---\n'),
                };
              } else if (multiIrr) {
                // 并行查询所有数据库
                const routeQueries = Object.entries(IRR_SERVERS).map(([srvName, srvHost]) =>
                  whoisQuery(prefixClean, srvName).then(r => ({ srvName, result: r }))
                );
                const routeResults = await Promise.all(routeQueries);
                
                let foundIn: string | null = null;
                const routeObjects: any[] = [];
                const combinedRaw: string[] = [];
                let hasAnyRoute = false;
                for (const { srvName, result: r } of routeResults) {
                  const objs = parseRouteObjects(r || '');
                  combinedRaw.push(`[${srvName}]\n${(r || '').substring(0, 300)}`);
                  hasAnyRoute = hasAnyRoute || objs.length > 0;
                  const matched = objs.filter(o => originMatches(o.origin));
                  if (matched.length > 0 && !foundIn) {
                    foundIn = srvName;
                    routeObjects.push(...objs);
                  }
                }
                const hasOurRoute = foundIn !== null;
                return {
                  prefix: prefixClean,
                  has_route: hasAnyRoute,
                  origin_match: hasOurRoute,
                  route_objects: routeObjects,
                  rpki: rpkiResult,
                  raw: combinedRaw.length > 0 ? combinedRaw.slice(0, 4).join('\n---\n') : null,
                  ok: hasOurRoute,
                  found_in: foundIn,
                };
              } else {
                const routeResult = await whoisQuery(prefixClean, server);
                const routeObjects = parseRouteObjects(routeResult || '');
                const matched = routeObjects.filter(ro => originMatches(ro.origin));
                const hasOurRoute = matched.length > 0;
                const hasAnyRoute = routeObjects.length > 0;
                return {
                  prefix: prefixClean,
                  has_route: hasAnyRoute,
                  origin_match: hasOurRoute,
                  route_objects: routeObjects,
                  rpki: rpkiResult,
                  raw: routeResult,
                  ok: hasOurRoute,
                  found_in: null,
                };
              }
            });

            const prefixResults = await Promise.all(prefixPromises);
            prefixChecks.push(...prefixResults.filter(r => r !== null));

            const allPrefixOk = prefixChecks.every(p => p.ok);
            const allRpkiOk = prefixChecks.every(p => p.rpki?.ok === true);
            const overallOk = asOk && allPrefixOk && allRpkiOk;

            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 200;
            res.end(JSON.stringify({
              asn,
              prefixes: prefixChecks.map(p => p.prefix),
              server: host,
              overall_ok: overallOk,
              multi_irr: multiIrr,
              full_matrix: fullMatrix,
              db_names: dbNames,
              db_scopes: IRR_SCOPES,
              all_rpki_ok: allRpkiOk,
              as_check: {
                ok: asOk,
                has_aset: asOk,
                raw: asResult.raw,
                error: asResult.error,
                found_in: asResult.found_in,
                matrix: asResult.matrix,
              },
              prefix_checks: prefixChecks,
            }));
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message || '服务器错误' }));
          }
        });
      } else {
        res.statusCode = 405;
        res.end('Method Not Allowed');
      }
    });

    // IRR 检测 API - 批量验证
    server.middlewares.use('/api/irr/verify/bulk', async (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const asn = (data.asn || '').trim();
            const prefixesRaw = data.prefixes || '';
            const server = data.server || 'radb';

            if (!asn && !prefixesRaw) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '请输入 AS 号或前缀' }));
              return;
            }

            const results: any[] = [];
            if (asn) {
              const asnNorm = normalizeAS(asn);
              const host = IRR_SERVERS[server] || IRR_SERVERS.radb;
              const result = await whoisQuery(asnNorm, server);
              const hasASet = result.includes('AS-SET') || result.includes('as-set');
              const success = !result.startsWith('错误') && (hasASet || result.includes('aut-num') || result.includes('as-block'));
              results.push({
                type: 'as',
                query: asnNorm,
                server: host,
                success,
                has_aset: hasASet,
                raw: result,
                error: result.startsWith('错误') ? result : null,
              });
            }

            const prefixes = String(prefixesRaw).replace(/,/g, '\n').split(/\s+/).filter(Boolean);
            for (const prefix of prefixes) {
              const prefixClean = prefix.trim();
              if (!prefixClean) continue;
              const host = IRR_SERVERS[server] || IRR_SERVERS.radb;
              const result = await whoisQuery(prefixClean, server);
              const hasRoute = result.includes('route:') || result.includes('route6:');
              const success = !result.startsWith('错误') && hasRoute;
              results.push({
                type: 'route',
                query: prefixClean,
                server: host,
                success,
                has_route: hasRoute,
                raw: result,
                error: result.startsWith('错误') ? result : null,
              });
            }

            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 200;
            res.end(JSON.stringify({ results }));
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message || '服务器错误' }));
          }
        });
      } else {
        res.statusCode = 405;
        res.end('Method Not Allowed');
      }
    });

    /** Cheburcheck.ru：抓取检测结果页并解析「是否可用」、CDN、РКН（仅开发/preview 中间件） */
    server.middlewares.use('/api/cheburcheck/lookup', async (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.end();
        return;
      }
      const urlObj = new URL(req.url || '', 'http://localhost');
      const target = (urlObj.searchParams.get('target') || '').trim();
      if (target.length < 3 || target.length > 512) {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, message: '请提供合法 target（IPv4 前缀等）' }));
        return;
      }
      const upstream = `https://cheburcheck.ru/check?target=${encodeURIComponent(target)}`;
      try {
        const html = await fetchHttpsText(upstream, 50000);
        const p = parseCheburcheckHtml(html);
        if (!p.parsed) {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              success: false,
              message: '未能解析 Cheburcheck 结果页（页面结构可能已变更）',
              upstream,
            })
          );
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            success: true,
            upstream,
            available: p.available,
            statusTitle: p.statusTitle,
            subheading: p.subheading,
            cdn: p.cdn,
            rkn: p.rkn,
          })
        );
      } catch (e: any) {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 502;
        res.end(
          JSON.stringify({
            success: false,
            message: e?.message || '拉取 Cheburcheck 失败（请确认可访问 cheburcheck.ru，且使用本机 npm run dev / npm run preview）',
            upstream,
          })
        );
      }
    });

    /** Hurricane Electric bgp.he.net：抓取 Network Info，并尽量给出「路由相关条数」（Visibility 表行数或 BGPView 宣告方数） */
    server.middlewares.use('/api/bgphe/lookup', async (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.end();
        return;
      }
      const urlObj = new URL(req.url || '', 'http://localhost');
      const raw = (urlObj.searchParams.get('prefix') || '').trim();
      if (raw.length < 5 || raw.length > 128 || !/^[0-9a-fA-F.:\/\-]+$/i.test(raw) || !raw.includes('/')) {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, message: '请提供有效前缀，如 147.125.148.0/24' }));
        return;
      }
      const heUrl = `https://bgp.he.net/net/${raw.replace(/^\//, '')}`;
      try {
        const html = await fetchHttpsText(heUrl, 55000);
        if (!/Announced By|bgp\.he\.net/i.test(html) && !/Hurricane Electric/i.test(html)) {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              success: false,
              message: '未识别为 HE 前缀页，可能前缀无效',
              heUrl,
            })
          );
          return;
        }
        const neti = parseBgpHeNetinfoHtml(html)
        const heVisRows = countBgpHeVisibilityDataRows(html)
        /** HE Network Info 里 「Announced by」表的非空数据行（多行为多源宣告时亦为多层） */
        const announcedTableRows = neti.announced.length
        let bgpUniqAsnCount = 0
        let bgpviewAsns: Array<{ asn?: number; name?: string }> | null = null
        try {
          const j = await fetchHttpsJson(
            `https://api.bgpview.io/prefix/${raw.replace(/^\//, '')}`,
            22000
          )
          const asnsRaw = j?.data?.asns
          if (Array.isArray(asnsRaw) && asnsRaw.length > 0) {
            const uniq = dedupeBgpViewAsns(asnsRaw)
            bgpUniqAsnCount = uniq.length
            bgpviewAsns = uniq.slice(0, 50).map((a) => ({ asn: a.asn, name: a.name }))
          }
        } catch {
          /* 忽略 BGPView 失败 */
        }

        /** 路由「表层」数：IPv4 优先由 Matching delegations 是否含严格父前缀判断 1/2 层；否则 Visibility 行；再否则 Announced×BGPView 合并 */
        const delHint = bgpHeDelegationLayerHint(raw, neti.delegations)
        let routeCount: number | null = null
        let countSource:
          | 'delegation_parent'
          | 'delegation_no_parent'
          | 'he_visibility'
          | 'bgpview'
          | 'he_announced'
          | 'merged'
          | 'none' = 'none'
        if (delHint === 'parent') {
          routeCount = 2
          countSource = 'delegation_parent'
        } else if (delHint === 'no_parent') {
          routeCount = 1
          countSource = 'delegation_no_parent'
        } else if (heVisRows > 0) {
          routeCount = heVisRows
          countSource = 'he_visibility'
        } else {
          const merged = Math.max(announcedTableRows, bgpUniqAsnCount)
          if (merged > 0) {
            routeCount = merged
            if (announcedTableRows > bgpUniqAsnCount) countSource = 'he_announced'
            else if (bgpUniqAsnCount > announcedTableRows) countSource = 'bgpview'
            else countSource = merged > 1 || announcedTableRows > 1 ? 'merged' : 'bgpview'
          }
        }
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            success: true,
            heUrl,
            routeCount: routeCount != null ? routeCount : null,
            countSource,
            heVisibilityTableRows: heVisRows,
            announcedTableRows,
            bgpUniqAsnCount,
            announcedBy: neti.announced,
            delegations: neti.delegations,
            bogonLine: neti.bogonLine,
            bgpviewAsns,
          })
        );
      } catch (e: any) {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 502;
        res.end(
          JSON.stringify({
            success: false,
            message: e?.message || '拉取 bgp.he.net 失败',
            heUrl,
          })
        );
      }
    });

    // IRR 数据库列表 API
    server.middlewares.use('/api/irr/servers', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }

      if (req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify({ servers: IRR_SERVERS, scopes: IRR_SCOPES }));
      } else {
        res.statusCode = 405;
        res.end('Method Not Allowed');
      }
    });

    // 路由检测 API - RIPE Stat Routing Status
    server.middlewares.use('/api/routing/status', async (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }

      if (req.method === 'GET' || req.method === 'POST') {
        let resource = '';
        if (req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', async () => {
            try {
              try {
                const data = JSON.parse(body || '{}');
                resource = (data.resource || '').trim();
              } catch (e) {
                const url = new URL(req.url || '', `http://${req.headers.host}`);
                resource = url.searchParams.get('resource') || '';
              }
              await handleRoutingStatusRequest(res, resource);
            } catch (err: any) {
              console.error('[api/routing/status] 未捕获错误:', err);
              if (!res.headersSent) {
                res.setHeader('Content-Type', 'application/json');
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err?.message || '服务器内部错误' }));
              }
            }
          });
        } else {
          try {
            const url = new URL(req.url || '', `http://${req.headers.host}`);
            resource = url.searchParams.get('resource') || '';
            await handleRoutingStatusRequest(res, resource);
          } catch (err: any) {
            console.error('[api/routing/status] GET 未捕获错误:', err);
            if (!res.headersSent) {
              res.setHeader('Content-Type', 'application/json');
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err?.message || '服务器内部错误' }));
            }
          }
        }
      } else {
        res.statusCode = 405;
        res.end('Method Not Allowed');
      }
    });

    /** 常见 Tier 1 / 超大国际运营商 ASN（与 bgp.tools Connectivity 中「Tier 1 ISPs」区域常见集合对齐，用于路径统计） */
    const TIER1_ASN_LABELS: Record<string, string> = {
      '12956': 'Telxius',
      '7018': 'AT&T',
      '6830': 'Liberty',
      '6762': 'Sparkle',
      '6461': 'Zayo',
      '6453': 'Tata',
      '5511': 'Orange',
      '3491': 'PCCW',
      '3356': 'Lumen',
      '3320': 'DTAG',
      '3257': 'GTT',
      '2914': 'NTT',
      '174': 'Cogent',
      '1299': 'Arelion',
      '6939': 'Hurricane Electric',
    };
    const TIER1_ASN_SET = new Set(Object.keys(TIER1_ASN_LABELS));

    function normalizeIpv4PrefixInput(raw: string): string | null {
      const t = raw.trim();
      const m = t.match(/^((?:\d{1,3}\.){3}\d{1,3})\/(\d{1,2})$/);
      if (!m) return null;
      const octets = m[1].split('.').map((x) => parseInt(x, 10));
      if (octets.some((n) => n > 255)) return null;
      const pfx = parseInt(m[2], 10);
      if (pfx < 0 || pfx > 32) return null;
      return `${m[1]}/${m[2]}`;
    }

    function analyzeLookingGlassTier1(lgJson: any): {
      originAsn: string | undefined;
      pathObservationCount: number;
      tier1Asns: string[];
      tier1Details: Array<{ asn: string; name: string }>;
    } {
      const seenTier1 = new Set<string>();
      let originAsn: string | undefined;
      let pathObservationCount = 0;
      const rrcs = lgJson?.data?.rrcs;
      if (!Array.isArray(rrcs)) {
        return { originAsn, pathObservationCount: 0, tier1Asns: [], tier1Details: [] };
      }
      for (const rrc of rrcs) {
        const peers = rrc?.peers;
        if (!Array.isArray(peers)) continue;
        for (const peer of peers) {
          pathObservationCount++;
          if (originAsn == null && peer?.asn_origin != null && String(peer.asn_origin).trim() !== '') {
            originAsn = String(peer.asn_origin).trim();
          }
          const ap = peer?.as_path;
          if (typeof ap !== 'string' || !ap.trim()) continue;
          const hops = ap.trim().split(/\s+/).filter(Boolean);
          for (const hop of hops) {
            const digits = hop.replace(/\D/g, '');
            if (!digits) continue;
            if (TIER1_ASN_SET.has(digits)) seenTier1.add(digits);
          }
        }
      }
      const tier1Asns = Array.from(seenTier1).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
      const tier1Details = tier1Asns.map((asn) => ({
        asn,
        name: TIER1_ASN_LABELS[asn] || asn,
      }));
      return { originAsn, pathObservationCount, tier1Asns, tier1Details };
    }

    server.middlewares.use('/api/bgp/tier1-reception', async (req, res, _next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.statusCode = 405;
        res.end();
        return;
      }

      const sendJson = (code: number, obj: Record<string, unknown>) => {
        if (res.writableEnded) return;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = code;
        res.end(JSON.stringify(obj));
      };

      const runOne = async (prefixRaw: string) => {
        const normalized = normalizeIpv4PrefixInput(prefixRaw);
        if (!normalized) {
          return {
            input: prefixRaw,
            success: false,
            error: '请输入合法 IPv4 前缀，格式如 74.1.46.0/24',
          };
        }
        const lgUrl = `https://stat.ripe.net/data/looking-glass/data.json?resource=${encodeURIComponent(normalized)}`;
        let lgJson: any;
        try {
          lgJson = await fetchHttpsJson(lgUrl, 90000);
        } catch (e: any) {
          return {
            prefix: normalized,
            success: false,
            error: e?.message || 'RIPE Looking Glass 请求失败',
          };
        }
        if (lgJson?.status !== 'ok') {
          const msg =
            typeof lgJson?.message === 'string' && lgJson.message.trim()
              ? lgJson.message.trim()
              : 'RIPE Looking Glass 返回状态非 ok';
          return {
            prefix: normalized,
            success: false,
            error: msg,
          };
        }
        const analyzed = analyzeLookingGlassTier1(lgJson);
        const tier1Count = analyzed.tier1Asns.length;
        const [ipPart, lenPart] = normalized.split('/');
        const bgpToolsConnectivityUrl = `https://bgp.tools/prefix/${ipPart}/${lenPart}#connectivity`;
        return {
          prefix: normalized,
          success: true,
          originAsn: analyzed.originAsn,
          pathObservationCount: analyzed.pathObservationCount,
          tier1Asns: analyzed.tier1Asns,
          tier1Details: analyzed.tier1Details,
          tier1Count,
          /** 路径中至少出现 2 个不同 Tier 1 ASN 时，视为已较好进入全球上游骨干（与 bgp.tools 多 Tier1 展示含义接近） */
          receptionLikelyOk: tier1Count >= 2,
          bgpToolsConnectivityUrl,
          source: 'ripe-looking-glass',
        };
      };

      if (req.method === 'GET') {
        const url = new URL(req.url || '', 'http://localhost');
        const prefix = (url.searchParams.get('prefix') || '').trim();
        if (!prefix) {
          sendJson(400, { success: false, message: '缺少 prefix 参数' });
          return;
        }
        try {
          const result = await runOne(prefix);
          sendJson(200, { success: true, result });
        } catch (e: any) {
          sendJson(500, { success: false, message: e?.message || '服务错误' });
        }
        return;
      }

      let body = '';
      req.on('data', (c) => {
        body += c.toString();
      });
      req.on('end', async () => {
        try {
          let prefixes: string[] = [];
          try {
            const j = JSON.parse(body || '{}');
            if (typeof j.prefix === 'string' && j.prefix.trim()) {
              prefixes = [j.prefix.trim()];
            } else if (Array.isArray(j.prefixes)) {
              prefixes = j.prefixes.map((x: unknown) => String(x || '').trim()).filter(Boolean);
            }
          } catch {
            sendJson(400, { success: false, message: 'JSON 格式错误' });
            return;
          }
          if (prefixes.length === 0) {
            sendJson(400, { success: false, message: '请提供 prefix 或 prefixes[]' });
            return;
          }
          const uniq = Array.from(new Set(prefixes));
          if (uniq.length > 30) {
            sendJson(400, { success: false, message: '单次最多检测 30 个前缀' });
            return;
          }
          const results: unknown[] = [];
          for (const p of uniq) {
            results.push(await runOne(p));
          }
          sendJson(200, { success: true, results });
        } catch (e: any) {
          sendJson(500, { success: false, message: e?.message || '服务错误' });
        }
      });
    });

    async function handleRoutingStatusRequest(res: any, resource: string) {
      const safeEnd = (code: number, body: string) => {
        if (res.writableEnded) return;
        try {
          res.statusCode = code;
          res.setHeader('Content-Type', 'application/json');
          res.end(body);
        } catch (e) {
          console.error('[api/routing/status] Response error:', e);
        }
      };
      if (!resource) {
        safeEnd(400, JSON.stringify({ error: '请输入 IP 前缀或 AS 号' }));
        return;
      }

      try {
        // 获取 Prefix Routing Consistency 数据（ASN 信息来源；RPKI 需 resource=ASN+prefix，暂不合并）
        const consistencyUrl = `https://stat.ripe.net/data/prefix-routing-consistency/data.json?resource=${encodeURIComponent(resource)}`;

        return new Promise((resolve) => {
          const urlObj1 = new URL(consistencyUrl);
          const httpModule1 = urlObj1.protocol === 'https:' ? https : http;
          const req1 = httpModule1.get(consistencyUrl, { timeout: 15000 }, (apiRes1) => {
            let data1 = '';
            apiRes1.on('data', (chunk) => { data1 += chunk.toString(); });
            apiRes1.on('end', () => {
              try {
                const consistencyData = JSON.parse(data1);
                safeEnd(200, JSON.stringify(consistencyData));
              } catch (e) {
                safeEnd(500, JSON.stringify({ error: '解析响应失败: ' + String(e) }));
              }
              resolve(null);
            });
          });
          req1.on('error', (err) => {
            safeEnd(500, JSON.stringify({ error: err.message }));
            resolve(null);
          });
          req1.on('timeout', () => {
            req1.destroy();
            safeEnd(500, JSON.stringify({ error: '请求超时' }));
            resolve(null);
          });
        });
      } catch (e: any) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: e.message || '服务器错误' }));
      }
    }

    // ===================== IPXO API 接口 =====================

    // 保存/获取 IPXO 配置
    server.middlewares.use('/api/ipxo/config', (req, res, _next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }

      if (req.method === 'GET') {
        const config = loadIpxoConfig();
        // 返回时隐藏 secret 中间部分
        if (config) {
          const cfg = config as any;
          const masked = {
            ...config,
            clientSecret: config.clientSecret.slice(0, 4) + '****' + config.clientSecret.slice(-4),
            abuseipdbApiKeySet: !!(cfg.abuseipdbApiKey),
            abuseipdbApiKey: cfg.abuseipdbApiKey
              ? cfg.abuseipdbApiKey.slice(0, 6) + '****'
              : '',
          };
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, data: masked }));
        } else {
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, data: null }));
        }
        return;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c.toString(); });
        req.on('end', () => {
          try {
            const { clientId, clientSecret, companyUuid, abuseipdbApiKey } = JSON.parse(body);
            if (!clientId || !clientSecret || !companyUuid) {
              res.statusCode = 400;
              res.end(JSON.stringify({ success: false, message: '缺少必填字段' }));
              return;
            }
            const cfg: any = { clientId, clientSecret, companyUuid };
            if (abuseipdbApiKey !== undefined) cfg.abuseipdbApiKey = abuseipdbApiKey;
            else {
              // 保留已有的 abuseipdbApiKey
              const existing = loadIpxoConfig() as any;
              if (existing?.abuseipdbApiKey) cfg.abuseipdbApiKey = existing.abuseipdbApiKey;
            }
            saveIpxoConfig(cfg);
            ipxoTokenCache = null; // 清除旧 token
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true }));
          } catch (e: any) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, message: e.message }));
          }
        });
        return;
      }
      res.statusCode = 405;
      res.end(JSON.stringify({ error: 'Method not allowed' }));
    });

    // IPXO 账单发票列表（优先读缓存）
    server.middlewares.use('/api/ipxo/invoices', async (req, res, _next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      try {
        const config = loadIpxoConfig();
        if (!config) { res.statusCode = 400; res.end(JSON.stringify({ success: false, message: 'IPXO 配置未设置' })); return; }
        const reqUrl = new URL(req.url || '/', 'http://localhost');
        const forceRefresh = reqUrl.searchParams.get('refresh') === '1';
        // 检查缓存（6小时有效）
        const cache = loadIpxoCache();
        const cacheValid = cache && !forceRefresh && (Date.now() - new Date(cache.cachedAt).getTime()) < 6 * 3600 * 1000;
        if (cacheValid && cache.invoices) {
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, data: cache.invoices, fromCache: true, cachedAt: cache.cachedAt }));
          return;
        }
        const result = await callIpxoApi(`/billing/v1/{tenant_uuid}/invoices`);
        res.statusCode = result.status === 200 ? 200 : result.status ?? 500;
        res.end(JSON.stringify({ success: result.status === 200, data: result.body }));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });

    // IPXO 订单列表
    server.middlewares.use('/api/ipxo/orders', async (req, res, _next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      try {
        const config = loadIpxoConfig();
        if (!config) { res.statusCode = 400; res.end(JSON.stringify({ success: false, message: 'IPXO 配置未设置' })); return; }
        const result = await callIpxoApi(`/ecommerce/public/{tenant_uuid}/orders`);
        res.statusCode = result.status === 200 ? 200 : result.status ?? 500;
        res.end(JSON.stringify({ success: result.status === 200, data: result.body }));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });

    // ─── 已租用 IP 段列表（含分页，来自缓存，支持 no_asn 过滤）────────────
    server.middlewares.use('/api/ipxo/leased-segments', async (req: any, res: any, _next: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      try {
        const reqUrl = new URL(req.url || '/', 'http://localhost');
        const page = Math.max(1, parseInt(reqUrl.searchParams.get('page') || '1'));
        const pageSize = Math.min(200, Math.max(1, parseInt(reqUrl.searchParams.get('page_size') || '50')));
        const noAsnOnly = reqUrl.searchParams.get('no_asn') === '1';
        const searchSeg = (reqUrl.searchParams.get('search') || '').trim().toLowerCase();

        const cache = loadIpxoCache();
        if (!cache?.services?.data?.length) {
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, data: [], total: 0, page, pageSize, message: '缓存为空，请先刷新缓存' }));
          return;
        }

        // 读取本地 ip-data.json 补充 remark、projectGroups 等信息
        const localData = fs.existsSync(dataFilePath)
          ? JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'))
          : { ipSegments: [] };
        const localMap = new Map<string, any>();
        (localData.ipSegments || []).forEach((s: any) => { if (s.segment) localMap.set(s.segment, s); });
        const upcomingStore = loadUpcomingStatus();

        let items = cache.services.data.map((item: any) => {
          const bs = item.billing_service;
          const segKey = bs?.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
          const loa: any[] = item.loa || [];
          const localSeg = segKey ? localMap.get(segKey) : null;
          return {
            segment: segKey,
            address: bs?.address,
            cidr: bs?.cidr,
            status: bs?.status,
            nextDueDate: bs?.next_due_date ? new Date(bs.next_due_date * 1000).toISOString().slice(0, 10) : null,
            recurringAmount: bs?.recurring_amount,
            serviceUuid: bs?.uuid,
            marketServiceUuid: item.market_service?.uuid,
            registry: item.market_service?.registry || '',
            // LOA / ASN 信息
            loa: loa.map((l: any) => ({
              uuid: l.uuid,
              asn: l.asn,
              asName: l.as_name,
              status: l.status,
            })),
            hasAsn: loa.length > 0,
            // 本地补充信息
            remark: upcomingStore[segKey]?.remark || localSeg?.remark || '',
            projectGroups: localSeg?.projectGroups || [],
            renewalStatus: localSeg?.renewalStatus || null,
          };
        });

        // 过滤：无 ASN
        if (noAsnOnly) items = items.filter((i: any) => !i.hasAsn);
        // 过滤：搜索（支持多值，空格/逗号/换行分隔，OR 匹配）
        if (searchSeg) {
          const keywords = searchSeg.split(/[\s,，\n]+/).map((k: string) => k.trim().toLowerCase()).filter(Boolean);
          if (keywords.length > 0) {
            items = items.filter((i: any) => {
              const seg = (i.segment || '').toLowerCase();
              return keywords.some((kw: string) => seg.includes(kw));
            });
          }
        }

        const total = items.length;
        const start = (page - 1) * pageSize;
        const pageData = items.slice(start, start + pageSize);

        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, data: pageData, total, page, pageSize, cachedAt: cache.cachedAt }));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });

    // ─── 验证 ASN 并添加 LOA 到购物车 ──────────────────────────────────────
    server.middlewares.use('/api/ipxo/loa/add-to-cart', async (req: any, res: any, _next: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' })); return; }
      try {
        const config = loadIpxoConfig();
        if (!config) { res.statusCode = 400; res.end(JSON.stringify({ success: false, message: 'IPXO 配置未设置' })); return; }

        let body = '';
        req.on('data', (chunk: any) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            // payload: { asn: number, subnets: string[], companyName?: string }
            const payload = JSON.parse(body);
            const { asn, subnets, companyName = '' } = payload;
            if (!asn || !subnets?.length) {
              res.statusCode = 400;
              res.end(JSON.stringify({ success: false, message: '缺少 asn 或 subnets 参数' }));
              return;
            }

            // 1. 验证 ASN
            const validateResult = await callIpxoApiPost(
              `/billing/v1/{tenant_uuid}/asn/validate/${asn}`,
              JSON.stringify({ subnets })
            );
            if (validateResult.status !== 200) {
              res.statusCode = 200;
              res.end(JSON.stringify({
                success: false,
                message: `ASN ${asn} 验证失败：${validateResult.body?.message || validateResult.body?.error || JSON.stringify(validateResult.body)}`,
                validateStatus: validateResult.status,
                validateBody: validateResult.body,
              }));
              return;
            }

            // 2. 添加 LOA 到购物车
            const cartBody = JSON.stringify({
              product_type: 'loa',
              billing_cycle: 0,
              product_fields: {
                asn: Number(asn),
                subnets,
                company_name: companyName,
                max_length: 24,
                info: '',
                create_whois_inetnum: true,
                whois_data_exposed: false,
              },
              product_options: {
                selection: { roa: 'yes', radb: 'yes', route: 'yes' },
              },
            });
            const cartResult = await callIpxoApiPost(
              `/billing/v1/{tenant_uuid}/cart/items`,
              cartBody
            );

            res.statusCode = 200;
            res.end(JSON.stringify({
              success: cartResult.status === 200 || cartResult.status === 201,
              message: cartResult.status === 200 || cartResult.status === 201
                ? `ASN ${asn} 验证通过，LOA 已加入购物车（${subnets.length} 个 IP 段），请前往 IPXO 平台完成支付`
                : `LOA 加入购物车失败：${cartResult.body?.message || JSON.stringify(cartResult.body)}`,
              validateBody: validateResult.body,
              cartStatus: cartResult.status,
              cartBody: cartResult.body,
            }));
          } catch (e: any) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, message: e.message }));
          }
        });
      } catch (e: any) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });

    // ─── 单独更新 AbuseIPDB API Key（不影响其他 IPXO 配置） ───────────────
    server.middlewares.use('/api/ipxo/config/abuseipdb-key', (req: any, res: any, _next: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ success: false })); return; }
      let body = '';
      req.on('data', (c: any) => { body += c.toString(); });
      req.on('end', () => {
        try {
          const { abuseipdbApiKey } = JSON.parse(body);
          if (!abuseipdbApiKey) { res.statusCode = 400; res.end(JSON.stringify({ success: false, message: '缺少 abuseipdbApiKey' })); return; }
          const existing = loadIpxoConfig() as any;
          if (!existing) { res.statusCode = 400; res.end(JSON.stringify({ success: false, message: 'IPXO 配置未设置' })); return; }
          existing.abuseipdbApiKey = abuseipdbApiKey;
          saveIpxoConfig(existing);
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true }));
        } catch (e: any) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, message: e.message }));
        }
      });
    });

    // ─── AbuseIPDB 检测代理（需在 ipxo-config.json 中配置 abuseipdbApiKey） ──
    server.middlewares.use('/api/abuse-check', async (req: any, res: any, _next: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      try {
        const ipxoCfg = loadIpxoConfig();
        const apiKey = (ipxoCfg as any)?.abuseipdbApiKey || '';
        if (!apiKey) {
          res.statusCode = 200;
          res.end(JSON.stringify({ success: false, message: '未配置 AbuseIPDB API Key（在 IPXO 配置中添加 abuseipdbApiKey 字段）' }));
          return;
        }
        const reqUrl = new URL(req.url || '/', 'http://localhost');
        const segment = reqUrl.searchParams.get('segment') || '';
        if (!segment) { res.statusCode = 400; res.end(JSON.stringify({ success: false, message: '缺少 segment 参数' })); return; }

        // 取 IP 段的网络地址（去掉 /cidr）
        const ipAddress = segment.split('/')[0];
        const cidr = segment.includes('/') ? segment.split('/')[1] : '24';

        const abuseResult = await new Promise<any>((resolve, reject) => {
          // 免费账号用 /api/v2/check（单 IP），查询网段的网络地址
          const path = `/api/v2/check?ipAddress=${encodeURIComponent(ipAddress)}&maxAgeInDays=90&verbose`;
          const apiReq = https.request({
            hostname: 'api.abuseipdb.com',
            path,
            method: 'GET',
            headers: {
              'Key': apiKey,
              'Accept': 'application/json',
            },
            timeout: 15000,
          }, (apiRes) => {
            let d = '';
            apiRes.on('data', (c: any) => { d += c.toString(); });
            apiRes.on('end', () => {
              try { resolve({ status: apiRes.statusCode, body: JSON.parse(d) }); }
              catch { resolve({ status: apiRes.statusCode, body: d }); }
            });
          });
          apiReq.on('error', reject);
          apiReq.on('timeout', () => { apiReq.destroy(); reject(new Error('AbuseIPDB timeout')); });
          apiReq.end();
        });

        if (abuseResult.status === 200) {
          const data = abuseResult.body?.data || {};
          res.statusCode = 200;
          res.end(JSON.stringify({
            success: true,
            data: {
              networkAddress: data.ipAddress || segment,
              // /api/v2/check 返回 abuseConfidenceScore（0-100）
              abuseConfidenceScore: data.abuseConfidenceScore ?? 0,
              numDistinctUsers: data.numDistinctUsers ?? 0,
              totalReports: data.totalReports ?? 0,
              countryCode: data.countryCode || '',
              usageType: data.usageType || '',
              isp: data.isp || '',
              domain: data.domain || '',
              isWhitelisted: data.isWhitelisted ?? false,
            },
          }));
        } else {
          res.statusCode = 200;
          res.end(JSON.stringify({ success: false, message: `AbuseIPDB API 返回 ${abuseResult.status}${abuseResult.body?.errors?.[0]?.detail ? ': ' + abuseResult.body.errors[0].detail : ''}` }));
        }
      } catch (e: any) {
        res.statusCode = 200;
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });

    // ─── 购前检测：搜索 IPXO 市场可购买 IP 段 ─────────────────────────────
    server.middlewares.use('/api/ipxo/market/search', async (req: any, res: any, _next: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      try {
        const config = loadIpxoConfig();
        if (!config) { res.statusCode = 400; res.end(JSON.stringify({ success: false, message: 'IPXO 配置未设置' })); return; }
        const reqUrl = new URL(req.url || '/', 'http://localhost');
        // 透传查询参数：prefix_length, geo_country_code, price_min, price_max, limit, sort, page 等
        const params = reqUrl.searchParams.toString();
        const result = await callIpxoApi(`/billing/v1/{tenant_uuid}/market/search${params ? '?' + params : ''}`);
        res.statusCode = result.status === 200 ? 200 : (result.status ?? 500);
        res.end(JSON.stringify({ success: result.status === 200, data: result.body }));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });

    // ─── 购前检测：获取购物车 ─────────────────────────────────────────────
    // ─── 购前检测：本地购物车记录（因 IPXO ecommerce API 网络不通，改为本地记录） ──
    // GET：读取本地购物车记录
    // POST：添加记录（添加到 IPXO 后同时写本地）
    // DELETE：清空本地记录
    server.middlewares.use('/api/ipxo/cart', async (req: any, res: any, _next: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }

      const localCartPath = path.resolve(__dirname, 'local-cart.json');
      const loadLocalCart = () => {
        try {
          if (fs.existsSync(localCartPath)) return JSON.parse(fs.readFileSync(localCartPath, 'utf-8'));
        } catch (_) {}
        return { items: [], updatedAt: null };
      };

      try {
        if (req.method === 'GET') {
          // GET 直接读取本地购物车，不需要 IPXO 配置
          const cart = loadLocalCart();
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, data: cart }));
          return;
        }
        if (req.method === 'DELETE') {
          fs.writeFileSync(localCartPath, JSON.stringify({ items: [], updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, message: '本地购物车已清空' }));
          return;
        }

        const config = loadIpxoConfig();
        if (!config) { res.statusCode = 400; res.end(JSON.stringify({ success: false, message: 'IPXO 配置未设置' })); return; }

        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: any) => { body += chunk.toString(); });
          req.on('end', async () => {
            try {
              const payload = JSON.parse(body);
              const items: any[] = Array.isArray(payload) ? payload : [payload];
              const results = [];
              const successItems = [];

              for (const item of items) {
                const cartBody = JSON.stringify({
                  product_type: 'ipv4',
                  billing_cycle: item.billing_cycle || 1,
                  product_fields: { address: item.address, cidr: Number(item.cidr) },
                });
                const result = await callIpxoApiPost(
                  `/billing/v1/{tenant_uuid}/cart/items`,
                  cartBody
                );
                results.push({ address: item.address, cidr: item.cidr, status: result.status, body: result.body });
                if (result.status === 200 || result.status === 201) {
                  successItems.push({
                    address: item.address,
                    cidr: item.cidr,
                    segment: `${item.address}/${item.cidr}`,
                    price: item.price || null,
                    registry: item.registry || '',
                    addedAt: new Date().toISOString(),
                    cartUuid: result.body?.data?.uuid || result.body?.uuid || '',
                  });
                }
              }

              // 写入本地购物车记录
              if (successItems.length > 0) {
                const cart = loadLocalCart();
                const existing = new Set(cart.items.map((i: any) => i.segment));
                const newItems = successItems.filter(i => !existing.has(i.segment));
                cart.items = [...cart.items, ...newItems];
                cart.updatedAt = new Date().toISOString();
                fs.writeFileSync(localCartPath, JSON.stringify(cart, null, 2), 'utf-8');
              }

              res.statusCode = 200;
              res.end(JSON.stringify({ success: true, results }));
            } catch (e: any) {
              res.statusCode = 400;
              res.end(JSON.stringify({ success: false, message: e.message }));
            }
          });

        } else {
          res.statusCode = 405;
          res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
        }
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });
    server.middlewares.use('/api/ipxo/services', async (req, res, _next) => {
      // 子路径交给后续中间件处理
      if (req.url && (req.url.startsWith('/upcoming') || req.url.startsWith('/renewed') || req.url.startsWith('/sync-leased') || req.url === '-list' || req.url.startsWith('-list'))) { _next(); return; }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      try {
        const config = loadIpxoConfig();
        if (!config) { res.statusCode = 400; res.end(JSON.stringify({ success: false, message: 'IPXO 配置未设置' })); return; }
        const reqUrl = new URL(req.url || '/', 'http://localhost');
        const page = parseInt(reqUrl.searchParams.get('page') || '1');
        const perPage = parseInt(reqUrl.searchParams.get('per_page') || '15');
        const status = reqUrl.searchParams.get('status') || '';
        const forceRefresh = reqUrl.searchParams.get('refresh') === '1';

        // 仅 active 且第一页时走缓存（缓存存全量 active 数据）
        const useCache = status === 'active' && !forceRefresh;
        const cache = useCache ? loadIpxoCache() : null;
        const cacheValid = cache && (Date.now() - new Date(cache.cachedAt).getTime()) < 6 * 3600 * 1000;

        if (cacheValid && cache.services?.data?.length) {
          // 从缓存中切页返回
          const allData: any[] = cache.services.data;
          const start = (page - 1) * perPage;
          const end = start + perPage;
          const pageData = allData.slice(start, end);
          const lastPage = Math.ceil(allData.length / perPage);
          res.statusCode = 200;
          res.end(JSON.stringify({
            success: true,
            fromCache: true,
            cachedAt: cache.cachedAt,
            data: {
              data: pageData,
              meta: { current_page: page, last_page: lastPage, per_page: perPage, total: allData.length, from: start + 1, to: end },
            },
          }));
          return;
        }

        // 无缓存或强制刷新：从 API 拉取
        let apiPath = `/billing/v1/{tenant_uuid}/market/ipv4/services?page=${page}&per_page=${perPage}`;
        if (status) apiPath += `&status=${encodeURIComponent(status)}`;
        const result = await callIpxoApi(apiPath);
        res.statusCode = result.status === 200 ? 200 : result.status ?? 500;
        res.end(JSON.stringify({ success: result.status === 200, data: result.body }));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });

    // IPXO 近期续费 IP 段（优先读缓存，按 days 过滤）

    // IPXO 近期续费 IP 段（优先读缓存，按 days 过滤，附加近期续费独立状态）
    server.middlewares.use('/api/ipxo/services/upcoming', async (req, res, _next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      try {
        const config = loadIpxoConfig();
        if (!config) { res.statusCode = 400; res.end(JSON.stringify({ success: false, message: 'IPXO 配置未设置' })); return; }
        const reqUrl = new URL(req.url || '/', 'http://localhost');
        const days = Math.min(Math.max(parseInt(reqUrl.searchParams.get('days') || '7'), 1), 90);
        const forceRefresh = reqUrl.searchParams.get('refresh') === '1';
        const nowSec = Math.floor(Date.now() / 1000);
        const endSec = nowSec + days * 86400;

        // 优先从缓存过滤（缓存存全量 active 数据）
        const cache = !forceRefresh ? loadIpxoCache() : null;
        const cacheValid = cache && (Date.now() - new Date(cache.cachedAt).getTime()) < 6 * 3600 * 1000;

        // 加载近期续费独立状态（续费标记+备注，不影响 IP 段管理）
        const upcomingStore = loadUpcomingStatus();

        // 加载 ip-data.json 建立 segment -> {projectGroups, supplier, renewalStatus} 映射
        const localData = fs.existsSync(dataFilePath)
          ? JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'))
          : { ipSegments: [] };
        const localSegInfoMap: Map<string, { projectGroups: string[]; supplier: string; renewalStatus?: string }> = new Map();
        for (const seg of (localData.ipSegments || [])) {
          if (seg.segment) {
            localSegInfoMap.set(seg.segment, {
              projectGroups: seg.projectGroups || [],
              supplier: seg.supplier || '',
              renewalStatus: seg.renewalStatus || '',
            });
          }
        }

        const attachLocalStatus = (items: any[]) => items.map((item: any) => {
          const bs = item.billing_service;
          const segKey = bs?.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
          const localStatus = segKey ? (upcomingStore[segKey] || {}) : {};
          const localInfo = segKey ? (localSegInfoMap.get(segKey) || {}) : {};
          return {
            ...item,
            _localRenewalStatus: localStatus.renewalStatus || 'not_renewed',
            _localRemark: localStatus.remark || '',
            _localProjectGroups: (localInfo as any).projectGroups || [],
            _localSupplier: (localInfo as any).supplier || '',
          };
        });

        /** 综合判断：IPXO 状态正常 + 近期续费状态未标记为 cancelled + ip-data.json 中未取消 */
        const isUpcomingRenewable = (item: any): boolean => {
          if (!isRenewableService(item)) return false;
          const bs = item.billing_service;
          const segKey = bs?.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
          // 近期续费独立状态中标记为 cancelled
          if (segKey && upcomingStore[segKey]?.renewalStatus === 'cancelled') return false;
          // ip-data.json 中本地标记为 cancelled（在续费日前取消的情况）
          if (segKey && localSegInfoMap.get(segKey)?.renewalStatus === 'cancelled') return false;
          return true;
        };

        if (cacheValid && cache.services?.data?.length) {
          const matched = attachLocalStatus(cache.services.data
            .filter((item: any) => {
              const due = item.billing_service?.next_due_date;
              return due != null && due >= nowSec && due <= endSec && isUpcomingRenewable(item);
            })
            .sort((a: any, b: any) =>
              (a.billing_service?.next_due_date ?? 0) - (b.billing_service?.next_due_date ?? 0)
            ));
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, data: matched, total: matched.length, days, fromCache: true, cachedAt: cache.cachedAt }));
          return;
        }

        // 无缓存：逐页拉取所有 active 服务
        const matched: any[] = [];
        let page = 1;
        const perPage = 100;
        let lastPage = 1;

        do {
          const result = await callIpxoApi(
            `/billing/v1/{tenant_uuid}/market/ipv4/services?page=${page}&per_page=${perPage}&status=active`
          );
          if (result.status !== 200) break;
          const body = result.body;
          const items: any[] = body?.data ?? [];
          lastPage = body?.meta?.last_page ?? 1;
          for (const item of items) {
            const due = item.billing_service?.next_due_date;
            if (due != null && due >= nowSec && due <= endSec && isUpcomingRenewable(item)) {
              matched.push(item);
            }
          }
          page++;
        } while (page <= lastPage);

        matched.sort((a, b) =>
          (a.billing_service?.next_due_date ?? 0) - (b.billing_service?.next_due_date ?? 0)
        );

        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, data: attachLocalStatus(matched), total: matched.length, days }));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });

    // IPXO 已续费 IP 段查询（展示近期已标记续费的条目，默认近 3 天，可自定义）
    // 来源 1：近期续费独立状态中标记为 renewed 且在 IPXO 缓存中的条目
    // 来源 2：ip-data.json 中 renewalDate 已过期（<=今天）且 renewalStatus 不是 cancelled 的 IP 段
    server.middlewares.use('/api/ipxo/services/renewed', async (req, res, _next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      try {
        const reqUrl = new URL(req.url || '/', 'http://localhost');
        const days = Math.min(Math.max(parseInt(reqUrl.searchParams.get('days') || '3'), 1), 30);
        const nowSec = Math.floor(Date.now() / 1000);
        const startSec = nowSec - days * 86400;
        const todayStr = new Date().toISOString().slice(0, 10);

        const upcomingStore = loadUpcomingStatus();
        const cache = loadIpxoCache();

        // 提前加载 ip-data.json 建立 segment -> {projectGroups, supplier, purchaseDate} 映射
        const localData = fs.existsSync(dataFilePath)
          ? JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'))
          : { ipSegments: [] };
        const localSegInfoMap = new Map();
        for (const seg of (localData.ipSegments || [])) {
          if (seg.segment) {
            localSegInfoMap.set(seg.segment, {
              projectGroups: seg.projectGroups || [],
              supplier: seg.supplier || '',
              purchaseDate: seg.purchaseDate || '',
            });
          }
        }

        // ── 来源 1：IPXO 缓存中符合已续费条件的条目 ──────────────────────────
        // 条件 A：在 upcomingStore 中手动标记为 renewed
        // 条件 B：next_due_date - 1个月 在查询时间范围内，且上次续费日晚于购买日（排除新购第一个月）
        // 额外排除：ip-data.json 中本地标记为 cancelled 的 IP 段
        const localCancelledSet = new Set(
          (localData.ipSegments || [])
            .filter((seg: any) => seg.renewalStatus === 'cancelled' && seg.segment)
            .map((seg: any) => seg.segment)
        );

        const cacheRenewed = (cache?.services?.data ?? [])
          .filter((item) => {
            const bs = item.billing_service;
            const segKey = bs?.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
            if (!segKey) return false;
            if (!isRenewableService(item)) return false; // 排除已终止服务
            // 排除本地已标记取消续费的 IP 段
            if (localCancelledSet.has(segKey)) return false;

            // 条件 A：手动标记为已续费
            // 用 updatedAt（标记时间）判断是否在查询的天数范围内
            if (upcomingStore[segKey]?.renewalStatus === 'renewed') {
              const updatedAt = upcomingStore[segKey]?.updatedAt;
              if (!updatedAt) return false;
              const updatedTs = Math.floor(new Date(updatedAt).getTime() / 1000);
              // 标记时间必须在查询范围内（startSec ~ nowSec）
              return updatedTs >= startSec && updatedTs <= nowSec;
            }

            // 条件 B：从 next_due_date 推算上次续费日
            // 要求 IP 段必须在 ip-data.json 中有记录（有 purchaseDate），否则无法验证续费周期
            const localInfo = localSegInfoMap.get(segKey) || {};
            const purchaseDate = (localInfo as any).purchaseDate || '';
            if (!purchaseDate) return false; // 未录入 IP 段管理的，不自动计入已续费
            const due = bs?.next_due_date;
            if (!due) return false;
            // next_due_date 必须在未来，或在过去 7 天内（缓存未及时刷新的宽限）
            // 超过 7 天的已到期段说明缓存严重过期，跳过
            if (due < nowSec - 7 * 86400) return false;
            // 上次续费日 = next_due_date - 1个月
            const nextDueDate = new Date(due * 1000);
            const lastRenewalDate = new Date(nextDueDate);
            lastRenewalDate.setMonth(lastRenewalDate.getMonth() - 1);
            const lastRenewalStr = lastRenewalDate.toISOString().slice(0, 10);
            const lastRenewalTs = Math.floor(lastRenewalDate.getTime() / 1000);
            // 上次续费日在查询范围内，且已经过了（< now）
            if (!(lastRenewalTs >= startSec && lastRenewalTs <= nowSec)) return false;
            // 排除新购第一个月：上次续费日必须晚于购买日
            if (lastRenewalStr <= purchaseDate) return false;
            return true;
          })
          .map((item) => {
            const bs = item.billing_service;
            const segKey = `${bs.address}/${bs.cidr}`;
            const localStatus = upcomingStore[segKey] || {};
            const localInfo = localSegInfoMap.get(segKey) || {};

            // 展示上次续费日（next_due_date - 1月），而不是下次到期日
            const nextDueDate = new Date(bs.next_due_date * 1000);
            const lastRenewalDate = new Date(nextDueDate);
            lastRenewalDate.setMonth(lastRenewalDate.getMonth() - 1);
            const lastRenewalTs = Math.floor(lastRenewalDate.getTime() / 1000);

            return {
              ...item,
              billing_service: {
                ...bs,
                next_due_date: lastRenewalTs,              // 展示上次续费日
                _next_due_original: bs.next_due_date,       // 原下次到期日备用
              },
              _localRenewalStatus: 'renewed',
              _localRemark: localStatus.remark || '',
              _localProjectGroups: localInfo.projectGroups || [],
              _localSupplier: localInfo.supplier || '',
              _source: 'ipxo_cache',
            };
          });

        // ── 来源 2：ip-data.json 中已过期且未取消的 IP 段 ────────────────────
        const cacheSegSet = new Set(
          (cache?.services?.data ?? []).map((item) => {
            const bs = item.billing_service;
            return bs?.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
          }).filter(Boolean)
        );

        const localRenewed = (localData.ipSegments || [])
          .filter((seg) => {
            if (!seg.segment || !seg.renewalDate || !seg.purchaseDate) return false;
            if (seg.renewalStatus === 'cancelled') return false;

            // 计算上次续费日：renewalDate（下次到期日）往前推1个月
            // 即上次续费 = renewalDate - 1 month
            const nextDueDate = new Date(seg.renewalDate);
            const lastRenewalDate = new Date(nextDueDate);
            lastRenewalDate.setMonth(lastRenewalDate.getMonth() - 1);
            const lastRenewalStr = lastRenewalDate.toISOString().slice(0, 10);

            // 购买日本身不算续费，上次续费日必须晚于购买日
            if (lastRenewalStr <= seg.purchaseDate) return false;

            // 上次续费日必须 <= 今天（已经发生的续费）
            if (lastRenewalStr > todayStr) return false;

            // 上次续费日在查询的天数范围内
            const lastRenewalTs = Math.floor(lastRenewalDate.getTime() / 1000);
            if (lastRenewalTs < startSec) return false;

            return true;
          })
          .map((seg) => {
            if (cacheSegSet.has(seg.segment)) return null;
            const [address, cidrStr] = seg.segment.split('/');
            const cidr = cidrStr ? parseInt(cidrStr) : null;

            // 显示的日期用"上次续费日"（renewalDate - 1 month）
            const nextDueDate = new Date(seg.renewalDate);
            const lastRenewalDate = new Date(nextDueDate);
            lastRenewalDate.setMonth(lastRenewalDate.getMonth() - 1);
            const lastRenewalTs = Math.floor(lastRenewalDate.getTime() / 1000);

            return {
              billing_service: {
                address, cidr,
                next_due_date: lastRenewalTs,   // 展示上次续费日
                _next_due_original: Math.floor(nextDueDate.getTime() / 1000), // 原下次到期日备用
                recurring_amount: seg.monthlyPrice ?? 0,
                status: 'active',
                uuid: seg.id,
              },
              market_service: { registry: '', uuid: '' },
              loa: [],
              _localRenewalStatus: 'renewed',
              _localRemark: seg.remark || '',
              _localProjectGroups: seg.projectGroups || [],
              _localSupplier: seg.supplier || '',
              _source: 'local_data',
            };
          })
          .filter(Boolean);

        const allRenewed = [...cacheRenewed, ...localRenewed]
          .sort((a, b) =>
            (a.billing_service?.next_due_date ?? 0) - (b.billing_service?.next_due_date ?? 0)
          );

        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, data: allRenewed, total: allRenewed.length, days }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });


    // IPXO 缓存刷新（全量拉取 active 服务 + 发票，写入 ipxo-cache.json）
    server.middlewares.use('/api/ipxo/cache/refresh', async (req, res, _next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' })); return; }
      try {
        const config = loadIpxoConfig();
        if (!config) { res.statusCode = 400; res.end(JSON.stringify({ success: false, message: 'IPXO 配置未设置' })); return; }

        // 复用 refreshIpxoCache() 统一刷新逻辑
        const { servicesCount, invoicesCount } = await refreshIpxoCache();
        const nowIso = new Date().toISOString();
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          cachedAt: nowIso,
          servicesCount,
          invoicesCount,
          message: `缓存刷新完成：${servicesCount} 条服务，${invoicesCount} 条发票`,
        }));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });

    // 获取缓存状态
    server.middlewares.use('/api/ipxo/cache/status', (req, res, _next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      try {
        const cache = loadIpxoCache();
        if (!cache) {
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, exists: false }));
          return;
        }
        const ageMs = Date.now() - new Date(cache.cachedAt).getTime();
        const ageMinutes = Math.floor(ageMs / 60000);
        const isExpired = ageMs > 6 * 3600 * 1000;
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          exists: true,
          cachedAt: cache.cachedAt,
          ageMinutes,
          isExpired,
          servicesCount: cache.services?.data?.length ?? 0,
          invoicesCount: cache.invoices?.data?.length ?? 0,
          upcomingCount: cache.upcoming?.length ?? 0,
        }));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });

    // IPXO 同步到 IP 管理（预览 + 执行）
    server.middlewares.use('/api/ipxo/sync', async (req, res, _next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }

      try {
        // 从缓存加载已租用服务
        const cache = loadIpxoCache();
        if (!cache?.services?.data?.length) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, message: '缓存为空，请先刷新缓存' }));
          return;
        }

        // 读取本地 ip-data.json
        let localData: any = { ipSegments: [] };
        if (fs.existsSync(dataFilePath)) {
          localData = JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'));
        }
        const localSegments: any[] = localData.ipSegments || [];
        const nowIso = new Date().toISOString();

        // 建立本地索引
        const localBySegment = new Map<string, any>();
        const localByIpxoUuid = new Map<string, any>();
        for (const s of localSegments) {
          localBySegment.set(s.segment, s);
          if (s.ipxoServiceUuid) localByIpxoUuid.set(s.ipxoServiceUuid, s);
        }

        // 缓存中 active 服务集合
        const cacheActiveSet = new Set<string>();
        for (const svc of cache.services.data) {
          const bs = svc.billing_service;
          if (bs?.address && bs.cidr != null && (bs.status || '').toLowerCase() === 'active') {
            cacheActiveSet.add(`${bs.address}/${bs.cidr}`);
          }
        }

        const toAdd: any[] = [];    // 缓存有，本地无
        const toCancel: any[] = []; // 本地有（ipxo来源），缓存无 active 记录

        // 1. 扫描缓存，找出本地缺少的
        for (const svc of cache.services.data) {
          const bs = svc.billing_service;
          if (!bs?.address || bs.cidr == null) continue;
          if ((bs.status || '').toLowerCase() !== 'active') continue;
          const segStr = `${bs.address}/${bs.cidr}`;
          const marketUuid = svc.market_service?.uuid || '';
          const existing = localBySegment.get(segStr) || localByIpxoUuid.get(marketUuid);
          if (!existing) {
            const nextDueDate = bs.next_due_date ? new Date(bs.next_due_date * 1000).toISOString().slice(0, 10) : '';
            toAdd.push({
              _action: 'add',
              segment: segStr,
              monthlyPrice: bs.recurring_amount ?? 0,
              nextDueDate,
              registry: svc.market_service?.registry ?? '',
              marketUuid,
              loa: svc.loa ?? [],
            });
          }
        }

        // 2. 扫描本地，找出缓存中已不存在的 active ipxo 来源记录
        for (const seg of localSegments) {
          if (!seg.segment) continue;
          // 只处理来自 IPXO 同步的记录，且当前非终态
          if (seg.syncSource !== 'ipxo_api') continue;
          if (['cancelled', 'refunded'].includes(seg.renewalStatus)) continue;
          if (cacheActiveSet.has(seg.segment)) continue; // 缓存中仍然存在，不处理
          // 取消日期 = 本地续费日前一天
          const renewalDate = seg.renewalDate;
          let cancellationDate = '';
          if (renewalDate) {
            const d = new Date(renewalDate);
            d.setDate(d.getDate() - 1);
            cancellationDate = d.toISOString().slice(0, 10);
          }
          toCancel.push({
            _action: 'cancel',
            segment: seg.segment,
            localId: seg.id,
            oldRenewalStatus: seg.renewalStatus,
            renewalDate,
            cancellationDate,
          });
        }

        // GET：仅预览
        if (req.method === 'GET') {
          res.statusCode = 200;
          res.end(JSON.stringify({
            success: true,
            preview: true,
            toAdd: toAdd.length,
            toCancel: toCancel.length,
            toAddItems: toAdd,
            toCancelItems: toCancel,
            cacheTotal: cache.services.data.length,
            localTotal: localSegments.length,
          }));
          return;
        }

        // POST：执行同步
        let addedCount = 0;
        let cancelledCount = 0;

        for (const item of toAdd) {
          const newSeg: any = {
            id: `ip-${Date.now()}-${Math.random()}-ipxo`,
            segment: item.segment,
            supplier: 'IPXO',
            asn: '',
            usageArea: '',
            purchaseDate: '',
            renewalDate: item.nextDueDate || '',
            cancellationDate: '',
            monthlyPrice: item.monthlyPrice,
            renewalStatus: 'not_renewed',
            projectGroups: [],
            serverLocations: [],
            blockedCountries: [],
            rateLimitedCountries: [],
            detectedCountries: [],
            history: [],
            syncSource: 'ipxo_api',
            ipxoServiceUuid: item.marketUuid,
            ipxoLastSyncAt: nowIso,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          localData.ipSegments.push(newSeg);
          addedCount++;
        }

        for (const item of toCancel) {
          const idx = localData.ipSegments.findIndex((s: any) => s.id === item.localId);
          if (idx === -1) continue;
          localData.ipSegments[idx].renewalStatus = 'cancelled';
          if (item.cancellationDate) {
            localData.ipSegments[idx].cancellationDate = item.cancellationDate;
          }
          localData.ipSegments[idx].ipxoLastSyncAt = nowIso;
          localData.ipSegments[idx].updatedAt = nowIso;
          cancelledCount++;
        }

        localData.exportTime = nowIso;
        fs.writeFileSync(dataFilePath, JSON.stringify(localData, null, 2), 'utf-8');

        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          preview: false,
          addedCount,
          cancelledCount,
          message: `同步完成：新增 ${addedCount} 条，取消 ${cancelledCount} 条`,
        }));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });

    // IPXO 同步到 IP 管理（预览 + 执行）
    server.middlewares.use('/api/ipxo/sync', async (req, res, _next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }

      try {
        const ipxoConfig = loadIpxoConfig();
        if (!ipxoConfig) { res.statusCode = 400; res.end(JSON.stringify({ success: false, message: 'IPXO 配置未设置' })); return; }

        // 读取本地 ip-data.json
        let localData: any = { ipSegments: [], projectGroups: [], suppliers: [], usageAreas: [], asns: [], asnGroups: [], version: '1.0.0' };
        if (fs.existsSync(dataFilePath)) {
          localData = JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'));
        }
        const localSegments: any[] = localData.ipSegments || [];

        // 建立本地 IP 段索引（segment 字符串 -> 记录）
        const localBySegment = new Map<string, any>();
        const localByIpxoUuid = new Map<string, any>();
        for (const s of localSegments) {
          localBySegment.set(s.segment, s);
          if (s.ipxoServiceUuid) localByIpxoUuid.set(s.ipxoServiceUuid, s);
        }

        // 拉取 IPXO 所有 active + terminated 服务（全量，翻页）
        const allIpxoServices: any[] = [];
        const activeSegments = new Set<string>(); // 记录 active 状态的 IP 段，防止 terminated 误覆盖
        for (const status of ['active', 'terminated']) {
          let page = 1;
          let lastPage = 1;
          do {
            const result = await callIpxoApi(
              `/billing/v1/{tenant_uuid}/market/ipv4/services?page=${page}&per_page=100&status=${status}`
            );
            if (result.status !== 200) break;
            const body = result.body;
            const items: any[] = body?.data ?? [];
            lastPage = body?.meta?.last_page ?? 1;
            for (const item of items) {
              item._ipxoStatus = status;
              allIpxoServices.push(item);
              if (status === 'active') {
                const bs = item.billing_service;
                if (bs?.address && bs.cidr != null) {
                  activeSegments.add(`${bs.address}/${bs.cidr}`);
                }
              }
            }
            page++;
          } while (page <= lastPage);
        }

        const nowIso = new Date().toISOString();
        const toAdd: any[] = [];      // IPXO 有，本地没有
        const toUpdate: any[] = [];   // 本地有，状态需更新

        for (const svc of allIpxoServices) {
          const bs = svc.billing_service;
          if (!bs?.address || bs.cidr == null) continue;
          const segStr = `${bs.address}/${bs.cidr}`;
          const marketUuid = svc.market_service?.uuid || '';
          const billingUuid = bs.uuid || '';
          const ipxoStatus = svc._ipxoStatus as string;
          const nextDueDate = bs.next_due_date ? new Date(bs.next_due_date * 1000).toISOString().slice(0, 10) : '';

          const existing = localBySegment.get(segStr) || localByIpxoUuid.get(marketUuid);

          if (!existing) {
            // 新增：IPXO 有，本地无
            if (ipxoStatus !== 'active') continue; // 已终止的不新增
            toAdd.push({
              _action: 'add',
              segment: segStr,
              ipxoStatus,
              monthlyPrice: bs.recurring_amount ?? 0,
              nextDueDate,
              registry: svc.market_service?.registry ?? '',
              marketUuid,
              billingUuid,
              loa: svc.loa ?? [],
            });
          } else {
            // 已存在：检查是否需要更新 renewalStatus
            const localStatus = existing.renewalStatus;
            if (
              ipxoStatus === 'terminated' &&
              !activeSegments.has(segStr) && // 在 active 列表中出现过的不处理
              (localStatus === 'renewed' || localStatus === 'not_renewed')
            ) {
              toUpdate.push({
                _action: 'update_status',
                segment: segStr,
                localId: existing.id,
                oldRenewalStatus: localStatus,
                newRenewalStatus: 'cancelled',
                ipxoStatus,
                monthlyPrice: bs.recurring_amount ?? 0,
                nextDueDate,
                marketUuid,
              });
            }
            // 同步 ipxoServiceUuid（如果之前没有）
            if (!existing.ipxoServiceUuid && marketUuid) {
              toUpdate.push({
                _action: 'update_uuid',
                segment: segStr,
                localId: existing.id,
                marketUuid,
              });
            }
          }
        }

        // GET：仅预览，不执行
        if (req.method === 'GET') {
          const reqUrl2 = new URL(req.url || '/', 'http://localhost');
          const mode = reqUrl2.searchParams.get('mode') || 'all'; // all | add_only | status_only
          const filteredAdd = mode === 'status_only' ? [] : toAdd;
          const filteredUpdate = mode === 'add_only' ? [] : toUpdate.filter(i => i._action === 'update_status');
          const uuidUpdates = toUpdate.filter(i => i._action === 'update_uuid');
          res.statusCode = 200;
          res.end(JSON.stringify({
            success: true,
            preview: true,
            mode,
            toAdd: filteredAdd.length,
            toUpdate: filteredUpdate.length,
            toUuidUpdate: uuidUpdates.length,
            toAddItems: filteredAdd,
            toUpdateItems: [...filteredUpdate, ...uuidUpdates],
            ipxoTotal: allIpxoServices.length,
            localTotal: localSegments.length,
          }));
          return;
        }

        // POST：执行同步
        const reqUrl3 = new URL(req.url || '/', 'http://localhost');
        const syncMode = reqUrl3.searchParams.get('mode') || 'all'; // all | add_only | status_only
        let addedCount = 0;
        let updatedCount = 0;

        // 新增记录
        if (syncMode !== 'status_only') {
        for (const item of toAdd) {
          const newId = `ip-${Date.now()}-${Math.random()}-ipxo`;
          const newSeg: any = {
            id: newId,
            segment: item.segment,
            supplier: 'IPXO',
            asn: '',
            usageArea: '',
            purchaseDate: '',
            renewalDate: item.nextDueDate || '',
            cancellationDate: '',
            monthlyPrice: item.monthlyPrice,
            renewalStatus: 'not_renewed',
            projectGroups: [],
            serverLocations: [],
            blockedCountries: [],
            rateLimitedCountries: [],
            detectedCountries: [],
            history: [],
            syncSource: 'ipxo_api',
            ipxoServiceUuid: item.marketUuid,
            ipxoLastSyncAt: nowIso,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          localData.ipSegments.push(newSeg);
          addedCount++;
        }
        } // end if add_only

        // 更新记录（按 localId 合并，每条 IP 段只写一次）
        if (syncMode !== 'add_only') {
          // 按 localId 归并所有待更新动作
          const updateMap = new Map<string, any>();
          for (const item of toUpdate) {
            const existing2 = updateMap.get(item.localId);
            if (!existing2) {
              updateMap.set(item.localId, { ...item });
            } else {
              // 合并：status 优先，uuid 可补充
              if (item._action === 'update_status') {
                existing2._action = 'update_status';
                existing2.newRenewalStatus = item.newRenewalStatus;
              }
              if (item.marketUuid) existing2.marketUuid = item.marketUuid;
            }
          }

          for (const item of Array.from(updateMap.values())) {
            const idx = localData.ipSegments.findIndex((s: any) => s.id === item.localId);
            if (idx === -1) continue;
            if (item._action === 'update_status') {
              // 仅当本地状态真的不同时才写（差异更新）
              if (localData.ipSegments[idx].renewalStatus !== item.newRenewalStatus) {
                localData.ipSegments[idx].renewalStatus = item.newRenewalStatus;
                updatedCount++;
              }
            }
            if (item.marketUuid && localData.ipSegments[idx].ipxoServiceUuid !== item.marketUuid) {
              localData.ipSegments[idx].ipxoServiceUuid = item.marketUuid;
            }
            localData.ipSegments[idx].ipxoLastSyncAt = nowIso;
            localData.ipSegments[idx].updatedAt = nowIso;
          }
        } // end if status_only

        localData.exportTime = nowIso;
        fs.writeFileSync(dataFilePath, JSON.stringify(localData, null, 2), 'utf-8');

        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          preview: false,
          syncMode,
          addedCount,
          updatedCount,
          message: `同步完成：新增 ${addedCount} 条，更新状态 ${updatedCount} 条`,
        }));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });

    // ─── 已租用IP tab：基于缓存快速同步到本地IP管理 ──────────────────────────
    server.middlewares.use('/api/ipxo/services/sync-leased', async (req: any, res: any, _next: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }

      try {
        const cache = loadIpxoCache();
        if (!cache?.services?.data?.length) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, message: '缓存为空，请先刷新缓存' }));
          return;
        }

        let localData: any = { ipSegments: [] };
        if (fs.existsSync(dataFilePath)) {
          localData = JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'));
        }
        const localSegments: any[] = localData.ipSegments || [];
        const nowIso = new Date().toISOString();

        const localBySegment = new Map<string, any>();
        const localByIpxoUuid = new Map<string, any>();
        for (const s of localSegments) {
          localBySegment.set(s.segment, s);
          if (s.ipxoServiceUuid) localByIpxoUuid.set(s.ipxoServiceUuid, s);
        }

        // 缓存中 active 服务的 segment 集合
        const cacheActiveSet = new Set<string>();
        for (const svc of cache.services.data) {
          const bs = svc.billing_service;
          if (bs?.address && bs.cidr != null && (bs.status || '').toLowerCase() === 'active') {
            cacheActiveSet.add(`${bs.address}/${bs.cidr}`);
          }
        }

        const toAdd: any[] = [];
        const toCancel: any[] = [];

        // 1. 缓存有，本地无 → 新增
        for (const svc of cache.services.data) {
          const bs = svc.billing_service;
          if (!bs?.address || bs.cidr == null) continue;
          if ((bs.status || '').toLowerCase() !== 'active') continue;
          const segStr = `${bs.address}/${bs.cidr}`;
          const marketUuid = svc.market_service?.uuid || '';
          const existing = localBySegment.get(segStr) || localByIpxoUuid.get(marketUuid);
          if (!existing) {
            const nextDueDate = bs.next_due_date ? new Date(bs.next_due_date * 1000).toISOString().slice(0, 10) : '';
            toAdd.push({
              _action: 'add',
              segment: segStr,
              monthlyPrice: bs.recurring_amount ?? 0,
              nextDueDate,
              registry: svc.market_service?.registry ?? '',
              marketUuid,
              loa: svc.loa ?? [],
            });
          }
        }

        // 2. 本地有（ipxo_api来源，非终态），缓存中已无 active 记录 → 取消
        for (const seg of localSegments) {
          if (!seg.segment) continue;
          if (seg.syncSource !== 'ipxo_api') continue;
          if (['cancelled', 'refunded'].includes(seg.renewalStatus)) continue;
          if (cacheActiveSet.has(seg.segment)) continue;
          // 取消日期 = 续费日前一天
          let cancellationDate = '';
          if (seg.renewalDate) {
            const d = new Date(seg.renewalDate);
            d.setDate(d.getDate() - 1);
            cancellationDate = d.toISOString().slice(0, 10);
          }
          toCancel.push({
            _action: 'cancel',
            segment: seg.segment,
            localId: seg.id,
            oldRenewalStatus: seg.renewalStatus,
            renewalDate: seg.renewalDate || '',
            cancellationDate,
          });
        }

        if (req.method === 'GET') {
          res.statusCode = 200;
          res.end(JSON.stringify({
            success: true,
            preview: true,
            toAdd: toAdd.length,
            toCancel: toCancel.length,
            toAddItems: toAdd,
            toCancelItems: toCancel,
            cacheTotal: cache.services.data.length,
            localTotal: localSegments.length,
          }));
          return;
        }

        let addedCount = 0;
        let cancelledCount = 0;

        for (const item of toAdd) {
          const newSeg: any = {
            id: `ip-${Date.now()}-${Math.random()}-ipxo`,
            segment: item.segment,
            supplier: 'IPXO',
            asn: '',
            usageArea: '',
            purchaseDate: '',
            renewalDate: item.nextDueDate || '',
            cancellationDate: '',
            monthlyPrice: item.monthlyPrice,
            renewalStatus: 'not_renewed',
            projectGroups: [],
            serverLocations: [],
            blockedCountries: [],
            rateLimitedCountries: [],
            detectedCountries: [],
            history: [],
            syncSource: 'ipxo_api',
            ipxoServiceUuid: item.marketUuid,
            ipxoLastSyncAt: nowIso,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          localData.ipSegments.push(newSeg);
          addedCount++;
        }

        for (const item of toCancel) {
          const idx = localData.ipSegments.findIndex((s: any) => s.id === item.localId);
          if (idx === -1) continue;
          localData.ipSegments[idx].renewalStatus = 'cancelled';
          if (item.cancellationDate) {
            localData.ipSegments[idx].cancellationDate = item.cancellationDate;
          }
          localData.ipSegments[idx].ipxoLastSyncAt = nowIso;
          localData.ipSegments[idx].updatedAt = nowIso;
          cancelledCount++;
        }

        localData.exportTime = nowIso;
        fs.writeFileSync(dataFilePath, JSON.stringify(localData, null, 2), 'utf-8');

        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          preview: false,
          addedCount,
          cancelledCount,
          message: `同步完成：新增 ${addedCount} 条，取消 ${cancelledCount} 条`,
        }));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });

    // IPXO 单个服务的 LOA 详情
    server.middlewares.use('/api/ipxo/service-loa', async (req, res, _next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      try {
        const config = loadIpxoConfig();
        if (!config) { res.statusCode = 400; res.end(JSON.stringify({ success: false, message: 'IPXO 配置未设置' })); return; }
        const reqUrl = new URL(req.url || '/', 'http://localhost');
        const serviceUuid = reqUrl.searchParams.get('service_uuid');
        if (!serviceUuid) { res.statusCode = 400; res.end(JSON.stringify({ success: false, message: 'service_uuid 参数缺失' })); return; }
        const result = await callIpxoApi(`/billing/v1/{tenant_uuid}/market/ipv4/services/${serviceUuid}/loa`);
        res.statusCode = result.status === 200 ? 200 : result.status ?? 500;
        res.end(JSON.stringify({ success: result.status === 200, data: result.body }));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });

    // ─── 邮件通知配置 GET/POST ───────────────────────────────────────────────
    server.middlewares.use('/api/notify/config', (req: any, res: any, _next: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }

      if (req.method === 'GET') {
        const cfg = loadNotifyConfig();
        if (!cfg) {
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, data: null }));
          return;
        }
        // 隐藏 App Password 明文，只返回是否已配置
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          data: {
            gmailUser: cfg.gmailUser,
            gmailAppPasswordSet: !!cfg.gmailAppPassword,
            recipients: cfg.recipients,
            notifyDaysAhead: cfg.notifyDaysAhead,
            enabled: cfg.enabled,
            scheduledEnabled: cfg.scheduledEnabled ?? false,
            notifyTime: cfg.notifyTime || '09:00',
            notifyIntervalHours: cfg.notifyIntervalHours || 0,
            lastSentDate: cfg.lastSentDate || null,
            lastSentAt: cfg.lastSentAt || null,
            googleChatWebhook: cfg.googleChatWebhook || '',
            backupEnabled: cfg.backupEnabled !== false, // 默认 true
            lastBackupAt: cfg.lastBackupAt || null,
            lastBackupDate: cfg.lastBackupDate || null,
            weeklyReportEnabled: cfg.weeklyReportEnabled !== false, // 默认 true
            lastWeeklyReportDate: cfg.lastWeeklyReportDate || null,
            serverBaseUrl: cfg.serverBaseUrl || '',
          },
        }));
        return;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: any) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const payload = JSON.parse(body);
            const existing = loadNotifyConfig();
            const newCfg: NotifyConfig = {
              gmailUser: payload.gmailUser || '',
              // 如果前端没有传新密码（空字符串），保留原有密码
              gmailAppPassword: payload.gmailAppPassword || existing?.gmailAppPassword || '',
              recipients: Array.isArray(payload.recipients) ? payload.recipients : (payload.recipients || '').split(',').map((s: string) => s.trim()).filter(Boolean),
              notifyDaysAhead: Number(payload.notifyDaysAhead) || 7,
              enabled: payload.enabled !== false,
              scheduledEnabled: payload.scheduledEnabled === true,
              notifyTime: payload.notifyTime || existing?.notifyTime || '09:00',
              notifyIntervalHours: Number(payload.notifyIntervalHours) || 0,
              lastSentDate: existing?.lastSentDate,
              lastSentAt: existing?.lastSentAt,
              googleChatWebhook: payload.googleChatWebhook || existing?.googleChatWebhook || '',
              backupEnabled: payload.backupEnabled !== false,
              lastBackupAt: existing?.lastBackupAt,
              lastBackupDate: existing?.lastBackupDate,
              weeklyReportEnabled: payload.weeklyReportEnabled !== false,
              lastWeeklyReportDate: existing?.lastWeeklyReportDate,
              serverBaseUrl: payload.serverBaseUrl || existing?.serverBaseUrl || '',
            };
            saveNotifyConfig(newCfg);
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true }));
          } catch (e: any) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, message: e.message }));
          }
        });
        return;
      }

      res.statusCode = 405;
      res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    });

    // ─── exports 目录静态文件下载 ─────────────────────────────────────────
    server.middlewares.use('/exports', (req: any, res: any, _next: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      try {
        // req.url 形如 /IP段周报-2026-07-06.xlsx
        const rawName = decodeURIComponent((req.url || '').replace(/^\//, '').split('?')[0]);
        if (!rawName || rawName.includes('..') || rawName.includes('/')) {
          res.statusCode = 400; res.end('Bad Request'); return;
        }
        const exportsDir = path.resolve(__dirname, 'exports');
        const filePath = path.join(exportsDir, rawName);
        if (!fs.existsSync(filePath)) { res.statusCode = 404; res.end('Not Found'); return; }
        const stat = fs.statSync(filePath);
        const ext = path.extname(rawName).toLowerCase();
        const mime = ext === '.xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : ext === '.csv' ? 'text/csv' : 'application/octet-stream';
        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Length', stat.size);
        // 英文文件名时自动映射为中文显示名
        const displayName = rawName.startsWith('weekly-report-')
          ? rawName.replace('weekly-report-', 'IP段周报-')
          : rawName;
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(displayName)}`);
        res.statusCode = 200;
        fs.createReadStream(filePath).pipe(res);
      } catch (e: any) {
        res.statusCode = 500; res.end('Server Error');
      }
    });

    // ─── 手动触发周报发送 ────────────────────────────────────────────────
    server.middlewares.use('/api/notify/send-weekly-report', async (req: any, res: any, _next: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' })); return; }
      try {
        await sendWeeklyReport();
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, message: '周报已发送' }));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });

    // ─── 发送续费提醒邮件 ────────────────────────────────────────────────────
    server.middlewares.use('/api/notify/send', async (req: any, res: any, _next: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' })); return; }

      try {
        const cfg = loadNotifyConfig();
        if (!cfg || !cfg.enabled) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, message: '通知已禁用，请在通知配置中启用' }));
          return;
        }
        // 读取请求体（前端可传入自定义 items/renewedItems，否则后端自动从缓存获取）
        let body = '';
        await new Promise<void>((resolve) => {
          req.on('data', (chunk: any) => { body += chunk.toString(); });
          req.on('end', resolve);
        });

        let customItems: any[] | undefined;
        let renewedItems: any[] | undefined;
        if (body) {
          try {
            const parsed = JSON.parse(body);
            if (Array.isArray(parsed.items) && parsed.items.length > 0) {
              customItems = parsed.items;
            }
            if (Array.isArray(parsed.renewedItems) && parsed.renewedItems.length > 0) {
              renewedItems = parsed.renewedItems;
            }
          } catch (_) { /* ignore */ }
        }

        const result = await sendRenewalNotifyEmail(cfg, customItems, renewedItems);
        res.statusCode = result.success ? 200 : 400;
        res.end(JSON.stringify(result));
      } catch (e: any) {
        console.error('[Notify] 发送邮件失败:', e);
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, message: `发送失败：${e.message}` }));
      }
    });

    // ─── 查询定时任务状态 ────────────────────────────────────────────────────
    server.middlewares.use('/api/notify/schedule/status', (req: any, res: any, _next: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }

      const cfg = loadNotifyConfig();
      const intervalHours = cfg?.notifyIntervalHours || 0;
      // 计算下次发送时间
      let nextSendIn: string | null = null;
      if (cfg?.enabled && cfg?.scheduledEnabled) {
        if (intervalHours > 0) {
          const lastSentAt = cfg.lastSentAt || 0;
          const nextMs = lastSentAt + intervalHours * 3600 * 1000;
          const diffMs = nextMs - Date.now();
          if (diffMs > 0) {
            const h = Math.floor(diffMs / 3600000);
            const m = Math.floor((diffMs % 3600000) / 60000);
            nextSendIn = h > 0 ? `${h} 小时 ${m} 分钟后` : `${m} 分钟后`;
          } else {
            nextSendIn = '即将发送';
          }
        }
      }
      res.statusCode = 200;
      res.end(JSON.stringify({
        success: true,
        scheduledEnabled: cfg?.scheduledEnabled ?? false,
        notifyTime: cfg?.notifyTime || '09:00',
        notifyIntervalHours: intervalHours,
        lastSentDate: cfg?.lastSentDate || null,
        lastSentAt: cfg?.lastSentAt || null,
        nextSendIn,
        enabled: cfg?.enabled ?? false,
      }));
    });


    // ─── 近期续费：读取全量独立状态文件（供统计图使用） ────────────────────────
    server.middlewares.use('/api/ipxo/upcoming-status', (req: any, res: any, _next: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      const store = loadUpcomingStatus();
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, data: store }));
    });

    // ─── IPXO 官网 IP 段列表（来自 ipxo-cache.json services.data，供统计图使用） ──
    server.middlewares.use('/api/ipxo/services-list', (req: any, res: any, _next: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      try {
        const cache = JSON.parse(fs.readFileSync(ipxoCachePath, 'utf-8'));
        const data: any[] = cache?.services?.data || [];
        // 读取 ip-data.json，补充 renewalStatus、remark 等本地信息
        const localData = JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'));
        const localSegs: any[] = localData?.ipSegments || [];
        const localMap = new Map<string, any>();
        localSegs.forEach((s: any) => { if (s.segment) localMap.set(s.segment, s); });
        // 读取 ipxo-upcoming-status.json 补充备注
        const upcomingStore = loadUpcomingStatus();
        const result = data.map((item: any) => {
          const bs = item.billing_service;
          const segKey = bs?.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
          const localSeg = segKey ? localMap.get(segKey) : null;
          return {
            segment: segKey,
            address: bs?.address,
            cidr: bs?.cidr,
            status: bs?.status,
            nextDueDate: bs?.next_due_date,
            recurringAmount: bs?.recurring_amount,
            renewalStatus: localSeg?.renewalStatus || null,
            renewalDate: localSeg?.renewalDate || null,
            purchaseDate: localSeg?.purchaseDate || null,
            remark: upcomingStore[segKey]?.remark || localSeg?.remark || '',
            projectGroups: localSeg?.projectGroups || [],
            monthlyPrice: localSeg?.monthlyPrice ?? bs?.recurring_amount ?? null,
            supplier: localSeg?.supplier || 'IPXO',
          };
        });
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, data: result, total: result.length, cachedAt: cache?.cachedAt || null }));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });

    // ─── 近期续费：批量设置 IP 段的续费状态（写独立状态文件，不影响 IP 段管理） ──
    server.middlewares.use('/api/ipxo/upcoming/set-renewal-status', (req: any, res: any, _next: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' })); return; }

      let body = '';
      req.on('data', (chunk: any) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { segments, renewalStatus } = JSON.parse(body);
          if (!Array.isArray(segments) || segments.length === 0) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, message: '未指定 IP 段' }));
            return;
          }
          const validStatuses = ['not_renewed', 'renewed', 'cancelled', 'refunded'];
          if (!validStatuses.includes(renewalStatus)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, message: `无效的续费状态: ${renewalStatus}` }));
            return;
          }
          const store = loadUpcomingStatus();
          const nowIso = new Date().toISOString();
          for (const seg of segments) {
            if (!store[seg]) store[seg] = {};
            store[seg].renewalStatus = renewalStatus;
            store[seg].updatedAt = nowIso;
          }
          saveUpcomingStatus(store);
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, updatedCount: segments.length }));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, message: e.message }));
        }
      });
    });

    // ─── 近期续费：设置单个 IP 段的备注（写独立状态文件，不影响 IP 段管理） ────
    server.middlewares.use('/api/ipxo/upcoming/set-remark', (req: any, res: any, _next: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
      if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' })); return; }

      let body = '';
      req.on('data', (chunk: any) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { segment, remark } = JSON.parse(body);
          if (!segment) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, message: '未指定 IP 段' }));
            return;
          }
          const store = loadUpcomingStatus();
          if (!store[segment]) store[segment] = {};
          store[segment].remark = remark ?? '';
          store[segment].updatedAt = new Date().toISOString();
          saveUpcomingStatus(store);

          // ── 同步备注到 ip-data.json ────────────────────────────────────────
          try {
            if (fs.existsSync(dataFilePath)) {
              const localData = JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'));
              const segments: any[] = localData?.ipSegments || [];
              const idx = segments.findIndex((s: any) => s.segment === segment);
              if (idx !== -1) {
                segments[idx].remark = remark ?? '';
                fs.writeFileSync(dataFilePath, JSON.stringify(localData, null, 2), 'utf-8');
              }
            }
          } catch (syncErr) {
            console.error('[Sync] 同步备注到 ip-data 失败:', syncErr);
          }
          // ───────────────────────────────────────────────────────────────────

          res.statusCode = 200;
          res.end(JSON.stringify({ success: true }));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, message: e.message }));
        }
      });
    });


    // ─── ASN 备用组数据 GET/POST ─────────────────────────────────────────────
    server.middlewares.use('/api/asn-standby-groups', (req: any, res: any, _next: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }

      if (req.method === 'GET') {
        try {
          if (fs.existsSync(asnStandbyFilePath)) {
            const data = JSON.parse(fs.readFileSync(asnStandbyFilePath, 'utf-8'));
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true, data }));
          } else {
            // 初始化空结构
            const init = { A: { items: [] }, B: { items: [] } };
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true, data: init }));
          }
        } catch (e: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, message: e.message }));
        }
        return;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: any) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const payload = JSON.parse(body);
            fs.writeFileSync(asnStandbyFilePath, JSON.stringify(payload, null, 2), 'utf-8');
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true }));
          } catch (e: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, message: e.message }));
          }
        });
        return;
      }

      res.statusCode = 405;
      res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    });

  // ══════════════════════════════════════════════════════════════════════════
  // ─── ZEN 宣告 API 接口 ────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════

  // 工具函数：解析简单 key=value 格式的 .env 文件
  function parseEnvFile(filePath: string): Record<string, string> {
    const result: Record<string, string> = {};
    try {
      if (!fs.existsSync(filePath)) return result;
      for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 1) continue;
        result[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
      }
    } catch { /* ignore */ }
    return result;
  }

  // ZEN-Auto-Announce 项目的 .env 文件路径（相邻目录，优先读 web/.env.local 再读根目录 .env）
  const zenEnvPaths = [
    path.resolve(__dirname, '..', '..', 'ZEN-Auto-Announce', 'web', '.env.local'),
    path.resolve(__dirname, '..', '..', 'ZEN-Auto-Announce', '.env'),
  ];

  /**
   * 启动时一次性：若 zen-config.json 尚未配置凭据，
   * 从 ZEN-Auto-Announce .env 文件读取并写入 zen-config.json。
   * 之后所有运行时读取均只走 zen-config.json，不再读 .env。
   */
  function importZenEnvOnce(): void {
    try {
      // 若已有完整配置，直接跳过
      if (fs.existsSync(zenConfigFilePath)) {
        const existing = JSON.parse(fs.readFileSync(zenConfigFilePath, 'utf-8'));
        if (existing?.accessKeyId && existing?.accessKeyPassword) return;
      }
      // 从 .env 文件读取
      for (const envPath of zenEnvPaths) {
        const env = parseEnvFile(envPath);
        const ak = env['ZENLAYER_ACCESS_KEY_ID']?.trim();
        const sk = env['ZENLAYER_ACCESS_KEY_PASSWORD']?.trim();
        if (ak && sk) {
          const cfg: Record<string, any> = {
            accessKeyId: ak,
            accessKeyPassword: sk,
            apiVersion: env['ZENLAYER_API_VERSION']?.trim() || '2022-11-20',
            bandwidthClusterId: env['ZENLAYER_BANDWIDTH_CLUSTER_ID']?.trim() || '',
            importedFrom: envPath,
            importedAt: new Date().toISOString(),
          };
          fs.writeFileSync(zenConfigFilePath, JSON.stringify(cfg, null, 2), 'utf-8');
          console.log(`[ZEN] 已从 ${envPath} 导入凭据并写入 zen-config.json`);
          return;
        }
      }
    } catch (e) {
      console.error('[ZEN] 导入 .env 凭据失败:', e);
    }
  }

  // 工具函数：仅从 zen-config.json 读取配置（启动后不再读 .env）
  function loadZenConfig(): any {
    try {
      if (fs.existsSync(zenConfigFilePath)) {
        return JSON.parse(fs.readFileSync(zenConfigFilePath, 'utf-8'));
      }
    } catch { /* ignore */ }
    return null;
  }
  function saveZenConfig(cfg: any): void {
    fs.writeFileSync(zenConfigFilePath, JSON.stringify(cfg, null, 2), 'utf-8');
  }
  function getZenCreds(): { ak: string; sk: string } {
    const cfg = loadZenConfig();
    if (!cfg?.accessKeyId || !cfg?.accessKeyPassword) throw new Error('ZEN API 凭据未配置，请在「ZEN 宣告」配置页设置 Access Key');
    return { ak: cfg.accessKeyId, sk: cfg.accessKeyPassword };
  }
  function zenApiVersion(): string { return loadZenConfig()?.apiVersion || '2022-11-20'; }

  // 工具函数：从动态加载的 zen lib 模块执行 NDJSON 流并写入响应
  async function streamNdjson(res: any, gen: AsyncGenerator<any>): Promise<void> {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.statusCode = 200;
    const write = (obj: any) => { try { res.write(JSON.stringify(obj) + '\n'); } catch { /* ignore */ } };
    write({ type: 'log', level: 'info', message: '流已建立…' });
    try {
      for await (const ev of gen) write(ev);
    } catch (e: any) {
      write({ type: 'error', message: e?.message || String(e) });
    } finally {
      res.end();
    }
  }

  // 通用 CORS + JSON 响应头设置
  function setCorsJson(res: any): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');
  }
  async function readBody(req: any): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (c: any) => { body += c.toString(); });
      req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('无效 JSON')); } });
      req.on('error', reject);
    });
  }

  // ─── GET /api/zen/config ─── 读取 ZEN 配置
  server.middlewares.use('/api/zen/config', (req: any, res: any, _next: any) => {
    setCorsJson(res);
    if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
    if (req.method === 'GET') {
      const cfg = loadZenConfig() || {};
      const fromFile = fs.existsSync(zenConfigFilePath) && (() => { try { const c = JSON.parse(fs.readFileSync(zenConfigFilePath, 'utf-8')); return !!(c?.accessKeyId && c?.accessKeyPassword); } catch { return false; } })();
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, config: { accessKeyId: cfg.accessKeyId || '', apiVersion: cfg.apiVersion || '2022-11-20', bandwidthClusterId: cfg.bandwidthClusterId || '', eipBandwidthMbps: cfg.eipBandwidthMbps || 10000, createEipsMaxAmount: cfg.createEipsMaxAmount || 100, configured: !!(cfg.accessKeyId && cfg.accessKeyPassword), source: cfg.importedFrom ? 'env' : (fromFile ? 'config' : 'none') } }));
      return;
    }
    if (req.method === 'POST') {
      readBody(req).then((body: any) => {
        const cfg = loadZenConfig() || {};
        if (body.accessKeyId !== undefined) cfg.accessKeyId = body.accessKeyId;
        if (body.accessKeyPassword !== undefined) cfg.accessKeyPassword = body.accessKeyPassword;
        if (body.apiVersion !== undefined) cfg.apiVersion = body.apiVersion;
        if (body.bandwidthClusterId !== undefined) cfg.bandwidthClusterId = body.bandwidthClusterId;
        if (body.eipBandwidthMbps !== undefined) cfg.eipBandwidthMbps = Number(body.eipBandwidthMbps) || 10000;
        if (body.createEipsMaxAmount !== undefined) cfg.createEipsMaxAmount = Number(body.createEipsMaxAmount) || 100;
        saveZenConfig(cfg);
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
      }).catch((e: any) => { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: e.message })); });
      return;
    }
    res.statusCode = 405; res.end(JSON.stringify({ ok: false }));
  });

  // ─── GET /api/zen/meta/byoip ─── 宣告元数据：ZEC regionOptions + BMC 可用区 + 公网 VLAN
  server.middlewares.use('/api/zen/meta/byoip', async (req: any, res: any, _next: any) => {
    setCorsJson(res);
    if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
    if (req.method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ ok: false })); return; }
    try {
      const { ak, sk } = getZenCreds();
      const ver = zenApiVersion();
      const { fetchBmcByoipZones, fetchBmcPublicVirtualInterfaces, fetchByoipRegionRows } = await import('./src/lib/zen/region-meta.js' as any);
      const { zecCall, unwrapResponse } = await import('./src/lib/zen/zenlayer.js' as any);
      // 并行获取：ZEC 宣告地域、BMC BYOIP 可用区、公网 VLAN
      const [regionRows, zones, pvis] = await Promise.all([
        fetchByoipRegionRows(ak, sk, ver).catch(() => []),
        fetchBmcByoipZones(ak, sk, ver).catch(() => []),
        fetchBmcPublicVirtualInterfaces(ak, sk, ver).catch(() => []),
      ]);
      // 构建 ZEC regionOptions（需要拿地域标签）
      const regionIds: string[] = (regionRows as any[]).map((r: any) => r.regionId).filter(Boolean);
      let regionLabels: Record<string, string> = {};
      if (regionIds.length > 0) {
        try {
          const labelData = await zecCall('DescribeSubnetRegions', { regionIds }, ak, sk, ver);
          const inner = unwrapResponse(labelData);
          const set = (inner.regionSet as any[]) || [];
          for (const r of set) {
            if (r.regionId) regionLabels[r.regionId] = r.regionTitle || r.regionName || r.regionId;
          }
        } catch { /* ignore */ }
      }
      const networksForRegion: Record<string, string[]> = {};
      // 按 regionId 去重，合并 network 列表
      const regionMap = new Map<string, string[]>();
      for (const r of (regionRows as any[])) {
        if (!r.regionId) continue;
        const nets = regionMap.get(r.regionId) || [];
        if (r.network && !nets.includes(r.network)) nets.push(r.network);
        regionMap.set(r.regionId, nets);
      }
      for (const [rid, nets] of regionMap) networksForRegion[rid] = nets;
      const regionOptions = [...regionMap.keys()].map(rid => {
        const city = regionLabels[rid] || rid;
        return { regionId: rid, label: `${city}（${rid}）` };
      });
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, regionOptions, networksForRegion, zones, publicVirtualInterfaces: pvis }));
    } catch (e: any) {
      res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });

  // ─── GET /api/zen/meta/asns ─── 获取已授权 ASN 列表（静默探测）
  server.middlewares.use('/api/zen/meta/asns', async (req: any, res: any, _next: any) => {
    setCorsJson(res);
    if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
    if (req.method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ ok: false })); return; }
    const hint = '若自动拉取失败，请直接输入 ASN 数字（与控制台一致）';
    const url = new URL(req.url || '/', 'http://localhost');
    const probe = url.searchParams.get('probe') === '1';
    if (!probe) { res.statusCode = 200; res.end(JSON.stringify({ ok: true, source: null, asns: [], hint })); return; }
    try {
      const { ak, sk } = getZenCreds();
      const { zecCall, unwrapResponse } = await import('./src/lib/zen/zenlayer.js' as any);
      const data = await zecCall('DescribeAuthorizedAsns', {}, ak, sk, zenApiVersion(), 20000);
      const inner = unwrapResponse(data);
      const out: any[] = [];
      for (const arr of [inner.dataSet, inner.asnSet, inner.asns, inner.authorizedAsns, inner.list]) {
        if (!Array.isArray(arr)) continue;
        for (const r of arr) {
          const asn = r.asn ?? r.asnNumber ?? r.ASN ?? r.customerAsn;
          const num = typeof asn === 'number' ? asn : parseInt(String(asn), 10);
          if (!Number.isFinite(num) || num <= 0) continue;
          out.push({ value: num, label: `${num} — ${String(r.name ?? r.asnName ?? r.organization ?? `AS${num}`)}` });
        }
      }
      const seen = new Set<number>(); const asns = out.filter(x => { if (seen.has(x.value)) return false; seen.add(x.value); return true; }).sort((a, b) => a.value - b.value);
      res.statusCode = 200; res.end(JSON.stringify({ ok: true, source: asns.length ? 'DescribeAuthorizedAsns' : null, asns, hint: asns.length ? undefined : hint }));
    } catch {
      res.statusCode = 200; res.end(JSON.stringify({ ok: true, source: null, asns: [], hint }));
    }
  });

  // ─── POST /api/zen/cidr/inspect ─── 检查 CIDR 是否已存在
  server.middlewares.use('/api/zen/cidr/inspect', async (req: any, res: any, _next: any) => {
    setCorsJson(res);
    if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
    if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ ok: false })); return; }
    try {
      const body = await readBody(req);
      const raw = body?.items;
      if (!Array.isArray(raw) || !raw.length) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: '缺少 items' })); return; }
      const { ak, sk } = getZenCreds();
      const ver = zenApiVersion();
      const { describeCidrRow } = await import('./src/lib/zen/describe-cidr.js' as any);
      const { parseUserIpSegment, normalizeIpv4Cidr } = await import('./src/lib/zen/iputil.js' as any);
      const seen = new Set<string>(); const results: any[] = [];
      for (const x of raw) {
        if (!x || typeof x !== 'object') continue;
        const cidrBlock = String(x.cidrBlock ?? '').trim();
        const regionId = String(x.regionId ?? '').trim();
        if (!cidrBlock || !regionId) continue;
        const norm = parseUserIpSegment(cidrBlock)?.displayCidr ?? normalizeIpv4Cidr(cidrBlock) ?? cidrBlock;
        const key = `${regionId}\t${norm}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let row = await describeCidrRow(norm, regionId, ak, sk, ver);
        if (!row && cidrBlock !== norm) row = await describeCidrRow(cidrBlock, regionId, ak, sk, ver);
        const found = row != null;
        results.push({ cidrBlock, regionId, queryCidr: norm, found, ...(found ? { status: String(row.status ?? ''), usedCount: Number(row.usedCount ?? 0), totalCount: Number(row.totalCount ?? 0) } : {}) });
      }
      res.statusCode = 200; res.end(JSON.stringify({ ok: true, results }));
    } catch (e: any) {
      res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });

  // ─── POST /api/zen/clusters ─── 查询合并带宽组列表
  server.middlewares.use('/api/zen/clusters', async (req: any, res: any, _next: any) => {
    setCorsJson(res);
    if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
    if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ ok: false })); return; }
    try {
      const body = await readBody(req);
      const { ak, sk } = getZenCreds();
      const ver = zenApiVersion();
      const { listBandwidthClusters } = await import('./src/lib/zen/bandwidth.js' as any);
      const rows = await listBandwidthClusters(ak, sk, ver, { cityName: body?.cityName?.trim() || undefined, clusterNameFuzzy: body?.name?.trim() || undefined });
      res.statusCode = 200; res.end(JSON.stringify({ ok: true, data: rows.map((r: any) => ({ bandwidthClusterId: r.bandwidthClusterId, bandwidthClusterName: r.bandwidthClusterName, location: r.location })) }));
    } catch (e: any) {
      res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });

  // ─── POST /api/zen/pipeline ─── 执行宣告流水线（NDJSON 流）
  server.middlewares.use('/api/zen/pipeline', async (req: any, res: any, _next: any) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
    if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ ok: false })); return; }
    try {
      const body = await readBody(req);
      const { ak, sk } = getZenCreds();
      const { runPipeline } = await import('./src/lib/zen/pipeline.js' as any);
      await streamNdjson(res, runPipeline(body, ak, sk));
    } catch (e: any) {
      if (!res.headersSent) { res.setHeader('Content-Type', 'application/json'); res.statusCode = 500; }
      res.end(JSON.stringify({ type: 'error', message: e.message }));
    }
  });

  // ─── POST /api/zen/eip-delete ─── 删除 EIP（NDJSON 流）
  server.middlewares.use('/api/zen/eip-delete', async (req: any, res: any, _next: any) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
    if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ ok: false })); return; }
    try {
      const body = await readBody(req);
      const { ak, sk } = getZenCreds();
      // 规范化请求体
      let normalized: any;
      if (Array.isArray(body?.tasks)) {
        normalized = { tasks: body.tasks.map((t: any) => ({ regionId: String(t.regionId ?? '').trim(), cidrBlock: String(t.cidrBlock ?? '').trim() })).filter((t: any) => t.cidrBlock), scanRegionIds: (body.scanRegionIds || []).map((x: any) => String(x).trim()).filter(Boolean), dryRun: Boolean(body.dryRun), unbindBeforeDelete: Boolean(body.unbindBeforeDelete) };
      } else {
        const regionId = String(body?.regionId ?? '').trim();
        const cidrBlock = String(body?.cidrBlock ?? '').trim();
        if (!cidrBlock) throw new Error('请求体需包含 tasks[] 或 cidrBlock');
        normalized = { tasks: [{ regionId, cidrBlock }], scanRegionIds: (body.scanRegionIds || []).map((x: any) => String(x).trim()).filter(Boolean), dryRun: Boolean(body.dryRun), unbindBeforeDelete: Boolean(body.unbindBeforeDelete) };
      }
      if (!normalized.tasks.length) throw new Error('请至少填写一行 CIDR');
      const { runEipDelete } = await import('./src/lib/zen/eip-delete.js' as any);
      await streamNdjson(res, runEipDelete(normalized, ak, sk));
    } catch (e: any) {
      if (!res.headersSent) { res.setHeader('Content-Type', 'application/json'); res.statusCode = 500; }
      res.end(JSON.stringify({ type: 'error', message: e.message }));
    }
  });

  // ─── POST /api/zen/byoip-announce ─── 仅 BYOIP 宣告（NDJSON 流）
  server.middlewares.use('/api/zen/byoip-announce', async (req: any, res: any, _next: any) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
    if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ ok: false })); return; }
    try {
      const body = await readBody(req);
      const { ak, sk } = getZenCreds();
      const jobs = Array.isArray(body?.jobs) ? body.jobs.map((j: any) => ({
        cidrBlock: String(j.cidrBlock ?? '').trim(),
        asn: Number(j.asn),
        ipType: 'IPV4',
        zones: Array.isArray(j.zones) ? j.zones.map((z: any) => ({
          zoneId: String(z.zoneId ?? '').trim(),
          publicVirtualInterfaceId: String(z.publicVirtualInterfaceId ?? '').trim(),
        })).filter((z: any) => z.zoneId && z.publicVirtualInterfaceId) : [],
      })).filter((j: any) => j.cidrBlock && Number.isFinite(j.asn) && j.asn > 0 && j.zones.length > 0) : [];
      if (!jobs.length) throw new Error('请至少填写一条完整任务（CIDR、ASN、至少一个可用区+公网 VLAN）');
      const { runByoipAnnounce } = await import('./src/lib/zen/byoip-announce.js' as any);
      await streamNdjson(res, runByoipAnnounce({ jobs, dryRun: Boolean(body?.dryRun) }, ak, sk));
    } catch (e: any) {
      if (!res.headersSent) { res.setHeader('Content-Type', 'application/json'); res.statusCode = 500; }
      res.end(JSON.stringify({ type: 'error', message: e.message }));
    }
  });

  // ─── POST /api/zen/byoip-withdraw ─── 取消 BYOIP 宣告 / DeleteCidr（NDJSON 流）
  server.middlewares.use('/api/zen/byoip-withdraw', async (req: any, res: any, _next: any) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
    if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ ok: false })); return; }
    try {
      const body = await readBody(req);
      const { ak, sk } = getZenCreds();
      let tasks: { regionId: string; cidrBlock: string }[];
      if (Array.isArray(body?.tasks)) {
        tasks = body.tasks.map((t: any) => ({
          regionId: String(t.regionId ?? '').trim(),
          cidrBlock: String(t.cidrBlock ?? '').trim(),
        })).filter((t: any) => t.cidrBlock);
      } else {
        const cidrBlock = String(body?.cidrBlock ?? '').trim();
        if (!cidrBlock) throw new Error('请求体需包含 tasks[] 或 cidrBlock');
        tasks = [{ regionId: String(body?.regionId ?? '').trim(), cidrBlock }];
      }
      if (!tasks.length) throw new Error('请至少填写一行 CIDR');
      const scanRegionIds = (body?.scanRegionIds || []).map((x: any) => String(x).trim()).filter(Boolean);
      const { runByoipWithdraw } = await import('./src/lib/zen/byoip-withdraw.js' as any);
      await streamNdjson(res, runByoipWithdraw({ tasks, scanRegionIds, dryRun: Boolean(body?.dryRun) }, ak, sk));
    } catch (e: any) {
      if (!res.headersSent) { res.setHeader('Content-Type', 'application/json'); res.statusCode = 500; }
      res.end(JSON.stringify({ type: 'error', message: e.message }));
    }
  });

  // ─── POST /api/zen/byoip-withdraw-by-id ─── 直接按 cidrBlockId 取消宣告（NDJSON 流）
  server.middlewares.use('/api/zen/byoip-withdraw-by-id', async (req: any, res: any, _next: any) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
    if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ ok: false })); return; }
    try {
      const body = await readBody(req);
      const { ak, sk } = getZenCreds();
      const dryRun = Boolean(body?.dryRun);
      const ids: string[] = (Array.isArray(body?.cidrBlockIds) ? body.cidrBlockIds : [])
        .map((x: any) => String(x).trim()).filter(Boolean);
      if (!ids.length) throw new Error('请至少填写一个 cidrBlockId');
      const { bmcCall, unwrapResponse } = await import('./src/lib/zen/zenlayer.js' as any);
      const { apiVersion } = await import('./src/lib/zen/credentials.js' as any);
      const ver = apiVersion();
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.statusCode = 200;
      const write = (ev: any) => res.write(JSON.stringify(ev) + '\n');
      for (let i = 0; i < ids.length; i++) {
        const cidrBlockId = ids[i];
        write({ type: 'log', level: 'info', message: `[${i + 1}/${ids.length}] cidrBlockId=${cidrBlockId}${dryRun ? ' [演练]' : ''}` });
        if (dryRun) {
          write({ type: 'id_done', index: i, cidrBlockId, dryRun: true, deleted: false, message: '演练模式未实际取消' });
          continue;
        }
        try {
          const result = await bmcCall('TerminateCidrBlock', { cidrBlockId }, ak, sk, ver);
          unwrapResponse(result);
          write({ type: 'log', level: 'info', message: `[${i + 1}/${ids.length}] TerminateCidrBlock 成功 cidrBlockId=${cidrBlockId}` });
          write({ type: 'id_done', index: i, cidrBlockId, dryRun: false, deleted: true });
        } catch (e: any) {
          write({ type: 'log', level: 'error', message: `[${i + 1}/${ids.length}] 失败：${e.message}` });
          write({ type: 'id_done', index: i, cidrBlockId, dryRun: false, deleted: false, message: e.message });
        }
      }
      write({ type: 'done' });
      res.end();
    } catch (e: any) {
      if (!res.headersSent) { res.setHeader('Content-Type', 'application/json'); res.statusCode = 500; }
      res.end(JSON.stringify({ type: 'error', message: e.message }));
    }
  });

  // 
  // DEBUG: GET /api/zen/debug/cidr-blocks?cidr=xxx
  server.middlewares.use('/api/zen/debug/cidr-blocks', async (req, res, _next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const cidr = urlObj.searchParams.get('cidr') || '';
      const { ak, sk } = getZenCreds();
      const { bmcCall } = await import('./src/lib/zen/zenlayer.js');
      const ver = '2024-09-01';
      const payload = { pageSize: 50, pageNum: 1 };
      if (cidr) payload.cidrBlock = cidr;
      const raw = await bmcCall('DescribeCidrBlocks', payload, ak, sk, ver);
      res.end(JSON.stringify({ ok: true, cidr, raw }, null, 2));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });

  // ─── ZEN web 健康检查（前端轮询用，后端探测本机 127.0.0.1:3000）────────────
  // 无论用户从哪个 IP/域名访问主应用，探测始终打向服务器本机，不依赖客户端网络
  server.middlewares.use('/api/zen-status', async (req: any, res: any, _next: any) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
    try {
      const http = await import('http');
      const ok = await new Promise<boolean>((resolve) => {
        const req2 = http.get('http://127.0.0.1:3000/', { timeout: 3000 }, (r) => {
          r.resume(); // 消耗响应体，避免 socket hang
          resolve(true);
        });
        req2.on('error', () => resolve(false));
        req2.on('timeout', () => { req2.destroy(); resolve(false); });
      });
      res.statusCode = 200;
      res.end(JSON.stringify({ online: ok }));
    } catch {
      res.statusCode = 200;
      res.end(JSON.stringify({ online: false }));
    }
  });

  // 启动时一次性从 ZEN-Auto-Announce .env 导入凭据到 zen-config.json
  importZenEnvOnce();
}

const dataPersistencePlugin = () => ({
  name: 'data-persistence',
  enforce: 'pre' as const,
    configureServer(server) {
      installDataPersistenceMiddlewares(server);
      setTimeout(() => { startNotifyScheduler(); startBackupScheduler(); startIpxoCacheRefreshScheduler(); startWeeklyReportScheduler(); initSyncRemarks(); }, 2000);
    },
    configurePreviewServer(server) {
      installDataPersistenceMiddlewares(server);
      setTimeout(() => { startNotifyScheduler(); startBackupScheduler(); startIpxoCacheRefreshScheduler(); startWeeklyReportScheduler(); initSyncRemarks(); }, 2000);
    },
});

export default defineConfig({
  plugins: [react(), dataPersistencePlugin()],
  server: {
    port: 8081,
    host: '0.0.0.0', // 允许外部访问，监听所有网络接口
    open: true,
    // 固定 8081：被占用时不自动换端口，避免歧义（需关掉占用进程后再启动）
    strictPort: true,
  },
  preview: {
    port: 8081,
    host: '0.0.0.0',
    strictPort: true,
    /** 无图形界面的 Linux 服务器上若尝试 open 浏览器会报错 spawn xdg-open ENOENT */
    open: false,
  },
})

