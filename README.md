# 딥 씨 크루 프로토타입 (독립 배포 버전)

Claude 없이, 친구들이 링크만 열면 로그인 없이 바로 참여할 수 있는 버전입니다.
Firebase Realtime Database + 익명 인증을 사용합니다.

## 1. Firebase 설정값 채우기

`src/firebase.js` 파일을 열어 `firebaseConfig` 안의 값들을
Firebase 콘솔 > 프로젝트 설정 > 일반 > 내 앱(웹) 에서 복사한 값으로 바꿔주세요.

## 2. Realtime Database 보안 규칙 설정

Firebase 콘솔 > Realtime Database > 규칙 탭에서 아래처럼 바꿔주세요.
(테스트 모드 그대로 두면 일정 시간 뒤 자동으로 잠기니 꼭 바꿔주세요.)

```json
{
  "rules": {
    "rooms": {
      ".read": "auth != null",
      ".write": "auth != null"
    }
  }
}
```

## 3. 로컬에서 실행해보기

```bash
npm install
npm run dev
```

터미널에 나오는 주소(보통 http://localhost:5173)를 브라우저에서 열면 확인할 수 있어요.

## 4. 실제 배포하기 (Vercel 예시)

1. https://vercel.com 가입 (깃허브 계정으로 가능)
2. 이 프로젝트 폴더를 깃허브 저장소로 올리기
3. Vercel에서 "Add New Project" → 방금 올린 저장소 선택 → Deploy
4. 몇 분 뒤 `https://your-project.vercel.app` 같은 실제 주소가 생성됨
5. 이 주소를 친구들에게 링크로 공유하면 끝 — 가입도, 클로드 로그인도 필요 없음

## 참고

- 지금 버전은 기본 카드 분배 + 트릭 진행만 구현되어 있고, 미션 카드 시스템은 아직 없어요.
- 방 데이터는 Firebase Realtime Database에 저장되고, 실시간으로 동기화돼요 (새로고침해도 방 코드로 다시 들어오면 이어짐 — 단, 내 플레이어 식별은 브라우저의 익명 로그인 세션에 연결되어 있어서, 다른 브라우저/시크릿창으로 들어오면 새 참가자로 인식돼요).
