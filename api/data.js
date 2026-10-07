// api/data.js — Sokury 데이터 API (이 파일 하나가 모든 데이터 처리를 담당합니다)
//
// 주소 형식: /api/data?resource=...&id=...&action=...
//   GET    ?resource=health                         진단: DB 연결 상태 확인 (공개)
//   GET    ?resource=share&id=ID  (= /s/ID)          공유 링크 미리보기 페이지 (공개)
//   GET    ?resource=schedules                      일정 목록 (공개)
//   POST   ?resource=schedules                      일정 추가 (관리자)
//   PUT    ?resource=schedules&id=ID                일정 수정 (관리자)
//   DELETE ?resource=schedules&id=ID                일정 삭제 (관리자)
//   POST   ?resource=schedules&id=ID&action=like    좋아요 (공개)
//   GET    ?resource=applications                   신청 목록 (관리자)
//   POST   ?resource=applications                   신청서 제출 (공개)
//   PATCH  ?resource=applications&id=ID             신청 상태 변경 (관리자)
//   DELETE ?resource=applications&id=ID             신청 삭제 (관리자)
//
// 관리자 권한 확인은 middleware.js가 이 파일보다 먼저 처리합니다.
// DB는 Upstash Redis를 별도 라이브러리 없이 HTTPS로 직접 호출합니다.

const KEYS = { schedules: 'sokury:schedules', applications: 'sokury:applications' };

function getRedisConfig() {
  const pairs = [
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
  ];
  for (const [u, t] of pairs) {
    if (process.env[u] && process.env[t]) return { url: process.env[u], token: process.env[t], via: u };
  }
  return null;
}

async function redis(command) {
  const cfg = getRedisConfig();
  if (!cfg) {
    const e = new Error('DB 연결 정보가 없습니다. Vercel → Storage에서 Upstash Redis를 이 프로젝트에 연결(Connect)한 뒤 재배포(Redeploy)해주세요.');
    e.status = 500;
    throw e;
  }
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    const e = new Error('DB 요청 실패: ' + (data.error || r.status));
    e.status = 502;
    throw e;
  }
  return data.result;
}

async function readList(name) {
  const raw = await redis(['GET', KEYS[name]]);
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}
async function writeList(name, list) {
  await redis(['SET', KEYS[name], JSON.stringify(list)]);
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function getBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return req.body;
}

async function handleHealth(req, res) {
  const cfg = getRedisConfig();
  const envNames = Object.keys(process.env).filter((k) => /REDIS|KV_|UPSTASH/i.test(k)).sort();
  let reachable = false;
  let pingError = null;
  if (cfg) {
    try { reachable = (await redis(['PING'])) === 'PONG'; }
    catch (e) { pingError = e.message; }
  }
  return res.status(200).json({
    ok: Boolean(cfg && reachable),
    dbConfigured: Boolean(cfg),
    dbReachable: reachable,
    dbVia: cfg ? cfg.via : null,
    dbError: pingError,
    adminConfigured: Boolean(process.env.ADMIN_USER && process.env.ADMIN_PASSWORD),
    googleLoginConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.SESSION_SECRET),
    adminEmailCount: adminEmails().length,
    envNamesFound: envNames, // 값은 절대 보여주지 않고 이름만 보여줍니다
  });
}

// ---------------------------------------------------------------------------
// 공유 카드 이미지: 카톡·디스코드·X가 링크를 읽으러 오는 순간 서버가 직접 그립니다.
// (메인 페이지 공유 팝업의 카드와 같은 디자인, 1200x630)
// ---------------------------------------------------------------------------
const CAT_COLORS = { regular: '#7C5CFC', ep: '#12B886', single: '#228BE6', mixtape: '#F59F00', compilation: '#E64980', physical: '#495057', concert: '#E03131' };
const HEART_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#E03131" d="M12 21s-7.5-4.6-10-9.3C.3 8.3 2.2 4.5 5.9 4.1 8.1 3.9 10 5 12 7.2 14 5 15.9 3.9 18.1 4.1c3.7.4 5.6 4.2 3.9 7.6C19.5 16.4 12 21 12 21z"/></svg>');

