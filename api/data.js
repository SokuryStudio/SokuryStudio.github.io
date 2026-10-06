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
    envNamesFound: envNames, // 값은 절대 보여주지 않고 이름만 보여줍니다
  });
}

const ogKey = (id) => `sokury:og:${id}`;

// 관리자 페이지가 그린 공유 카드 이미지(PNG)를 저장(PUT, 관리자) / 제공(GET, 공개)
async function handleOgImage(req, res, id) {
  if (!id) return res.status(400).json({ error: 'id가 필요합니다.' });
  if (req.method === 'GET') {
    const b64 = await redis(['GET', ogKey(id)]);
    if (!b64) return res.status(404).json({ error: '이미지가 없습니다.' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=86400');
    return res.status(200).send(Buffer.from(b64, 'base64'));
  }
  if (req.method === 'PUT') {
    const { png } = getBody(req);
    const m = typeof png === 'string' && png.match(/^data:image\/png;base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'PNG 이미지가 아닙니다.' });
    if (m[1].length > 900000) return res.status(413).json({ error: '이미지가 너무 큽니다.' });
    const list = await readList('schedules');
    const s = list.find((x) => x.id === id);
    if (!s) return res.status(404).json({ error: '일정을 찾을 수 없습니다.' });
    await redis(['SET', ogKey(id), m[1]]);
    s.ogVersion = Date.now(); // 카톡 등이 예전 이미지를 계속 보여주지 않도록 버전 표시
    await writeList('schedules', list);
    return res.status(200).json({ id, ogVersion: s.ogVersion });
  }
  return res.status(405).json({ error: '지원하지 않는 요청입니다.' });
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
    await redis(['DEL', ogKey(id)]);
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
    const item = { id: uid('a'), startDate, endDate, artist, category, name, venue: venue || '', note: note || '', status: 'pending', createdAt: Date.now() };
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

  let title = 'Sokury — 컴백 · 콘서트 캘린더';
  let desc = '아티스트들의 앨범 발매와 콘서트 일정을 한눈에.';
  let image = `${origin}/og-default.png`;
  let target = '/';
  if (s) {
    const cat = CATEGORY_LABELS[s.category] || s.category;
    title = s.title ? `${s.artist} - ${s.title}` : s.artist;
    desc = `[${cat}] ${fmtRange(s.startDate, s.endDate)}${s.venue ? ' · ' + s.venue : ''} · ❤️ ${s.likes || 0}`;
    image = s.ogVersion
      ? `${origin}/og/${encodeURIComponent(s.id)}?v=${s.ogVersion}`
      : `${origin}/og-${s.category}.png`;
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
