# Claude Deck

Claude Code 세션을 여러 개 띄워놓고 일하기 위한 Windows 터미널입니다.
탭은 왼쪽에 세로로 쌓이고, 로컬 폴더든 SSH 서버 폴더든 골라서 바로 `claude`를 켭니다.

## 실행

Windows 10/11, Node.js 20 이상이 필요합니다.

```
git clone https://github.com/gwmage/claude-deck.git
cd claude-deck
npm install
npm start
```

`npm install` 중 Electron 바이너리가 안 받아졌다면 `node node_modules/electron/install.js`를 한 번 실행하세요.
바로가기를 만들려면 대상을 `node_modules\electron\dist\electron.exe`, 인수를 이 폴더 경로로 지정하면 됩니다.

## 할 수 있는 것

**세션**
- 좌측 세로 탭, 서버별로 묶어서 표시. 탭에는 닫기 버튼이 없고 `⋯` 메뉴나 `Ctrl+Shift+W`로만 닫으며, 실행 중이면 한 번 더 묻습니다.
- 상태 점: 파랑(작업 중), 초록(입력 대기), 주황(다른 탭에서 응답 완료, 확인 필요), 회색 테두리(종료).
- 창이 뒤에 있을 때 오래 걸린 응답이 끝나면 Windows 알림을 띄웁니다.
- 앱을 껐다 켜면 탭 목록이 복원되고 `이어서 시작`(claude --continue)으로 한 번에 재개합니다.
- 빠른 실행: 자주 쓰는 "서버 + 폴더 + 명령" 조합을 저장해두고 클릭 한 번으로 실행.

**원격 서버**
- `~/.ssh/config`의 Host 항목을 자동으로 읽습니다. 직접 추가도 가능 (서버 관리).
- 한 서버에 탭을 여러 개 열어도 SSH 연결은 하나를 공유합니다. 인증도 한 번.
- 원격 폴더는 새 세션 창의 `찾아보기…`로 서버 디렉터리를 탐색해서 고릅니다.
- 첫 접속 때 서버 지문을 확인하고, `known_hosts`에 있으면 그대로 통과합니다.

**파일 보기 (원격도 동일)**
- 터미널에 찍힌 파일 경로를 클릭하면 바로 열립니다. 원격이면 SFTP로 받아서 엽니다.
- 파일 패널(`Ctrl+Shift+E`) `최근 변경` 탭: 이 세션을 시작한 뒤 만들어지거나 바뀐 파일 목록. 새 문서가 생기면 우측 하단 알림으로 알려줍니다.
- 뷰어: Markdown 렌더링, HTML, PDF, 이미지, CSV 표, JSON, 코드/텍스트, 동영상. 오피스·한글 파일은 외부 앱으로 엽니다.
- `@` 버튼으로 파일을 Claude 입력창에 `@경로` 형태로 넣을 수 있습니다.

**붙여넣기 / 드래그**
- `Ctrl+V`로 이미지(스크린샷) 붙여넣기. 원격 세션이면 서버 `~/.claude-deck/uploads/`로 올리고 그 경로를 넣어줍니다.
- 탐색기에서 파일을 끌어다 놓아도 똑같이 동작합니다.
- `Shift+Enter`는 Claude 입력창 줄바꿈.

## 단축키

| 키 | 동작 |
|---|---|
| Ctrl+Shift+T | 새 세션 |
| Ctrl+Shift+W | 세션 닫기 (확인) |
| Ctrl+1 ~ 9, Ctrl+Tab | 탭 이동 |
| Ctrl+Shift+E | 파일 패널 |
| Ctrl+C (선택 있을 때), 우클릭 | 복사 / 붙여넣기 |
| Ctrl+= / Ctrl+- / Ctrl+0 | 글꼴 크기 |
| F12 | 개발자 도구 |

## 구조

- `main.js`: 로컬 셸(node-pty, ConPTY), SSH(ssh2), SFTP 파일 전송, 설정 저장
- `preload.js`: 렌더러에 노출하는 API
- `renderer/`: UI (xterm.js)
- 설정 파일: `%APPDATA%\claude-deck\config.json`
- 원격 파일 캐시: `%TEMP%\claude-deck\`