function cardVersion(s) {
  const str = [s.artist, s.title, s.venue, s.startDate, s.endDate, s.category, s.likes || 0].join('|');
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function clip(str, max) {
  const chars = Array.from(String(str || ''));
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}
async function loadGoogleFont(weight, text) {
  const url = `https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@${weight}&text=${encodeURIComponent(text)}`;
  const css = await (await fetch(url)).text();
  const m = css.match(/src: url\((.+?)\) format\('(opentype|truetype)'\)/);
  if (!m) throw new Error('폰트를 불러오지 못했습니다.');
  const r = await fetch(m[1]);
  if (!r.ok) throw new Error('폰트를 불러오지 못했습니다.');
  return r.arrayBuffer();
}
const el = (type, style, children) => ({ type, props: { style, children } });

async function renderCardPng(s) {
  const { ImageResponse } = await import('@vercel/og');
  const label = CATEGORY_LABELS[s.category] || s.category;
  const color = CAT_COLORS[s.category] || '#6C5CFC';
  const artist = clip(s.artist, 40);
  const meta = clip(fmtRange(s.startDate, s.endDate) + (s.title ? ' · ' + s.title : '') + (s.venue ? ' · ' + s.venue : ''), 110);
  const likes = String(s.likes || 0);
  const allText = label + artist + meta + likes + 'Sokury…0123456789';
  const [w500, w700, w900] = await Promise.all([
    loadGoogleFont(500, allText), loadGoogleFont(700, allText), loadGoogleFont(900, allText),
  ]);

  const tree = el('div', { width: '100%', height: '100%', display: 'flex', background: '#ffffff', padding: 56, fontFamily: 'Noto Sans KR' }, [
    el('div', { flex: 1, display: 'flex', flexDirection: 'column', background: '#f0f1f6', border: '2px solid #e3e5ec', borderRadius: 40, padding: '64px 72px 52px' }, [
      el('div', { display: 'flex', alignSelf: 'flex-start', background: color, color: '#fff', fontSize: 36, fontWeight: 700, borderRadius: 999, padding: '8px 30px' }, label),
      el('div', { display: 'flex', marginTop: 28, fontSize: 76, fontWeight: 900, color: '#1c1e26', lineHeight: 1.2, maxHeight: 184, overflow: 'hidden' }, artist),
      el('div', { display: 'flex', marginTop: 18, fontSize: 36, fontWeight: 500, color: '#8b8fa3', lineHeight: 1.45, maxHeight: 158, overflow: 'hidden' }, meta),
      el('div', { display: 'flex', marginTop: 'auto', justifyContent: 'space-between', alignItems: 'center' }, [
        el('div', { display: 'flex', alignItems: 'center', fontSize: 36, fontWeight: 700, color: '#E03131' }, [
          { type: 'img', props: { src: HEART_SVG, width: 38, height: 38, style: { marginRight: 12 } } },
          likes,
        ]),
        el('div', { display: 'flex', fontSize: 36, fontWeight: 900, color: '#6C5CFC' }, 'Sokury'),
      ]),
    ]),
  ]);

  const img = new ImageResponse(tree, {
    width: 1200, height: 630,
    fonts: [
      { name: 'Noto Sans KR', data: w500, weight: 500, style: 'normal' },
      { name: 'Noto Sans KR', data: w700, weight: 700, style: 'normal' },
      { name: 'Noto Sans KR', data: w900, weight: 900, style: 'normal' },
    ],
  });
  return Buffer.from(await img.arrayBuffer());
}

async function handleOgImage(req, res, id) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ error: '지원하지 않는 요청입니다.' });
  const list = await readList('schedules');
  const s = id ? list.find((x) => x.id === id) : null;
  const fallback = `/og-${s ? s.category : 'default'}.png`;
  if (!s) { res.setHeader('Location', fallback); return res.status(302).end(); }
  try {
    const png = await renderCardPng(s);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=86400');
    return res.status(200).send(png);
  } catch (e) {
    console.error('카드 이미지 생성 실패:', e && e.message);
    res.setHeader('Location', fallback); // 실패해도 카테고리 이미지로 미리보기는 뜨도록
    return res.status(302).end();
  }
}


// ---------------------------------------------------------------------------
// 구글 로그인 / 세션
//   - 브라우저가 구글 로그인 후 받은 ID 토큰을 구글에 직접 검증받고,
//     서명된 세션 쿠키(sokury_session)를 발급합니다. (값 위조 불가, JS에서 읽을 수 없음)
//   - 관리자 여부: Vercel 환경변수 ADMIN_EMAILS(쉼표로 구분)에 있는 이메일인지로 판단
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const SESSION_COOKIE = 'sokury_session';
const SESSION_DAYS = 30;

