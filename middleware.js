// middleware.js — Vercel Edge Middleware
//
// /admin 경로만 HTTP Basic 인증으로 막습니다. 그 외 경로(메인 사이트, 신청 페이지)는
// 그대로 통과합니다. 비밀번호는 ADMIN_USER / ADMIN_PASSWORD 환경변수로만 읽고,
// 이 파일 어디에도 실제 값을 적지 않습니다 — Vercel 대시보드에서 직접 넣으세요.

export const config = {
  matcher: ['/admin', '/admin/:path*'],
};

const REALM = 'Admin Area';
// 아이디가 틀렸는지 비밀번호가 틀렸는지 구분하지 않는 단 하나의 메시지.
const GENERIC_MESSAGE = '인증이 필요합니다.';

function unauthorized() {
  return new Response(GENERIC_MESSAGE, {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

// Edge Runtime에는 Node의 crypto.timingSafeEqual이 없어서, Web Crypto로
// 고정 길이(SHA-256, 32바이트) 해시를 만든 뒤 상수 시간으로 비교합니다.
async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function base64Decode(base64) {
  // atob은 Edge Runtime에서 전역으로 사용 가능합니다.
  try {
    return atob(base64);
  } catch (e) {
    return null;
  }
}

export default async function middleware(request) {
  const adminUser = process.env.ADMIN_USER;
  const adminPassword = process.env.ADMIN_PASSWORD;

  // 환경변수가 비어 있으면 "잠금 없이 조용히 통과"시키지 않고 무조건 막습니다.
  // (서버리스 환경엔 "시작 시점"이 따로 없으므로, 매 요청마다 확인해서
  //  절대 인증 없이 열리는 일이 없게 합니다.)
  if (!adminUser || !adminPassword) {
    return new Response(
      '서버 설정 오류: ADMIN_USER / ADMIN_PASSWORD 환경변수가 설정되지 않았습니다.',
      { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }

  const authHeader = request.headers.get('authorization') || '';
  if (!authHeader.startsWith('Basic ')) {
    return unauthorized();
  }

  const decoded = base64Decode(authHeader.slice('Basic '.length).trim());
  if (decoded === null) return unauthorized();

  const sepIndex = decoded.indexOf(':');
  if (sepIndex === -1) return unauthorized();

  const inputUser = decoded.slice(0, sepIndex);
  const inputPassword = decoded.slice(sepIndex + 1);

  const [userHash, expectedUserHash, passHash, expectedPassHash] = await Promise.all([
    sha256(inputUser),
    sha256(adminUser),
    sha256(inputPassword),
    sha256(adminPassword),
  ]);

  // 둘 다 항상 계산한 뒤 합쳐서 판단 — "아이디가 틀리면 더 빨리 끝난다" 같은
  // 타이밍 차이를 만들지 않습니다.
  const userOk = timingSafeEqualBytes(userHash, expectedUserHash);
  const passOk = timingSafeEqualBytes(passHash, expectedPassHash);

  if (!(userOk && passOk)) {
    // 여기서 authHeader, inputUser, inputPassword를 로그로 남기지 마세요.
    return unauthorized();
  }

  // 통과 — 이후 정적 파일(/admin/index.html)이 그대로 내려갑니다.
}
