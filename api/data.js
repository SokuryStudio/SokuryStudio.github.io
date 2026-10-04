// api/data.js — Sokury 데이터 API (이 파일 하나가 모든 데이터 처리를 담당합니다)
//
// 주소 형식: /api/data?resource=...&id=...&action=...
//   GET    ?resource=health                         진단: DB 연결 상태 확인 (공개)
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
    const { startDate, endDate, artist, category, title, note } = getBody(req);
    if (!startDate || !endDate || !artist || !category) {
      return res.status(400).json({ error: '시작일, 종료일, 아티스트, 카테고리는 필수입니다.' });
    }
    const list = await readList('schedules');
    const item = { id: uid('s'), startDate, endDate, artist, category, title: title || '', note: note || '', likes: 0, createdAt: Date.now() };
    list.push(item);
    await writeList('schedules', list);
    return res.status(201).json(item);
  }

  if (m === 'PUT' && id) {
    const list = await readList('schedules');
    const i = list.findIndex((x) => x.id === id);
    if (i === -1) return res.status(404).json({ error: '일정을 찾을 수 없습니다.' });
    const b = getBody(req);
    for (const k of ['startDate', 'endDate', 'artist', 'category', 'title', 'note']) {
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
    const { startDate, endDate, artist, category, name, note } = getBody(req);
    if (!startDate || !endDate || !artist || !category || !name) {
      return res.status(400).json({ error: '시작일, 종료일, 아티스트, 카테고리, 일정은 필수입니다.' });
    }
    const list = await readList('applications');
    const item = { id: uid('a'), startDate, endDate, artist, category, name, note: note || '', status: 'pending', createdAt: Date.now() };
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

module.exports = async function handler(req, res) {
  try {
    const q = req.query || {};
    const resource = q.resource;
    const id = q.id || null;
    const action = q.action || null;

    if (resource === 'health') return await handleHealth(req, res);
    if (resource === 'schedules') return await handleSchedules(req, res, id, action);
    if (resource === 'applications') return await handleApplications(req, res, id);
    return res.status(400).json({ error: 'resource 값이 올바르지 않습니다.' });
  } catch (e) {
    console.error(e && e.message);
    return res.status(e.status || 500).json({ error: e.message || '서버 오류' });
  }
};
