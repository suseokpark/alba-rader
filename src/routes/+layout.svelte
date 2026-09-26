<script lang="ts">
	import { setContext } from 'svelte';
	import { createSearchSession, SEARCH_SESSION } from '$lib/search-session';
	import favicon from '$lib/assets/favicon.svg';
	import '../app.css';

	setContext(SEARCH_SESSION, createSearchSession());
	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
