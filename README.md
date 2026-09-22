# Sokury — Vercel 정적 배포 (Middleware로 /admin 잠금)

## 구조

```
sokury-vercel/
├── index.html        # 메인 사이트 (캘린더 + 신청) — 누구나 접근 가능
├── admin/
│   └── index.html    # 관리자 페이지 — /admin 요청은 middleware.js를 먼저 통과해야 함
└── middleware.js      # /admin 경로에 HTTP Basic 인증을 붙이는 Vercel Edge Middleware
```

메인 사이트, 신청 페이지는 지금까지와 똑같이 완전한 정적 파일이고 로그인이 전혀 필요 없어요. `/admin`으로 시작하는 요청만 `middleware.js`를 거칩니다.

## 배포 방법

1. 이 폴더를 그대로 GitHub 저장소로 올리거나, Vercel CLI로 `vercel` 명령을 이 폴더 안에서 실행
2. Vercel 프로젝트 설정 → **Settings → Environment Variables**에서 아래 두 값을 추가
   ```
   ADMIN_USER = 원하는 아이디
   ADMIN_PASSWORD = 원하는 비밀번호
   ```
   (Production/Preview/Development 환경 전부에 넣어두는 걸 권장해요)
3. 배포

배포되면:
- `https://내도메인/` → 바로 열림
- `https://내도메인/admin` → 브라우저가 아이디/비밀번호를 묻는 기본 로그인창을 띄움. `ADMIN_USER`/`ADMIN_PASSWORD`와 일치해야만 페이지가 내려감

## 이번에 반영한 요구사항

- [x] 아이디·비밀번호는 코드에 없음 — `middleware.js`는 `process.env.ADMIN_USER` / `process.env.ADMIN_PASSWORD`만 읽음
- [x] 두 값 중 하나라도 비어 있으면 요청마다 무조건 `500`으로 막음 — "잠금 없이 조용히 통과"되는 경우 자체가 없음 (서버리스라 "시작 시점"이 따로 없어서, 매 요청 때 확인하는 방식으로 같은 효과를 냄)
- [x] `crypto.subtle`(Web Crypto)로 SHA-256 해시를 만든 뒤 상수 시간 비교 — 타이밍 공격 방지
- [x] 실패 시 항상 동일한 메시지("인증이 필요합니다.") — 아이디/비밀번호 구분 없음
- [x] `authHeader`, 입력한 아이디/비밀번호를 어디에도 로그로 남기지 않음

## 실제로 검증한 내용

Node의 표준 `Request`/`Response`/`crypto.subtle` API로 미들웨어 함수만 따로 불러서 직접 테스트했습니다.
- 인증 헤더 없음 → `401`
- 틀린 비밀번호 → `401`
- 맞는 아이디/비밀번호 → 통과 (정상적으로 다음 단계로 넘어감)
- `ADMIN_PASSWORD` 환경변수가 없을 때 → `500` (열린 채로 통과되지 않음)

## 관리자 페이지 쪽 변경

`admin/index.html`, 그리고 `index.html` 안에 내장된 `/admin` 라우트 둘 다 이전에 있던 구글 로그인/비밀번호 게이트 코드를 없앴습니다. 이제 인증은 오직 `middleware.js`가 담당하고, 페이지 자체는 인증이 이미 끝난 뒤에만 내려받아지므로 다시 확인할 필요가 없습니다.

## 로그아웃이 없는 이유

HTTP Basic 인증은 브라우저가 한 번 입력받은 아이디/비밀번호를 자체적으로 기억해뒀다가 같은 사이트에 재요청할 때마다 자동으로 실어 보내는 방식이라, 페이지 안에 "로그아웃" 버튼을 넣어도 정말로 로그아웃시킬 방법이 없어요 (기술적으로는 가능하지만 매우 지저분합니다). 다른 사람 컴퓨터에서 로그인했다면 그 브라우저를 완전히 닫는 게 사실상의 로그아웃입니다.

## 데이터는 여전히 브라우저 저장 방식입니다

지금 이 단계는 "관리자 페이지 접근"만 잠근 것이고, 일정/신청 데이터 자체는 여전히 각자 브라우저의 localStorage에 저장돼요. 방문자와 관리자가 데이터를 실시간으로 공유하게 하려면 이전에 만들어둔 API 백엔드(`admin-basic-auth/` 폴더)와 연동하는 작업이 별도로 필요해요.

## git / GitHub에 올리기

이 폴더는 이미 git 저장소로 초기화되어 있고 첫 커밋까지 되어 있습니다. `.gitignore`가 `.env`, `.vercel` 같은 민감할 수 있는 파일을 커밋 대상에서 자동으로 빼주니, 평소처럼 `git add .` 해도 안전합니다.

```bash
# GitHub에 새 저장소를 만든 다음 (비어있는 저장소로),
git remote add origin <새로 만든 저장소 주소>
git branch -M main
git push -u origin main
```

그 다음 Vercel에서 "Import Git Repository"로 이 저장소를 그대로 연결하면, GitHub에 푸시할 때마다 자동으로 재배포됩니다. `ADMIN_USER`/`ADMIN_PASSWORD`는 GitHub가 아니라 **Vercel 프로젝트 환경변수 화면에만** 넣으세요 — `.env.example`은 어떤 이름이 필요한지 보여주는 빈 예시일 뿐입니다.

