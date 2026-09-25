import cloudflare from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// Local preview has its own persistent D1; Sites binds a separate production DB.
			adapter: cloudflare({ config: 'wrangler.sites.jsonc', platformProxy: { configPath: 'wrangler.sites.jsonc', persist: { path: '.wrangler/state/v3' } } })
		})
	]
});