function adminEmails() {
  return (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}
function isAdminEmail(email) {
  return !!email && adminEmails().includes(String(email).toLowerCase());
}
function signSession(payload) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) { const e = new Error('SESSION_SECRET 환경변수가 없습니다.'); e.status = 500; throw e; }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function readSession(req) {
  const secret = process.env.SESSION_SECRET;
  const raw = (req.headers && req.headers.cookie) || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + SESSION_COOKIE + '=([^;]+)'));
  if (!secret || !m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch (e) { return null; }
}
function publicUser(p) {
  return p ? { email: p.email, name: p.name, picture: p.picture, isAdmin: isAdminEmail(p.email) } : null;
}

async function handleConfig(req, res) {
  return res.status(200).json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null });
}

async function handleAuth(req, res, action) {
  if (req.method === 'GET') return res.status(200).json({ user: publicUser(readSession(req)) });

  if (req.method === 'POST' && action === 'logout') {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    return res.status(200).json({ user: null });
  }

  if (req.method === 'POST' && action === 'login') {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID 환경변수가 없습니다.' });
    const { credential } = getBody(req);
    if (!credential) return res.status(400).json({ error: '로그인 정보가 없습니다.' });
    // 구글에 토큰이 진짜인지 직접 확인
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
    const t = await r.json().catch(() => ({}));
    const validIss = t.iss === 'accounts.google.com' || t.iss === 'https://accounts.google.com';
    if (!r.ok || t.aud !== clientId || !validIss || String(t.email_verified) !== 'true' || Number(t.exp) * 1000 < Date.now()) {
      return res.status(401).json({ error: '구글 로그인 확인에 실패했습니다.' });
    }
    const payload = {
      sub: t.sub, email: t.email, name: t.name || t.email, picture: t.picture || '',
      exp: Date.now() + SESSION_DAYS * 86400000,
    };
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${signSession(payload)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
    return res.status(200).json({ user: publicUser(payload) });
  }

  return res.status(405).json({ error: '지원하지 않는 요청입니다.' });
}

// 로그인한 사람이 자기 신청 내역만 조회
async function handleMyApplications(req, res) {
  const me = readSession(req);
  if (!me) return res.status(401).json({ error: '로그인이 필요합니다.' });
  const list = await readList('applications');
  const mine = list.filter((a) => a.ownerSub === me.sub).sort((a, b) => b.createdAt - a.createdAt)
    .map(({ ownerSub, ...rest }) => rest);
  return res.status(200).json(mine);
}

async function handleSchedules(req, res, id, action) {
  const m = req.method;

  if (m === 'GET' && !id) {
    return res.status(200).json(await readList('schedules'));
  }

  if (m === 'POST' && id && action === 'like') {
    const list = await readList('schedules');
    const s = list.find((x) => x.id === id);
    if (!s) return res.status(404).json({ error: '일정을 찾을 수 없습니다.' });
    const liked = Boolean(getBody(req).liked);
    s.likes = Math.max(0, (s.likes || 0) + (liked ? 1 : -1));
    await writeList('schedules', list);
    return res.status(200).json({ id: s.id, likes: s.likes });
  }

  if (m === 'POST' && !id && !action) {
    const { startDate, endDate, artist, category, title, note, venue } = getBody(req);
    if (!startDate || !endDate || !artist || !category) {
      return res.status(400).json({ error: '시작일, 종료일, 아티스트, 카테고리는 필수입니다.' });
    }
    const list = await readList('schedules');
    const item = { id: uid('s'), startDate, endDate, artist, category, title: title || '', venue: venue || '', note: note || '', likes: 0, createdAt: Date.now() };
    list.push(item);
    await writeList('schedules', list);
    return res.status(201).json(item);
  }

  if (m === 'PUT' && id) {
    const list = await readList('schedules');
    const i = list.findIndex((x) => x.id === id);
    if (i === -1) return res.status(404).json({ error: '일정을 찾을 수 없습니다.' });
    const b = getBody(req);
    for (const k of ['startDate', 'endDate', 'artist', 'category', 'title', 'venue', 'note']) {
      if (b[k] !== undefined) list[i][k] = b[k];
    }
    await writeList('schedules', list);
    return res.status(200).json(list[i]);
  }

  if (m === 'DELETE' && id) {
    const list = await readList('schedules');
    const next = list.filter((x) => x.id !== id);
    if (next.length === list.length) return res.status(404).json({ error: '일정을 찾을 수 없습니다.' });
    await writeList('schedules', next);
    return res.status(200).json({ deleted: id });
  }

  return res.status(405).json({ error: '지원하지 않는 요청입니다.' });
}

async function handleApplications(req, res, id) {
  const m = req.method;

  if (m === 'GET' && !id) {
    return res.status(200).json(await readList('applications'));
  }

  if (m === 'POST' && !id) {
    const { startDate, endDate, artist, category, name, note, venue } = getBody(req);
    if (!startDate || !endDate || !artist || !category || !name) {
      return res.status(400).json({ error: '시작일, 종료일, 아티스트, 카테고리, 일정은 필수입니다.' });
    }
    const list = await readList('applications');
    const me = readSession(req);
    const item = { id: uid('a'), startDate, endDate, artist, category, name, venue: venue || '', note: note || '', status: 'pending', createdAt: Date.now() };
    if (me) { item.ownerSub = me.sub; item.ownerEmail = me.email; }
    list.push(item);
    await writeList('applications', list);
    return res.status(201).json(item);
  }

  if (m === 'PATCH' && id) {
    const list = await readList('applications');
    const a = list.find((x) => x.id === id);
    if (!a) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });
    const { status } = getBody(req);
    if (status) a.status = status;
    await writeList('applications', list);
    return res.status(200).json(a);
  }

  if (m === 'DELETE' && id) {
    const list = await readList('applications');
    const next = list.filter((x) => x.id !== id);
    if (next.length === list.length) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });
    await writeList('applications', next);
    return res.status(200).json({ deleted: id });
  }

  return res.status(405).json({ error: '지원하지 않는 요청입니다.' });
}


