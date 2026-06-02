# 🛡️ 다크나이트 (Dark Knight) - LMS 미디어 익스트랙터 MVP

LMS(학습 관리 시스템)의 동영상 시청 및 스트리밍 환경에서 미디어를 정밀 식별하고, 브라우저 다층 보안 체계를 무력화하며 무손실 원본(.mp4 / .ts)을 안정적으로 소장할 수 있도록 설계된 크롬 확장 프로그램 프로토타입(MVP)입니다.

This is a Chrome Extension Prototype (MVP) designed to scan, manage, and download lossless university LMS stream videos (.mp4 / .ts) by bypassing modern multi-layered browser security systems.

---

## 🛠️ 제공하는 핵심 기능 (Core MVP Features)

1. **지능형 네트워크 스니퍼 (`background.js`)**
   - 백그라운드 네트워크 레이어에서 흐르는 미디어 스트림 주소를 실시간 식별합니다.
2. **동일 출처 프레임 스캐너 (`content.js` injected in iframe)**
   - 플레이어가 호스팅되는 동일 출처 도메인(`hducc.handong.edu`) 내부를 역추적하여 진짜 스트림/MP4 소스를 직접 Crawling합니다.
3. **CORS/CSP & SameSite 쿠키 보안 우회 Fetcher**
   - iframe 컨텐트 스크립트 위임 패치 방식으로 브라우저가 사용자 로그인 세션 쿠키를 패킷에 자연스럽게 동봉하게끔 만들어 CORS/SameSite 제한을 무너뜨립니다.
4. **아이프레임 샌드박스 우회 다운로드 엔진 (frameId: 0 Relay)**
   - iframe 샌드박스의 로컬 다운로드 차단 정책을 회피하기 위해 최상위 메인 프레임(`frameId: 0`)으로 바이너리 버퍼(`ArrayBuffer`)를 릴레이하여 가상 앵커 클릭 방식으로 소장을 보장합니다.
5. **공상과학(Sci-Fi) HUD 다크 스타일 테마 UI**
   - 글래스모피즘(Glassmorphism)과 네온 테마가 조합된 고급 팝업창에서 감지 목록 확인, 고속 병합 진행률 모달, 1클릭 다운로드 기능을 제공합니다.

---

## ⚠️ 미해결 과제 및 아키텍처 한계 (Technical Debt & Limitations)

현재 구현된 프로토타입은 **오프라인 동작이 가능한 로컬 클라이언트 독립형 모델**로, 상용화를 위해서는 아래 명시된 기술적 한계를 보완해야 합니다:

1. **클라이언트 사이드 검증의 취약성 (Client-Side Storage Vulnerability)**:
   - 일일 무료 다운로드 횟수 제한(3회)이나 요금제 결제 정보가 로컬 스토리지에만 존재할 경우, 사용자가 크롬 개발자 도구(F12) 콘솔에서 스토리지를 직접 조작하거나 확장 프로그램을 단순 삭제 후 재설치하여 손쉽게 다운로드 한도를 영구히 무력화할 수 있습니다.
2. **동영상 단독 페이지 실행 시의 세션 감지**:
   - 사용자가 LMS 강의실 외부에서 비디오 단독 링크로 직접 접근할 경우, 백그라운드 서비스 워커의 감지 규칙이 탭 상태와 어긋날 수 있으므로 항상 강의실을 통해 플레이어를 구동시키는 시나리오가 확실히 유도되어야 합니다.
3. **네트워크 대역폭 점유 및 대용량 파일 지연**:
   - 로컬 메모리상에서 고속으로 TS 조각들을 ArrayBuffer 배열에 적재하고 병합하므로, 영화나 2시간이 넘는 대용량 동영상의 경우 브라우저 탭 메모리 오버플로우(Out of Memory) 현상 또는 병합 단계에서의 프레임 딜레이가 일어날 수 있습니다.

---

## 🚀 향후 대표님이 완료해야 할 개발 로드맵 (Future Actions for SaaS Launch)

본 로컬 프로토타입을 완전한 상용 SaaS 과금 모델로 전환하기 위해 후속으로 설계 및 구축해야 할 필수 작업 목록입니다.

### 1단계: Firebase Auth + Firestore 보안 데이터베이스 결합
- **목적**: 유저별 인증 및 불법 크레딧 자가 복제/조작 차단.
- **작업 내용**:
  - `popup.html` 및 `popup.js` 내에 Google Firebase Client SDK 연동 및 구글 로그인 버튼 배치.
  - NoSQL Database (Firestore)에 `users` 컬렉션을 설계하여 유저별 크레딧(`credits`)과 `dailyFreeDownloads` 잔량을 보안 관리.
  - 데이터 증감 연산은 로컬에서 절대 수정 불가하도록 외부 클라우드 함수(Firebase Cloud Functions) API 엔드포인트로 전적으로 격리.

### 2단계: PG 결제 연동 라우터 구축
- **목적**: 유저가 다운로드 권한/크레딧을 자동 충전하고 정기 구독권을 구매할 수 있는 결제망 연동.
- **작업 내용**:
  - 토스페이먼츠(Toss Payments), Stripe 또는 아임포트(PortOne) 결제 연동 스크립트 설계.
  - 결제 완료 시 결제 승인 결과를 받아 Firestore의 유저 크레딧을 안전하게 증산해 주는 가상 결제 승인 API(Webhook) 미들웨어 백엔드 연동.

### 3단계: AWS Lambda 기반 서버 사이드 프록시 다운로더로 전향
- **목적**: 동영상 추출 핵심 소스 코드 유출 원천 차단 및 클라이언트 오버헤드 다운타임 최소화.
- **작업 내용**:
  - 확장 프로그램에서 직접 무거운 청크 다운로드 및 머지 연산을 돌리는 대신, 스니핑된 미디어 URL과 유저 인증 세션 헤더 정보만을 백엔드 서버(AWS Lambda 등)로 POST 요청.
  - 백엔드가 고성능 네트워크 망에서 ReadyStream 동영상을 대신 긁어 병합한 뒤 완성된 `.mp4` 완성본 바이너리를 암호화 임시 보관(AWS S3) 처리.
  - 다운로더 팝업창은 보안 서명된 다운로드 주소(Signed URL)만을 수령하여 1초 만에 깔끔하고 안전하게 다이렉트 소장을 실행하는 구조로 전환.

---

## 📖 학습 및 상세 분석서 안내

보안 아키텍처 우회(CORS, CSP, SameSite, Iframe Sandbox) 및 dynamic DNR 헤더 주입의 상세 교과서적 기술 배경과 소스 코드 라인별 심층 분석 내용은 다음 리포트에 매우 상세히 기술되어 있습니다. 대학생 대표님의 학술적 성장에 큰 나침반으로 삼아보시기 바랍니다.

- **상세 코드리뷰 및 분석 보고서**: [report.md](file:///c:/Users/_%20%EB%8C%80%20%EC%84%B1/Desktop/%EC%99%B8%EC%A3%BC/dark-knight/report.md)
