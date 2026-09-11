// dao-check ㉞：在管公开活仓的合并闸形状（issue #999）。
//
// 病：分支保护是静默漂移——有人在 GitHub 网页上关掉 / 从未装上，没有任何东西报警。
// 本仓已落地（PR #998）：required=["check"]、enforce_admins=false、strict=false。
// 不造分发器（#999 实测：照搬本仓配置会把 CI 不在 PR 上跑的仓永久锁死）。
//
// 扫描面不手写仓名单：从仓内已有登记扫——INDEX E 类「归 `仓名`」、
// host/machine/feishu-groups.json 的 repo 字段、docs/release-policy.json 的 demo 键，
// 再并上本仓 origin。归档 / 私有 / Pages 站不进判定面。
//
// 检查器自持解析，不 import INDEX / 群映射 / 发布策略的消费方（自己查自己查不出错）。
// 探头（gh api）由调用方注入；本文件零 spawn。
//
// 三态必须分得开：
//   unscanned —— 没查成（清单空 / 探头失败 / 保护 JSON 读不成布尔）
//   skip      —— 缺 gh / 连 branches 摘要都 401/403（不是绿）
//   red       —— 进了判定面，但缺闸或形状错（缺保护、contexts 不对、enforce_admins/strict 为 true）
//   ok        —— 判定面上每个仓形状都对
// 空清单不许当绿。
//
// live / CI 打 GET repos/:slug/branches/master（contents:read 够）。
// 完整 GET .../protection 要 Administration，CI token 和四个 App 都是 403，
// SKIP 仍绿 = 闸被关掉也没人报警。装闸脚本继续走完整 /protection。
// 摘要看得见：protected、required_status_checks.contexts、enforcement_level。
// strict 不在摘要里——live 盖不住「有人把 strict 拨成 true」。

import { join } from 'node:path';

export const REQUIRED_CONTEXTS = ['check'];
export const REQUIRE_STRICT = false;
export const REQUIRE_ENFORCE_ADMINS = false;

export const INDEX_REL = 'host/machine/INDEX.md';
export const GROUPS_REL = 'host/machine/feishu-groups.json';
export const POLICY_REL = 'docs/release-policy.json';
export const FIXTURES_REL = 'tests/fixtures/branch-protection';

const INDEX_OWNED_RE = /归\s*`([A-Za-z0-9._-]+)`/g;

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** git remote / GitHub URL → owner/repo。抽不出返回 null。 */
export function repoSlugFromRemote(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  const m = s.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?\s*$/i);
  if (!m) return null;
  const owner = m[1];
  const name = String(m[2]).replace(/\.git$/i, '');
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}

