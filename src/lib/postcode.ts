import type { SearchArea } from './search';

export interface SelectedAddress extends SearchArea {
  address: string;
  zonecode: string;
}

interface PostcodeData {
  address: string;
  roadAddress: string;
  jibunAddress: string;
  userSelectedType: string;
  zonecode: string;
  sido: string;
  sigungu: string;
  sigunguCode: string;
  bname: string;
  bname1: string;
  bcode: string;
}

interface PostcodeOptions {
  oncomplete: (data: PostcodeData) => void;
  onresize?: (size: { width: number; height: number }) => void;
  width: string;
  height: string;
  focusInput: boolean;
  submitMode: boolean;
}

interface PostcodeNamespace {
  Postcode: new (options: PostcodeOptions) => {
    embed: (element: HTMLElement, options: { autoClose: boolean }) => void;
  };
}

declare global {
  interface Window {
    kakao?: PostcodeNamespace;
    daum?: PostcodeNamespace;
  }
}

let sdkPromise: Promise<PostcodeNamespace> | undefined;

export function loadPostcode(): Promise<PostcodeNamespace> {
  const available = window.kakao?.Postcode ? window.kakao : window.daum;
  if (available?.Postcode) return Promise.resolve(available);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<PostcodeNamespace>((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = setTimeout(() => fail(), 12_000);
    const fail = () => {
      clearTimeout(timeout);
      script.remove();
      sdkPromise = undefined;
      reject(new Error('주소 검색 서비스에 연결하지 못했어요. 잠시 후 다시 시도해주세요.'));
    };
    script.src = 'https://t1.kakaocdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js';
    script.async = true;
    script.onerror = fail;
    script.onload = () => {
      const api = window.kakao?.Postcode ? window.kakao : window.daum;
      if (!api?.Postcode) return fail();
      clearTimeout(timeout);
      resolve(api);
    };
    document.head.append(script);
  });
  return sdkPromise;
}

export function selectedAddress(data: PostcodeData): SelectedAddress {
  return {
    address: (data.userSelectedType === 'R' ? data.roadAddress : data.jibunAddress) || data.address,
    zonecode: data.zonecode,
    sido: data.sido,
    sigungu: data.sigungu,
    sigunguCode: data.sigunguCode,
    bname: data.bname1 || data.bname,
    bcode: data.bcode
  };
}

export type PostcodeStatus = 'loading' | 'retrying' | 'ready' | 'error';
interface PostcodeEvents {
  status: (state: PostcodeStatus, message?: string) => void;
  complete: (data: PostcodeData) => void;
}

// Keep SDK lifecycle separate from the dialog so delayed callbacks can be tested.
export function createPostcodeSearch({ load = loadPostcode, timeoutMs = 8_000 } = {}) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let container: HTMLElement | undefined;
  const stopTimer = () => { clearTimeout(timer); timer = undefined; };
  const close = () => {
    generation += 1;
    stopTimer();
    container?.replaceChildren();
    container = undefined;
  };
  return {
    async open(element: HTMLElement, events: PostcodeEvents) {
      close();
      const session = generation;
      container = element;
      events.status('loading');
      try {
        const sdk = await load();
        if (session !== generation) return;
        let activeAttempt = 0;
        const render = (attempt: number) => {
          activeAttempt = attempt;
          let ready = false;
          let completed = false;
          const current = () => session === generation && attempt === activeAttempt;
          const fail = () => {
            if (!current()) return;
            activeAttempt += 1;
            stopTimer();
            element.replaceChildren();
            events.status('error', '주소 검색 화면에 연결하지 못했어요. 다시 시도해주세요. 계속 열리지 않으면 일반 브라우저에서 이 페이지를 열어주세요.');
          };
          element.replaceChildren();
          if (attempt > 0) events.status('retrying');
          timer = setTimeout(() => {
            if (!current() || ready) return;
            if (attempt === 0) render(1);
            else fail();
          }, timeoutMs);
          try {
            new sdk.Postcode({
              width: '100%', height: '100%', focusInput: true, submitMode: false,
              // The real iframe sends an initial resize after its own UI initializes.
              // Script.onload and iframe.onload alone are not proof that it is usable.
              onresize: (size) => {
                if (!current() || ready || size.width <= 0 || size.height <= 0) return;
                ready = true;
                stopTimer();
                events.status('ready');
              },
              oncomplete: (data) => {
                if (!current() || completed) return;
                completed = true;
                stopTimer();
                events.complete(data);
              }
            }).embed(element, { autoClose: false });
          } catch { fail(); }
        };
        render(0);
      } catch {
        if (session === generation) events.status('error', '주소 검색 서비스에 연결하지 못했어요. 다시 시도해주세요.');
      }
    },
    close
  };
}
