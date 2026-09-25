import adapter from '@sveltejs/adapter-auto';
import cloudflare from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// Keep local development unchanged; production includes the search API Worker.
			adapter: command === 'build' ? cloudflare({ config: 'wrangler.sites.jsonc' }) : adapter()
		})
	]
}));
