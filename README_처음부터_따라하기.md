# 유튜브 LIVE 자동 감지 홈페이지 — 처음부터 따라하기

이 파일은 사용자가 보여준 스크린샷처럼 멤버별 **유튜브 방송 상태 카드**를 표시합니다.
**중요:** 아직 실제 채널 주소와 본인의 API 키가 없으므로 실시간 데이터 연동은 실제로 실행해 보지 못했습니다. 아래 2~5단계를 마치면 서버가 자동 확인을 시작합니다.

## 1. 어떤 파일이 있나요?

- `public/index.html` — 홈페이지 디자인(모바일 2열, PC 4열)
- `public/assets/` — 사용자가 제공한 스크린샷에서 추출한 데모용 배너·썸네일
- `config/members.json` — 멤버 이름 / 유튜브 채널 설정 (이 파일을 편집하세요)
- `server.js` — YouTube Data API를 사용해 LIVE 여부를 주기적으로 확인하는 서버
- `package.json` — Node.js 실행 설정
- `render.yaml` — Render 자동 배포 설정
- `.env.example` — 환경변수 이름 참고용 **예시** (실제 키를 넣어서 GitHub에 올리면 안 됩니다)

## 2. 멤버의 유튜브 채널을 등록하세요 (가장 먼저!)

`config/members.json` 파일을 열어 `channel`에 각 유튜브 채널의 ID 또는 핸들을 적습니다.

예시(아래 `@examplechannel`은 실제 계정이 아니라 형식 예시입니다):

```json
[
  {"id":"kim", "name":"김인환 대표님", "channel":"@examplechannel", "tag":"대표"},
  {"id":"cha", "name":"차윤현", "channel":"UCxxxxxxxxxxxxxxxxxxxxxx", "tag":"멤버"}
]
```

- `channel`에는 `@채널핸들` 또는 `UC`로 시작하는 **24자 채널 ID**를 입력합니다.
- 유튜브 주소가 `https://www.youtube.com/@examplechannel`인 경우 `@examplechannel` 부분만 넣습니다.
- 채널 ID 주소가 `https://www.youtube.com/channel/UC...`인 경우 `UC...` 부분만 넣습니다.
- 채널을 아직 모르면 `"channel":""` 상태로 남겨둘 수 있지만 해당 멤버는 '미설정'으로 표시됩니다.
- JSON 편집 중 따옴표(`"`)·쉼표(`,`)를 빼먹지 않도록 주의하세요.
- **실제 유튜브 링크를 모르는 상태에서 멤버를 임의로 연결하지 마세요.**

## 3. 무료 YouTube Data API 키 만들기

1. https://console.cloud.google.com/ 접속 후 Google 계정으로 로그인
2. 상단 프로젝트 선택 > **새 프로젝트** 만들기
3. **API 및 서비스 > 라이브러리**에서 `YouTube Data API v3` 검색 > **사용**
4. **API 및 서비스 > 사용자 인증 정보**에서 **사용자 인증 정보 만들기 > API 키** 선택
5. API 키 설정에서 **API 제한 사항**을 `YouTube Data API v3`로 제한하세요. 서버에서 호출하기 때문에 **웹사이트 HTTP 리퍼러만 허용하는 제한**을 걸면 호출이 실패할 수 있습니다. 적용 가능한 제한은 운영 상황에 따라 설정하세요.
6. 생성된 키를 안전한 곳에 복사합니다. **GitHub 코드/HTML/스크린샷/대화에 키를 공개하지 마세요.**

공식 문서: https://developers.google.com/youtube/data/guides/authentication

## 4. GitHub에 코드 올리기

1. https://github.com 에 회원가입/로그인
2. `New repository` 클릭
3. 저장소 이름 예: `youtube-live-label`, 공개 또는 비공개 중 선택
4. `Add file > Upload files` 클릭
5. 압축파일 자체가 아니라 **ZIP을 풀었을 때 나오는 안쪽 파일들**을 업로드합니다. 반드시 `server.js`와 `package.json`이 **저장소 최상단(root)** 에 있어야 합니다.
6. `config` 폴더와 `public` 폴더도 그대로 보존합니다.
7. `Commit changes` 클릭
8. `.env` 파일이나 진짜 API 키는 절대 업로드하지 마세요.

## 5. Render에 배포하기

1. https://dashboard.render.com 접속 후 GitHub 계정 연결
2. `New` > `Web Service` 클릭 (중요: `Static Site`가 아닙니다)
3. 4단계에서 만든 저장소 선택
4. 이름 예: `my-youtube-live-label`, Runtime: **Node**, Plan: **Free**(테스트용) 선택
5. Build Command: `npm install --omit=dev`
6. Start Command: `npm start`
7. **Environment**에서 새 변수 추가:
   - Key: `YOUTUBE_API_KEY`
   - Value: 본인이 발급받은 Google API 키 (다른 사람에게 보내지 않기)
8. `Create Web Service` 또는 `Deploy Web Service` 클릭
9. 배포가 성공하면 `https://내서비스명.onrender.com` 같은 주소를 받습니다.
10. 접속 직후 채널 조회가 완료되기 전에는 '확인 중'이 잠깐 표시될 수 있습니다.