const CATEGORY_LABELS = { regular: '정규', ep: 'EP', single: '싱글', mixtape: '믹스테잎', compilation: '컴필레이션', physical: '피지컬', concert: '콘서트' };
function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtKR(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return `${y}년 ${m}월 ${d}일`;
}
function fmtRange(a, b) { return (!b || a === b) ? fmtKR(a) : `${fmtKR(a)} ~ ${fmtKR(b)}`; }

// 카카오톡·디스코드·X·인스타 DM 등은 링크를 붙여넣으면 이 페이지의 <meta> 태그를 읽어서
// 미리보기 카드를 만듭니다. 사람이 열면 바로 메인 사이트의 해당 일정 팝업으로 이동합니다.
async function handleShare(req, res, id) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${proto}://${host}`;
  const list = await readList('schedules');
  const s = id ? list.find((x) => x.id === id) : null;

  let title = 'Sokury';
  let desc = '좋아하는 아티스트의 앨범, LP, 콘서트 일정을 한 눈에';
  let image = `${origin}/og-default.png`;
  let target = '/';
  if (s) {
    const cat = CATEGORY_LABELS[s.category] || s.category;
    title = s.title ? `${s.artist} - ${s.title}` : s.artist;
    desc = `[${cat}] ${fmtRange(s.startDate, s.endDate)}${s.venue ? ' · ' + s.venue : ''} · ❤️ ${s.likes || 0}`;
    image = `${origin}/og/${encodeURIComponent(s.id)}?v=${cardVersion(s)}`;
    target = `/#/?schedule=${encodeURIComponent(s.id)}`;
  }
  const shareUrl = `${origin}/s/${encodeURIComponent(id || '')}`;

  const html = `<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | Sokury</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Sokury">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(shareUrl)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="ko_KR">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="theme-color" content="#6C5CFC">
<script>location.replace(${JSON.stringify(target)});</script>
</head>
<body style="font-family:sans-serif;padding:40px;text-align:center">
<p>${esc(title)}<br>${esc(desc)}</p>
<p><a href="${esc(target)}">Sokury에서 보기</a></p>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
  return res.status(200).send(html);
}

module.exports = async function handler(req, res) {
  try {
    const q = req.query || {};
    const resource = q.resource;
    const id = q.id || null;
    const action = q.action || null;

    if (resource === 'health') return await handleHealth(req, res);
    if (resource === 'config') return await handleConfig(req, res);
    if (resource === 'auth') return await handleAuth(req, res, action);
    if (resource === 'myapplications') return await handleMyApplications(req, res);
    if (resource === 'share') return await handleShare(req, res, id);
    if (resource === 'ogimage') return await handleOgImage(req, res, id);
    if (resource === 'schedules') return await handleSchedules(req, res, id, action);
    if (resource === 'applications') return await handleApplications(req, res, id);
    return res.status(400).json({ error: 'resource 값이 올바르지 않습니다.' });
  } catch (e) {
    console.error(e && e.message);
    return res.status(e.status || 500).json({ error: e.message || '서버 오류' });
  }
};
