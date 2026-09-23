import { load } from 'cheerio';
import type { JobListing, SearchArea, SearchOptions, SearchResult } from '../../search';

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
const areaCodeUrl = 'https://www.alba.co.kr/rsc/js/_AreaCode.js';
let areaCache: { expiresAt: number; data: Record<string, unknown> } | undefined;

type AlbaArea = { value: string; label: string };

async function resolveArea(area: SearchArea, signal: AbortSignal): Promise<AlbaArea | undefined> {
	let data = areaCache?.expiresAt && areaCache.expiresAt > Date.now() ? areaCache.data : undefined;
	if (!data) {
		const response = await fetch(areaCodeUrl, { signal });
		if (!response.ok || response.url !== areaCodeUrl) throw new Error('Region list unavailable');
		// This public asset is a data assignment with unquoted keys. Never evaluate remote JS.
		const script = await response.text();
		const assignment = script.match(/^\s*var\s+arrAreaCodeJson\s*=\s*(\{[\s\S]*\});?\s*$/);
		if (!assignment) throw new Error('Region list changed');
		const parsed = JSON.parse(assignment[1].replace(/([{,]\s*)([A-Z][A-Z0-9_]*)\s*:/g, '$1"$2":'));
		if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.ARCD)) {
			throw new Error('Invalid region list');
		}
		data = parsed as Record<string, unknown>;
		areaCache = { expiresAt: Date.now() + 6 * 60 * 60 * 1_000, data };
	}
	const aliases: Record<string, string> = {
		강원특별자치도: '강원',
		전북특별자치도: '전북',
		제주특별자치도: '제주',
		세종특별자치시: '세종'
	};
	const sido = aliases[area.sido] ?? normalize(area.sido);
	const provinces = data.ARCD as { ARCD: string; ARNM: string; FUNM: string }[];
	const province = provinces.find((entry) => entry.ARNM === sido || entry.FUNM === sido);
	if (!province || !/^\d{2,3}$/.test(province.ARCD) || province.ARCD === '99') return;
	const districts = data[`ARCD_${province.ARCD}`];
	if (!Array.isArray(districts)) return;
	const sigungu = normalize(area.sigungu);
	// Sejong has no subordinate city/district in this official search selector.
	const districtName = province.ARCD === '044' && !sigungu ? '전체' : sigungu;
	const district = districts.find((entry) => entry && entry.GUCD === districtName);
	if (!district) return;
	return {
		// Verified from public WNTopSearch.js: ARCD + '||' + GUCD + ','.
		value: `${province.ARCD}||${district.GUCD},`,
		label: district.GUCD === '전체'
			? `${province.ARNM} 전체 · 시 기준`
			: `${province.ARNM} ${district.GUCD} · 시·군·구 기준`
	};
}

/** Read the same public search HTML served to an anonymous visitor. */
export async function searchAlba(query: string, options: SearchOptions = { scope: 'nationwide' }): Promise<SearchResult> {
	const url = new URL('https://www.alba.co.kr/search/Search');
	url.search = new URLSearchParams({
		section: 'ALL',
		srchType: 'ALL',
		clsType: 'search',
		EasySearch: 'mainSearch',
		wsSrchWord: query
	}).toString();
	const result: SearchResult = {
		source: 'alba',
		status: 'unavailable',
		jobs: [],
		searchUrl: url.href,
		checkedAt: new Date().toISOString(),
		regionNote: options.scope === 'address' ? '선택 지역 확인 중' : '전국 검색'
	};

	try {
		const signal = AbortSignal.timeout(12_000);
		let selectedArea: AlbaArea | undefined;
		if (options.scope === 'address') {
			selectedArea = options.area ? await resolveArea(options.area, signal) : undefined;
			if (!selectedArea) {
				return {
					...result,
					regionNote: '선택 지역 연결 불가',
					message: '선택한 주소를 알바천국의 시·군·구에 연결하지 못했어요. 원문에서 지역을 선택해 주세요.'
				};
			}
			url.searchParams.set('hidArea', selectedArea.value);
			result.searchUrl = url.href;
			result.regionNote = selectedArea.label;
		}
		const response = await fetch(url, {
			signal,
			headers: { Accept: 'text/html', 'Accept-Language': 'ko-KR,ko;q=0.9' }
		});
		if (!response.ok) {
			return { ...result, message: `알바천국이 검색 요청에 응답하지 않았어요. (${response.status})` };
		}
		const responseUrl = new URL(response.url);
		if (responseUrl.origin !== url.origin || responseUrl.pathname.toLowerCase() !== '/search/search') {
			return { ...result, message: '알바천국 검색 페이지로 연결되지 않았어요. 원문에서 확인해 주세요.' };
		}
		const $ = load(await response.text());
		if (selectedArea && $('#hidArea').val() !== selectedArea.value) {
			return { ...result, message: '알바천국의 지역 조건 적용을 확인하지 못했어요. 원문에서 확인해 주세요.' };
		}
		const jobs: JobListing[] = [];
		const seen = new Set<string>();
		// Paid keyword sections are separate siblings of this ordinary-results list.
		$('#jobNormal .job-list__row').each((_, element) => {
			if (jobs.length >= 20) return false;
			const row = $(element);
			const href = row.find('a.job-list__link.info').attr('href');
			const title = normalize(row.find('.job-list__subject').text());
			if (!href || !title) return;
			let jobUrl: URL;
			try {
				jobUrl = new URL(href, url);
			} catch {
				return;
			}
			const id = jobUrl.searchParams.get('adid');
			if (
				jobUrl.origin !== url.origin ||
				jobUrl.pathname.toLowerCase() !== '/job/detail' ||
				!id ||
				!/^\d+$/.test(id) ||
				seen.has(id)
			) return;
			seen.add(id);
			const companyElement = row.find('.job-list__company').clone();
			companyElement.find('.job-list__area').remove();
			const company = normalize(companyElement.text());
			const location = normalize(row.find('.job-list__area').text());
			const payElement = row.find('.job-list__col.pay');
			const payType = normalize(payElement.find('.payIcon').text());
			const payAmount = normalize(payElement.find('.job-list__number').text());
			// The source's pay renderer labels numeric amounts in won.
			const amountWithUnit = /^[\d,]+$/.test(payAmount) ? `${payAmount}원` : payAmount;
			const pay = payAmount
				? [payType, amountWithUnit].filter(Boolean).join(' ')
				: normalize(payElement.text());
			jobs.push({
				id: `alba-${id}`,
				title,
				url: jobUrl.href,
				...(company && { company }),
				...(location && { location }),
				...(pay && { pay })
			});
		});
		if (jobs.length) {
			return { ...result, status: 'ok', jobs, message: '원문 검색 첫 페이지의 일반 채용공고예요.' };
		}
		const description = $('meta[name="Description"]').attr('content') ?? '';
		// A missing selector is not evidence of zero matches. Require the site's explicit count.
		if (/관련 검색결과 총\s*0건의 채용정보/.test(description)) {
			return { ...result, status: 'empty', message: '이 검색어에 해당하는 공고가 없어요.' };
		}
		return { ...result, message: '알바천국 검색 결과를 읽지 못했어요. 원문에서 확인해 주세요.' };
	} catch {
		return { ...result, message: '알바천국 조회가 지연되거나 연결되지 않았어요. 다시 검색해 주세요.' };
	}
}
