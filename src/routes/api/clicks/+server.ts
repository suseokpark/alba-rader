import { json } from '@sveltejs/kit';
import { parseClick } from '$lib/click-analytics';
import { readClicks, saveClick } from '$lib/server/click-store';
import type { SourceId } from '$lib/search';
import type { RequestHandler } from './$types';

const headers = { 'Cache-Control': 'no-store' };
const unavailable = () => json({ message: '클릭 통계를 연결하지 못했어요. 잠시 후 다시 확인해주세요.' }, { status: 503, headers });

export const POST: RequestHandler = async ({ request, url, platform }) => {
  if (request.headers.get('origin') !== url.origin) return json({ message: '잘못된 요청입니다.' }, { status: 403, headers });
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return new Response(null, { status: 415, headers });
  if (Number(request.headers.get('content-length')) > 8192) return new Response(null, { status: 413, headers });
  // Bound the actual stream too; Content-Length alone is client-controlled.
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400, headers });
  let body = ''; let bytes = 0; const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) { reader.releaseLock(); return new Response(null, { status: 413, headers }); }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    const click = parseClick(JSON.parse(body));
    if (!click) return new Response(null, { status: 400, headers });
    if (!platform?.env?.DB) return unavailable();
    await saveClick(platform.env.DB, click);
    return new Response(null, { status: 204, headers });
  } catch (error) {
    if (error instanceof SyntaxError) return new Response(null, { status: 400, headers });
    return unavailable();
  }
};

export const GET: RequestHandler = async ({ url, platform }) => {
  const days = url.searchParams.get('days') || '7';
  const source = url.searchParams.get('source') || 'all';
  if (!['7', '30'].includes(days) || !['all', 'albamon', 'daangn', 'alba'].includes(source)) return new Response(null, { status: 400, headers });
  if (!platform?.env?.DB) return unavailable();
  try { return json(await readClicks(platform.env.DB, Number(days), source === 'all' ? undefined : source as SourceId), { headers }); }
  catch { return unavailable(); }
};
