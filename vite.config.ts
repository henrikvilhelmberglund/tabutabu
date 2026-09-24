import adapter from '@sveltejs/adapter-auto';
import { sveltekit } from '@sveltejs/kit/vite';
import UnoCSS from '@unocss/svelte-scoped/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	server: {
		// Not app code: the optional Python environment (tens of thousands of
		// files) and local reference audio. Watching them costs CPU for nothing.
		watch: { ignored: ['**/.venv/**', '**/reference/**'] }
	},
	plugins: [
		UnoCSS({
			injectReset: '@unocss/reset/tailwind.css'
		}),
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	]
});