참고: Render 무료 Web Service는 15분 동안 요청이 없으면 절전 상태가 되며, 다음 방문 시 약 1분의 시동 시간이 있을 수 있습니다. **24시간 지속 모니터링 또는 즉각적인 알림이 보장되지 않습니다.**

## 6. 어떻게 방송 상태를 자동 감지하나요?

- 페이지는 `/api/live`를 **1분마다** 불러옵니다. 방문자가 많아도 YouTube API를 매번 직접 호출하지 않고 서버 캐시를 사용합니다.
- 서버는 채널별 `uploads` 재생목록을 **약 10분마다** 확인해서 새 동영상 후보를 수집합니다.
- 이미 발견된 영상의 `liveBroadcastContent` 상태를 **약 2분마다** 확인합니다. LIVE 종료 여부를 더 빨리 반영합니다.
- YouTube Data API `search.list`를 사용해 멤버 한 명씩 정확하게 현재 방송을 검색합니다. **현재 기본 검색 한도는 하루 100회**이므로, 이 예제는 **하루 80회 이하**로 제한하며 18분마다 한 채널씩 순환 검색합니다.
  - 1명 등록: 새로운 방송을 검색으로 발견하는 데 약 18분까지 걸릴 수 있습니다.
  - 6명 등록: 같은 채널을 다시 검색하는 주기가 약 108분입니다.
  - 16명 등록: 같은 채널을 다시 검색하는 주기가 약 288분입니다.
  - 단, 업로드 목록에 방송 영상이 조기에 나타나면 더 빨리 발견할 수 있습니다. 반대로 **LIVE가 업로드 재생목록에 즉시 표시된다는 보장은 없어서** 지연이 더 길 수 있습니다.
- 검색 결과가 늦게 반영되는 경우도 있습니다. 이 구현을 '초 단위 진짜 실시간'으로 설명해서는 안 됩니다.
- YouTube 쿼터는 Google Cloud 프로젝트별로 적용되므로 같은 프로젝트에서 다른 앱도 API를 사용한다면 남은 할당량이 적을 수 있습니다.
- Google Cloud 콘솔에서 추가 검색 할당량을 신청할 수 있지만 승인·비용·조건은 Google 정책에 따릅니다. 서버 코드의 `SEARCH_DAILY_BUDGET`은 승인 없이 100을 초과하도록 설정하지 마세요.
- 무료 Render는 절전·재시작이 잦고 서버 메모리 캐시는 초기화되므로 계속 실행되는 운영 서버를 권장합니다.

공식 출처:
- YouTube 검색 API: https://developers.google.com/youtube/data/reference/rest/v3/search/list
- YouTube API 한도: https://developers.google.com/youtube/data/getting-started
- Render 무료 서비스: https://render.com/docs/free

## 7. 디자인 먼저 확인하고 싶다면

사이트 주소 뒤에 `?demo=1`을 붙여보세요. 예: `https://내서비스명.onrender.com/?demo=1`

이 경우 차윤현·안재현의 화면이 예시로 LIVE 표시됩니다. **실제 방송과 관계없는 데모 화면**입니다. 정상 홈페이지 `/`에서는 유튜브 API로 확인한 상태만 표시합니다.

## 8. 멤버 이름/사진을 바꾸고 싶다면

- 멤버 이름: `config/members.json`의 `name`
- 멤버 추가/삭제: 같은 파일에서 항목 추가/삭제
- 배너: `public/assets/banner.jpg`를 동일한 파일명으로 교체
- 라이브 썸네일: 실제 운영에서는 YouTube 공식 API에서 받아와 자동 표시
- 데모 이미지: `public/assets/cha-live.jpg`, `ahn-live.jpg`는 사용자가 제공한 스크린샷에서 추출한 참고 이미지이므로 본인의 권한 범위 안에서 사용하세요.

## 문제 해결

- 전부 '미설정': `config/members.json`의 `channel` 값을 입력하지 않았습니다.
- 상단에 'API 키 필요': Render Environment에 `YOUTUBE_API_KEY`가 빠져 있습니다.
- '확인 실패': 채널 핸들 오탈자, 잘못된 키, API 사용 설정 누락, 할당량 소진 등을 확인하세요. Render Logs도 확인하세요.
- 방송 중인데 OFFLINE: 유튜브 목록 반영 지연 또는 검색 순환 지연일 수 있습니다. 100회/일 제한 안에서는 모든 채널을 1분마다 정확히 검색할 수 없습니다.
- Render에서 배포 실패: `server.js`와 `package.json`이 최상위 경로에 있는지 확인하세요.
- 설정을 고친 후: GitHub에서 Commit하면 Render 자동 재배포(설정에 따라)를 진행합니다.

## 로컬에서 실행하기(선택)

Node.js 20 이상을 설치하고 프로젝트 폴더에서 다음 명령을 실행하세요.

```bash
# Mac/Linux
YOUTUBE_API_KEY='실제_키' npm start

# Windows PowerShell
$env:YOUTUBE_API_KEY='실제_키'; npm start
```

그다음 http://localhost:3000 접속. 키가 없어도 `npm start`를 실행해 디자인 데모 `http://localhost:3000/?demo=1`을 볼 수 있습니다.
