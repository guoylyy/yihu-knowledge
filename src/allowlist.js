import fs from 'node:fs';
import path from 'node:path';
import { writeConfigFile } from './setup.js';

// 向导只在 config.json 不存在时出现，这份副本让「删掉配置重来」时还能回填勾选。只用于回填，校验不看它
const LAST_FILE = 'allowlist.last.json';

export const pickAllowlist = ({ allowedUsers = [], allowedUserIds = [], allowedProfiles = {} }) => ({ allowedUsers, allowedUserIds, allowedProfiles });

const toId = (v) => (/^\d+$/.test(String(v)) ? Number(v) : String(v));

// 配置里存数字 id，表单和日志里都是字符串，统一成配置里的样子
export function membersFromIds(ids, users) {
  const byId = new Map(users.map((u) => [String(u.id), u]));
  return [...new Set([ids].flat().map(String).filter((id) => /^[\w-]{1,64}$/.test(id)))]
    .map((id) => ({ id, username: byId.get(id)?.username ?? null, name: byId.get(id)?.name ?? null }));
}

export function withMembers(lists, members) {
  const { allowedUsers, allowedUserIds, allowedProfiles } = pickAllowlist(lists);
  const profiles = { ...allowedProfiles };
  for (const m of members) {
    if (m.id !== null && m.id !== undefined) profiles[m.id] = { username: m.username ?? null, name: m.name ?? null };
  }
  return {
    allowedUsers: [...new Set([...allowedUsers, ...members.map((m) => m.username).filter(Boolean)])],
    allowedUserIds: [...new Set([...allowedUserIds, ...members.map((m) => m.id).filter((id) => id !== null && id !== undefined).map(toId)])],
    allowedProfiles: profiles,
  };
}

// 两个列表都要清干净，只删一边的话这个人还能靠另一边进来
export function withoutMember(lists, { id, username }) {
  const { allowedUsers, allowedUserIds, allowedProfiles } = pickAllowlist(lists);
  const { [id]: dropped, ...profiles } = allowedProfiles;
  return {
    allowedUsers: allowedUsers.filter((u) => u !== username && u !== id),
    allowedUserIds: allowedUserIds.filter((v) => String(v) !== id),
    allowedProfiles: profiles,
  };
}

export function rememberAllowlist(dataDir, lists) {
  writeConfigFile(path.join(dataDir, LAST_FILE), pickAllowlist(lists));
}

export function lastAllowlist(dataDir) {
  try {
    return pickAllowlist(JSON.parse(fs.readFileSync(path.join(dataDir, LAST_FILE), 'utf8')));
  } catch {
    return pickAllowlist({});
  }
}

// 现读现改：config.json 里还有口令 hash 和 AI key，不能用内存里的值覆盖。平台部署全靠环境变量，这里才第一次生成这个文件。
// 写成功才改内存：session 和回调读的都是这同一个 config 对象，所以不用重启
export function saveAllowlist(config, lists) {
  const file = path.join(config.dataDir, 'config.json');
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const next = pickAllowlist(lists);
  writeConfigFile(file, { ...current, ...next });
  rememberAllowlist(config.dataDir, next);
  Object.assign(config, next);
  if (config.sources) config.sources.allowedUsers = 'file';
}