function normalizeSlug(raw, owner) {
  const s = String(raw || '').trim().replace(/\.git$/i, '');
  if (!s || s.startsWith('_')) return null;
  if (s.includes('/')) {
    const parts = s.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  if (!owner) return null;
  return `${owner}/${s}`;
}

function ownerOf(slug) {
  const s = String(slug || '');
  const i = s.indexOf('/');
  return i > 0 ? s.slice(0, i) : '';
}

/** INDEX E 类「归 `仓名`」——只收反引号里的仓名，不读解析器。 */
export function extractReposFromIndex(text) {
  const names = [];
  const re = new RegExp(INDEX_OWNED_RE.source, 'g');
  let m;
  while ((m = re.exec(String(text || '')))) names.push(m[1]);
  return names;
}

/** 群映射表的 repo 字段。_ 注释键跳过。根坏了返回 unscanned。 */
export function extractReposFromGroups(doc) {
  if (!isPlainObject(doc)) {
    return { ok: false, unscanned: true, error: '群映射根不是对象', slugs: [] };
  }
  const slugs = [];
  for (const [id, v] of Object.entries(doc)) {
    if (id.startsWith('_')) continue;
    if (!isPlainObject(v)) continue;
    const slug = normalizeSlug(v.repo, null);
    if (slug) slugs.push(slug);
  }
  return { ok: true, unscanned: false, slugs };
}

/** release-policy demo 键。demo 不是对象 → unscanned。 */
export function extractReposFromPolicy(doc) {
  if (!isPlainObject(doc)) {
    return { ok: false, unscanned: true, error: 'release-policy 根不是对象', names: [] };
  }
  if (!isPlainObject(doc.demo)) {
    return { ok: false, unscanned: true, error: 'release-policy.demo 不是对象', names: [] };
  }
  const names = Object.keys(doc.demo).filter((k) => k && !k.startsWith('_'));
  return { ok: true, unscanned: false, names };
}

/**
 * 从三份已有登记并出 owner/repo。owner 来自 originSlug（本仓），
 * 不手写仓名单。origin 本身并进集合（本仓一定在管）。
 * 三份都空且没 origin → unscanned。
 */
export function collectManagedRepos({ indexText, groupsDoc, policyDoc, originSlug } = {}) {
  const origin = originSlug ? normalizeSlug(originSlug, null) : null;
  const owner = origin ? ownerOf(origin) : '';
  const set = new Set();

  if (typeof indexText === 'string') {
    for (const name of extractReposFromIndex(indexText)) {
      const slug = normalizeSlug(name, owner);
      if (slug) set.add(slug);
    }
  }

  if (groupsDoc !== undefined) {
    const g = extractReposFromGroups(groupsDoc);
    if (g.unscanned) return { ok: false, unscanned: true, error: g.error, slugs: [] };
    for (const s of g.slugs) set.add(s);
  }

  if (policyDoc !== undefined) {
    const p = extractReposFromPolicy(policyDoc);
    if (p.unscanned) return { ok: false, unscanned: true, error: p.error, slugs: [] };
    for (const name of p.names) {
      const slug = normalizeSlug(name, owner);
      if (slug) set.add(slug);
    }
  }

  if (origin) set.add(origin);

  const slugs = [...set].sort();
  if (slugs.length === 0) {
    return { ok: false, unscanned: true, error: '在管仓登记扫出 0 个（没查成，不是 0 个违规）', slugs: [] };
  }
  return { ok: true, unscanned: false, error: null, slugs };
}

/** 归档 / 私有 / Pages 站不进判定面。meta 缺关键字段 → 没查成。 */
export function inJudgmentSurface(meta) {
  if (!isPlainObject(meta)) {
    return { in: false, unscanned: true, why: '仓元数据不是对象（没查成）' };
  }
  const hasPrivate = Object.prototype.hasOwnProperty.call(meta, 'private');
  const hasArchived = Object.prototype.hasOwnProperty.call(meta, 'archived');
  const hasPages = Object.prototype.hasOwnProperty.call(meta, 'has_pages');
  if (!hasPrivate || !hasArchived || !hasPages) {
    return { in: false, unscanned: true, why: '仓元数据缺 private/archived/has_pages（没查成）' };
  }
  if (meta.private === true) return { in: false, unscanned: false, why: '私有仓' };
  if (meta.archived === true) return { in: false, unscanned: false, why: '归档仓' };
  if (meta.has_pages === true) return { in: false, unscanned: false, why: 'Pages 站' };
  const name = typeof meta.name === 'string' ? meta.name : '';
  if (/\.github\.io$/i.test(name)) return { in: false, unscanned: false, why: 'Pages 站' };
  return { in: true, unscanned: false, why: '公开活仓' };
}

function contextsOf(protection) {
  const rsc = protection && protection.required_status_checks;
  if (!isPlainObject(rsc)) return null;
  if (Array.isArray(rsc.contexts)) return rsc.contexts.map((c) => String(c));
  if (Array.isArray(rsc.checks)) {
    return rsc.checks.map((c) => {
      if (typeof c === 'string') return c;
      if (isPlainObject(c) && c.context != null) return String(c.context);
      return '';
    }).filter(Boolean);
  }
  return null;
}

function strictOf(protection) {
  const rsc = protection && protection.required_status_checks;
  if (!isPlainObject(rsc)) return { ok: false, value: null };
  if (typeof rsc.strict !== 'boolean') return { ok: false, value: rsc.strict };
  return { ok: true, value: rsc.strict };
}

function enforceAdminsOf(protection) {
  const v = protection && protection.enforce_admins;
  if (typeof v === 'boolean') return { ok: true, value: v };
  if (isPlainObject(v) && typeof v.enabled === 'boolean') return { ok: true, value: v.enabled };
  return { ok: false, value: v };
}

function sameContexts(got) {
  const want = [...REQUIRED_CONTEXTS].sort();
  const have = [...got].sort();
  if (want.length !== have.length) return false;
  return want.every((c, i) => c === have[i]);
}

/**
 * 纯函数：给保护 JSON，判绿 / 红 / 没查成。
 * 404 / protection=null → 红（缺闸）。JSON 在但字段读不成 → 没查成。
 */
export function judgeProtection(protection) {
  if (protection == null) {
    return { kind: 'red', why: '缺保护' };
  }
  if (!isPlainObject(protection)) {
    return { kind: 'unscanned', why: '保护 JSON 不是对象（没查成）' };
  }
  const contexts = contextsOf(protection);
  if (contexts == null) {
    return { kind: 'red', why: '缺 required_status_checks.contexts' };
  }
  const strict = strictOf(protection);
  if (!strict.ok) {
    return { kind: 'unscanned', why: 'required_status_checks.strict 不是布尔（没查成）' };
  }
  const admins = enforceAdminsOf(protection);
  if (!admins.ok) {
    return { kind: 'unscanned', why: 'enforce_admins 读不成布尔（没查成）' };
  }
  const problems = [];
  if (!sameContexts(contexts)) {
    problems.push(`required contexts=[${contexts.join(',')}]，要 [${REQUIRED_CONTEXTS.join(',')}]`);
  }
  if (admins.value !== REQUIRE_ENFORCE_ADMINS) {
    problems.push(`enforce_admins=${admins.value}，要 ${REQUIRE_ENFORCE_ADMINS}`);
  }
  if (strict.value !== REQUIRE_STRICT) {
    problems.push(`strict=${strict.value}，要 ${REQUIRE_STRICT}`);
  }
  if (problems.length) return { kind: 'red', why: problems.join('；'), contexts, enforce_admins: admins.value, strict: strict.value };
  return { kind: 'ok', why: '形状对', contexts, enforce_admins: admins.value, strict: strict.value };
}

/** GET branches/:name 摘要的 enforcement_level → 是否 enforce_admins。 */
export function enforceAdminsFromLevel(level) {
  if (level === 'non_admins' || level === 'off') return { ok: true, value: false };
  if (level === 'everyone') return { ok: true, value: true };
  return { ok: false, value: level };
}

/**
 * 纯函数：给 GET branches/master 那种摘要 JSON（不要完整 protection 对象）。
 * 绿 / 缺保护 / contexts 错 / enforcement_level=everyone。
 * strict 不在摘要里——live 盖不住「有人把 strict 拨成 true」，装闸脚本走完整 /protection。
 */
export function judgeBranchSummary(branch) {
  if (branch == null) {
    return { kind: 'unscanned', why: '分支摘要不是对象（没查成）' };
  }
  if (!isPlainObject(branch)) {
    return { kind: 'unscanned', why: '分支摘要不是对象（没查成）' };
  }
  if (branch.protected === false) {
    return { kind: 'red', why: '缺保护' };
  }
  if (branch.protected !== true) {
    return { kind: 'unscanned', why: 'protected 不是布尔（没查成）' };
  }
  const inner = isPlainObject(branch.protection) ? branch.protection : null;
  if (!inner) {
    return { kind: 'red', why: '缺保护' };
  }
  const contexts = contextsOf(inner);
  if (contexts == null) {
    return { kind: 'red', why: '缺 required_status_checks.contexts' };
  }
  const rsc = inner.required_status_checks;
  const level = isPlainObject(rsc) ? rsc.enforcement_level : undefined;
  const admins = enforceAdminsFromLevel(level);
  if (!admins.ok) {
    return { kind: 'unscanned', why: 'enforcement_level 读不成（没查成）' };
  }
  const problems = [];
  if (!sameContexts(contexts)) {
    problems.push(`required contexts=[${contexts.join(',')}]，要 [${REQUIRED_CONTEXTS.join(',')}]`);
  }
  if (admins.value !== REQUIRE_ENFORCE_ADMINS) {
    problems.push(`enforcement_level=${level}（enforce_admins=${admins.value}），要 non_admins`);
  }
  if (problems.length) {
    return {
      kind: 'red',
      why: problems.join('；'),
      contexts,
      enforce_admins: admins.value,
      enforcement_level: level,
    };
  }
  return {
    kind: 'ok',
    why: '形状对',
    contexts,
    enforce_admins: admins.value,
    enforcement_level: level,
  };
}

/**
 * 把 gh api 一次调用的结果收成 skip / 404缺保护 / 保护 JSON / 没查成。
 * 调用方 spawn，本函数不碰网络。
 */
export function classifyProtectionProbe({ error, status, stdout, stderr, httpStatus } = {}) {
  const err = error || null;
  const msg = String((err && (err.message || err.code)) || '');
  if (err && (err.code === 'ENOENT' || /ENOENT/i.test(msg))) {
    return { kind: 'skip', why: 'gh 不可用（ENOENT）' };
  }
  const text = `${String(stdout || '')}\n${String(stderr || '')}`;
  let doc = null;
  const trimmedOut = String(stdout || '').trim();
  const trimmedErr = String(stderr || '').trim();
  for (const chunk of [trimmedOut, trimmedErr]) {
    if (!chunk) continue;
    const i = chunk.indexOf('{');
    if (i < 0) continue;
    try { doc = JSON.parse(chunk.slice(i)); break; } catch { /* 下一片 */ }
  }
  const http = Number(httpStatus)
    || Number(doc && doc.status)
    || null;
  const combined = `${msg}\n${text}`;
  if (/401|403/.test(String(http)) || /HTTP\s*403|HTTP\s*401|Upgrade to GitHub Pro|Resource not accessible|Bad credentials|authentication/i.test(combined)) {
    return { kind: 'skip', why: `无权限（${http || '401/403'}）` };
  }
  if (http === 404 || /Branch not protected/i.test(combined) || (doc && doc.message === 'Branch not protected')) {
    return { kind: 'missing', why: '缺保护', protection: null };
  }
  if (err || (status != null && status !== 0)) {
    return {
      kind: 'unscanned',
      why: `探头失败（exit ${status ?? 'error'}）：${(trimmedErr || trimmedOut || msg).slice(0, 160)}`,
    };
  }
  if (!isPlainObject(doc)) {
    return { kind: 'unscanned', why: '保护 JSON 不是对象（没查成）' };
  }
  return { kind: 'ok', protection: doc };
}

/**
 * 把 GET branches/master 一次调用的结果收成 skip / 摘要 JSON / 没查成。
 * 403/ENOENT 只留给「连摘要都读不到」——那才是真没查成。
 * protected=false 走 judgeBranchSummary，是红不是 skip。
 */
function stripAnsi(s) {
  return String(s || '').replace(/\u001b\[[0-9;]*m/g, '');
}

export function classifyBranchProbe({ error, status, stdout, stderr, httpStatus } = {}) {
  const err = error || null;
  const msg = String((err && (err.message || err.code)) || '');
  if (err && (err.code === 'ENOENT' || /ENOENT/i.test(msg))) {
    return { kind: 'skip', why: 'gh 不可用（ENOENT）' };
  }
  // gh 在 FORCE_COLOR / TTY 下会给 JSON 上色。先剥再 parse，否则 `{` 前面那截 ESC
  // 让 JSON.parse 失败，这道闸整轮「没查成」——有保护也看不见。
  const trimmedOut = stripAnsi(stdout).trim();
  const trimmedErr = stripAnsi(stderr).trim();
  let doc = null;
  for (const chunk of [trimmedOut, trimmedErr]) {
    if (!chunk) continue;
    const i = chunk.indexOf('{');
    if (i < 0) continue;
    try { doc = JSON.parse(chunk.slice(i)); break; } catch { /* 下一片 */ }
  }
  const http = Number(httpStatus)
    || Number(doc && doc.status)
    || null;
  const combined = `${msg}\n${trimmedOut}\n${trimmedErr}`;
  const failed = Boolean(err) || (status != null && status !== 0);
  if (failed || http === 401 || http === 403) {
    if (/401|403/.test(String(http)) || /HTTP\s*403|HTTP\s*401|Upgrade to GitHub Pro|Resource not accessible|Bad credentials|authentication/i.test(combined)) {
      return { kind: 'skip', why: `无权限（${http || '401/403'}）` };
    }
    if (http === 404 || (doc && doc.message === 'Not Found')) {
      return { kind: 'unscanned', why: '分支摘要 404（没查成）' };
    }
    return {
      kind: 'unscanned',
      why: `探头失败（exit ${status ?? 'error'}）：${(trimmedErr || trimmedOut || msg).slice(0, 160)}`,
    };
  }
  if (!isPlainObject(doc)) {
    return { kind: 'unscanned', why: '分支摘要不是对象（没查成）' };
  }
  return { kind: 'ok', branch: doc };
}

/**
 * 一仓：元数据过滤 → 探头 → 形状。
 * probe 已分类（classifyProtectionProbe / classifyBranchProbe 的返回），
 * 或直接给 protection / summary（GET branches/master 那种摘要）。
 */
export function judgeRepoGate({ slug, meta, protection, probe, summary } = {}) {
  const name = String(slug || '(无名)');
  const surface = inJudgmentSurface(meta);
  if (surface.unscanned) {
    return { slug: name, kind: 'unscanned', why: `${name}：${surface.why}` };
  }
  if (!surface.in) {
    return { slug: name, kind: 'out', why: `${name}：${surface.why}` };
  }
  const p = probe && probe.kind ? probe : null;
  if (p) {
    if (p.kind === 'skip') return { slug: name, kind: 'skip', why: `${name}：${p.why}` };
    if (p.kind === 'unscanned') return { slug: name, kind: 'unscanned', why: `${name}：${p.why}` };
    if (p.kind === 'missing') {
      return { slug: name, kind: 'red', why: `${name}：缺保护` };
    }
    if (p.kind === 'ok') {
      if (p.branch) {
        const j = judgeBranchSummary(p.branch);
        return { slug: name, kind: j.kind, why: `${name}：${j.why}` };
      }
      const j = judgeProtection(p.protection);
      return { slug: name, kind: j.kind, why: `${name}：${j.why}` };
    }
  }
  if (summary !== undefined) {
    const j = judgeBranchSummary(summary);
    return { slug: name, kind: j.kind, why: `${name}：${j.why}` };
  }
  const j = judgeProtection(protection);
  return { slug: name, kind: j.kind, why: `${name}：${j.why}` };
}

/**
 * 纯判官：给 [{slug, meta, protection, probe}]。
 * 不是数组 / 长度 0 → unscanned。
 * 判定面空（全是私有/归档/Pages）→ unscanned。
 * 判定面上有 skip（无 gh / 403）且没有红 → skip（live 用，不是绿）。
 * 判定面上有没查成 → unscanned。
 * 有红 → red。全绿 → ok。
 */
export function inspectBranchProtection({ repos } = {}) {
  if (!Array.isArray(repos)) {
    return { ok: false, unscanned: true, skip: false, error: '没给仓清单（没查成）', violations: [], scanned: 0, judged: 0 };
  }
  if (repos.length === 0) {
    return { ok: false, unscanned: true, skip: false, error: '扫到 0 个仓（没查成，不是 0 个违规）', violations: [], scanned: 0, judged: 0 };
  }
  const judged = [];
  for (const r of repos) {
    judged.push(judgeRepoGate(r || {}));
  }
  const inScope = judged.filter((j) => j.kind !== 'out');
  if (inScope.length === 0) {
    return {
      ok: false,
      unscanned: true,
      skip: false,
      error: '判定面 0 个公开活仓（全是私有/归档/Pages）——没查成，不是 0 个违规',
      violations: [],
      scanned: judged.length,
      judged: 0,
      out: judged.filter((j) => j.kind === 'out').length,
    };
  }
  const skips = inScope.filter((j) => j.kind === 'skip');
  const unscans = inScope.filter((j) => j.kind === 'unscanned');
  const reds = inScope.filter((j) => j.kind === 'red');
  if (reds.length) {
    return {
      ok: false,
      unscanned: false,
      skip: false,
      error: null,
      violations: reds,
      scanned: judged.length,
      judged: inScope.length,
      out: judged.length - inScope.length,
    };
  }
  if (unscans.length) {
    return {
      ok: false,
      unscanned: true,
      skip: false,
      error: unscans.map((j) => j.why).join('；'),
      violations: [],
      scanned: judged.length,
      judged: inScope.length,
    };
  }
  if (skips.length) {
    return {
      ok: false,
      unscanned: false,
      skip: true,
      error: skips.map((j) => j.why).join('；'),
      violations: [],
      scanned: judged.length,
      judged: inScope.length,
    };
  }
  const oks = inScope.filter((j) => j.kind === 'ok');
  return {
    ok: oks.length === inScope.length,
    unscanned: false,
    skip: false,
    error: null,
    violations: [],
    scanned: judged.length,
    judged: inScope.length,
    out: judged.length - inScope.length,
  };
}

function readJsonFile(file, readFile) {
  const src = readFile(file);
  try { return { ok: true, doc: JSON.parse(src) }; }
  catch (e) {
    return { ok: false, error: `${file} JSON 坏了：${String(e && e.message ? e.message : e).slice(0, 160)}` };
  }
}

/** 夹具判别力：red 必须拦缺保护/错形状，ok 必须绿，empty 必须没查成。 */
export function inspectBranchProtectionFixtures({
  rootRel = FIXTURES_REL,
  exists,
  readFile,
} = {}) {
  if (typeof exists !== 'function' || typeof readFile !== 'function') {
    return { ok: false, unscanned: true, error: '没给 exists/readFile 探头（没查成）' };
  }
  if (!exists(rootRel)) {
    return { ok: false, unscanned: true, error: `样本目录不在：${rootRel}` };
  }
  const kinds = { red: 0, ok: 0, empty: 0 };
  const problems = [];
  for (const kind of ['red', 'ok', 'empty']) {
    const file = `${rootRel}/${kind}/repos.json`;
    if (!exists(file)) {
      problems.push(`缺 ${kind}/repos.json`);
      continue;
    }
    const parsed = readJsonFile(file, readFile);
    if (!parsed.ok) {
      problems.push(parsed.error);
      continue;
    }
    const repos = parsed.doc;
    const r = inspectBranchProtection({ repos: Array.isArray(repos) ? repos : repos && repos.repos });
    if (kind === 'empty') {
      if (!r.unscanned) {
        problems.push(`empty/ 应没查成但判成 ok=${r.ok} unscanned=${r.unscanned} scanned=${r.scanned}`);
      } else kinds.empty += 1;
    } else if (kind === 'red') {
      if (r.unscanned || r.ok) {
        problems.push(`red/ 自称该红但判成 ok=${r.ok} unscanned=${r.unscanned}`);
      } else {
        const whys = (r.violations || []).map((v) => v.why || '').join('｜');
        const hitMissing = /缺保护/.test(whys);
        const hitCtx = /required contexts/.test(whys);
        const hitAdmins = /enforce_admins=true/.test(whys);
        const hitStrict = /strict=true/.test(whys);
        if (!hitMissing) problems.push('red/ 没点出缺保护');
        else if (!hitCtx) problems.push('red/ 没点出 required contexts 不对');
        else if (!hitAdmins) problems.push('red/ 没点出 enforce_admins: true');
        else if (!hitStrict) problems.push('red/ 没点出 strict: true');
        else kinds.red += 1;
      }
    } else if (kind === 'ok') {
      if (r.unscanned || !r.ok) {
        const names = (r.violations || []).map((v) => v.slug).join('、');
        problems.push(`ok/ 自称该绿但判成 ok=${r.ok} unscanned=${r.unscanned}${names ? `：${names}` : ''}${r.error ? ` ${r.error}` : ''}`);
      } else if (r.judged === 0) {
        problems.push('ok/ 判定面 0 个——和 empty 分不开');
      } else kinds.ok += 1;
    }
  }
  if (kinds.red === 0 || kinds.ok === 0 || kinds.empty === 0) {
    return {
      ok: false,
      unscanned: true,
      error: `样本种类不够 red=${kinds.red} ok=${kinds.ok} empty=${kinds.empty}`,
      kinds,
      problems,
    };
  }
  if (problems.length) return { ok: false, unscanned: false, error: problems[0], kinds, problems };
  return { ok: true, unscanned: false, kinds };
}

/**
 * 从仓根读三份登记，扫在管仓。文件不在 / JSON 坏 = 没查成。
 * originSlug 可选（本仓 remote）。
 */
export function collectManagedReposFromRoot({
  root,
  originSlug,
  exists,
  readFile,
} = {}) {
  if (typeof exists !== 'function' || typeof readFile !== 'function') {
    return { ok: false, unscanned: true, error: '没给 exists/readFile 探头（没查成）', slugs: [] };
  }
  if (!root) {
    return { ok: false, unscanned: true, error: '没给仓库根（没查成）', slugs: [] };
  }
  const tryRead = (rel) => {
    const abs = join(root, rel);
    if (exists(abs)) return readFile(abs);
    if (exists(rel)) return readFile(rel);
    return null;
  };
  const indexText = tryRead(INDEX_REL);
  if (indexText == null) {
    return { ok: false, unscanned: true, error: `${INDEX_REL} 不在（没查成）`, slugs: [] };
  }
  const groupsSrc = tryRead(GROUPS_REL);
  if (groupsSrc == null) {
    return { ok: false, unscanned: true, error: `${GROUPS_REL} 不在（没查成）`, slugs: [] };
  }
  const policySrc = tryRead(POLICY_REL);
  if (policySrc == null) {
    return { ok: false, unscanned: true, error: `${POLICY_REL} 不在（没查成）`, slugs: [] };
  }
  let groupsDoc;
  let policyDoc;
  try { groupsDoc = JSON.parse(groupsSrc); }
  catch (e) {
    return { ok: false, unscanned: true, error: `${GROUPS_REL} JSON 坏了：${String(e.message || e).slice(0, 120)}`, slugs: [] };
  }
  try { policyDoc = JSON.parse(policySrc); }
  catch (e) {
    return { ok: false, unscanned: true, error: `${POLICY_REL} JSON 坏了：${String(e.message || e).slice(0, 120)}`, slugs: [] };
  }
  return collectManagedRepos({ indexText, groupsDoc, policyDoc, originSlug });
}

/** 装闸用的 PUT 载荷。与 judge 认的形状同一份常量。不是分发器——一次只装一个仓。 */
export function protectionPutPayload() {
  return {
    required_status_checks: {
      strict: REQUIRE_STRICT,
      contexts: [...REQUIRED_CONTEXTS],
    },
    enforce_admins: REQUIRE_ENFORCE_ADMINS,
    required_pull_request_reviews: null,
    restrictions: null,
  };
}

/**
 * live：本仓 master 保护形状。探头（gh api）由调用方注入。
 * 打 GET repos/:slug/branches/master（contents:read 够，CI / App 都能读）。
 * 完整 /protection 要 Administration，CI 上 403 → SKIP 仍绿，闸被关也没人报警。
 * 缺 gh / 连摘要都 401/403 → skip（不是绿）。清单空 / 探头失败 → unscanned。
 * protected=false / contexts 错 / enforcement_level=everyone → 红。
 * strict 不在摘要里——live 盖不住「有人把 strict 拨成 true」；装闸脚本走完整 /protection。
 * 只查这一个仓——别的公开活仓（如 miraquota-win）刻意没装闸，
 * 扫进判定面会让 dao-check 永远红。扫描面本身由 collectManagedRepos 在夹具/目录检里验。
 */
export function inspectThisRepoProtection({ originSlug, meta, spawnGh } = {}) {
  if (typeof spawnGh !== 'function') {
    return {
      ok: false, unscanned: true, skip: false,
      error: '没给 spawnGh 探头（没查成）', violations: [], scanned: 0, judged: 0,
    };
  }
  const slug = originSlug ? normalizeSlug(originSlug, null) : null;
  if (!slug) {
    return {
      ok: false, unscanned: true, skip: false,
      error: '没给 origin slug（没查成）', violations: [], scanned: 0, judged: 0,
    };
  }
  const name = slug.split('/')[1] || slug;
  const repoMeta = isPlainObject(meta)
    ? meta
    : { private: false, archived: false, has_pages: false, name };
  let raw;
  try {
    raw = spawnGh(['api', `repos/${slug}/branches/master`]);
  } catch (e) {
    return {
      ok: false, unscanned: true, skip: false,
      error: `探头抛错：${String(e && e.message ? e.message : e).slice(0, 160)}`,
      violations: [], scanned: 0, judged: 0,
    };
  }
  const probe = classifyBranchProbe(raw || {});
  return inspectBranchProtection({ repos: [{ slug, meta: repoMeta, probe }] });
}
