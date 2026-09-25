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
  onsearch?: (data: { q: string; count: number }) => void;
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
let sdkOwner: object | undefined;

export function loadPostcode(): Promise<PostcodeNamespace> {
  const available = window.kakao?.Postcode ? window.kakao : window.daum;
  if (available?.Postcode) return Promise.resolve(available);
  if (sdkPromise) return sdkPromise;
  const owner = {};
  let resolveLoad!: (api: PostcodeNamespace) => void;
  let rejectLoad!: (error: Error) => void;
  const pending = new Promise<PostcodeNamespace>((resolve, reject) => {
    resolveLoad = resolve;
    rejectLoad = reject;
  });
  // Install ownership before touching the DOM, including synchronous failures.
  sdkPromise = pending;
  sdkOwner = owner;
  let settled = false;
  let script: HTMLScriptElement | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    clearTimeout(timeout);
    if (script) { script.onload = null; script.onerror = null; }
  };
  const fail = () => {
    if (settled) return;
    settled = true;
    cleanup();
    script?.remove();
    // A late callback from an abandoned script cannot reset a newer request.
    if (sdkOwner === owner) { sdkPromise = undefined; sdkOwner = undefined; }
    rejectLoad(new Error('주소 검색 서비스에 연결하지 못했어요. 잠시 후 다시 시도해주세요.'));
  };
  try {
    script = document.createElement('script');
    timeout = setTimeout(fail, 12_000);
    script.src = 'https://t1.kakaocdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js';
    script.async = true;
    script.onerror = fail;
    script.onload = () => {
      if (settled) return;
      const api = window.kakao?.Postcode ? window.kakao : window.daum;
      if (!api?.Postcode) return fail();
      settled = true;
      cleanup();
      resolveLoad(api);
    };
    document.head.append(script);
  } catch { fail(); }
  return pending;
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

export type PostcodeStatus = 'loading' | 'delayed' | 'ready' | 'error';
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
        let active = true;
        let ready = false;
        const current = () => session === generation && active;
        const markReady = () => {
          if (!current() || ready) return;
          ready = true;
          stopTimer();
          events.status('ready');
        };
        const fail = () => {
          if (!current()) return;
          active = false;
          stopTimer();
          element.replaceChildren();
          events.status('error', '주소 검색 화면을 열지 못했어요. 다시 시도해주세요. 계속 열리지 않으면 일반 브라우저에서 이 페이지를 열어주세요.');
        };
        element.replaceChildren();
        timer = setTimeout(() => {
          if (!current() || ready) return;
          timer = undefined;
          // No callback is not proof of a broken iframe. Keep any visible form
          // and entered text intact; only an explicit open() replaces it.
          events.status('delayed', '주소 검색 화면의 응답 확인이 늦어지고 있어요. 화면이 보이면 그대로 검색해주세요. 비어 있으면 다시 시도하거나 일반 브라우저에서 이 페이지를 열어주세요.');
        }, timeoutMs);
        try {
          new sdk.Postcode({
            width: '100%', height: '100%', focusInput: true, submitMode: false,
            // Kakao documents resize as a size-change callback, not a guaranteed
            // initial-ready event. Script/iframe load alone also proves no usability.
            onresize: (size) => {
              if (!Number.isFinite(size?.width) || !Number.isFinite(size?.height) || size.width <= 0 || size.height <= 0) return;
              markReady();
            },
            // The documented search callback precedes resize. Zero results still
            // prove a completed search; do not retain or log the address query.
            onsearch: (data) => {
              if (typeof data?.q !== 'string' || !Number.isInteger(data.count) || data.count < 0) return;
              markReady();
            },
            oncomplete: (data) => {
              if (!current()) return;
              active = false;
              stopTimer();
              events.complete(data);
            }
          }).embed(element, { autoClose: false });
        } catch { fail(); }
      } catch {
        if (session === generation) events.status('error', '주소 검색 서비스에 연결하지 못했어요. 다시 시도해주세요. 계속 열리지 않으면 일반 브라우저에서 이 페이지를 열어주세요.');
      }
    },
    close
  };
}
